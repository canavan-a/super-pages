// An account's secret is 32 bytes of entropy, made on the device that signs
// up. Its keys are derived from it: an Ed25519 key that signs every request
// and save, and an X25519 key documents' keys are sealed to. The 24-word
// recovery phrase is the entropy itself.
//
// Signing in is by email code, so the server keeps a copy of the entropy for
// new devices, but only as a bundle locked under the user's passphrase
// (scrypt + XChaCha20-Poly1305). The server can't open it; the passphrase
// never leaves the device.
import {
  entropyToMnemonic,
  mnemonicToEntropy,
  validateMnemonic,
} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english';
import {scrypt} from './kdf';

import {b64, keyIdFromPub, randomBytes, unb64, utf8} from './encoding';
import {aeadOpen, aeadSeal, edPublicKey, hkdf, xPublicKey} from './primitives';

/** The unlocked account's keys. */
export interface Account {
  entropy: Uint8Array;
  edSeed: Uint8Array;
  edPub: Uint8Array;
  xPriv: Uint8Array;
  xPub: Uint8Array;
  /** The signing key as X-SP-Key carries it. */
  keyId: string;
}

/** Anything that signs requests. */
export type Signer = Pick<Account, 'edSeed' | 'keyId'>;

export function accountFromEntropy(entropy: Uint8Array): Account {
  if (entropy.length !== 32) throw new Error('entropy must be 32 bytes');
  const edSeed = hkdf(entropy, 'sp-ed25519');
  const xPriv = hkdf(entropy, 'sp-x25519');
  const edPub = edPublicKey(edSeed);
  return {
    entropy,
    edSeed,
    edPub,
    xPriv,
    xPub: xPublicKey(xPriv),
    keyId: keyIdFromPub(edPub),
  };
}

export function newAccount(): Account {
  return accountFromEntropy(randomBytes(32));
}

export function phraseFromEntropy(entropy: Uint8Array): string[] {
  return entropyToMnemonic(entropy, wordlist).split(' ');
}

/** Accepts any spacing/case. Throws with a readable message. */
export function entropyFromPhrase(phrase: string): Uint8Array {
  const words = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  if (words.split(' ').length !== 24)
    throw new Error('A recovery phrase is 24 words.');
  const unknown = words.split(' ').filter(w => !wordlist.includes(w));
  if (unknown.length)
    throw new Error(`Not in the word list: ${unknown.join(', ')}`);
  if (!validateMnemonic(words, wordlist))
    throw new Error(
      "Those words don't check out. Look for a typo or a swapped word.",
    );
  return mnemonicToEntropy(words, wordlist);
}

export const WORDLIST = wordlist;

// ---- the locked bundle ----

// scrypt cost for the bundle. It's what makes guessing a passphrase from a
// stolen database slow: 2^16 is about a second natively (kdf.ts) or in a
// browser's worker (kdf.web.ts), and 64 MB of memory per guess.
const SCRYPT = {N: 1 << 16, r: 8, p: 1};

export const MIN_PASSPHRASE = 10;

interface Bundle {
  v: 1;
  kdf: 'scrypt';
  n: number;
  r: number;
  p: number;
  salt: string;
  ct: string;
}

const BUNDLE_AD = utf8('sp-bundle');

export async function lockBundle(
  entropy: Uint8Array,
  passphrase: string,
  cost = SCRYPT,
): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(utf8(passphrase), salt, {...cost, dkLen: 32});
  const bundle: Bundle = {
    v: 1,
    kdf: 'scrypt',
    n: cost.N,
    r: cost.r,
    p: cost.p,
    salt: b64(salt),
    ct: b64(aeadSeal(key, entropy, BUNDLE_AD)),
  };
  return JSON.stringify(bundle);
}

export class WrongPassphrase extends Error {
  constructor() {
    super("That passphrase doesn't unlock this account.");
  }
}

/** Opens a bundle. Throws WrongPassphrase if the passphrase is wrong. */
export async function openBundle(
  json: string,
  passphrase: string,
): Promise<Uint8Array> {
  let b: Bundle;
  try {
    b = JSON.parse(json);
  } catch {
    throw new Error('This account’s key looks damaged.');
  }
  if (
    b?.v !== 1 ||
    b.kdf !== 'scrypt' ||
    !(b.n > 0) ||
    b.n > 1 << 20 ||
    b.r > 16 ||
    b.p > 4
  ) {
    throw new Error('This account’s key looks damaged.');
  }
  const key = await scrypt(utf8(passphrase), unb64(b.salt), {
    N: b.n,
    r: b.r,
    p: b.p,
    dkLen: 32,
  });
  try {
    return aeadOpen(key, unb64(b.ct), BUNDLE_AD);
  } catch {
    throw new WrongPassphrase();
  }
}

/** A rough passphrase strength for the meter: 0 (weak) to 4 (strong). */
export function passphraseStrength(p: string): number {
  if (p.length < MIN_PASSPHRASE) return 0;
  let classes = 0;
  if (/[a-z]/.test(p)) classes++;
  if (/[A-Z]/.test(p)) classes++;
  if (/[0-9]/.test(p)) classes++;
  if (/[^a-zA-Z0-9]/.test(p)) classes++;
  const words = p.trim().split(/\s+/).length;
  let score = 1;
  if (p.length >= 14) score++;
  if (p.length >= 20 || words >= 4) score++;
  if (classes >= 3) score++;
  return Math.min(4, score);
}
