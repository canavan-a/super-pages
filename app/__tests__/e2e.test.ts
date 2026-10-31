// End to end against a real server: sign-up with email codes and an invite
// code, encrypted pages, sharing by email (to someone who signs up later),
// share links, roles, and removing someone. Runs the Go server from
// ../server, so it only runs with E2E=1 (see run-tests in flake.nix).
import {ChildProcess, execFileSync, spawn} from 'child_process';
import {mkdtempSync, readFileSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {api} from '../src/api';
import {
  accountFromEntropy,
  b64,
  lockBundle,
  newAccount,
  openBundle,
  parseShareLink,
} from '../src/crypto';
import * as store from '../src/pagesStore';
import {session} from '../src/session';

const run = process.env.E2E ? describe : describe.skip;
const PORT = 18000 + Math.floor(Math.random() * 1000);
const SERVER = `http://127.0.0.1:${PORT}`;
const serverDir = join(__dirname, '../../server');
const FAST = {N: 1 << 10, r: 8, p: 1};

let proc: ChildProcess;
let dataDir: string;
let log = '';

const seen = new Map<string, number>();

// The newest code logged for email that hasn't been used yet.
async function codeFor(email: string): Promise<string> {
  const used = seen.get(email) ?? 0;
  for (let i = 0; i < 100; i++) {
    const all = [
      ...log.matchAll(
        new RegExp(
          `sign-in code for ${email.replace('.', '\\.')}: (\\d{6})`,
          'g',
        ),
      ),
    ];
    if (all.length > used) {
      seen.set(email, all.length);
      return all[all.length - 1][1];
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`no code for ${email}`);
}

async function signUp(email: string, name: string, regCode = '') {
  await api.emailStart(SERVER, email);
  const v = await api.emailVerify(SERVER, email, await codeFor(email));
  expect(v.account).toBeNull();
  const account = newAccount();
  const me = await api.createAccount(SERVER, account, {
    ticket: v.ticket,
    reg_code: regCode,
    box_pub: b64(account.xPub),
    bundle: await lockBundle(account.entropy, `${name} passphrase`, FAST),
    name,
  });
  return {account, me, email, needsCode: v.needs_code};
}

function as(u: {account: {entropy: Uint8Array}; me: any}) {
  store.resetStore();
  session.unlock(SERVER, u.account.entropy, u.me);
}

run('end to end', () => {
  jest.setTimeout(120_000);

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'sp-e2e-'));
    const env = {
      ...process.env,
      SUPERPAGES_LISTEN_ADDR: `127.0.0.1:${PORT}`,
      SUPERPAGES_DATA_DIR: dataDir,
      SUPERPAGES_LOG_CODES: '1',
    };
    execFileSync(
      'go',
      ['build', '-o', join(dataDir, 'srv'), './cmd/superpages-server'],
      {cwd: serverDir, env},
    );
    execFileSync(
      'go',
      ['build', '-o', join(dataDir, 'admin'), './cmd/superpages-admin'],
      {cwd: serverDir, env},
    );
    proc = spawn(join(dataDir, 'srv'), [], {env, cwd: dataDir});
    proc.stdout!.on('data', d => (log += d));
    proc.stderr!.on('data', d => (log += d));
    for (let i = 0; i < 100; i++) {
      try {
        if ((await api.config(SERVER)).app === 'superpages') return;
      } catch {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    throw new Error(`server didn't start:\n${log}`);
  });

  afterAll(() => {
    proc?.kill();
    rmSync(dataDir, {recursive: true, force: true});
  });

  it('works', async () => {
    const env = {...process.env, SUPERPAGES_DATA_DIR: dataDir};
    const regCode = execFileSync(
      join(dataDir, 'admin'),
      ['codes', 'create', '--uses', '2', '--label', 'e2e'],
      {env},
    )
      .toString()
      .split('\n')[0]
      .trim();
    expect(regCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    // Signing up without an invite code is refused.
    await api.emailStart(SERVER, 'nobody@example.com');
    const v = await api.emailVerify(
      SERVER,
      'nobody@example.com',
      await codeFor('nobody@example.com'),
    );
    expect(v.needs_code).toBe(true);
    const stranger = newAccount();
    await expect(
      api.createAccount(SERVER, stranger, {
        ticket: v.ticket,
        reg_code: '',
        box_pub: b64(stranger.xPub),
        bundle: 'x',
        name: 'x',
      }),
    ).rejects.toMatchObject({status: 403});

    const alice = await signUp('alice@example.com', 'Alice', regCode);
    const carol = await signUp('carol@example.com', 'Carol', regCode);

    // Alice writes a page.
    as(alice);
    const id = await store.createDoc('');
    let opened = await store.openDoc(id);
    const secret = 'The launch code is 0000. Nobody may know.';
    let version = await store.saveDoc(
      id,
      opened.doc.version,
      opened.doc.epoch,
      opened.key,
      `# Plans\n\n${secret}\n`,
    );
    await store.refreshDocs();
    expect(store.getState().docs[0].head).toEqual({
      title: 'Plans',
      snippet: secret,
    });

    // Shares it with Bob, who has no account yet: a pending share.
    const r = await store.shareByEmail(id, 'bob@example.com', 'edit');
    expect(r.kind).toBe('pending');

    // Bob signs up; the share counts as his invitation.
    const bob = await signUp('bob@example.com', 'Bob');
    expect(bob.needsCode).toBe(false);
    as(bob);
    await store.refreshDocs();
    // Nothing yet: only a key holder can finish the share.
    expect(store.getState().docs).toHaveLength(0);

    // Alice's app finishes the share next time it runs.
    as(alice);
    await store.refreshDocs();
    await store.processTodo();
    as(bob);
    await store.refreshDocs();
    opened = await store.openDoc(id);
    expect(opened.markdown).toContain(secret);
    expect(opened.verified).toBe(true);
    expect(opened.doc.role).toBe('edit');
    version = await store.saveDoc(
      id,
      opened.doc.version,
      opened.doc.epoch,
      opened.key,
      `# Plans\n\n${secret}\n\nBob was here.\n`,
    );
    // Editors can't share.
    await expect(
      store.shareByEmail(id, 'carol@example.com', 'view'),
    ).rejects.toMatchObject({status: 403});

    // Carol joins through a view link.
    as(alice);
    const {url} = await store.createLink(id, 'view', 24, 1);
    const link = parseShareLink(url)!;
    as(carol);
    expect(
      (await store.previewLink(SERVER, link.link, link.secret)).title,
    ).toBe('Plans');
    await store.joinLink(link.link, link.secret);
    opened = await store.openDoc(id);
    expect(opened.markdown).toContain('Bob was here.');
    await expect(
      store.saveDoc(
        id,
        opened.doc.version,
        opened.doc.epoch,
        opened.key,
        'vandalised',
      ),
    ).rejects.toMatchObject({
      status: 403,
    });

    // The member list shows names, never addresses.
    const full = JSON.stringify(await api.doc(SERVER, carol.account, id));
    expect(full).not.toContain('@example.com');

    // Alice removes Bob: a fresh key, and he's out.
    as(alice);
    await store.removeMember(id, bob.me.id);
    as(bob);
    await expect(store.openDoc(id)).rejects.toMatchObject({status: 404});
    as(carol);
    expect((await store.openDoc(id)).doc.epoch).toBe(2);

    // A new device: the email code returns the locked bundle, the passphrase opens it.
    await api.emailStart(SERVER, 'alice@example.com');
    const again = await api.emailVerify(
      SERVER,
      'alice@example.com',
      await codeFor('alice@example.com'),
    );
    await expect(openBundle(again.account!.bundle, 'wrong')).rejects.toThrow(
      /passphrase/,
    );
    const entropy = await openBundle(again.account!.bundle, 'Alice passphrase');
    expect(accountFromEntropy(entropy).keyId).toBe(alice.account.keyId);

    // Nothing readable reached the server's database.
    const db =
      readFileSync(join(dataDir, 'superpages.db')).toString('latin1') +
      readFileSync(join(dataDir, 'superpages.db-wal')).toString('latin1');
    expect(db).not.toContain('launch code');
    expect(db).not.toContain('Plans');
    expect(version).toBeGreaterThan(1);
  });
});
