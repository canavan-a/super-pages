// The documents this account can open, decrypted on the device. The server
// hands out ciphertext and sealed keys; everything readable is made here.
import {useSyncExternalStore} from 'react';

import {
  api,
  ApiError,
  DocFull,
  DocSummary,
  Member,
  Pending,
  Role,
  ShareLinkInfo,
  Todo,
} from './api';
import {
  b64,
  DocHead,
  formatShareLink,
  headFromMarkdown,
  imageUrl,
  joinProof,
  linkKeys,
  newDocKey,
  newId,
  openBlob,
  openBody,
  openHead,
  openLinkKey,
  parseImageUrl,
  pubFromKeyId,
  randomBytes,
  sealBlob,
  sealBody,
  sealHead,
  sealLinkKey,
  signSave,
  unwrapDocKey,
  verifySave,
  wrapDocKey,
} from './crypto';
import {dataUri} from './files';
import {session, Session} from './session';

export interface DocEntry {
  summary: DocSummary;
  /** null while the key hasn't been sealed for this account yet. */
  head: DocHead | null;
  locked: boolean;
}

interface State {
  docs: DocEntry[];
  loaded: boolean;
  error: string | null;
}

let state: State = {docs: [], loaded: false, error: null};
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = {...state, ...patch};
  listeners.forEach(l => l());
};

export function useStore<T>(pick: (s: State) => T): T {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pick(state),
  );
}

export const getState = (): State => state;

export function resetStore(): void {
  keys.clear();
  images.clear();
  state = {docs: [], loaded: false, error: null};
  listeners.forEach(l => l());
}

// Unwrapping a key is an X25519 multiplication; remember each one.
const keys = new Map<string, Uint8Array>();

function docKey(
  s: Session,
  d: {id: string; epoch: number; key: string | null},
): Uint8Array | null {
  if (!d.key) return null;
  const k = `${d.id}|${d.epoch}`;
  let key = keys.get(k);
  if (!key) {
    key = unwrapDocKey(s.account, d.key, d.id);
    keys.set(k, key);
  }
  return key;
}

function entry(s: Session, d: DocSummary): DocEntry {
  try {
    const key = docKey(s, d);
    if (!key) return {summary: d, head: null, locked: true};
    return {
      summary: d,
      head: openHead(key, d.id, d.epoch, d.head_ct),
      locked: false,
    };
  } catch {
    return {summary: d, head: null, locked: true};
  }
}

let refreshing: Promise<void> | null = null;

/** Reloads the list, then quietly does any sharing work waiting on this device. */
export function refreshDocs(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const s = session.require();
    try {
      const docs = await api.docs(s.server, s.account);
      set({docs: docs.map(d => entry(s, d)), loaded: true, error: null});
    } catch (e) {
      set({loaded: true, error: (e as Error).message});
      return;
    }
    processTodo().catch(() => {});
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

function patchSummary(id: string, patch: Partial<DocSummary>, head?: DocHead) {
  set({
    docs: state.docs
      .map(e =>
        e.summary.id === id
          ? {...e, summary: {...e.summary, ...patch}, head: head ?? e.head}
          : e,
      )
      .sort((a, b) => b.summary.updated_at - a.summary.updated_at),
  });
}

// ---- one document ----

export interface OpenDoc {
  doc: DocFull;
  key: Uint8Array;
  markdown: string;
  /** False if the last save's signature didn't check out against its writer's key. */
  verified: boolean;
}

export class LockedError extends Error {
  constructor() {
    super(
      "This page's key hasn't reached this account yet. It will once an owner opens Super Pages.",
    );
  }
}

export async function openDoc(id: string): Promise<OpenDoc> {
  const s = session.require();
  const doc = await api.doc(s.server, s.account, id);
  const key = docKey(s, doc);
  if (!key) throw new LockedError();
  const markdown = openBody(key, doc.id, doc.epoch, doc.body_ct);
  const writer = doc.members.find(m => m.id === doc.updated_by);
  const verified =
    !!writer &&
    verifySave(
      pubFromKeyId(writer.sign_pub),
      doc.id,
      doc.version,
      doc.epoch,
      doc.head_ct,
      doc.body_ct,
      doc.sig,
    );
  return {doc, key, markdown, verified};
}

function sealed(
  s: Session,
  id: string,
  version: number,
  epoch: number,
  key: Uint8Array,
  markdown: string,
) {
  const head = headFromMarkdown(markdown);
  const head_ct = sealHead(key, id, epoch, head);
  const body_ct = sealBody(key, id, epoch, markdown);
  return {
    head,
    head_ct,
    body_ct,
    sig: signSave(s.account, id, version, epoch, head_ct, body_ct),
  };
}

export async function createDoc(markdown = ''): Promise<string> {
  const s = session.require();
  const id = newId();
  const key = newDocKey();
  const {head, head_ct, body_ct, sig} = sealed(s, id, 1, 1, key, markdown);
  const res = await api.createDoc(s.server, s.account, {
    id,
    base_version: 0,
    epoch: 1,
    head_ct,
    body_ct,
    sig,
    wrapped_key: wrapDocKey(key, b64(s.account.xPub), id),
  });
  keys.set(`${id}|1`, key);
  const me = s.me;
  const summary: DocSummary = {
    id,
    version: res.version,
    epoch: 1,
    head_ct,
    updated_by: me?.id ?? '',
    updated_at: res.updated_at,
    created_at: res.updated_at,
    role: 'owner',
    key: null,
    needs_rekey: false,
    members: me
      ? [
          {
            id: me.id,
            name: me.name,
            avatar: me.avatar,
            role: 'owner',
            sign_pub: me.sign_pub,
            box_pub: me.box_pub,
            has_key: true,
          },
        ]
      : [],
  };
  set({docs: [{summary, head, locked: false}, ...state.docs]});
  return id;
}

export class ConflictError extends Error {
  constructor(public version: number) {
    super('This page was changed somewhere else.');
  }
}

/** Saves markdown as the version after base. Throws ConflictError if someone else saved first. */
export async function saveDoc(
  id: string,
  base: number,
  epoch: number,
  key: Uint8Array,
  markdown: string,
): Promise<number> {
  const s = session.require();
  const {head, head_ct, body_ct, sig} = sealed(
    s,
    id,
    base + 1,
    epoch,
    key,
    markdown,
  );
  try {
    const res = await api.saveDoc(s.server, s.account, id, {
      base_version: base,
      epoch,
      head_ct,
      body_ct,
      sig,
    });
    patchSummary(
      id,
      {
        version: res.version,
        head_ct,
        updated_at: res.updated_at,
        updated_by: s.me?.id ?? '',
      },
      head,
    );
    return res.version;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409)
      throw new ConflictError(e.body?.version ?? base);
    throw e;
  }
}

export async function deleteDoc(id: string): Promise<void> {
  const s = session.require();
  await api.deleteDoc(s.server, s.account, id);
  set({docs: state.docs.filter(e => e.summary.id !== id)});
}

export async function leaveDoc(id: string): Promise<void> {
  const s = session.require();
  await api.leaveDoc(s.server, s.account, id);
  set({docs: state.docs.filter(e => e.summary.id !== id)});
}

// ---- sharing ----

export type ShareResult =
  | {kind: 'added'; name: string}
  | {kind: 'pending'; pending: Pending};

/**
 * Shares by exact email address. Someone with an account gets the key sealed
 * to them now; an address without one gets an invitation, and this (or any
 * owner's) app finishes the share once they sign up.
 */
export async function shareByEmail(
  id: string,
  email: string,
  role: Role,
): Promise<ShareResult> {
  const s = session.require();
  const res = await api.share(s.server, s.account, id, email, role);
  if (res.pending) return {kind: 'pending', pending: res.pending};
  const user = res.user!;
  const {doc, key} = await openDoc(id);
  await api.addMember(s.server, s.account, id, {
    user_id: user.id,
    role,
    epoch: doc.epoch,
    wrapped_key: wrapDocKey(key, user.box_pub, id),
  });
  refreshDocs().catch(() => {});
  return {kind: 'added', name: user.name};
}

export async function setRole(
  id: string,
  user: string,
  role: Role,
): Promise<void> {
  const s = session.require();
  await api.setRole(s.server, s.account, id, user, role);
}

export async function cancelPending(
  id: string,
  pending: string,
): Promise<void> {
  const s = session.require();
  await api.deletePending(s.server, s.account, id, pending);
}

/**
 * Moves a document to a fresh key, dropping remove from it: the content is
 * re-encrypted and the new key sealed to everyone who stays, so whoever left
 * can't read anything written from now on. Share links die with the old key.
 */
export async function rekey(id: string, remove: string[] = []): Promise<void> {
  const s = session.require();
  const {doc, markdown} = await openDoc(id);
  const epoch = doc.epoch + 1;
  const key = newDocKey();
  const stay = doc.members.filter((m: Member) => !remove.includes(m.id));
  const {head, head_ct, body_ct, sig} = sealed(
    s,
    id,
    doc.version + 1,
    epoch,
    key,
    markdown,
  );
  const wrapped: Record<string, string> = {};
  for (const m of stay) wrapped[m.id] = wrapDocKey(key, m.box_pub, id);
  const res = await api.rekey(s.server, s.account, id, {
    base_version: doc.version,
    epoch,
    head_ct,
    body_ct,
    sig,
    keys: wrapped,
    remove,
  });
  keys.set(`${id}|${epoch}`, key);
  patchSummary(
    id,
    {
      version: res.version,
      epoch,
      head_ct,
      updated_at: res.updated_at,
      key: wrapped[s.me?.id ?? ''] ?? null,
      needs_rekey: false,
    },
    head,
  );
}

export const removeMember = (id: string, user: string) => rekey(id, [user]);

export async function listLinks(id: string): Promise<ShareLinkInfo[]> {
  const s = session.require();
  return api.links(s.server, s.account, id);
}

/** Makes a share link. Its secret is only ever in the returned URL. */
export async function createLink(
  id: string,
  role: Role,
  expiresHours: number,
  maxUses: number,
): Promise<{url: string; link: ShareLinkInfo}> {
  const s = session.require();
  const {doc, key} = await openDoc(id);
  const secret = randomBytes(32);
  const link = await api.createLink(s.server, s.account, id, {
    role,
    link_pub: b64(linkKeys(secret).edPub),
    key_ct: sealLinkKey(secret, id, key),
    epoch: doc.epoch,
    expires_hours: expiresHours,
    max_uses: maxUses,
  });
  const origin = s.server;
  return {url: formatShareLink(origin, link.id, secret), link};
}

export async function revokeLink(id: string, link: string): Promise<void> {
  const s = session.require();
  await api.revokeLink(s.server, s.account, id, link);
}

export interface LinkPreview {
  doc: string;
  role: Role;
  title: string;
}

export async function previewLink(
  server: string,
  link: string,
  secret: Uint8Array,
): Promise<LinkPreview> {
  const p = await api.previewLink(server, link);
  const key = openLinkKey(secret, p.doc_id, p.key_ct);
  const head = openHead(key, p.doc_id, p.epoch, p.head_ct);
  return {doc: p.doc_id, role: p.role, title: head.title};
}

export async function joinLink(
  link: string,
  secret: Uint8Array,
): Promise<string> {
  const s = session.require();
  const p = await api.previewLink(s.server, link);
  const key = openLinkKey(secret, p.doc_id, p.key_ct);
  const me = s.me ?? (await api.me(s.server, s.account));
  await api.joinLink(
    s.server,
    s.account,
    link,
    joinProof(secret, link, p.doc_id, me.id),
    wrapDocKey(key, me.box_pub, p.doc_id),
  );
  await refreshDocs();
  return p.doc_id;
}

/**
 * Sharing work the server can't do because it can't seal keys: finish
 * shares to addresses that have since signed up, seal the key again for
 * members who reset their account, and make a fresh key after someone left.
 */
export async function processTodo(): Promise<void> {
  const s = session.require();
  const todo: Todo[] = await api.todo(s.server, s.account);
  let changed = false;
  for (const t of todo) {
    try {
      if (t.kind === 'rekey') {
        await rekey(t.doc_id);
      } else if (t.user) {
        const e = state.docs.find(d => d.summary.id === t.doc_id);
        const key = e ? docKey(s, e.summary) : null;
        if (!key || e!.summary.epoch !== t.epoch) continue;
        const wrapped = wrapDocKey(key, t.user.box_pub, t.doc_id);
        if (t.kind === 'pending') {
          await api.addMember(s.server, s.account, t.doc_id, {
            user_id: t.user.id,
            epoch: t.epoch,
            wrapped_key: wrapped,
            pending_id: t.pending_id,
          });
        } else {
          await api.putMemberKey(
            s.server,
            s.account,
            t.doc_id,
            t.user.id,
            t.epoch,
            wrapped,
          );
        }
      }
      changed = true;
    } catch {
      // Someone else's app may have done it first; try again next refresh.
    }
  }
  if (changed) {
    const docs = await api.docs(s.server, s.account);
    set({docs: docs.map(d => entry(s, d))});
  }
}

// ---- images ----

/** Imported images are scaled down to fit this many pixels on their long side. */
export const MAX_IMAGE_DIM = 2048;

function sniffMime(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return 'application/octet-stream';
}

/** Encrypts and uploads an image, returning the sp-img: URL to put in the page. */
export async function uploadImage(
  id: string,
  bytes: Uint8Array,
  onProgress?: (f: number) => void,
): Promise<string> {
  const s = session.require();
  const {key, sealed: ct} = sealBlob(bytes);
  const blob = await api.uploadBlob(s.server, s.account, id, ct, onProgress);
  const url = imageUrl(blob, key);
  images.set(url, dataUri(sniffMime(bytes), bytes));
  return url;
}

const images = new Map<string, string>();

/** The displayable URI for an sp-img: URL (a data: URI), downloaded and decrypted once. */
export async function loadImage(id: string, url: string): Promise<string> {
  const cached = images.get(url);
  if (cached) return cached;
  const ref = parseImageUrl(url);
  if (!ref) throw new Error('not an image link');
  const s = session.require();
  const bytes = openBlob(
    ref.key,
    await api.downloadBlob(s.server, s.account, id, ref.blob),
  );
  const uri = dataUri(sniffMime(bytes), bytes);
  images.set(url, uri);
  return uri;
}
