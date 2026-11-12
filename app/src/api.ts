// Requests to a Super Pages server (docs/protocol.md). Email sign-in is
// unsigned; everything after is signed by the account's Ed25519 key, with no
// session tokens.
import {sha256} from '@noble/hashes/sha256';
import {Platform} from 'react-native';

import {b64, bytesToHex, newId, sign, Signer, utf8} from './crypto';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any = null) {
    super(message);
  }
}

function signedHeaders(
  by: Signer,
  method: string,
  pathQuery: string,
  body: Uint8Array,
): Record<string, string> {
  const ts = String(Date.now());
  const nonce = newId();
  const msg = utf8(
    `SP1\n${method}\n${pathQuery}\n${ts}\n${nonce}\n${bytesToHex(
      sha256(body),
    )}`,
  );
  return {
    'X-SP-Key': by.keyId,
    'X-SP-Ts': ts,
    'X-SP-Nonce': nonce,
    'X-SP-Sig': b64(sign(by.edSeed, '', msg)),
  };
}

const REQUEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 300_000;

function errorText(status: number, json: any): string {
  if (json?.error) return json.error;
  if (status === 429) return 'Too many tries. Wait a bit and try again.';
  return `HTTP ${status}`;
}

/** A request; signed when `by` is given. */
export async function request<T>(
  server: string,
  method: string,
  path: string,
  by: Signer | null,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
  /** Let the request finish even if the page is closing. */
  keepalive = false,
): Promise<T> {
  const text = body === undefined ? '' : JSON.stringify(body);
  const bytes = utf8(text);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let res: Response;
  let out: string;
  try {
    res = await fetch(server + path, {
      method,
      headers: {
        ...(by ? signedHeaders(by, method, path, bytes) : {}),
        ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
      },
      body: body === undefined ? undefined : text,
      signal: abort.signal,
      keepalive,
    });
    out = await res.text();
  } catch (e) {
    if (abort.signal.aborted)
      throw new ApiError(
        0,
        `${server.replace(/^https?:\/\//, '')} didn't answer`,
      );
    throw new ApiError(0, `Can't reach ${server.replace(/^https?:\/\//, '')}`);
  } finally {
    clearTimeout(timer);
  }
  let json: any = null;
  try {
    json = out ? JSON.parse(out) : null;
  } catch {
    // not JSON
  }
  if (!res.ok)
    throw new ApiError(res.status, errorText(res.status, json), json);
  return json as T;
}

// Binary transfers go through XMLHttpRequest: React Native's fetch can't
// read a response as an ArrayBuffer, but its XHR can (responseType).
function xhr(
  server: string,
  method: 'GET' | 'PUT',
  path: string,
  by: Signer,
  body?: Uint8Array,
  onProgress?: (fraction: number) => void,
): Promise<{status: number; data: any}> {
  return new Promise((resolve, reject) => {
    const req = new XMLHttpRequest();
    req.open(method, server + path);
    for (const [k, v] of Object.entries(
      signedHeaders(by, method, path, body ?? new Uint8Array()),
    ))
      req.setRequestHeader(k, v);
    // Android's networking layer refuses a binary body without a content
    // type (it fails as a bare "network error"); the server ignores it.
    if (body) req.setRequestHeader('Content-Type', 'application/octet-stream');
    if (method === 'GET') req.responseType = 'arraybuffer';
    if (onProgress) {
      const target = method === 'PUT' ? req.upload : req;
      // Android's upload counter counts every byte twice: halve it there.
      const scale = method === 'PUT' && Platform.OS === 'android' ? 2 : 1;
      target.onprogress = e =>
        e.lengthComputable &&
        onProgress(Math.min(1, e.loaded / (e.total * scale)));
    }
    req.onload = () => resolve({status: req.status, data: req.response});
    req.timeout = method === 'PUT' ? UPLOAD_TIMEOUT_MS : DOWNLOAD_TIMEOUT_MS;
    req.ontimeout = () => reject(new ApiError(0, 'timed out'));
    req.onerror = () => reject(new ApiError(0, 'network error'));
    req.send(body as any);
  });
}

async function putBytes(
  server: string,
  path: string,
  by: Signer,
  bytes: Uint8Array,
  onProgress?: (f: number) => void,
): Promise<any> {
  const res = await xhr(server, 'PUT', path, by, bytes, onProgress);
  let json: any = null;
  try {
    json = JSON.parse(typeof res.data === 'string' ? res.data : '');
  } catch {
    // not JSON
  }
  if (res.status < 200 || res.status >= 300)
    throw new ApiError(res.status, errorText(res.status, json), json);
  return json;
}

// ---- types ----

export interface Me {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
  sign_pub: string;
  box_pub: string;
  key_gen: number;
}

export type Role = 'owner' | 'edit' | 'view';

export interface Member {
  id: string;
  name: string;
  avatar: string | null;
  role: Role;
  sign_pub: string;
  box_pub: string;
  has_key: boolean;
}

export interface Pending {
  id: string;
  /** Masked: "a***@example.com". */
  email: string;
  role: Role;
}

export interface DocSummary {
  id: string;
  version: number;
  epoch: number;
  head_ct: string;
  updated_by: string;
  updated_at: number;
  created_at: number;
  role: Role;
  /** My sealed copy of the current key; null while waiting for an owner's app. */
  key: string | null;
  needs_rekey: boolean;
  /** False while the page waits in "Shared with me" for me to accept it. */
  accepted: boolean;
  /** Who shared it with me (my own id for pages I made), and when (ms). */
  added_by: string;
  added_at: number;
  members: Member[];
}

export interface DocFull extends DocSummary {
  body_ct: string;
  sig: string;
  pending?: Pending[];
}

export interface SaveBody {
  id?: string;
  base_version: number;
  epoch: number;
  head_ct: string;
  body_ct: string;
  sig: string;
  wrapped_key?: string;
}

/** A live check-in (POST /docs/:id/live); everything in it is sealed by the apps. */
export interface LiveReq {
  tab: string;
  since: number;
  gen?: number;
  wait?: boolean;
  leaving?: boolean;
  aware?: string;
  updates?: string[];
}

export interface LiveResp {
  seq: number;
  gen: number;
  reset?: boolean;
  msgs: {seq: number; user: string; tab: string; data: string}[];
  viewers: {user: string; tab: string; aware?: string}[];
  version: number;
  epoch: number;
}

export interface ShareLinkInfo {
  id: string;
  role: Role;
  expires_at: number | null;
  max_uses: number | null;
  uses: number;
  created_at: number;
}

export interface Todo {
  kind: 'pending' | 'key' | 'rekey';
  doc_id: string;
  epoch: number;
  pending_id?: string;
  role?: Role;
  user?: {id: string; name: string; box_pub: string};
}

export interface VerifyResult {
  ticket: string;
  account: {bundle: string; sign_pub: string; key_gen: number} | null;
}

export interface ServerConfig {
  app: string;
  // New accounts need the pre-release invite code to get a sign-in code.
  prerelease: boolean;
  email_ready: boolean;
  max_blob_bytes: number;
  public_origin: string;
}

// ---- endpoints ----

export const api = {
  config: (server: string) =>
    request<ServerConfig>(server, 'GET', '/v1/config', null),
  emailStart: (server: string, email: string, inviteCode: string) =>
    request<{ok: true}>(server, 'POST', '/v1/auth/email/start', null, {
      email,
      invite_code: inviteCode,
    }),
  emailVerify: (server: string, email: string, code: string) =>
    request<VerifyResult>(server, 'POST', '/v1/auth/email/verify', null, {
      email,
      code,
    }),
  createAccount: (
    server: string,
    by: Signer,
    b: {
      ticket: string;
      box_pub: string;
      bundle: string;
      name: string;
    },
  ) => request<Me>(server, 'POST', '/v1/accounts', by, b),
  resetAccount: (
    server: string,
    by: Signer,
    b: {ticket: string; box_pub: string; bundle: string},
  ) => request<Me>(server, 'POST', '/v1/accounts/reset', by, b),

  me: (server: string, by: Signer) => request<Me>(server, 'GET', '/v1/me', by),
  setName: (server: string, by: Signer, name: string) =>
    request<Me>(server, 'PATCH', '/v1/me', by, {name}),
  putBundle: (server: string, by: Signer, bundle: string) =>
    request<void>(server, 'PUT', '/v1/me/bundle', by, {bundle}),
  putAvatar: (server: string, by: Signer, bytes: Uint8Array) =>
    putBytes(server, '/v1/me/avatar', by, bytes) as Promise<Me>,
  deleteAvatar: (server: string, by: Signer) =>
    request<Me>(server, 'DELETE', '/v1/me/avatar', by),
  deleteMe: (server: string, by: Signer) =>
    request<void>(server, 'DELETE', '/v1/me', by),
  avatarUrl: (server: string, user: string, blob: string) =>
    `${server}/v1/users/${user}/avatar?v=${blob}`,

  docs: (server: string, by: Signer) =>
    request<{docs: DocSummary[]}>(server, 'GET', '/v1/docs', by).then(
      r => r.docs,
    ),
  doc: (server: string, by: Signer, id: string) =>
    request<DocFull>(server, 'GET', `/v1/docs/${id}`, by),
  createDoc: (server: string, by: Signer, b: SaveBody) =>
    request<{id: string; version: number; updated_at: number}>(
      server,
      'POST',
      '/v1/docs',
      by,
      b,
    ),
  saveDoc: (server: string, by: Signer, id: string, b: SaveBody) =>
    request<{version: number; updated_at: number}>(
      server,
      'PUT',
      `/v1/docs/${id}`,
      by,
      b,
    ),
  rekey: (
    server: string,
    by: Signer,
    id: string,
    b: SaveBody & {keys: Record<string, string>; remove: string[]},
  ) =>
    request<{version: number; epoch: number; updated_at: number}>(
      server,
      'POST',
      `/v1/docs/${id}/rekey`,
      by,
      b,
    ),
  deleteDoc: (server: string, by: Signer, id: string) =>
    request<void>(server, 'DELETE', `/v1/docs/${id}`, by),
  /** Waiting check-ins are held up to 20s by the server. */
  live: (server: string, by: Signer, id: string, body: LiveReq) =>
    request<LiveResp>(
      server,
      'POST',
      `/v1/docs/${id}/live`,
      by,
      body,
      body.wait ? 35_000 : REQUEST_TIMEOUT_MS,
    ),

  /** This tab is closing the page: sent so it outlives the page. */
  liveLeave: (server: string, by: Signer, id: string, tab: string) =>
    request<void>(
      server,
      'POST',
      `/v1/docs/${id}/live`,
      by,
      {tab, since: 0, leaving: true},
      REQUEST_TIMEOUT_MS,
      true,
    ),

  leaveDoc: (server: string, by: Signer, id: string) =>
    request<void>(server, 'POST', `/v1/docs/${id}/leave`, by),
  acceptDoc: (server: string, by: Signer, id: string) =>
    request<void>(server, 'POST', `/v1/docs/${id}/accept`, by),

  share: (server: string, by: Signer, id: string, email: string, role: Role) =>
    request<{
      user?: {id: string; name: string; avatar: string | null; box_pub: string};
      pending?: Pending;
    }>(server, 'POST', `/v1/docs/${id}/share`, by, {email, role}),
  addMember: (
    server: string,
    by: Signer,
    id: string,
    b: {
      user_id: string;
      role?: Role;
      epoch: number;
      wrapped_key: string;
      pending_id?: string;
    },
  ) => request<void>(server, 'POST', `/v1/docs/${id}/members`, by, b),
  setRole: (server: string, by: Signer, id: string, user: string, role: Role) =>
    request<void>(server, 'PATCH', `/v1/docs/${id}/members/${user}`, by, {
      role,
    }),
  putMemberKey: (
    server: string,
    by: Signer,
    id: string,
    user: string,
    epoch: number,
    wrapped_key: string,
  ) =>
    request<void>(server, 'PUT', `/v1/docs/${id}/keys/${user}`, by, {
      epoch,
      wrapped_key,
    }),
  deletePending: (server: string, by: Signer, id: string, pending: string) =>
    request<void>(server, 'DELETE', `/v1/docs/${id}/pending/${pending}`, by),
  todo: (server: string, by: Signer) =>
    request<{todo: Todo[]}>(server, 'GET', '/v1/shares/todo', by).then(
      r => r.todo,
    ),

  links: (server: string, by: Signer, id: string) =>
    request<{links: ShareLinkInfo[]}>(
      server,
      'GET',
      `/v1/docs/${id}/links`,
      by,
    ).then(r => r.links),
  createLink: (
    server: string,
    by: Signer,
    id: string,
    b: {
      role: Role;
      link_pub: string;
      key_ct: string;
      epoch: number;
      expires_hours: number;
      max_uses: number;
    },
  ) => request<ShareLinkInfo>(server, 'POST', `/v1/docs/${id}/links`, by, b),
  revokeLink: (server: string, by: Signer, id: string, link: string) =>
    request<void>(server, 'DELETE', `/v1/docs/${id}/links/${link}`, by),
  previewLink: (server: string, link: string) =>
    request<{
      doc_id: string;
      role: Role;
      epoch: number;
      key_ct: string;
      head_ct: string;
      expires_at: number | null;
    }>(server, 'GET', `/v1/links/${link}`, null),
  joinLink: (
    server: string,
    by: Signer,
    link: string,
    proof: string,
    wrapped_key: string,
  ) =>
    request<{doc_id: string}>(server, 'POST', `/v1/links/${link}/join`, by, {
      proof,
      wrapped_key,
    }),

  uploadBlob: async (
    server: string,
    by: Signer,
    doc: string,
    sealed: Uint8Array,
    onProgress?: (f: number) => void,
  ): Promise<string> =>
    (await putBytes(server, `/v1/docs/${doc}/blobs`, by, sealed, onProgress))
      .id,
  downloadBlob: async (
    server: string,
    by: Signer,
    doc: string,
    blob: string,
  ): Promise<Uint8Array> => {
    const res = await xhr(server, 'GET', `/v1/docs/${doc}/blobs/${blob}`, by);
    if (res.status !== 200) throw new ApiError(res.status, 'download failed');
    return new Uint8Array(res.data as ArrayBuffer);
  },
};
