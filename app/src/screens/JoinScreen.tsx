import React, {useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {Notice} from '../components/Notice';
import {roleLabel} from '../components/RolePicker';
import {parseShareLink} from '../crypto';
import {joinLink, LinkPreview, previewLink} from '../pagesStore';
import type {Route} from '../routes';
import {session} from '../session';
import {Theme, useTheme} from '../theme';

/** A share link was opened: show what it's for, then join. */
export function JoinScreen({
  link,
  onNavigate,
}: {
  link: string;
  onNavigate: (r: Route) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const parsed = useMemo(() => parseShareLink(link), [link]);
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const server = session.get()?.server;
  const otherServer = !!parsed && !!server && parsed.server !== server;

  useEffect(() => {
    if (!parsed) {
      setError("This link doesn't look right. Ask for a new one.");
      return;
    }
    if (otherServer) return;
    previewLink(parsed.server, parsed.link, parsed.secret)
      .then(setPreview)
      .catch(e => setError((e as Error).message));
  }, [parsed, otherServer]);

  const join = async () => {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      const doc = await joinLink(parsed.link, parsed.secret);
      onNavigate({name: 'doc', id: doc});
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        {otherServer ? (
          <Notice kind="info" title="This link is for another server">
            It's for {parsed!.server.replace(/^https?:\/\//, '')}, and your
            account is on {server!.replace(/^https?:\/\//, '')}. Sign in to an
            account on that server to open it.
          </Notice>
        ) : error ? (
          <Notice kind="error" title="Can't open this link">
            {error}
          </Notice>
        ) : !preview ? (
          <ActivityIndicator color={theme.textMuted} />
        ) : (
          <>
            <Text style={styles.kicker}>You've been invited to</Text>
            <Text style={styles.title}>{preview.title || 'Untitled page'}</Text>
            <Text style={styles.body}>
              as {preview.role === 'view' ? 'a viewer' : 'an editor'} (
              {roleLabel(preview.role)}).
            </Text>
            <Pressable
              style={[styles.primary, busy && styles.disabled]}
              disabled={busy}
              onPress={join}>
              {busy ? (
                <ActivityIndicator color={theme.primaryText} />
              ) : (
                <Text style={styles.primaryText}>Open page</Text>
              )}
            </Pressable>
          </>
        )}
        <Pressable
          style={styles.secondary}
          onPress={() => onNavigate({name: 'home'})}>
          <Text style={styles.secondaryText}>Not now</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.bg,
      justifyContent: 'center',
      padding: 20,
    },
    card: {
      maxWidth: 440,
      width: '100%',
      alignSelf: 'center',
      padding: 20,
      borderRadius: 14,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
      gap: 8,
    },
    kicker: {color: theme.textMuted, fontSize: 13, fontWeight: '600'},
    title: {color: theme.text, fontSize: 22, fontWeight: '800'},
    body: {color: theme.textMuted, fontSize: 14},
    primary: {
      marginTop: 12,
      paddingVertical: 13,
      borderRadius: 8,
      backgroundColor: theme.primary,
      alignItems: 'center',
    },
    primaryText: {color: theme.primaryText, fontWeight: '700', fontSize: 15},
    secondary: {paddingVertical: 10, alignItems: 'center'},
    secondaryText: {color: theme.textMuted, fontWeight: '600'},
    disabled: {opacity: 0.6},
  });
}
