// The unlocked account, held in memory only: its keys, the server it lives
// on, and its profile once fetched.
import type {Me} from './api';
import {Account, accountFromEntropy} from './crypto';

export interface Session {
  server: string;
  account: Account;
  me: Me | null;
}

type Listener = (s: Session | null) => void;

let current: Session | null = null;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach(l => l(current));

export const session = {
  get: (): Session | null => current,
  require(): Session {
    if (!current) throw new Error('locked');
    return current;
  },
  unlock(server: string, entropy: Uint8Array, me: Me | null = null): Session {
    current = {server, account: accountFromEntropy(entropy), me};
    emit();
    return current;
  },
  setMe(me: Me): void {
    if (!current) return;
    current = {...current, me};
    emit();
  },
  /** Forget the keys entirely (sign out). */
  clear(): void {
    current = null;
    emit();
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
