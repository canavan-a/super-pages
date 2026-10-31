// Byte helpers shared by the crypto modules. Everything that goes over the
// wire is unpadded base64url ("b64"); key IDs are lowercase base32 of an
// account's Ed25519 public key (see docs/protocol.md).
import {base32nopad, base64urlnopad} from '@scure/base';
import {bytesToHex, randomBytes, utf8ToBytes} from '@noble/hashes/utils';

export const b64 = (bytes: Uint8Array): string => base64urlnopad.encode(bytes);
export const unb64 = (s: string): Uint8Array => base64urlnopad.decode(s);

export const utf8 = (s: string): Uint8Array => utf8ToBytes(s);

// Hermes has TextEncoder but not TextDecoder, so decoding is done by hand.
export function unutf8(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i++];
    let cp: number;
    if (c < 0x80) {
      cp = c;
    } else if (c < 0xe0) {
      cp = ((c & 0x1f) << 6) | (b[i++] & 0x3f);
    } else if (c < 0xf0) {
      cp = ((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
    } else {
      cp =
        ((c & 0x07) << 18) |
        ((b[i++] & 0x3f) << 12) |
        ((b[i++] & 0x3f) << 6) |
        (b[i++] & 0x3f);
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function keyIdFromPub(pub: Uint8Array): string {
  return base32nopad.encode(pub).toLowerCase();
}

export function pubFromKeyId(id: string): Uint8Array {
  if (id.length !== 52 || id !== id.toLowerCase())
    throw new Error('bad key id');
  const pub = base32nopad.decode(id.toUpperCase());
  if (pub.length !== 32) throw new Error('bad key id');
  return pub;
}

export const newId = (): string => b64(randomBytes(16));

export function isId(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try {
    return unb64(s).length === 16;
  } catch {
    return false;
  }
}

export {bytesToHex, randomBytes};
