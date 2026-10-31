import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type {HeaderInfo} from '../App';
import {Notice} from '../components/Notice';
import {headFromMarkdown} from '../crypto';
import {DocEditor} from '../editor/DocEditor';
import type {DocEditorRef} from '../editor/types';
import {pickImages} from '../files';
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
import {Theme, useTheme} from '../theme';
import {roleLabel} from '../components/RolePicker';

/** How long typing has to pause before the page is saved. */
const SAVE_DELAY_MS = 1200;
const MAX_IMAGE_BYTES = 15 << 20;

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

/** One page, open for reading or editing. Saves as you type. */
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

  // What's on screen vs. what the server has.
  const latest = useRef<string>('');
  const saved = useRef<string>('');
  const base = useRef({version: 0, epoch: 0});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const o = await openDoc(id);
      latest.current = saved.current = o.markdown;
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

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) await inFlight.current;
    if (!opened || latest.current === saved.current) return;
    const md = latest.current;
    setSaveState('saving');
    inFlight.current = (async () => {
      try {
        const v = await saveDoc(
          id,
          base.current.version,
          base.current.epoch,
          opened.key,
          md,
        );
        base.current.version = v;
        saved.current = md;
        setSaveError(null);
        setSaveState(latest.current === md ? 'saved' : 'dirty');
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
  }, [id, opened]);

  const onChange = useCallback(
    (md: string) => {
      latest.current = md;
      if (md === saved.current) return;
      setSaveState(s => (s === 'conflict' ? s : 'dirty'));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        flush();
      }, SAVE_DELAY_MS);
    },
    [flush],
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
      if (latest.current !== saved.current) {
        flush();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [flush]);

  /** Someone else saved first: keep what's on screen, on top of their version. */
  const keepMine = async () => {
    try {
      const o = await openDoc(id);
      if (o.doc.epoch !== base.current.epoch) {
        // The key changed too (someone was removed): carry on with the new one.
        setOpened(o);
      }
      base.current = {version: o.doc.version, epoch: o.doc.epoch};
      saved.current = o.markdown;
      setSaveState('dirty');
      await flush();
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

  useEffect(() => {
    if (!opened) {
      onHeaderChange({title: 'Page'});
      return;
    }
    onHeaderChange({
      title: headFromMarkdown(latest.current).title || 'Untitled',
      subtitle: status,
      members: opened.doc.members,
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
    status,
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
        <ActivityIndicator color={theme.textMuted} />
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
          <ActivityIndicator size="small" color={theme.textMuted} />
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
        readOnly={!canWrite}
        autoFocus={fresh}
        onChange={onChange}
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
