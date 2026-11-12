import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {DocEntry, sharedBy} from '../pagesStore';
import {Theme, useTheme} from '../theme';
import {Avatar} from './Avatar';
import {rowTime} from './DocRow';
import {Icon} from './Icon';
import {roleLabel} from './RolePicker';

/**
 * A page someone shared with me, waiting in "Shared with me": who shared it,
 * its title (if it opens), and Accept / Decline.
 */
export function InviteRow({
  entry,
  busy,
  onOpen,
  onAccept,
  onDecline,
}: {
  entry: DocEntry;
  busy: boolean;
  onOpen: () => void;
  onAccept: () => void;
  onDecline: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const {summary, head, locked, unreadable} = entry;
  const who = sharedBy(summary);
  const inviter = summary.members.find(m => m.id === summary.added_by);
  const title =
    head?.title ||
    (unreadable
      ? "Can't be opened"
      : locked
      ? 'Waiting for access'
      : 'Untitled');
  return (
    <View style={styles.row}>
      <Pressable
        style={({pressed}) => [styles.main, pressed && styles.pressed]}
        onPress={onOpen}
        disabled={!!unreadable || locked}
        accessibilityRole="button"
        accessibilityLabel={`${title}, shared by ${who ?? 'someone'}`}>
        {inviter ? (
          <Avatar
            user={inviter.id}
            name={inviter.name}
            avatar={inviter.avatar}
            size={36}
          />
        ) : (
          <View style={styles.noAvatar}>
            <Icon name="file" size={18} color={theme.textMuted} />
          </View>
        )}
        <View style={styles.text}>
          <Text
            style={[styles.title, !head?.title && styles.muted]}
            numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.sub} numberOfLines={2}>
            {who ? `${who} · ` : ''}
            {roleLabel(summary.role)} · {rowTime(summary.added_at)}
            {unreadable ? ` · ${unreadable}` : ''}
          </Text>
        </View>
      </Pressable>
      <View style={styles.actions}>
        <Pressable
          style={[styles.decline, busy && styles.disabled]}
          disabled={busy}
          onPress={onDecline}
          accessibilityLabel={`Decline ${title}`}>
          <Icon name="close" size={16} color={theme.text} />
        </Pressable>
        {!unreadable && (
          <Pressable
            style={[styles.accept, busy && styles.disabled]}
            disabled={busy}
            onPress={onAccept}
            accessibilityLabel={`Accept ${title}`}>
            <Icon name="check" size={16} color={theme.primaryText} />
            <Text style={styles.acceptText}>Accept</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    main: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 4,
      paddingHorizontal: 4,
      borderRadius: 8,
    },
    pressed: {backgroundColor: theme.surface},
    noAvatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surface,
    },
    text: {flex: 1, minWidth: 0, gap: 2},
    title: {fontSize: 15, fontWeight: '600', color: theme.text},
    muted: {color: theme.textMuted},
    sub: {fontSize: 12, color: theme.textMuted},
    actions: {flexDirection: 'row', alignItems: 'center', gap: 6},
    decline: {
      width: 36,
      height: 36,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    accept: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      height: 36,
      paddingHorizontal: 12,
      borderRadius: 18,
      backgroundColor: theme.primary,
    },
    acceptText: {color: theme.primaryText, fontSize: 14, fontWeight: '700'},
    disabled: {opacity: 0.5},
  });
}
