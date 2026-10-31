// Key-file scrypt. On Android and iOS it runs natively off the JS thread
// (Scrypt.java, ScryptModule.m): in Hermes the key file's 2^15 cost took
// seconds and froze every button, spinner included, while it ran. Same algorithm and output either way, so existing key files
// open unchanged. Falls back to @noble/hashes where the module isn't there
// (tests; kdf.web.ts covers the browser).
import {NativeModules} from 'react-native';
import {scryptAsync} from '@noble/hashes/scrypt';
import {base64} from '@scure/base';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  dkLen: number;
}

interface ScryptNative {
  derive(
    pass: string,
    salt: string,
    n: number,
    r: number,
    p: number,
    dkLen: number,
  ): Promise<string>;
}
const Native = NativeModules.Scrypt as ScryptNative | undefined;

export async function scrypt(
  pass: Uint8Array,
  salt: Uint8Array,
  o: ScryptParams,
): Promise<Uint8Array> {
  if (Native)
    return base64.decode(
      await Native.derive(
        base64.encode(pass),
        base64.encode(salt),
        o.N,
        o.r,
        o.p,
        o.dkLen,
      ),
    );
  return scryptAsync(pass, salt, o);
}
