// One open page's live connection (server/api/live.go): it says this tab is
// here, sends what's typed and where the cursor is, and hears the same from
// every other tab with the page open, all sealed under the page's key. The
// server holds a check-in with nothing new for up to 20s, so changes arrive
// as soon as they're sent without polling hard.
import {api, LiveResp} from './api';
import {openLive, sealLive} from './crypto';
import {session} from './session';

export interface Viewer {
  user: string;
  tab: string;
  /** Their cursor (an awareness update), opened; null if none or unreadable. */
  aware: Uint8Array | null;
}

export interface LiveOptions {
  doc: string;
  key: Uint8Array;
  epoch: number;
  tab: string;
  /** Others' changes, opened, in order. */
  onChanges: (changes: Uint8Array[]) => void;
  onViewers: (viewers: Viewer[]) => void;
  /** The page's saved version and key now; a new key means reopen the page. */
  onSaved: (version: number, epoch: number) => void;
  /** Changes were missed (the buffer moved on): merge the saved page in again. */
  onReset: () => void;
}

export interface Live {
  send(change: Uint8Array): void;
  setAware(aware: Uint8Array): void;
  stop(): void;
}

/** How long sends wait to gather keystrokes into one check-in. */
const BATCH_MS = 80;
const RETRY_MS = 3000;

export function startLive(o: LiveOptions): Live {
  const s = session.require();
  let stopped = false;
  let since = -1;
  let gen = 0;
  let aware: string | undefined;
  let queue: string[] = [];
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let sending = false;
  let dirtyAware = false;

  const take = (r: LiveResp) => {
    if (stopped) return;
    if (r.reset) {
      since = r.seq;
      o.onReset();
    } else {
      const changes: Uint8Array[] = [];
      for (const m of r.msgs) {
        if (m.seq <= since) continue;
        try {
          changes.push(openLive(o.key, o.doc, o.epoch, m.data));
        } catch {
          // sealed under another key (just rekeyed): onSaved reopens
        }
      }
      // Every change after since came back (but this tab's own), so the
      // tab is now up to the server's newest.
      since = Math.max(since, r.seq);
      if (changes.length) o.onChanges(changes);
    }
    gen = r.gen;
    o.onViewers(
      r.viewers.map(v => {
        let a: Uint8Array | null = null;
        if (v.aware) {
          try {
            a = openLive(o.key, o.doc, o.epoch, v.aware);
          } catch {
            a = null;
          }
        }
        return {user: v.user, tab: v.tab, aware: a};
      }),
    );
    o.onSaved(r.version, r.epoch);
  };

  // The waiting loop: one check-in in flight at a time, held by the server
  // until something happens.
  (async () => {
    let wait = false;
    while (!stopped) {
      try {
        const r = await api.live(s.server, s.account, o.doc, {
          tab: o.tab,
          since,
          gen,
          wait,
          aware,
        });
        take(r);
        wait = true;
      } catch {
        if (stopped) return;
        wait = false;
        await new Promise(res => setTimeout(res, RETRY_MS));
      }
    }
  })();

  const flush = async () => {
    sendTimer = null;
    if (sending || stopped) return;
    if (!queue.length && !dirtyAware) return;
    sending = true;
    const batch = queue.slice(0, 64);
    dirtyAware = false;
    try {
      const r = await api.live(s.server, s.account, o.doc, {
        tab: o.tab,
        since: since < 0 ? -1 : since,
        aware,
        updates: batch.length ? batch : undefined,
      });
      queue = queue.slice(batch.length);
      take(r);
    } catch {
      // Keep the changes; they go with the next try.
      dirtyAware = true;
      sending = false;
      if (!stopped) sendTimer = setTimeout(flush, RETRY_MS);
      return;
    }
    sending = false;
    if (queue.length || dirtyAware) schedule();
  };
  const schedule = () => {
    if (!sendTimer && !stopped) sendTimer = setTimeout(flush, BATCH_MS);
  };

  // Closing the tab or browser: say so, so the others see it go at once.
  // (A tab that just vanishes drops off the list after 30s.)
  const leave = () =>
    api.liveLeave(s.server, s.account, o.doc, o.tab).catch(() => {});
  const canListen =
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function';
  if (canListen) window.addEventListener('pagehide', leave);

  return {
    send(change) {
      queue.push(sealLive(o.key, o.doc, o.epoch, change));
      schedule();
    },
    setAware(a) {
      aware = sealLive(o.key, o.doc, o.epoch, a);
      dirtyAware = true;
      schedule();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (sendTimer) clearTimeout(sendTimer);
      if (canListen) window.removeEventListener('pagehide', leave);
      leave();
    },
  };
}

/**
 * A person's color: their cursors (in every tab they have open), and the
 * ring around their faces in the top bar.
 */
const USER_COLORS = [
  '#e5484d',
  '#f76b15',
  '#ffb224',
  '#30a46c',
  '#12a594',
  '#0090ff',
  '#3e63dd',
  '#8e4ec6',
  '#d6409f',
  '#a18072',
];

export function colorForUser(user: string): string {
  let h = 0;
  for (let i = 0; i < user.length; i++) h = (h * 31 + user.charCodeAt(i)) >>> 0;
  return USER_COLORS[h % USER_COLORS.length];
}
