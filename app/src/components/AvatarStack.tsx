import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import type {Member} from '../api';
import {useTheme} from '../theme';
import {Avatar} from './Avatar';

/**
 * Who else a page is shared with: up to `max` overlapping faces, then a "+N"
 * chip. Owners come first. Nothing at all for a page only you have.
 */
export function AvatarStack({
  members,
  exclude,
  size = 24,
  max = 3,
  ring,
}: {
  members: Member[];
  /** Usually you: you know you have it. */
  exclude?: string;
  size?: number;
  max?: number;
  /** The color behind the stack, drawn as a ring around each face. */
  ring?: string;
}): React.JSX.Element | null {
  const theme = useTheme();
  const others = members
    .filter(m => m.id !== exclude)
    .sort((a, b) => rank(a.role) - rank(b.role));
  if (others.length === 0) return null;
  const shown = others.slice(0, others.length > max ? max - 1 : max);
  const extra = others.length - shown.length;
  const overlap = -Math.round(size * 0.32);
  return (
    <View
      style={styles.row}
      accessibilityLabel={`Shared with ${others
        .map(m => m.name || 'someone')
        .join(', ')}`}>
      {shown.map((m, i) => (
        <View key={m.id} style={i > 0 ? {marginLeft: overlap} : null}>
          <Avatar
            user={m.id}
            name={m.name}
            avatar={m.avatar}
            size={size}
            ring={ring ?? theme.surface}
          />
        </View>
      ))}
      {extra > 0 && (
        <View
          style={[
            styles.more,
            {
              marginLeft: overlap,
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: theme.surfaceAlt,
              borderColor: ring ?? theme.surface,
            },
          ]}>
          <Text
            style={[
              styles.moreText,
              {color: theme.text, fontSize: size * 0.4},
            ]}>
            +{extra}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * Who has a page open: one face per open copy (a person with two tabs shows
 * twice), each ringed in its person's cursor color, then a "+N" chip.
 */
export function PresenceStack({
  viewers,
  size = 28,
  max = 4,
}: {
  viewers: {
    key: string;
    user: string;
    name: string;
    avatar: string | null;
    color: string;
  }[];
  size?: number;
  max?: number;
}): React.JSX.Element | null {
  const theme = useTheme();
  if (viewers.length === 0) return null;
  const shown = viewers.slice(0, viewers.length > max ? max - 1 : max);
  const extra = viewers.length - shown.length;
  const overlap = -Math.round(size * 0.28);
  const ring = 2;
  return (
    <View style={styles.row}>
      {shown.map((v, i) => (
        <View
          key={v.key}
          style={[
            styles.presence,
            {
              marginLeft: i > 0 ? overlap : 0,
              padding: ring,
              borderRadius: size / 2 + ring,
              backgroundColor: v.color,
            },
          ]}>
          <Avatar
            user={v.user}
            name={v.name}
            avatar={v.avatar}
            size={size - ring * 2}
            ring={theme.bg}
          />
        </View>
      ))}
      {extra > 0 && (
        <View
          style={[
            styles.more,
            {
              marginLeft: overlap,
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: theme.surfaceAlt,
              borderColor: theme.bg,
            },
          ]}>
          <Text
            style={[
              styles.moreText,
              {color: theme.text, fontSize: size * 0.38},
            ]}>
            +{extra}
          </Text>
        </View>
      )}
    </View>
  );
}

const rank = (r: Member['role']) => (r === 'owner' ? 0 : r === 'edit' ? 1 : 2);

const styles = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center'},
  more: {alignItems: 'center', justifyContent: 'center', borderWidth: 2},
  moreText: {fontWeight: '700'},
  presence: {alignItems: 'center', justifyContent: 'center'},
});
