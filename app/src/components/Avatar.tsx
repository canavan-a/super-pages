import React, {useState} from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';

import {api} from '../api';
import {session} from '../session';
import {useTheme} from '../theme';

/**
 * A person's profile picture, or their initial on a colored disc when they
 * have none (or it fails to load). Pictures are plain images on the server,
 * fetched by URL with the picture's blob id in it, so a changed picture is a
 * new URL and an unchanged one comes from the image cache.
 */
export function Avatar({
  user,
  name,
  avatar,
  size = 32,
  ring,
}: {
  user: string;
  name?: string | null;
  avatar?: string | null;
  size?: number;
  /** A border in this color, so overlapping avatars stand apart. */
  ring?: string;
}) {
  const theme = useTheme();
  const [failed, setFailed] = useState<string | null>(null);
  const server = session.get()?.server;
  const box = {width: size, height: size, borderRadius: size / 2};
  const border = ring ? {borderWidth: 2, borderColor: ring} : null;
  if (avatar && server && failed !== avatar) {
    return (
      <Image
        source={{uri: api.avatarUrl(server, user, avatar)}}
        style={[box, border, {backgroundColor: theme.surfaceAlt}]}
        onError={() => setFailed(avatar)}
        accessibilityLabel={name ?? undefined}
      />
    );
  }
  const label = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <View
      style={[box, border, styles.fallback, {backgroundColor: hueFor(user)}]}
      accessibilityLabel={name ?? undefined}>
      <Text style={[styles.initial, {fontSize: size * 0.45}]}>{label}</Text>
    </View>
  );
}

/** A steady color per person, so a fallback disc is recognisable. */
export function hueFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 45%, 45%)`;
}

const styles = StyleSheet.create({
  fallback: {alignItems: 'center', justifyContent: 'center'},
  initial: {color: '#fff', fontWeight: '700'},
});
