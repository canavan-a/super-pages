import AsyncStorage from '@react-native-async-storage/async-storage';
import {Platform} from 'react-native';

// Everyone's default server. Anyone can run their own and pick it when
// signing in (Advanced); an account lives on one server.
export const DEFAULT_SERVER = 'https://pages.superbadger.io';

const STORAGE_KEY = 'superpages.settings.v1';

export interface Settings {
  // The server picked at the last sign-in, offered again next time.
  lastServer: string;
  // See src/theme.tsx for the palettes.
  themeName: 'light' | 'dark' | 'slate' | 'sepia' | 'ember';
  // Minutes in the background before the app asks for biometrics again
  // (phones). 0 = every time it's reopened.
  lockAfterMin: number;
  // Android-only: switch the launcher icon to the one matching the current
  // theme (see src/appIcon.ts).
  themedIcon: boolean;
  // Play the animated launch splash.
  launchSplash: boolean;
  // Crash-loop protection for the splash: a launch counts as a strike before
  // the animation starts and is cleared when it finishes. After
  // MAX_SPLASH_STRIKES in a row the splash turns itself off.
  splashStrikes: number;
  splashAutoDisabled: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  lastServer: DEFAULT_SERVER,
  themeName: 'dark',
  lockAfterMin: 5,
  themedIcon: true,
  launchSplash: true,
  splashStrikes: 0,
  splashAutoDisabled: false,
};

type Listener = (settings: Settings) => void;

let current: Settings = DEFAULT_SETTINGS;
let loaded = false;
const listeners = new Set<Listener>();

async function load(): Promise<Settings> {
  if (loaded) {
    return current;
  }
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) current = {...DEFAULT_SETTINGS, ...JSON.parse(raw)};
  } catch {
    // fall back to defaults — a corrupt/missing value shouldn't crash startup
  }
  loaded = true;
  return current;
}

async function save(next: Settings): Promise<void> {
  current = next;
  listeners.forEach(l => l(current));
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort persistence; the in-memory value above is still updated
  }
}

async function update(patch: Partial<Settings>): Promise<void> {
  await save({...current, ...patch});
}

export const settingsStore = {
  get: (): Settings => current,
  load,
  save,
  update,
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function normalizeServer(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//.test(u)) u = `https://${u}`;
  return u;
}

/**
 * The server a web build talks to by default: its own origin when it's
 * served by a Super Pages server (the usual case), else DEFAULT_SERVER.
 */
export function homeServer(): string {
  if (
    Platform.OS === 'web' &&
    typeof location !== 'undefined' &&
    /^https?:$/.test(location.protocol)
  ) {
    const port = location.port;
    // The Vite dev server (5173) talks to the dev API instead.
    if (port === '5173') return 'http://127.0.0.1:8080';
    return location.origin;
  }
  return DEFAULT_SERVER;
}
