// Document encryption (docs/protocol.md, "Documents"). Every document has a
// random 32-byte key per epoch, sealed to each member's X25519 key. Its head
// ({title, snippet}, for the grid) and body (markdown) are sealed under it,
// bound to the document and epoch. Images are sealed under their own keys,
// which live inside the body, so they're only as readable as the body.
import {sha256} from '@noble/hashes/sha256';

import {Account} from './identity';
import {b64, bytesToHex, randomBytes, unb64, unutf8, utf8} from './encoding';
import {
  aeadOpen,
  aeadSeal,
  edPublicKey,
  hkdf,
  seal,
  sign,
  unseal,
  verify,
} from './primitives';

export interface DocHead {
  title: string;
  snippet: string;
}

export const newDocKey = (): Uint8Array => randomBytes(32);

const keyAd = (doc: string) => utf8(`sp-dockey|${doc}`);
const headAd = (doc: string, epoch: number) => utf8(`sp-head|${doc}|${epoch}`);
const bodyAd = (doc: string, epoch: number) => utf8(`sp-body|${doc}|${epoch}`);

/** The document key sealed to a member's box key (b64). */
export function wrapDocKey(
  key: Uint8Array,
  boxPub: string,
  doc: string,
): string {
  return b64(seal(unb64(boxPub), key, keyAd(doc)));
}

export function unwrapDocKey(
  me: Account,
  wrapped: string,
  doc: string,
): Uint8Array {
  return unseal(me.xPriv, unb64(wrapped), keyAd(doc), me.xPub);
}

export function sealHead(
  key: Uint8Array,
  doc: string,
  epoch: number,
  head: DocHead,
): string {
  return b64(aeadSeal(key, utf8(JSON.stringify(head)), headAd(doc, epoch)));
}

export function openHead(
  key: Uint8Array,
  doc: string,
  epoch: number,
  ct: string,
): DocHead {
  const h = JSON.parse(unutf8(aeadOpen(key, unb64(ct), headAd(doc, epoch))));
  return {title: String(h?.title ?? ''), snippet: String(h?.snippet ?? '')};
}

export function sealBody(
  key: Uint8Array,
  doc: string,
  epoch: number,
  markdown: string,
): string {
  return b64(aeadSeal(key, utf8(markdown), bodyAd(doc, epoch)));
}

export function openBody(
  key: Uint8Array,
  doc: string,
  epoch: number,
  ct: string,
): string {
  return unutf8(aeadOpen(key, unb64(ct), bodyAd(doc, epoch)));
}

/** What a save signs; server/proto.DocSigningString must match. */
export function docSigningString(
  doc: string,
  version: number,
  epoch: number,
  head: string,
  body: string,
): Uint8Array {
  return utf8(
    `${doc}|${version}|${epoch}|${bytesToHex(sha256(utf8(head)))}|${bytesToHex(
      sha256(utf8(body)),
    )}`,
  );
}

export function signSave(
  me: Account,
  doc: string,
  version: number,
  epoch: number,
  head: string,
  body: string,
): string {
  return b64(
    sign(
      me.edSeed,
      'sp-doc',
      docSigningString(doc, version, epoch, head, body),
    ),
  );
}

export function verifySave(
  signPub: Uint8Array,
  doc: string,
  version: number,
  epoch: number,
  head: string,
  body: string,
  sig: string,
): boolean {
  try {
    return verify(
      signPub,
      'sp-doc',
      docSigningString(doc, version, epoch, head, body),
      unb64(sig),
    );
  } catch {
    return false;
  }
}

// ---- head from markdown ----

/** Plain text of a markdown line: formatting marks and image links dropped. */
export function plainText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]\s+\[[ xX]\]|[-*+]|\d+[.)])\s*/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/** The title (first non-empty line) and the snippet (what follows) the grid shows. */
export function headFromMarkdown(md: string): DocHead {
  const lines = md
    .split('\n')
    .map(plainText)
    .filter(l => l.length > 0);
  const title = (lines[0] ?? '').slice(0, 120);
  const snippet = lines.slice(1).join(' ').replace(/\s+/g, ' ').slice(0, 280);
  return {title, snippet};
}

// ---- images ----

const BLOB_AD = utf8('sp-blob');

/** Seals an image under a fresh key. The key goes in the document body. */
export function sealBlob(bytes: Uint8Array): {key: string; sealed: Uint8Array} {
  const key = randomBytes(32);
  return {key: b64(key), sealed: aeadSeal(key, bytes, BLOB_AD)};
}

export function openBlob(key: string, sealed: Uint8Array): Uint8Array {
  return aeadOpen(unb64(key), sealed, BLOB_AD);
}

/** sp-img:<blob>#<key>: how an image is written in a document's markdown. */
export function imageUrl(blob: string, key: string): string {
  return `sp-img:${blob}#${key}`;
}

export function parseImageUrl(url: string): {blob: string; key: string} | null {
  const m = /^sp-img:([A-Za-z0-9_-]{22})#([A-Za-z0-9_-]{43})$/.exec(url);
  return m ? {blob: m[1], key: m[2]} : null;
}

// ---- share links ----

/** Keys derived from a share link's secret: one signs joins, one seals the doc key. */
export function linkKeys(secret: Uint8Array): {
  edSeed: Uint8Array;
  edPub: Uint8Array;
  encKey: Uint8Array;
} {
  const edSeed = hkdf(secret, 'sp-link-sign');
  return {edSeed, edPub: edPublicKey(edSeed), encKey: hkdf(secret, 'sp-link')};
}

export function sealLinkKey(
  secret: Uint8Array,
  doc: string,
  key: Uint8Array,
): string {
  return b64(aeadSeal(linkKeys(secret).encKey, key, utf8(`sp-linkkey|${doc}`)));
}

export function openLinkKey(
  secret: Uint8Array,
  doc: string,
  ct: string,
): Uint8Array {
  return aeadOpen(
    linkKeys(secret).encKey,
    unb64(ct),
    utf8(`sp-linkkey|${doc}`),
  );
}

/** Proof that whoever is joining holds the link's secret (server/proto.JoinSigningString). */
export function joinProof(
  secret: Uint8Array,
  link: string,
  doc: string,
  user: string,
): string {
  return b64(
    sign(linkKeys(secret).edSeed, 'sp-join', utf8(`${link}|${doc}|${user}`)),
  );
}

export function formatShareLink(
  origin: string,
  link: string,
  secret: Uint8Array,
): string {
  return `${origin.replace(/\/+$/, '')}/s/${link}#${b64(secret)}`;
}

/** Reads https://host/s/<id>#<secret> or superpages://share?s=…&l=…&k=…. */
export function parseShareLink(
  url: string,
): {server: string; link: string; secret: Uint8Array} | null {
  try {
    const web =
      /^(https?:\/\/[^/]+)\/s\/([A-Za-z0-9_-]{22})#([A-Za-z0-9_-]{43})$/.exec(
        url.trim(),
      );
    if (web) return {server: web[1], link: web[2], secret: unb64(web[3])};
    const app = /^superpages:\/\/share\?(.*)$/.exec(url.trim());
    if (app) {
      const q = new Map(
        app[1]
          .split('&')
          .map(kv => kv.split('=').map(decodeURIComponent) as [string, string]),
      );
      const server = q.get('s');
      const link = q.get('l');
      const k = q.get('k');
      if (server && link && k && /^https?:\/\//.test(server)) {
        const secret = unb64(k);
        if (secret.length === 32) return {server, link, secret};
      }
    }
  } catch {
    // not a link
  }
  return null;
}
