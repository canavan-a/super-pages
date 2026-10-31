// The handful of primitives everything else is built from (docs/protocol.md):
// Ed25519 signatures, X25519 + HKDF sealing, and XChaCha20-Poly1305.
import {ed25519, x25519} from '@noble/curves/ed25519';
import {xchacha20poly1305} from '@noble/ciphers/chacha';
import {hkdf as nobleHkdf} from '@noble/hashes/hkdf';
import {sha256} from '@noble/hashes/sha256';

import {concat, randomBytes, utf8} from './encoding';

export const SALT = utf8('superpages/v1');

export function hkdf(
  ikm: Uint8Array,
  info: string,
  salt: Uint8Array = SALT,
  len = 32,
): Uint8Array {
  return nobleHkdf(sha256, ikm, salt, utf8(info), len);
}

export {sha256};

/** nonce(24) ‖ XChaCha20-Poly1305(key, nonce, plaintext, ad) */
export function aeadSeal(
  key: Uint8Array,
  plaintext: Uint8Array,
  ad: Uint8Array,
): Uint8Array {
  const nonce = randomBytes(24);
  return concat(nonce, xchacha20poly1305(key, nonce, ad).encrypt(plaintext));
}

/** Throws if the ciphertext or its associated data was tampered with. */
export function aeadOpen(
  key: Uint8Array,
  sealed: Uint8Array,
  ad: Uint8Array,
): Uint8Array {
  if (sealed.length < 24 + 16) throw new Error('ciphertext too short');
  return xchacha20poly1305(key, sealed.subarray(0, 24), ad).decrypt(
    sealed.subarray(24),
  );
}

/** Seal msg to an X25519 public key with a one-off ephemeral key. */
export function seal(
  recipientXPub: Uint8Array,
  msg: Uint8Array,
  ad: Uint8Array,
): Uint8Array {
  const ephPriv = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const key = hkdf(
    x25519.getSharedSecret(ephPriv, recipientXPub),
    'sp-seal-v1',
    concat(ephPub, recipientXPub),
  );
  return concat(ephPub, aeadSeal(key, msg, ad));
}

/** myPub: xPriv's public key, when the caller has it (it saves an X25519 multiplication). */
export function unseal(
  xPriv: Uint8Array,
  sealed: Uint8Array,
  ad: Uint8Array,
  myPub = x25519.getPublicKey(xPriv),
): Uint8Array {
  const ephPub = sealed.subarray(0, 32);
  const key = hkdf(
    x25519.getSharedSecret(xPriv, ephPub),
    'sp-seal-v1',
    concat(ephPub, myPub),
  );
  return aeadOpen(key, sealed.subarray(32), ad);
}

export function sign(
  edSeed: Uint8Array,
  domain: string,
  msg: Uint8Array,
): Uint8Array {
  return ed25519.sign(concat(utf8(domain), msg), edSeed);
}

export function verify(
  pub: Uint8Array,
  domain: string,
  msg: Uint8Array,
  sig: Uint8Array,
): boolean {
  try {
    // zip215 off: the same strict RFC 8032 rules as Go's crypto/ed25519, so
    // the server and every client accept exactly the same signatures.
    return ed25519.verify(sig, concat(utf8(domain), msg), pub, {zip215: false});
  } catch {
    return false;
  }
}

export const edPublicKey = (seed: Uint8Array): Uint8Array =>
  ed25519.getPublicKey(seed);
export const xPublicKey = (priv: Uint8Array): Uint8Array =>
  x25519.getPublicKey(priv);
