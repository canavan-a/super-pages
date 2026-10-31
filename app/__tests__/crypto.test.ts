import {readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {sha256} from '@noble/hashes/sha256';

import {
  accountFromEntropy,
  b64,
  bytesToHex,
  docSigningString,
  entropyFromPhrase,
  makeHead,
  imageUrl,
  joinProof,
  linkKeys,
  lockBundle,
  newAccount,
  newDocKey,
  newId,
  openBlob,
  openBody,
  openBundle,
  openHead,
  openLinkKey,
  parseImageUrl,
  parseShareLink,
  formatShareLink,
  phraseFromEntropy,
  randomBytes,
  sealBlob,
  sealBody,
  sealHead,
  sealLinkKey,
  sign,
  signSave,
  unwrapDocKey,
  utf8,
  verifySave,
  wrapDocKey,
  WrongPassphrase,
} from '../src/crypto';

// Cheap scrypt for tests; the cost is a parameter of the bundle itself.
const FAST = {N: 1 << 10, r: 8, p: 1};

test('account keys are derived from the entropy, and the phrase round-trips', () => {
  const a = newAccount();
  const again = accountFromEntropy(
    entropyFromPhrase(phraseFromEntropy(a.entropy).join(' ')),
  );
  expect(again.keyId).toBe(a.keyId);
  expect(b64(again.xPub)).toBe(b64(a.xPub));
  expect(a.keyId).toMatch(/^[a-z2-7]{52}$/);
  expect(phraseFromEntropy(a.entropy)).toHaveLength(24);
});

test('the bundle opens with the passphrase and only with it', async () => {
  const a = newAccount();
  const bundle = await lockBundle(a.entropy, 'correct horse battery', FAST);
  expect(bundle).not.toContain(b64(a.entropy));
  expect(b64(await openBundle(bundle, 'correct horse battery'))).toBe(
    b64(a.entropy),
  );
  await expect(
    openBundle(bundle, 'wrong horse battery'),
  ).rejects.toBeInstanceOf(WrongPassphrase);
  await expect(openBundle('{"v":2}', 'x')).rejects.toThrow(/damaged/);
});

test('a document key sealed to one account opens only for it', () => {
  const alice = newAccount();
  const bob = newAccount();
  const doc = newId();
  const key = newDocKey();
  const wrapped = wrapDocKey(key, b64(bob.xPub), doc);
  expect(b64(unwrapDocKey(bob, wrapped, doc))).toBe(b64(key));
  expect(() => unwrapDocKey(alice, wrapped, doc)).toThrow();
  // Bound to the document: can't be replayed onto another one.
  expect(() => unwrapDocKey(bob, wrapped, newId())).toThrow();
});

test('head and body are bound to their document and epoch', () => {
  const doc = newId();
  const key = newDocKey();
  const md =
    '# Groceries\n\n- [ ] eggs\n- [x] **milk**\n\nRemember the ![photo](sp-img:AAAAAAAAAAAAAAAAAAAAAA#BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB) list';
  // The title is the page's own, not taken from its text.
  const head = makeHead('  Shopping ', md);
  expect(head.title).toBe('Shopping');
  expect(head.snippet).toBe('Groceries eggs milk Remember the list');
  expect(makeHead('', '').title).toBe('');
  const h = sealHead(key, doc, 3, head);
  const b = sealBody(key, doc, 3, md);
  expect(openHead(key, doc, 3, h)).toEqual(head);
  expect(openBody(key, doc, 3, b)).toBe(md);
  expect(() => openBody(key, doc, 4, b)).toThrow();
  expect(() => openBody(key, newId(), 3, b)).toThrow();
  expect(() => openHead(key, doc, 3, b)).toThrow();
});

test('saves are signed by the writer', () => {
  const a = newAccount();
  const doc = newId();
  const sig = signSave(a, doc, 2, 1, 'h', 'b');
  expect(verifySave(a.edPub, doc, 2, 1, 'h', 'b', sig)).toBe(true);
  expect(verifySave(a.edPub, doc, 3, 1, 'h', 'b', sig)).toBe(false);
  expect(verifySave(newAccount().edPub, doc, 2, 1, 'h', 'b', sig)).toBe(false);
});

test('images: sealed under their own key, named by an sp-img: URL', () => {
  const bytes = randomBytes(1000);
  const {key, sealed} = sealBlob(bytes);
  expect(b64(openBlob(key, sealed))).toBe(b64(bytes));
  const blob = newId();
  expect(parseImageUrl(imageUrl(blob, key))).toEqual({blob, key});
  expect(parseImageUrl('https://evil.example/pixel.png')).toBeNull();
});

test('share links carry the key in the fragment', () => {
  const secret = randomBytes(32);
  const doc = newId();
  const link = newId();
  const key = newDocKey();
  const url = formatShareLink('https://pages.example.com/', link, secret);
  expect(url).toMatch(
    /^https:\/\/pages\.example\.com\/s\/[\w-]{22}#[\w-]{43}$/,
  );
  const parsed = parseShareLink(url)!;
  expect(parsed.server).toBe('https://pages.example.com');
  expect(parsed.link).toBe(link);
  expect(
    b64(openLinkKey(parsed.secret, doc, sealLinkKey(secret, doc, key))),
  ).toBe(b64(key));
  const app = parseShareLink(
    `superpages://share?s=${encodeURIComponent(
      'https://pages.example.com',
    )}&l=${link}&k=${b64(secret)}`,
  )!;
  expect(app.link).toBe(link);
  expect(parseShareLink('https://pages.example.com/s/abc')).toBeNull();
  expect(linkKeys(secret).edPub).toHaveLength(32);
});

// The server (Go) must accept exactly what the app signs. This writes the
// fixture server/proto/testdata/ts-sigs.json (UPDATE_FIXTURE=1) and checks
// the checked-in one still matches; server/proto/interop_test.go verifies it.
test('Go interop fixture', () => {
  const seed = new Uint8Array(32).fill(7);
  const a = accountFromEntropy(seed);
  const doc = 'AAAAAAAAAAAAAAAAAAAAAA';
  const link = 'BBBBBBBBBBBBBBBBBBBBBB';
  const user = 'CCCCCCCCCCCCCCCCCCCCCC';
  const req = utf8(
    `SP1\nGET\n/v1/me\n1700000000000\nnonce\n${bytesToHex(
      sha256(new Uint8Array()),
    )}`,
  );
  const secret = new Uint8Array(32).fill(9);
  const fixture = {
    key_id: a.keyId,
    request: {msg: b64(req), sig: b64(sign(a.edSeed, '', req))},
    doc: {
      id: doc,
      version: 5,
      epoch: 2,
      head: 'head-ct',
      body: 'body-ct',
      msg: b64(docSigningString(doc, 5, 2, 'head-ct', 'body-ct')),
      sig: signSave(a, doc, 5, 2, 'head-ct', 'body-ct'),
    },
    join: {
      link,
      doc,
      user,
      link_pub: b64(linkKeys(secret).edPub),
      proof: joinProof(secret, link, doc, user),
    },
  };
  const path = join(__dirname, '../../server/proto/testdata/ts-sigs.json');
  if (process.env.UPDATE_FIXTURE)
    writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(fixture);
});
