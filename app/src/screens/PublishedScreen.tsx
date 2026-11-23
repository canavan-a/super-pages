// A published page (/p/<slug>) as anyone sees it: no account, no keys of
// our own. The server hands out the page in the clear; images are still
// sealed blobs, opened with the keys in the page. It stays live by waiting
// on the server for each newer version. If the owner allows public edits,
// it's also a bare editor: what's typed is sent back as the page's shared
// state, merged with anyone else's (Yjs states always merge).
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Linking, StyleSheet, Text, View} from 'react-native';

import {api, ApiError} from '../api';
import {
  decodeBody,
  DocKind,
  encodeBody,
  newId,
  openBlob,
  parseImageUrl,
} from '../crypto';
import {DocEditor} from '../editor/DocEditor';
import type {DocEditorRef} from '../editor/types';
import {dataUri} from '../files';
import {sniffMime} from '../pagesStore';
import {Theme, useTheme} from '../theme';

/** The slug when the web app was opened at /p/<slug>, else null. */
export function publishedSlugFromLocation(): string | null {
  if (typeof location === 'undefined') return null;
  const m = /^\/p\/([a-z0-9-]{3,48})\/?$/.exec(location.pathname);
  return m ? m[1] : null;
}

interface Shown {
  title: string;
  markdown: string;
  y: string | null;
  kind: DocKind;
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

const RETRY_MS = 5000;
const SAVE_DELAY_MS = 1200;

export function PublishedScreen({slug}: {slug: string}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const server = typeof location !== 'undefined' ? location.origin : '';
  const reader = useRef({name: 'Guest', color: '#888888', tab: newId()});
  const [shown, setShown] = useState<Shown | null>(null);
  const [title, setTitle] = useState('');
  const [canEdit, setCanEdit] = useState(false);
  // Bumped to mount the editor afresh (a page with no shared state, or one
  // whose kind changed): its state can't just be merged in.
  const [mount, setMount] = useState(0);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const editor = useRef<DocEditorRef>(null);
  const current = useRef<Shown | null>(null);
  // The newest version of the public copy seen here: what a save starts from.
  const version = useRef(0);
  // Whether public edits were on when last heard, so a wait also ends when
  // the owner turns them on or off.
  const editRef = useRef<boolean | undefined>(undefined);

  /** Takes in a version of the page: merged into the editor, or a fresh mount. */
  const take = useCallback((body: string, t: string) => {
    const b = decodeBody(body);
    const next: Shown = {
      title: t,
      markdown: b.markdown,
      y: b.y ?? null,
      kind: b.kind ?? 'page',
    };
    const prev = current.current;
    current.current = next;
    setTitle(t);
    // Merge into what's open, never remount over it: that would drop what
    // was typed here and not sent yet. A page that had no shared state was
    // built from its markdown the same way everywhere (fixed client id), so
    // it merges too.
    if (prev && next.y && next.kind === prev.kind) {
      editor.current?.applyChanges([next.y]);
      return;
    }
    if (prev) setMount(m => m + 1);
    setShown(next);
  }, []);

  useEffect(() => {
    let stopped = false;
    (async () => {
      while (!stopped) {
        try {
          const first = !current.current;
          const p = await api.published(
            server,
            slug,
            first ? undefined : version.current,
            first ? undefined : editRef.current,
          );
          if (stopped) return;
          setError(null);
          setGone(false);
          editRef.current = p.public_edit;
          setCanEdit(p.public_edit);
          if (p.body !== undefined && p.version >= version.current) {
            version.current = p.version;
            take(p.body, p.title ?? '');
          }
        } catch (e) {
          if (stopped) return;
          if (e instanceof ApiError && e.status === 404) {
            setGone(true);
            current.current = null;
            version.current = 0;
            setShown(null);
          } else {
            setError((e as Error).message);
          }
          await new Promise(r => setTimeout(r, RETRY_MS));
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [server, slug, take]);

  // ---- saving public edits ----

  const edits = useRef(0);
  const savedEdits = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (saving.current || edits.current === savedEdits.current) return;
    const ed = editor.current;
    const kind = current.current?.kind ?? 'page';
    if (!ed) return;
    saving.current = true;
    setSaveState('saving');
    try {
      for (let tries = 0; ; tries++) {
        const n = edits.current;
        const snap = await ed.snapshot();
        try {
          const r = await api.putPublished(server, slug, {
            title: snap.title,
            body: encodeBody({markdown: snap.markdown, y: snap.y, kind}),
            base: version.current,
          });
          version.current = Math.max(version.current, r.version);
          savedEdits.current = n;
          break;
        } catch (e) {
          const cur = e instanceof ApiError && e.status === 409 ? e.body : null;
          if (!cur?.version || tries >= 4) throw e;
          // Someone else saved first: take theirs in and send the merge.
          const y = decodeBody(cur.body).y;
          if (y) ed.applyChanges([y]);
          version.current = cur.version;
        }
      }
      setSaveError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setCanEdit(false);
        setSaveError('The owner turned off editing here.');
      } else {
        setSaveError((e as Error).message);
      }
      setSaveState('error');
      saving.current = false;
      return;
    }
    saving.current = false;
    if (edits.current !== savedEdits.current) flush();
    else setSaveState('saved');
  }, [server, slug]);

  const onChange = useCallback(
    (_md: string, local: boolean) => {
      if (!local) return;
      edits.current++;
      setSaveState('dirty');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  // Closing the tab with something unsent: send it, and ask the browser to wait.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (edits.current !== savedEdits.current) {
        flush();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [flush]);

  // Nothing of the app around it: the page's title is the tab's, and only
  // the page is on screen.
  useEffect(() => {
    if (typeof document !== 'undefined') document.title = title || 'Untitled';
  }, [title]);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.textContent = PUBLIC_CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  const images = useRef(new Map<string, string>());
  const resolveImage = useCallback(
    async (url: string) => {
      const cached = images.current.get(url);
      if (cached) return cached;
      const ref = parseImageUrl(url);
      if (!ref) throw new Error('not an image link');
      const res = await fetch(api.publishedBlobUrl(server, slug, ref.blob));
      if (!res.ok) throw new Error('image not found');
      const bytes = openBlob(ref.key, new Uint8Array(await res.arrayBuffer()));
      const uri = dataUri(sniffMime(bytes), bytes);
      images.current.set(url, uri);
      return uri;
    },
    [server, slug],
  );

  const openLink = useCallback((href: string) => {
    if (/^(https?:|mailto:)/i.test(href)) Linking.openURL(href).catch(() => {});
  }, []);

  // Only while something is unsaved or went wrong, and quietly.
  const status = !canEdit
    ? null
    : saveState === 'error'
    ? saveError ?? 'Couldn’t save'
    : saveState === 'saved'
    ? null
    : 'Saving…';

  if (gone || (!shown && error)) {
    return (
      <View style={styles.center}>
        <Text style={styles.message}>
          {gone ? 'This page isn’t published.' : 'Couldn’t load this page.'}
        </Text>
      </View>
    );
  }
  if (!shown) return <View style={styles.container} />;
  return (
    <View style={styles.container}>
      <DocEditor
        key={mount}
        ref={editor}
        kind={shown.kind}
        markdown={shown.markdown}
        y={shown.y}
        title={shown.title}
        user={reader.current}
        readOnly={!canEdit}
        onChange={onChange}
        onTitle={setTitle}
        onLocalChange={() => {}}
        onAware={() => {}}
        onPickImage={() => {}}
        resolveImage={resolveImage}
        onOpenLink={openLink}
      />
      {status && (
        <Text
          style={[
            styles.status,
            saveState === 'error' && {color: theme.danger},
          ]}
          numberOfLines={1}>
          {status}
        </Text>
      )}
    </View>
  );
}

// Editing keeps the editor's usual toolbar, less the image button (and the
// divider before it): adding an image needs an account. Reading has no
// toolbar, so the text gets more room above it.
const PUBLIC_CSS = `
.sp-editor:not(.sp-canvas) .sp-toolbar button[aria-label="Insert image"],
.sp-editor:not(.sp-canvas) .sp-toolbar .sep:nth-last-child(2) { display:none; }
.sp-editor:not(.sp-canvas) .ProseMirror[contenteditable="false"] { padding-top:56px; }
`;

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {flex: 1, backgroundColor: theme.bg},
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      backgroundColor: theme.bg,
    },
    message: {fontSize: 15, color: theme.textMuted},
    status: {
      position: 'absolute',
      right: 14,
      bottom: 10,
      fontSize: 12,
      color: theme.textMuted,
      opacity: 0.7,
    },
  });
}
