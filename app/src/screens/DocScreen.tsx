import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AppState, Pressable, StyleSheet, Text, View} from 'react-native';

import type {HeaderInfo, HeaderViewer} from '../App';
import {Notice} from '../components/Notice';
import {TypingDots} from '../components/TypingDots';
import {b64, newId, unb64} from '../crypto';
import {DocEditor} from '../editor/DocEditor';
import type {DocEditorRef} from '../editor/types';
import {pickImages} from '../files';
import {colorForUser, Live, startLive, Viewer} from '../live';
import {
  ConflictError,
  LockedError,
  loadImage,
  openDoc,
  OpenDoc,
  saveDoc,
  uploadImage,
} from '../pagesStore';
import type {Route} from '../routes';
import {session} from '../session';
import {Theme, useTheme} from '../theme';
import {roleLabel} from '../components/RolePicker';

/** How long typing has to pause before the page is saved. */
const SAVE_DELAY_MS = 1200;
const MAX_IMAGE_BYTES = 15 << 20;

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

/**
 * One page, open for reading or editing with whoever else has it open:
 * their changes and cursors arrive live (live.ts), and it saves as you type.
 * Saves merge: if someone else saved first, their saved state is merged into
 * this one and the save goes again.
 */
export function DocScreen({
  id,
  fresh,
  onNavigate,
  onHeaderChange,
}: {
  id: string;
  fresh?: boolean;
  onNavigate: (r: Route) => void;
  onHeaderChange: (h: HeaderInfo | null) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [opened, setOpened] = useState<OpenDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  // Bumped to remount the editor with fresh content (after a reload).
  const [generation, setGeneration] = useState(0);
  const editor = useRef<DocEditorRef>(null);

  // This open copy of the page, to the others: its id, and your name and
  // color (the same in every tab you have open).
  const tab = useRef(newId()).current;
  const me = session.get()?.me;
  const user = useMemo(
    () => ({
      name: me?.name || 'Someone',
      color: colorForUser(me?.id ?? ''),
      tab,
    }),
    [me?.name, me?.id, tab],
  );
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const live = useRef<Live | null>(null);

  // Edits made here, and how many of them are saved.
  const edits = useRef(0);
  const savedEdits = useRef(0);
  // The title, kept apart from the text and edited in the top bar.
  const [title, setTitle] = useState('');
  const base = useRef({version: 0, epoch: 0});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const o = await openDoc(id);
      edits.current = savedEdits.current = 0;
      setTitle(o.title);
      base.current = {version: o.doc.version, epoch: o.doc.epoch};
      setOpened(o);
      setSaveState('saved');
      setGeneration(g => g + 1);
    } catch (e) {
      setLoadError(
        e instanceof LockedError
          ? e.message
          : `Couldn't open this page: ${(e as Error).message}`,
      );
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  /** Saves, merging in whatever someone else saved first. */
  const flush = useCallback(
    async (force = false): Promise<void> => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (inFlight.current) await inFlight.current;
      if (!opened || (!force && edits.current === savedEdits.current)) return;
      setSaveState('saving');
      inFlight.current = (async () => {
        try {
          for (let tries = 0; ; tries++) {
            const n = edits.current;
            const snap = await editor.current!.snapshot();
            try {
              const v = await saveDoc(
                id,
                base.current.version,
                base.current.epoch,
                opened.key,
                snap.markdown,
                snap.title,
                snap.y,
              );
              base.current.version = v;
              savedEdits.current = n;
              break;
            } catch (e) {
              if (!(e instanceof ConflictError) || tries >= 3) throw e;
              const o = await openDoc(id);
              if (o.doc.epoch !== base.current.epoch) {
                // A new key: start again from the page under it. What was
                // typed here reached the others live already.
                load();
                return;
              }
              if (!o.y) throw e; // saved by an app without live editing
              editor.current!.applyChanges([o.y]);
              base.current.version = o.doc.version;
            }
          }
          setSaveError(null);
          setSaveState(
            edits.current === savedEdits.current ? 'saved' : 'dirty',
          );
        } catch (e) {
          if (e instanceof ConflictError) {
            setSaveState('conflict');
          } else {
            setSaveState('error');
            setSaveError((e as Error).message);
          }
        }
      })();
      await inFlight.current;
      inFlight.current = null;
    },
    [id, opened, load],
  );

  const edited = useCallback(() => {
    edits.current++;
    setSaveState(s => (s === 'conflict' ? s : 'dirty'));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      flush();
    }, SAVE_DELAY_MS);
  }, [flush]);

  const onChange = useCallback(
    (_md: string, local: boolean) => {
      if (local) edited();
    },
    [edited],
  );

  const onRename = useCallback(
    (t: string) => {
      setTitle(t);
      editor.current?.setTitle(t);
      edited();
    },
    [edited],
  );

  // The live connection, for as long as this copy of the page is open.
  useEffect(() => {
    if (!opened) return;
    const l = startLive({
      doc: id,
      key: opened.key,
      epoch: opened.doc.epoch,
      tab,
      onChanges: changes => editor.current?.applyChanges(changes.map(b64)),
      onViewers: vs => {
        setViewers(vs);
        editor.current?.setPeers(
          vs
            .filter(v => v.tab !== tab)
            .map(v => ({tab: v.tab, aware: v.aware ? b64(v.aware) : null})),
        );
      },
      onSaved: (_version, epoch) => {
        if (epoch > base.current.epoch) flush().then(load);
      },
      onReset: () => {
        openDoc(id)
          .then(o => o.y && editor.current?.applyChanges([o.y]))
          .catch(() => {});
      },
    });
    live.current = l;
    return () => {
      l.stop();
      live.current = null;
    };
    // flush and load change with opened; the session follows opened alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, generation, id, tab]);

  const onLocalChange = useCallback(
    (u: string) => live.current?.send(unb64(u)),
    [],
  );
  const onAware = useCallback(
    (a: string) => live.current?.setAware(unb64(a)),
    [],
  );

  // Save before leaving the page or the app.
  useEffect(() => {
    const sub = AppState.addEventListener(
      'change',
      st => st !== 'active' && flush(),
    );
    return () => {
      sub.remove();
      flush();
    };
  }, [flush]);
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function'
    )
      return;
    const warn = (e: BeforeUnloadEvent) => {
      if (edits.current !== savedEdits.current) {
        flush();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [flush]);

  /** Someone saved without live editing (an older app): put this copy over theirs. */
  const keepMine = async () => {
    try {
      const o = await openDoc(id);
      if (o.doc.epoch !== base.current.epoch) {
        load();
        return;
      }
      base.current = {version: o.doc.version, epoch: o.doc.epoch};
      await flush(true);
    } catch (e) {
      setSaveError((e as Error).message);
    }
  };

  const canWrite = opened ? opened.doc.role !== 'view' : false;

  const pickImage = useCallback(async () => {
    if (!opened || !canWrite) return;
    try {
      const files = await pickImages();
      for (const [i, f] of files.entries()) {
        if (f.data.length > MAX_IMAGE_BYTES)
          throw new Error(`${f.name} is too big (15 MB at most).`);
        setUploading(
          files.length > 1
            ? `Adding image ${i + 1} of ${files.length}…`
            : 'Adding image…',
        );
        const url = await uploadImage(id, f.data);
        editor.current?.insertImage(url, f.name.replace(/\.[^.]+$/, ''));
      }
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setUploading(null);
    }
  }, [opened, canWrite, id]);

  const resolveImage = useCallback((url: string) => loadImage(id, url), [id]);

  const status =
    saveState === 'saving' || saveState === 'dirty'
      ? 'Saving…'
      : saveState === 'error'
      ? 'Not saved'
      : saveState === 'conflict'
      ? 'Changed elsewhere'
      : opened && !canWrite
      ? 'View only'
      : 'Saved';

  // Everyone with the page open, one face per tab (yours included), each
  // ringed in its person's cursor color.
  const here = useMemo((): HeaderViewer[] => {
    if (!opened) return [];
    const list = viewers.some(v => v.tab === tab)
      ? viewers
      : [{user: me?.id ?? '', tab, aware: null}, ...viewers];
    return list.map(v => {
      const m = opened.doc.members.find(x => x.id === v.user);
      return {
        key: v.tab,
        user: v.user,
        name:
          (m?.name || 'Someone') +
          (v.tab === tab ? ' (this tab)' : v.user === me?.id ? ' (you)' : ''),
        avatar: m?.avatar ?? null,
        color: colorForUser(v.user),
      };
    });
  }, [viewers, opened, tab, me?.id]);

  useEffect(() => {
    if (!opened) {
      onHeaderChange({title: 'Page'});
      return;
    }
    onHeaderChange({
      title: canWrite ? title : title || 'Untitled',
      onRename: canWrite ? onRename : undefined,
      subtitle: status,
      viewers: here,
      actions: [
        ...(canWrite
          ? [{label: 'Add image', icon: 'image' as const, onPress: pickImage}]
          : []),
        {
          label: 'Sharing and settings',
          icon: 'members' as const,
          onPress: () =>
            flush().then(() => onNavigate({name: 'docSettings', id})),
        },
      ],
    });
  }, [
    opened,
    title,
    onRename,
    status,
    here,
    canWrite,
    pickImage,
    flush,
    onNavigate,
    id,
    onHeaderChange,
  ]);

  if (loadError) {
    return (
      <View style={styles.center}>
        <Notice kind="info" title="Can't open this page yet">
          {loadError}
        </Notice>
        <Pressable style={styles.button} onPress={load}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (!opened) {
    return (
      <View style={styles.center}>
        <TypingDots color={theme.textMuted} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {saveState === 'conflict' && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            Someone else changed this page while you were editing.
          </Text>
          <View style={styles.bannerRow}>
            <Pressable style={styles.bannerButton} onPress={load}>
              <Text style={styles.bannerButtonText}>Load theirs</Text>
            </Pressable>
            <Pressable
              style={[styles.bannerButton, styles.bannerPrimary]}
              onPress={keepMine}>
              <Text style={[styles.bannerButtonText, styles.bannerPrimaryText]}>
                Keep mine
              </Text>
            </Pressable>
          </View>
        </View>
      )}
      {saveState === 'error' && saveError && (
        <Pressable style={styles.errorBar} onPress={() => flush()}>
          <Text style={styles.errorText}>{saveError} · Tap to retry</Text>
        </Pressable>
      )}
      {saveState !== 'error' && saveError && (
        <Pressable style={styles.errorBar} onPress={() => setSaveError(null)}>
          <Text style={styles.errorText}>{saveError}</Text>
        </Pressable>
      )}
      {!opened.verified && (
        <View style={styles.warnBar}>
          <Text style={styles.warnText}>
            The last change to this page couldn't be verified as coming from a
            member.
          </Text>
        </View>
      )}
      {uploading && (
        <View style={styles.infoBar}>
          <TypingDots color={theme.textMuted} size={5} />
          <Text style={styles.infoText}>{uploading}</Text>
        </View>
      )}
      {!canWrite && (
        <View style={styles.infoBar}>
          <Text style={styles.infoText}>
            You can view this page. Ask an owner for{' '}
            {roleLabel('edit').toLowerCase()} access to change it.
          </Text>
        </View>
      )}
      <DocEditor
        key={generation}
        ref={editor}
        markdown={opened.markdown}
        y={opened.y}
        title={opened.title}
        user={user}
        readOnly={!canWrite}
        autoFocus={fresh}
        onChange={onChange}
        onTitle={setTitle}
        onLocalChange={onLocalChange}
        onAware={onAware}
        onPickImage={pickImage}
        resolveImage={resolveImage}
      />
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {flex: 1, backgroundColor: theme.bg},
    center: {
      flex: 1,
      alignItems: 'stretch',
      justifyContent: 'center',
      padding: 24,
      backgroundColor: theme.bg,
      maxWidth: 520,
      width: '100%',
      alignSelf: 'center',
    },
    button: {
      marginTop: 16,
      paddingVertical: 12,
      borderRadius: 8,
      backgroundColor: theme.surfaceAlt,
      alignItems: 'center',
    },
    buttonText: {color: theme.text, fontWeight: '600'},
    banner: {
      padding: 12,
      backgroundColor: theme.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      gap: 8,
    },
    bannerText: {color: theme.text, fontSize: 13, fontWeight: '600'},
    bannerRow: {flexDirection: 'row', gap: 8},
    bannerButton: {
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 6,
      backgroundColor: theme.surfaceAlt,
    },
    bannerButtonText: {color: theme.text, fontSize: 13, fontWeight: '600'},
    bannerPrimary: {backgroundColor: theme.primary},
    bannerPrimaryText: {color: theme.primaryText},
    errorBar: {padding: 10, backgroundColor: theme.dangerBg},
    errorText: {
      color: theme.danger,
      fontSize: 13,
      fontWeight: '600',
      textAlign: 'center',
    },
    warnBar: {
      padding: 8,
      backgroundColor: theme.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    warnText: {color: theme.textMuted, fontSize: 12, textAlign: 'center'},
    infoBar: {
      flexDirection: 'row',
      gap: 8,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 8,
      backgroundColor: theme.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    infoText: {color: theme.textMuted, fontSize: 12},
  });
}
