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
import type {DocFull, Member, PubInfo, Role, ShareLinkInfo} from '../api';
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
  freeSlug,
  openDoc,
  publishDoc,
  publishedUrl,
  removeMember,
  revokeLink,
  setRole,
  shareByEmail,
  slugAvailable,
  unpublishDoc,
  updatePublished,
} from '../pagesStore';
import {platformConfirm} from '../platformConfirm';
import type {Route} from '../routes';
import {session} from '../session';
import {cleanSlug, randomSlug, validSlug} from '../slugWords';
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

      {!unreadable && (owner || doc.published) && (
        <PublishSection
          id={id}
          published={doc.published ?? null}
          owner={owner}
          busy={!!busy}
          run={run}
          onNote={setNote}
          styles={styles}
        />
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

type SlugState = 'checking' | 'free' | 'taken' | 'bad' | 'error';

const EDITS = [
  {key: 0, label: 'Only people in it'},
  {key: 1, label: 'Anyone with the link'},
];

/**
 * Publishing to the web: a live, public copy of the page at /p/<slug>,
 * readable without an account, and editable by anyone with the link if the
 * owner allows it. Owners pick the address (a random adjective-animal to
 * start) and can move or unpublish it; everyone else sees where it is.
 */
function PublishSection({
  id,
  published,
  owner,
  busy,
  run,
  onNote,
  styles,
}: {
  id: string;
  published: PubInfo | null;
  owner: boolean;
  busy: boolean;
  run: (label: string, f: () => Promise<void>) => Promise<void>;
  onNote: (note: string) => void;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  const theme = useTheme();
  const current = published?.slug ?? null;
  const [slug, setSlug] = useState(current ?? '');
  const [slugState, setSlugState] = useState<SlugState | null>(null);
  const [publicEdit, setPublicEdit] = useState(0);

  // A fresh address to offer, until the page is published.
  useEffect(() => {
    if (current) setSlug(current);
    else if (owner)
      freeSlug()
        .then(s => setSlug(cur => cur || s))
        .catch(() => setSlug(cur => cur || randomSlug()));
  }, [current, owner]);

  // Whether what's typed is free, checked once typing pauses.
  useEffect(() => {
    if (!owner || !slug) return setSlugState(null);
    if (!validSlug(slug)) return setSlugState('bad');
    setSlugState('checking');
    let live = true;
    const t = setTimeout(() => {
      slugAvailable(slug, current)
        .then(free => live && setSlugState(free ? 'free' : 'taken'))
        .catch(() => live && setSlugState('error'));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [slug, current, owner]);

  const url = current ? publishedUrl(current) : null;
  const changed = slug !== current;
  const canSubmit = owner && !busy && changed && slugState === 'free';

  const publish = () =>
    run(current ? 'Moving…' : 'Publishing…', async () => {
      const s = current
        ? (await updatePublished(id, {slug})).slug
        : await publishDoc(id, slug, publicEdit === 1);
      const u = publishedUrl(s);
      await copyText(u).catch(() => {});
      onNote(`${current ? 'Moved' : 'Published'}. Link copied: ${u}`);
    });

  const setEdits = (on: boolean) => {
    if (!published) return setPublicEdit(on ? 1 : 0);
    if (on === published.public_edit) return;
    const go = () =>
      run('Saving…', async () => {
        await updatePublished(id, {public_edit: on});
        onNote(
          on
            ? 'Anyone with the link can now edit this page.'
            : 'Only people in this page can edit it now.',
        );
      });
    if (on)
      platformConfirm(
        'Let anyone edit',
        'Anyone with the link will be able to change or delete what’s on this page, without an account. Their changes come into the page itself.',
        'Allow',
        go,
      );
    else go();
  };

  const unpublish = () =>
    platformConfirm(
      'Unpublish',
      'Take this page off the web? Its public link stops working right away.',
      'Unpublish',
      () =>
        run('Unpublishing…', async () => {
          await unpublishDoc(id);
          setSlug('');
          setPublicEdit(0);
          onNote('This page is no longer on the web.');
        }),
    );

  const slugHint: Record<SlugState, string> = {
    checking: 'Checking…',
    free: current && !changed ? 'This page’s address.' : 'Available.',
    taken: 'That address is taken. Try another, or roll the dice.',
    bad: 'Use 3 to 48 lowercase letters, numbers and dashes.',
    error: 'Couldn’t check that address.',
  };
  const editsOn = published ? published.public_edit : publicEdit === 1;

  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Publish to the web</Text>
      <Text style={styles.hint}>
        {published
          ? published.public_edit
            ? 'Anyone with this link can read and edit the page, without an account.'
            : 'Anyone with this link can read the page, without an account. It updates as the page is edited.'
          : 'Gives the page a public link anyone can read, without an account. It stays live as the page is edited.'}
      </Text>
      {url && (
        <View style={styles.linkBox}>
          <Text style={styles.linkText} selectable numberOfLines={2}>
            {url}
          </Text>
          <View style={styles.row}>
            <Pressable
              style={styles.smallButton}
              onPress={() => copyText(url).then(() => onNote('Link copied.'))}>
              <Icon name="copy" size={14} color={theme.text} />
              <Text style={styles.smallText}>Copy</Text>
            </Pressable>
            <Pressable
              style={styles.smallButton}
              onPress={() => Share.share({message: url}).catch(() => {})}>
              <Text style={styles.smallText}>Share…</Text>
            </Pressable>
          </View>
        </View>
      )}
      {owner && (
        <>
          <Text style={styles.label}>Who can edit it there</Text>
          <Chips
            options={EDITS}
            value={editsOn ? 1 : 0}
            onChange={k => setEdits(k === 1)}
            styles={styles}
          />
          <Text style={styles.label}>
            {current ? 'Change address' : 'Address'}
          </Text>
          <View style={styles.slugRow}>
            <Text style={styles.slugPrefix} numberOfLines={1}>
              /p/
            </Text>
            <TextInput
              style={[styles.input, styles.slugInput]}
              value={slug}
              onChangeText={t => setSlug(cleanSlug(t))}
              placeholder="smart-bunny"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={48}
              accessibilityLabel="Public address"
              onSubmitEditing={() => canSubmit && publish()}
            />
            <Pressable
              style={styles.iconButton}
              onPress={() => setSlug(randomSlug())}
              accessibilityLabel="Another random address">
              <Icon name="dice" size={18} color={theme.textMuted} />
            </Pressable>
          </View>
          {slugState && (
            <Text
              style={[
                styles.hint,
                (slugState === 'taken' || slugState === 'bad') && {
                  color: theme.danger,
                },
              ]}>
              {slugHint[slugState]}
            </Text>
          )}
          <View style={styles.row}>
            {published && (
              <Pressable
                style={[styles.smallButton, busy && styles.disabled]}
                disabled={busy}
                onPress={unpublish}>
                <Icon name="close" size={14} color={theme.danger} />
                <Text style={[styles.smallText, {color: theme.danger}]}>
                  Unpublish
                </Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.primary, !canSubmit && styles.disabled]}
              disabled={!canSubmit}
              onPress={publish}>
              <Icon name="globe" size={16} color={theme.primaryText} />
              <Text style={styles.primaryText}>
                {current ? 'Move' : 'Publish'}
              </Text>
            </Pressable>
          </View>
          {!published && (
            <Text style={styles.hint}>
              A published page isn’t end-to-end encrypted: its text and images
              are readable by our server, and by anyone with the link, until you
              unpublish it.
            </Text>
          )}
        </>
      )}
    </View>
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
    slugRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
    slugPrefix: {color: theme.textMuted, fontFamily: 'monospace', fontSize: 14},
    slugInput: {flex: 1, fontFamily: 'monospace'},
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
