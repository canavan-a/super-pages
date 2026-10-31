// Runs key-file scrypt for kdf.web.ts off the page's main thread.
import {scrypt} from '@noble/hashes/scrypt';

self.onmessage = (
  e: MessageEvent<{
    pass: Uint8Array;
    salt: Uint8Array;
    o: {N: number; r: number; p: number; dkLen: number};
  }>,
) => {
  try {
    const {pass, salt, o} = e.data;
    self.postMessage({key: scrypt(pass, salt, o)});
  } catch (err) {
    self.postMessage({error: (err as Error).message});
  }
};
