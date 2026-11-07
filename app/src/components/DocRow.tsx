import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import type {DocEntry} from '../pagesStore';
import {Theme, useTheme} from '../theme';
import {AvatarStack} from './AvatarStack';
import {Icon} from './Icon';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** Whole calendar days between ms and now (0 = today). */
const daysAgo = (ms: number, now: number): number =>
  Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);

/** "9:41 AM" (no Intl: Hermes's is patchy). */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

/** A row's date: the time today, the weekday this week, else the date. */
export function rowTime(ms: number, now = Date.now()): string {
  const days = daysAgo(ms, now);
  if (days <= 0) return clockTime(ms);
  if (days === 1) return 'Yesterday';
  const d = new Date(ms);
  if (days < 7) return DAYS[d.getDay()];
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear()
    ? md
    : `${md}, ${d.getFullYear()}`;
}

/** The heading a page is listed under: "Today", "Previous 7 days", "March 2026". */
export function dateGroup(ms: number, now = Date.now()): string {
  const days = daysAgo(ms, now);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  const d = new Date(ms);
  return d.getFullYear() === new Date(now).getFullYear()
    ? MONTHS_LONG[d.getMonth()]
    : `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}

/** Pages (newest first) split into date headings, in order. */
export function groupByDate(
  docs: DocEntry[],
  now = Date.now(),
): {title: string; data: DocEntry[]}[] {
  const out: {title: string; data: DocEntry[]}[] = [];
  for (const d of docs) {
    const title = dateGroup(d.summary.updated_at, now);
    const last = out[out.length - 1];
    if (last?.title === title) last.data.push(d);
    else out.push({title, data: [d]});
  }
  return out;
}

/**
 * A page in the list: title and the first line of its text on the left, when
 * it last changed and who it's shared with on the right.
 */
export function DocRow({
  entry,
  me,
  onPress,
  onLongPress,
}: {
  entry: DocEntry;
  me: string | undefined;
  onPress: () => void;
  onLongPress?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const {summary, head, locked} = entry;
  const title = head?.title || (locked ? 'Waiting for access' : 'Untitled');
  const snippet = locked
    ? "An owner's app will send you the key next time it opens."
    : (head?.snippet ?? '').replace(/\s+/g, ' ').trim();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
      style={({pressed}) => [styles.row, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${rowTime(summary.updated_at)}`}
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
      <View style={styles.main}>
        <View style={styles.titleLine}>
          {locked && <Icon name="lock" size={13} color={theme.textMuted} />}
          <Text
            style={[styles.title, !head?.title && styles.muted]}
            numberOfLines={1}>
            {title}
          </Text>
          {summary.role === 'view' && (
            <Icon name="eye" size={13} color={theme.textMuted} />
          )}
        </View>
        {snippet ? (
          <Text style={styles.snippet} numberOfLines={1}>
            {snippet}
          </Text>
        ) : null}
      </View>
      <View style={styles.side}>
        <Text style={styles.time}>{rowTime(summary.updated_at)}</Text>
        <AvatarStack
          members={summary.members}
          exclude={me}
          size={18}
          ring={theme.bg}
        />
      </View>
    </Pressable>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 16,
      minHeight: 64,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    pressed: {backgroundColor: theme.surface},
    main: {flex: 1, minWidth: 0, gap: 3},
    titleLine: {flexDirection: 'row', alignItems: 'center', gap: 6},
    title: {
      flexShrink: 1,
      fontSize: 15,
      fontWeight: '600',
      color: theme.text,
    },
    muted: {color: theme.textMuted},
    snippet: {fontSize: 13, color: theme.textMuted},
    side: {alignItems: 'flex-end', gap: 4, minWidth: 64},
    time: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.text,
      fontVariant: ['tabular-nums'],
    },
  });
}
