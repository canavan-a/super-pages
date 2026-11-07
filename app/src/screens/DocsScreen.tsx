import React, {useCallback, useMemo, useState} from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import {DocCard} from '../components/DocCard';
import {DocRow, groupByDate} from '../components/DocRow';
import {Icon} from '../components/Icon';
import {TypingDots} from '../components/TypingDots';
import {createDoc, DocEntry, refreshDocs, useStore} from '../pagesStore';
import type {Route} from '../routes';
import {session} from '../session';
import {useSetting} from '../settings';
import {Theme, useTheme} from '../theme';

/** Home: every page you can open, newest first, as a grid of squares or a list under date headings. */
export function DocsScreen({
  onNavigate,
}: {
  onNavigate: (r: Route) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const docs = useStore(s => s.docs);
  const loaded = useStore(s => s.loaded);
  const error = useStore(s => s.error);
  const [pulling, setPulling] = useState(false);
  const [creating, setCreating] = useState(false);
  const {width} = useWindowDimensions();
  // Two columns on a phone, more on a wide browser window.
  const columns = width >= 1100 ? 4 : width >= 760 ? 3 : 2;
  const me = session.get()?.me?.id;
  const view = useSetting('docsView');
  const sections = useMemo(
    () => (view === 'list' ? groupByDate(docs) : []),
    [view, docs],
  );

  const onRefresh = useCallback(() => {
    setPulling(true);
    refreshDocs().finally(() => setPulling(false));
  }, []);

  const newPage = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const id = await createDoc('');
      onNavigate({name: 'doc', id, fresh: true});
    } finally {
      setCreating(false);
    }
  };

  if (!loaded) {
    return (
      <View style={styles.center}>
        <TypingDots color={theme.textMuted} />
      </View>
    );
  }

  const open = (e: DocEntry) => () =>
    onNavigate({name: 'doc', id: e.summary.id});
  const settingsFor = (e: DocEntry) =>
    e.locked
      ? undefined
      : () =>
          onNavigate({name: 'docSettings', id: e.summary.id, fromHome: true});

  const refreshControl = (
    <RefreshControl
      refreshing={pulling}
      onRefresh={onRefresh}
      tintColor={theme.textMuted}
      colors={[theme.primary]}
    />
  );
  const header = error ? (
    <Pressable style={styles.error} onPress={onRefresh}>
      <Text style={styles.errorText}>{error} · Tap to retry</Text>
    </Pressable>
  ) : null;
  const empty = (
    <View style={styles.empty}>
      <Icon name="file" size={36} color={theme.textMuted} />
      <Text style={styles.emptyTitle}>No pages yet</Text>
      <Text style={styles.emptyBody}>
        Start one with the + button. Only you and the people you share it with
        can read it.
      </Text>
    </View>
  );

  return (
    <View style={styles.container}>
      {view === 'list' ? (
        <SectionList
          sections={sections}
          keyExtractor={d => d.summary.id}
          stickySectionHeadersEnabled
          contentContainerStyle={[
            styles.flat,
            docs.length === 0 && styles.listEmpty,
          ]}
          refreshControl={refreshControl}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          renderSectionHeader={({section}) => (
            <Text style={styles.section}>{section.title}</Text>
          )}
          renderItem={({item}) => (
            <DocRow
              entry={item}
              me={me}
              onPress={open(item)}
              onLongPress={settingsFor(item)}
            />
          )}
        />
      ) : (
        <FlatList
          key={columns}
          data={docs}
          keyExtractor={d => d.summary.id}
          numColumns={columns}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[
            styles.list,
            docs.length === 0 && styles.listEmpty,
          ]}
          refreshControl={refreshControl}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          renderItem={({item}) => (
            <View style={[styles.cell, {maxWidth: `${100 / columns}%`}]}>
              <DocCard
                entry={item}
                me={me}
                onPress={open(item)}
                onLongPress={settingsFor(item)}
              />
            </View>
          )}
        />
      )}
      <Pressable
        style={({pressed}) => [styles.fab, pressed && styles.fabPressed]}
        onPress={newPage}
        accessibilityRole="button"
        accessibilityLabel="New page"
        disabled={creating}>
        {creating ? (
          <TypingDots color={theme.primaryText} />
        ) : (
          <Icon name="plus" size={26} color={theme.primaryText} />
        )}
      </Pressable>
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {flex: 1, backgroundColor: theme.bg},
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.bg,
    },
    list: {
      padding: 8,
      paddingBottom: 96,
      maxWidth: 1200,
      width: '100%',
      alignSelf: 'center',
    },
    flat: {
      paddingBottom: 96,
      maxWidth: 760,
      width: '100%',
      alignSelf: 'center',
    },
    section: {
      paddingHorizontal: 16,
      paddingTop: 20,
      paddingBottom: 6,
      fontSize: 12,
      fontWeight: '700',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: theme.textMuted,
      backgroundColor: theme.bg,
    },
    listEmpty: {flexGrow: 1},
    row: {gap: 0},
    cell: {flex: 1, padding: 6},
    error: {
      margin: 6,
      padding: 10,
      borderRadius: 8,
      backgroundColor: theme.dangerBg,
    },
    errorText: {
      color: theme.danger,
      fontSize: 13,
      fontWeight: '600',
      textAlign: 'center',
    },
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
      gap: 8,
    },
    emptyTitle: {fontSize: 17, fontWeight: '700', color: theme.text},
    emptyBody: {
      fontSize: 14,
      color: theme.textMuted,
      textAlign: 'center',
      lineHeight: 20,
      maxWidth: 320,
    },
    fab: {
      position: 'absolute',
      right: 20,
      bottom: 24,
      width: 58,
      height: 58,
      borderRadius: 29,
      backgroundColor: theme.primary,
      alignItems: 'center',
      justifyContent: 'center',
      elevation: 6,
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 8,
      shadowOffset: {width: 0, height: 3},
    },
    fabPressed: {opacity: 0.85},
  });
}
