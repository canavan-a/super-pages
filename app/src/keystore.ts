// Where the account's entropy lives on a phone: the Android Keystore via
// react-native-keychain, behind the device's biometrics or screen-lock PIN.
// The server it belongs to is kept with it. Every key is derived from it.
import * as Keychain from 'react-native-keychain';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {b64, unb64} from './crypto';

const SERVICE = 'superpages.identity.v1';
const MODE_KEY = 'superpages.keystore.mode';

/** 'biometric': needs biometrics or the screen-lock PIN to open. 'none': the
 * device has no screen lock, so the Keystore can't require one. */
export type LockMode = 'biometric' | 'none';

export interface Stored {
  server: string;
  entropy: Uint8Array;
}

export async function hasStoredIdentity(): Promise<boolean> {
  const services = await Keychain.getAllGenericPasswordServices().catch(
    () => [] as string[],
  );
  return services.includes(SERVICE);
}

/** remember is for the browser (keystore.web.ts); a phone always remembers. */
export async function storeIdentity(
  server: string,
  entropy: Uint8Array,
  _remember = true,
): Promise<LockMode> {
  await Keychain.resetGenericPassword({service: SERVICE}).catch(() => {});
  try {
    const ok = await Keychain.setGenericPassword(server, b64(entropy), {
      service: SERVICE,
      accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      storage: Keychain.STORAGE_TYPE.RSA,
      securityLevel: Keychain.SECURITY_LEVEL.ANY,
    });
    if (ok) {
      await AsyncStorage.setItem(MODE_KEY, 'biometric');
      return 'biometric';
    }
  } catch {
    // No biometrics or screen lock set up: fall through.
  }
  await Keychain.setGenericPassword(server, b64(entropy), {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    storage: Keychain.STORAGE_TYPE.AES,
  });
  await AsyncStorage.setItem(MODE_KEY, 'none');
  return 'none';
}

export async function lockMode(): Promise<LockMode> {
  return ((await AsyncStorage.getItem(MODE_KEY)) as LockMode) ?? 'biometric';
}

/** Prompts for biometrics/PIN (if the key needs it). Null if cancelled. */
export async function loadIdentity(): Promise<Stored | null> {
  const creds = await Keychain.getGenericPassword({
    service: SERVICE,
    authenticationPrompt: {title: 'Unlock Super Pages', cancel: 'Cancel'},
  });
  if (!creds) return null;
  return {server: creds.username, entropy: unb64(creds.password)};
}

export async function forgetIdentity(): Promise<void> {
  await Keychain.resetGenericPassword({service: SERVICE});
  await AsyncStorage.removeItem(MODE_KEY);
}

/** Phones show a lock screen (biometrics) when the app comes back. */
export const HAS_LOCK = true;
/** Phones always keep the key; the browser asks. */
export const ASK_REMEMBER = false;
