// The browser has no hardware keystore. "Remember this browser" keeps the
// entropy in IndexedDB sealed under a WebCrypto AES-GCM key that is itself
// stored there as non-extractable: script on this page can use it, but not
// read it out, so a copied profile folder or a leaked backup of the site's
// storage doesn't carry a usable key. Without "remember", nothing is
// stored: the key lives in this tab's memory (session.ts) until it closes.
import {b64, unb64, unutf8, utf8} from './crypto';

export type LockMode = 'biometric' | 'none';

export interface Stored {
  server: string;
  entropy: Uint8Array;
}

const DB = 'superpages';
const STORE = 'kv';
const ITEM = 'identity.v1';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => {
      d.close();
      resolve(req.result);
    };
    t.onerror = () => {
      d.close();
      reject(t.error);
    };
  });
}

interface Sealed {
  key: CryptoKey;
  iv: Uint8Array;
  ct: ArrayBuffer;
}

export async function hasStoredIdentity(): Promise<boolean> {
  try {
    return !!(await tx<Sealed | undefined>('readonly', s => s.get(ITEM)));
  } catch {
    return false;
  }
}

export async function storeIdentity(
  server: string,
  entropy: Uint8Array,
  remember = true,
): Promise<LockMode> {
  await forgetIdentity();
  if (!remember) return 'none';
  const key = await crypto.subtle.generateKey(
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv},
    key,
    utf8(JSON.stringify({server, entropy: b64(entropy)})),
  );
  await tx('readwrite', s => s.put({key, iv, ct} satisfies Sealed, ITEM));
  return 'none';
}

export async function lockMode(): Promise<LockMode> {
  return 'none';
}

export async function loadIdentity(): Promise<Stored | null> {
  try {
    const sealed = await tx<Sealed | undefined>('readonly', s => s.get(ITEM));
    if (!sealed) return null;
    const plain = await crypto.subtle.decrypt(
      {name: 'AES-GCM', iv: sealed.iv},
      sealed.key,
      sealed.ct,
    );
    const {server, entropy} = JSON.parse(unutf8(new Uint8Array(plain)));
    return {server, entropy: unb64(entropy)};
  } catch {
    return null;
  }
}

export async function forgetIdentity(): Promise<void> {
  try {
    await tx('readwrite', s => s.delete(ITEM));
  } catch {
    // nothing stored
  }
}

/** The browser opens straight in; the remembered key needs no prompt. */
export const HAS_LOCK = false;
/** Ask at sign-in whether to remember this browser. */
export const ASK_REMEMBER = true;
