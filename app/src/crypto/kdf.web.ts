// Key-file scrypt in the browser (see kdf.ts for Android). It runs in a Web
// Worker: @noble/hashes' scryptAsync only yields to microtasks, so on the main
// thread the page can't even paint its "Unlocking…" spinner until it's done.
import {scryptAsync} from '@noble/hashes/scrypt';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  dkLen: number;
}

export function scrypt(
  pass: Uint8Array,
  salt: Uint8Array,
  o: ScryptParams,
): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') return scryptAsync(pass, salt, o);
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./kdf.worker.ts', import.meta.url), {
      type: 'module',
    });
    w.onmessage = (e: MessageEvent<{key?: Uint8Array; error?: string}>) => {
      w.terminate();
      if (e.data.key) resolve(e.data.key);
      else reject(new Error(e.data.error ?? 'scrypt failed'));
    };
    w.onerror = e => {
      w.terminate();
      reject(new Error(e.message || 'scrypt failed'));
    };
    w.postMessage({pass, salt, o});
  });
}
