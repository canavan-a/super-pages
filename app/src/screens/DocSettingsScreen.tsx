import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {ApiError} from '../api';
import type {DocFull, Member, Role, ShareLinkInfo} from '../api';
import {copyText} from '../clipboard';
import {Avatar} from '../components/Avatar';
import {Icon} from '../components/Icon';
import {Notice} from '../components/Notice';
import {roleLabel, RolePicker, ROLES} from '../components/RolePicker';
import {TypingDots} from '../components/TypingDots';
import {
  cancelPending,
  createLink,
  acceptDoc,
  deleteDoc,
  fetchDocInfo,
  leaveDoc,
  listLinks,
  LockedError,
  openDoc,
  removeMember,
  revokeLink,
  setRole,
  shareByEmail,
} from '../pagesStore';
import {platformConfirm} from '../platformConfirm';
import type {Route} from '../routes';
import {session} from '../session';
import {Theme, useTheme} from '../theme';

const EXPIRY = [
  {hours: 24, label: '1 day'},
  {hours: 24 * 7, label: '1 week'},
  {hours: 24 * 30, label: '30 days'},
  {hours: 0, label: 'Never'},
];

const USES = [
  {n: 1, label: 'Once'},
  {n: 10, label: '10 people'},
  {n: 0, label: 'No limit'},
];

/** Who a page is shared with and how: people, roles, links, and leaving or deleting it. */
export function DocSettingsScreen({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (r: Route) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const me = session.get()?.me?.id;
  const [doc, setDoc] = useState<DocFull | null>(null);
  const [title, setTitle] = useState('');
  const [links, setLinks] = useState<ShareLinkInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<Role>('edit');
  const [linkRole, setLinkRole] = useState<Role>('view');
  const [linkHours, setLinkHours] = useState(24 * 7);
  const [linkUses, setLinkUses] = useState(1);
  const [freshLink, setFreshLink] = useState<string | null>(null);

  // Set when the page's content can't be opened here (no key yet, or a key
  // that doesn't decrypt it, e.g. "invalid tag"). Its members and the way
  // out (leave, decline, delete) still show; anything needing the key won't.
  const [unreadable, setUnreadable] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const o = await openDoc(id);
      setDoc(o.doc);
      setTitle(o.title);
      setUnreadable(null);
      if (o.doc.role === 'owner') setLinks(await listLinks(id));
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        return;
      }
      try {
        setDoc(await fetchDocInfo(id));
        setUnreadable(
          e instanceof LockedError
            ? e.message
            : `This page can't be decrypted on this account (${
                (e as Error).message
              }). You can still leave it.`,
        );
      } catch (e2) {
        setError((e2 as Error).message);
      }
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (label: string, f: () => Promise<void>) => {
    setError(null);
    setNote(null);
    setBusy(label);
    try {
      await f();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!doc) {
    return (
      <View style={styles.center}>
        {error ? (
          <Notice kind="error" title="Couldn't load">
            {error}
          </Notice>
        ) : (
          <TypingDots color={theme.textMuted} />
        )}
      </View>
    );
  }

  // Sharing needs the page key, so it's hidden while the page can't be read.
  const owner = doc.role === 'owner' && !unreadable;
  const isOwner = doc.role === 'owner';
  const owners = doc.members.filter(m => m.role === 'owner').length;

  const share = () =>
    run('Sharing…', async () => {
      const r = await shareByEmail(id, email.trim(), newRole);
      setEmail('');
      setNote(
        r.kind === 'added'
          ? `${r.name || 'They'} can now ${
              newRole === 'view' ? 'view' : 'edit'
            } this page.`
          : `Invitation sent to ${r.pending.email}. They'll get access once they sign up and an owner's app is open.`,
      );
    });

  const makeLink = () =>
    run('Making a link…', async () => {
      const {url} = await createLink(id, linkRole, linkHours, linkUses);
      setFreshLink(url);
      await copyText(url).catch(() => {});
      setNote('Link copied. Anyone with it can join as long as it lasts.');
    });

  const remove = (m: Member) =>
    platformConfirm(
      'Remove',
      `Remove ${
        m.name || 'this person'
      }? They lose access, and the page gets a new key so nothing written from now on reaches them.`,
      'Remove',
      () => run('Removing…', () => removeMember(id, m.id)),
    );

  const leave = () =>
    platformConfirm(
      'Leave page',
      'Leave this page? You lose access until someone shares it with you again.',
      'Leave',
      () =>
        run('Leaving…', async () => {
          await leaveDoc(id);
          onNavigate({name: 'home'});
        }),
    );

  const del = () =>
    platformConfirm(
      'Delete page',
      'Delete this page for everyone? This can’t be undone.',
      'Delete',
      () =>
        run('Deleting…', async () => {
          await deleteDoc(id);
          onNavigate({name: 'home'});
        }),
    );

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled">
      <Text style={styles.pageTitle} numberOfLines={2}>
        {title || 'Untitled'}
      </Text>
      <Text style={styles.muted}>Your role: {roleLabel(doc.role)}</Text>

      {unreadable && (
        <Notice kind="error" title="Can't open this page">
          {unreadable}
        </Notice>
      )}
      {doc.accepted === false && (
        <View style={styles.section}>
          <Text style={styles.hint}>
            This page was shared with you and is waiting in Shared with me.
          </Text>
          {!unreadable && (
            <Pressable
              style={[styles.primary, !!busy && styles.disabled]}
              disabled={!!busy}
              onPress={() => run('Accepting…', () => acceptDoc(id))}>
              <Icon name="check" size={16} color={theme.primaryText} />
              <Text style={styles.primaryText}>Accept</Text>
            </Pressable>
          )}
        </View>
      )}
      {error && (
        <Notice kind="error" title="That didn't work">
          {error}
        </Notice>
      )}
      {note && <Notice kind="success" title={note} />}
      {busy && <Notice kind="working" title={busy} />}

      {owner && (
        <View style={styles.section}>
          <Text style={styles.h2}>Share with someone</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="Their email address"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            keyboardType="email-address"
            inputMode="email"
            onSubmitEditing={() => /\S+@\S+\.\S+/.test(email) && share()}
          />
          <View style={styles.row}>
            <RolePicker value={newRole} onChange={setNewRole} />
            <Pressable
              style={[
                styles.primary,
                (!/\S+@\S+\.\S+/.test(email) || !!busy) && styles.disabled,
              ]}
              disabled={!/\S+@\S+\.\S+/.test(email) || !!busy}
              onPress={share}>
              <Icon name="invite" size={16} color={theme.primaryText} />
              <Text style={styles.primaryText}>Share</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>
            {ROLES.find(r => r.role === newRole)!.hint}.
          </Text>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.h2}>People</Text>
        {doc.members.map(m => (
          <View key={m.id} style={styles.person}>
            <Avatar user={m.id} name={m.name} avatar={m.avatar} size={36} />
            <View style={styles.personText}>
              <Text style={styles.personName} numberOfLines={1}>
                {m.name || 'No name'}
                {m.id === me ? ' (you)' : ''}
              </Text>
              {!m.has_key && (
                <Text style={styles.hint}>Waiting for the page key</Text>
              )}
            </View>
            {owner && m.id !== me ? (
              <View style={styles.personActions}>
                <RolePicker
                  value={m.role}
                  onChange={r =>
                    r !== m.role &&
                    run('Changing role…', () => setRole(id, m.id, r))
                  }
                  disabled={!!busy}
                />
                <Pressable
                  style={styles.iconButton}
                  onPress={() => remove(m)}
                  accessibilityLabel={`Remove ${m.name}`}>
                  <Icon name="close" size={18} color={theme.danger} />
                </Pressable>
              </View>
            ) : owner && m.id === me && owners > 1 ? (
              <RolePicker
                value={m.role}
                onChange={r =>
                  r !== m.role &&
                  run('Changing role…', () => setRole(id, m.id, r))
                }
                disabled={!!busy}
              />
            ) : (
              <Text style={styles.roleTag}>{roleLabel(m.role)}</Text>
            )}
          </View>
        ))}
        {owner &&
          doc.pending?.map(p => (
            <View key={p.id} style={styles.person}>
              <View style={[styles.pendingIcon, {borderColor: theme.border}]}>
                <Icon name="mail" size={16} color={theme.textMuted} />
              </View>
              <View style={styles.personText}>
                <Text style={styles.personName}>{p.email}</Text>
                <Text style={styles.hint}>
                  Invited · {roleLabel(p.role)} · joins when they sign up
                </Text>
              </View>
              <Pressable
                style={styles.iconButton}
                onPress={() =>
                  run('Cancelling…', () => cancelPending(id, p.id))
                }
                accessibilityLabel="Cancel invitation">
                <Icon name="close" size={18} color={theme.textMuted} />
              </Pressable>
            </View>
          ))}
      </View>

      {owner && (
        <View style={styles.section}>
          <Text style={styles.h2}>Share links</Text>
          <Text style={styles.hint}>
            For people without an email on file. The key is inside the link
            itself; our server never sees it. Links stop working when someone is
            removed.
          </Text>
          <Text style={styles.label}>Gives</Text>
          <RolePicker
            value={linkRole}
            onChange={setLinkRole}
            roles={['edit', 'view']}
          />
          <Text style={styles.label}>Lasts</Text>
          <Chips
            options={EXPIRY.map(e => ({key: e.hours, label: e.label}))}
            value={linkHours}
            onChange={setLinkHours}
            styles={styles}
          />
          <Text style={styles.label}>Works</Text>
          <Chips
            options={USES.map(u => ({key: u.n, label: u.label}))}
            value={linkUses}
            onChange={setLinkUses}
            styles={styles}
          />
          <Pressable
            style={[styles.secondary, !!busy && styles.disabled]}
            disabled={!!busy}
            onPress={makeLink}>
            <Icon name="link" size={16} color={theme.text} />
            <Text style={styles.secondaryText}>Create link</Text>
          </Pressable>
          {freshLink && (
            <View style={styles.linkBox}>
              <Text style={styles.linkText} selectable numberOfLines={2}>
                {freshLink}
              </Text>
              <View style={styles.row}>
                <Pressable
                  style={styles.smallButton}
                  onPress={() =>
                    copyText(freshLink).then(() => setNote('Link copied.'))
                  }>
                  <Icon name="copy" size={14} color={theme.text} />
                  <Text style={styles.smallText}>Copy</Text>
                </Pressable>
                <Pressable
                  style={styles.smallButton}
                  onPress={() =>
                    Share.share({message: freshLink}).catch(() => {})
                  }>
                  <Text style={styles.smallText}>Share…</Text>
                </Pressable>
              </View>
              <Text style={styles.hint}>
                This is the only time the full link is shown.
              </Text>
            </View>
          )}
          {links.map(l => (
            <View key={l.id} style={styles.person}>
              <Icon name="link" size={16} color={theme.textMuted} />
              <View style={styles.personText}>
                <Text style={styles.personName}>
                  {roleLabel(l.role)} link · used {l.uses}
                  {l.max_uses ? ` of ${l.max_uses}` : ''}
                </Text>
                <Text style={styles.hint}>
                  {l.expires_at
                    ? `Expires ${new Date(
                        l.expires_at * 1000,
                      ).toLocaleDateString()}`
                    : 'Never expires'}
                </Text>
              </View>
              <Pressable
                style={styles.iconButton}
                onPress={() => run('Turning off…', () => revokeLink(id, l.id))}
                accessibilityLabel="Turn off link">
                <Icon name="trash" size={16} color={theme.danger} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <View style={styles.section}>
        {(!isOwner || owners > 1 || doc.members.length === 1) && (
          <Pressable style={styles.secondary} onPress={leave}>
            <Icon name="logout" size={16} color={theme.text} />
            <Text style={styles.secondaryText}>
              {doc.members.length === 1
                ? 'Leave (deletes it)'
                : doc.accepted !== false
                ? 'Leave page'
                : 'Decline page'}
            </Text>
          </Pressable>
        )}
        {isOwner && (
          <Pressable style={[styles.secondary, styles.danger]} onPress={del}>
            <Icon name="trash" size={16} color={theme.danger} />
            <Text style={[styles.secondaryText, {color: theme.danger}]}>
              Delete page
            </Text>
          </Pressable>
        )}
        {isOwner && owners === 1 && doc.members.length > 1 && (
          <Text style={styles.hint}>
            You're the only owner. Make someone else an owner before you leave.
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

function Chips<K extends number>({
  options,
  value,
  onChange,
  styles,
}: {
  options: {key: K; label: string}[];
  value: K;
  onChange: (k: K) => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.chips}>
      {options.map(o => (
        <Pressable
          key={o.key}
          style={[styles.chip, o.key === value && styles.chipOn]}
          onPress={() => onChange(o.key)}>
          <Text style={[styles.chipText, o.key === value && styles.chipTextOn]}>
            {o.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {flex: 1, backgroundColor: theme.bg},
    content: {
      padding: 16,
      paddingBottom: 48,
      maxWidth: 640,
      width: '100%',
      alignSelf: 'center',
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      backgroundColor: theme.bg,
    },
    pageTitle: {fontSize: 20, fontWeight: '800', color: theme.text},
    muted: {
      color: theme.textMuted,
      fontSize: 13,
      marginTop: 2,
      marginBottom: 6,
    },
    section: {marginTop: 22, gap: 8},
    h2: {
      fontSize: 13,
      fontWeight: '800',
      color: theme.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    label: {
      fontSize: 12,
      fontWeight: '700',
      color: theme.textMuted,
      marginTop: 4,
    },
    hint: {fontSize: 12, color: theme.textMuted, lineHeight: 17},
    input: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: theme.text,
      backgroundColor: theme.surface,
      fontSize: 15,
    },
    row: {flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap'},
    primary: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 16,
      paddingVertical: 9,
      borderRadius: 8,
      backgroundColor: theme.primary,
      marginLeft: 'auto',
    },
    primaryText: {color: theme.primaryText, fontWeight: '700'},
    secondary: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 12,
      borderRadius: 8,
      backgroundColor: theme.surfaceAlt,
      marginTop: 4,
    },
    secondaryText: {color: theme.text, fontWeight: '600'},
    danger: {backgroundColor: theme.dangerBg},
    disabled: {opacity: 0.5},
    person: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
      flexWrap: 'wrap',
    },
    personText: {flex: 1, minWidth: 120},
    personName: {color: theme.text, fontSize: 15, fontWeight: '600'},
    personActions: {flexDirection: 'row', alignItems: 'center', gap: 4},
    pendingIcon: {
      width: 36,
      height: 36,
      borderRadius: 18,
      borderWidth: 1,
      borderStyle: 'dashed',
      alignItems: 'center',
      justifyContent: 'center',
    },
    roleTag: {color: theme.textMuted, fontSize: 12, fontWeight: '700'},
    iconButton: {
      width: 34,
      height: 34,
      alignItems: 'center',
      justifyContent: 'center',
    },
    chips: {flexDirection: 'row', gap: 6, flexWrap: 'wrap'},
    chip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surface,
    },
    chipOn: {backgroundColor: theme.primary, borderColor: theme.primary},
    chipText: {color: theme.textMuted, fontSize: 13, fontWeight: '600'},
    chipTextOn: {color: theme.primaryText},
    linkBox: {
      padding: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surface,
      gap: 8,
    },
    linkText: {color: theme.text, fontFamily: 'monospace', fontSize: 12},
    smallButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 6,
      backgroundColor: theme.surfaceAlt,
    },
    smallText: {color: theme.text, fontSize: 13, fontWeight: '600'},
  });
}
