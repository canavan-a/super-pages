import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import type {DocEntry} from '../pagesStore';
import {Theme, useTheme} from '../theme';
import {AvatarStack} from './AvatarStack';
import {rowTime} from './DocRow';
import {Icon} from './Icon';

/**
 * A page in the grid: a square with its title, the start of its text, and
 * at the bottom who it's shared with.
 */
export function DocCard({
  entry,
  me,
  onPress,
  onLongPress,
}: {
  entry: DocEntry;
  me: string | undefined;
  onPress: () => void;
  /** Held down: the page's sharing and settings. */
  onLongPress?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const {summary, head, locked} = entry;
  const title = head?.title || (locked ? 'Waiting for access' : 'Untitled');
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
      style={({pressed}) => [styles.card, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={
        onLongPress ? 'Long press for sharing and settings' : undefined
      }
      accessibilityActions={
        onLongPress
          ? [{name: 'longpress', label: 'Sharing and settings'}]
          : undefined
      }
      onAccessibilityAction={e =>
        e.nativeEvent.actionName === 'longpress' && onLongPress?.()
      }>
      <View style={styles.top}>
        <Text
          style={[styles.title, !head?.title && styles.muted]}
          numberOfLines={2}>
          {title}
        </Text>
        {summary.role === 'view' && (
          <Icon name="eye" size={14} color={theme.textMuted} />
        )}
      </View>
      {locked ? (
        <View style={styles.lockedBox}>
          <Icon name="lock" size={18} color={theme.textMuted} />
          <Text style={styles.lockedText}>
            An owner's app will send you the key next time it opens.
          </Text>
        </View>
      ) : (
        <Text style={styles.snippet} numberOfLines={5}>
          {head?.snippet ?? ''}
        </Text>
      )}
      <View style={styles.footer}>
        <Text style={styles.time}>{rowTime(summary.updated_at)}</Text>
        <AvatarStack
          members={summary.members}
          exclude={me}
          size={22}
          ring={theme.surface}
        />
      </View>
    </Pressable>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    card: {
      flex: 1,
      aspectRatio: 1,
      borderRadius: 14,
      padding: 12,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
      overflow: 'hidden',
    },
    pressed: {opacity: 0.75},
    top: {flexDirection: 'row', alignItems: 'flex-start', gap: 6},
    title: {
      flex: 1,
      fontSize: 15,
      fontWeight: '700',
      color: theme.text,
      lineHeight: 20,
    },
    muted: {color: theme.textMuted},
    snippet: {
      flex: 1,
      marginTop: 6,
      fontSize: 13,
      lineHeight: 18,
      color: theme.textMuted,
    },
    lockedBox: {flex: 1, marginTop: 8, gap: 6},
    lockedText: {fontSize: 12, lineHeight: 16, color: theme.textMuted},
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 6,
      minHeight: 24,
    },
    time: {
      fontSize: 12,
      fontWeight: '700',
      color: theme.text,
      fontVariant: ['tabular-nums'],
    },
  });
}
