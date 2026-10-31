import React, {useEffect, useMemo, useState} from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import {api} from '../api';
import {
  compareVersions,
  DowngradeBlockedError,
  fetchReleases,
  getVersionInfo,
  onDownloadProgress,
  Release,
  runUpdate,
} from '../appUpdater';
import {copyText} from '../clipboard';
import {Avatar} from '../components/Avatar';
import {AvatarCropper} from '../components/AvatarCropper';
import {Icon} from '../components/Icon';
import {InstallCard} from '../components/InstallCard';
import {Notice} from '../components/Notice';
import {Overlay} from '../components/Overlay';
import {lockBundle, MIN_PASSPHRASE, phraseFromEntropy} from '../crypto';
import {isSideload} from '../distribution';
import {AvatarSource, pickAvatarSource} from '../files';
import {
  ASK_REMEMBER,
  forgetIdentity,
  hasStoredIdentity,
  HAS_LOCK,
  storeIdentity,
} from '../keystore';
import {resetStore} from '../pagesStore';
import {platformConfirm} from '../platformConfirm';
import {session} from '../session';
import {settingsStore} from '../settings';
import {Theme, THEME_OPTIONS, useThemeSetting} from '../theme';

const LOCK_OPTIONS = [
  {min: 0, label: 'Every time'},
  {min: 1, label: '1 min'},
  {min: 5, label: '5 min'},
  {min: 30, label: '30 min'},
];

export function SettingsScreen({
  onSignedOut,
  onOpenPrivacy,
  onOpenTerms,
}: {
  onSignedOut: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
}): React.JSX.Element {
  const {theme, themeName, setThemeName} = useThemeSetting();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [s, setS] = useState(settingsStore.get());
  useEffect(() => settingsStore.subscribe(setS), []);
  const [me, setMe] = useState(session.get()?.me ?? null);
  useEffect(() => session.subscribe(x => setMe(x?.me ?? null)), []);

  const [name, setName] = useState(me?.name ?? '');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [crop, setCrop] = useState<AvatarSource | null>(null);
  const [showPhrase, setShowPhrase] = useState(false);
  const [newPass, setNewPass] = useState<{a: string; b: string} | null>(null);
  const [remembered, setRemembered] = useState<boolean | null>(null);

  useEffect(() => {
    if (ASK_REMEMBER) hasStoredIdentity().then(setRemembered);
  }, []);

  const run = async (f: () => Promise<void>, done?: string) => {
    setError(null);
    setNote(null);
    try {
      await f();
      if (done) setNote(done);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const sess = session.get();

  const saveName = () =>
    run(async () => {
      const m = await api.setName(sess!.server, sess!.account, name.trim());
      session.setMe(m);
    }, 'Name saved.');

  const pickPicture = () =>
    run(async () => {
      const src = await pickAvatarSource();
      if (src) setCrop(src);
    });

  const changePassphrase = () =>
    run(async () => {
      await api.putBundle(
        sess!.server,
        sess!.account,
        await lockBundle(sess!.account.entropy, newPass!.a),
      );
      setNewPass(null);
    }, 'Passphrase changed. Use the new one next time you sign in on a new device.');

  const toggleRemember = (on: boolean) =>
    run(async () => {
      if (on) await storeIdentity(sess!.server, sess!.account.entropy, true);
      else await forgetIdentity();
      setRemembered(on);
    });

  const signOut = () =>
    platformConfirm(
      'Sign out',
      'Sign out on this device? You can sign back in with an email code and your passphrase.',
      'Sign out',
      async () => {
        await forgetIdentity();
        resetStore();
        session.clear();
        onSignedOut();
      },
    );

  const deleteAccount = () =>
    platformConfirm(
      'Delete account',
      'Delete your account? Pages only you can open are deleted. Shared pages stay with the people you shared them with. This can’t be undone.',
      'Delete account',
      () =>
        run(async () => {
          await api.deleteMe(sess!.server, sess!.account);
          await forgetIdentity();
          resetStore();
          session.clear();
          onSignedOut();
        }),
    );

  // ---- app updates (Android sideload), same flow as super-chat ----
  const [version, setVersion] = useState<string>();
  const [releases, setReleases] = useState<Release[]>([]);
  const [updateStatus, setUpdateStatus] = useState<string>();
  const [updateBusy, setUpdateBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'android' || !isSideload) return;
    getVersionInfo()
      .then(v => setVersion(`${v.versionName} (${v.versionCode})`))
      .catch(() => setVersion('unknown'));
    fetchReleases()
      .then(setReleases)
      .catch(e => setUpdateStatus(`Check failed: ${String(e)}`));
  }, []);
  useEffect(() => {
    if (!downloading) return;
    return onDownloadProgress(({bytesDownloaded, bytesTotal}) => {
      const pct =
        bytesTotal > 0 ? Math.round((bytesDownloaded / bytesTotal) * 100) : 0;
      setUpdateStatus(
        bytesTotal > 0 && bytesDownloaded >= bytesTotal
          ? 'Downloaded. Opening the installer…'
          : `Downloading… ${pct}%`,
      );
    });
  }, [downloading]);
  const latest = releases[0];
  const current = version?.split(' ')[0];
  const updateAvailable =
    !!latest && !!current && compareVersions(latest.version, current) > 0;
  const installUpdate = async () => {
    if (!latest) return;
    setUpdateBusy(true);
    try {
      await runUpdate(latest);
      setDownloading(true);
      setUpdateStatus(
        "Downloading in the background. The installer opens when it's done.",
      );
    } catch (e) {
      if (e instanceof DowngradeBlockedError)
        Alert.alert(
          'Downgrade blocked',
          'Uninstall the app first to install an older version.',
        );
      else setUpdateStatus(`Update failed: ${String(e)}`);
    } finally {
      setUpdateBusy(false);
    }
  };

  if (!sess || !me) return <View style={styles.container} />;
  const words = showPhrase ? phraseFromEntropy(sess.account.entropy) : [];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled">
      {error && (
        <Notice kind="error" title="That didn't work">
          {error}
        </Notice>
      )}
      {note && <Notice kind="success" title={note} />}

      <Text style={styles.h2}>Profile</Text>
      <View style={styles.profile}>
        <Pressable
          onPress={pickPicture}
          accessibilityLabel="Change profile picture">
          <Avatar user={me.id} name={me.name} avatar={me.avatar} size={64} />
          <View style={[styles.editBadge, {backgroundColor: theme.primary}]}>
            <Icon name="pencil" size={12} color={theme.primaryText} />
          </View>
        </Pressable>
        <View style={styles.flex}>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            maxLength={64}
            placeholder="Your name"
            placeholderTextColor={theme.textMuted}
            onSubmitEditing={saveName}
          />
          <Text style={styles.hint}>{me.email}</Text>
        </View>
      </View>
      <View style={styles.row}>
        {name.trim() !== me.name && (
          <Pressable style={styles.button} onPress={saveName}>
            <Text style={styles.buttonText}>Save name</Text>
          </Pressable>
        )}
        {me.avatar && (
          <Pressable
            style={styles.button}
            onPress={() =>
              run(
                async () =>
                  session.setMe(
                    await api.deleteAvatar(sess.server, sess.account),
                  ),
                'Picture removed.',
              )
            }>
            <Text style={styles.buttonText}>Remove picture</Text>
          </Pressable>
        )}
      </View>
      <Text style={styles.hint}>
        Your name and picture are visible to people you share pages with.
        They're not encrypted; your pages are.
      </Text>

      <View style={styles.divider} />
      <Text style={styles.h2}>Theme</Text>
      <View style={styles.chips}>
        {THEME_OPTIONS.map(o => (
          <Pressable
            key={o.name}
            style={[styles.chip, themeName === o.name && styles.chipOn]}
            onPress={() => setThemeName(o.name)}>
            <Text
              style={[
                styles.chipText,
                themeName === o.name && styles.chipTextOn,
              ]}>
              {o.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <SwitchRow
        label="Opening animation"
        hint="The scroll unrolling when the app starts."
        value={s.launchSplash && !s.splashAutoDisabled}
        onChange={v =>
          settingsStore.update({
            launchSplash: v,
            splashAutoDisabled: false,
            splashStrikes: 0,
          })
        }
        styles={styles}
      />
      {Platform.OS === 'android' && (
        <SwitchRow
          label="Match app icon to theme"
          value={s.themedIcon}
          onChange={v => settingsStore.update({themedIcon: v})}
          styles={styles}
        />
      )}

      <View style={styles.divider} />
      {Platform.OS === 'web' && (
        <>
          <InstallCard />
          <View style={styles.divider} />
        </>
      )}
      <Text style={styles.h2}>Security</Text>
      {newPass ? (
        <View style={styles.card}>
          <TextInput
            style={styles.input}
            secureTextEntry
            value={newPass.a}
            onChangeText={a => setNewPass({...newPass, a})}
            placeholder={`New passphrase (${MIN_PASSPHRASE}+ characters)`}
            placeholderTextColor={theme.textMuted}
            autoComplete="new-password"
          />
          <TextInput
            style={[styles.input, styles.spaced]}
            secureTextEntry
            value={newPass.b}
            onChangeText={b => setNewPass({...newPass, b})}
            placeholder="Again"
            placeholderTextColor={theme.textMuted}
            autoComplete="new-password"
          />
          <View style={styles.row}>
            <Pressable style={styles.button} onPress={() => setNewPass(null)}>
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[
                styles.button,
                styles.buttonPrimary,
                (newPass.a.length < MIN_PASSPHRASE ||
                  newPass.a !== newPass.b) &&
                  styles.disabled,
              ]}
              disabled={
                newPass.a.length < MIN_PASSPHRASE || newPass.a !== newPass.b
              }
              onPress={changePassphrase}>
              <Text style={[styles.buttonText, {color: theme.primaryText}]}>
                Change passphrase
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          style={styles.action}
          onPress={() => setNewPass({a: '', b: ''})}>
          <Icon name="lock" size={16} color={theme.text} />
          <Text style={styles.actionText}>Change passphrase</Text>
        </Pressable>
      )}
      <Pressable
        style={styles.action}
        onPress={() =>
          showPhrase
            ? setShowPhrase(false)
            : platformConfirm(
                'Show recovery phrase',
                'Show your 24-word recovery phrase? Make sure nobody can see your screen.',
                'Show',
                () => setShowPhrase(true),
                false,
              )
        }>
        <Icon name="shield" size={16} color={theme.text} />
        <Text style={styles.actionText}>
          {showPhrase ? 'Hide recovery phrase' : 'Show recovery phrase'}
        </Text>
      </Pressable>
      {showPhrase && (
        <View style={styles.card}>
          <Text style={styles.phrase} selectable>
            {words.map((w, i) => `${i + 1}. ${w}`).join('   ')}
          </Text>
          <Pressable
            style={styles.button}
            onPress={() =>
              copyText(words.join(' ')).then(() => setNote('Copied.'))
            }>
            <Text style={styles.buttonText}>Copy</Text>
          </Pressable>
        </View>
      )}
      {ASK_REMEMBER && remembered !== null && (
        <SwitchRow
          label="Remember this browser"
          hint="Off: you sign in again (email code and passphrase) each time you open Super Pages here."
          value={remembered}
          onChange={toggleRemember}
          styles={styles}
        />
      )}
      {HAS_LOCK && (
        <>
          <Text style={styles.label}>Lock after leaving the app</Text>
          <View style={styles.chips}>
            {LOCK_OPTIONS.map(o => (
              <Pressable
                key={o.min}
                style={[styles.chip, s.lockAfterMin === o.min && styles.chipOn]}
                onPress={() => settingsStore.update({lockAfterMin: o.min})}>
                <Text
                  style={[
                    styles.chipText,
                    s.lockAfterMin === o.min && styles.chipTextOn,
                  ]}>
                  {o.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
      <Text style={styles.hint}>
        Server: {sess.server.replace(/^https?:\/\//, '')}
      </Text>

      {Platform.OS === 'android' && isSideload && (
        <>
          <View style={styles.divider} />
          <Text style={styles.h2}>App updates</Text>
          <Text style={styles.hint}>
            {latest
              ? updateAvailable
                ? `Update available: v${latest.version}`
                : `Up to date (v${latest.version})`
              : `Current version: ${version ?? '…'}`}
          </Text>
          {latest && (
            <Pressable
              style={[styles.action, updateBusy && styles.disabled]}
              disabled={updateBusy}
              onPress={installUpdate}>
              <Icon name="download" size={16} color={theme.text} />
              <Text style={styles.actionText}>
                {updateAvailable
                  ? `Update to v${latest.version}`
                  : 'Reinstall current version'}
              </Text>
            </Pressable>
          )}
          {updateStatus && <Text style={styles.hint}>{updateStatus}</Text>}
        </>
      )}

      <View style={styles.divider} />
      <Pressable style={styles.action} onPress={onOpenPrivacy}>
        <Icon name="info" size={16} color={theme.text} />
        <Text style={styles.actionText}>Privacy policy</Text>
      </Pressable>
      <Pressable style={styles.action} onPress={onOpenTerms}>
        <Icon name="file" size={16} color={theme.text} />
        <Text style={styles.actionText}>Terms of use</Text>
      </Pressable>
      <Pressable style={styles.action} onPress={signOut}>
        <Icon name="logout" size={16} color={theme.text} />
        <Text style={styles.actionText}>Sign out</Text>
      </Pressable>
      <Pressable style={styles.action} onPress={deleteAccount}>
        <Icon name="trash" size={16} color={theme.danger} />
        <Text style={[styles.actionText, {color: theme.danger}]}>
          Delete account
        </Text>
      </Pressable>

      <Overlay visible={!!crop} onClose={() => setCrop(null)} modal>
        {crop && (
          <AvatarCropper
            src={crop}
            onCancel={() => setCrop(null)}
            onDone={async jpeg => {
              await run(
                async () =>
                  session.setMe(
                    await api.putAvatar(sess.server, sess.account, jpeg),
                  ),
                'Picture updated.',
              );
              setCrop(null);
            }}
          />
        )}
      </Overlay>
    </ScrollView>
  );
}

function SwitchRow({
  label,
  hint,
  value,
  onChange,
  styles,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.flex}>
        <Text style={styles.label}>{label}</Text>
        {hint && <Text style={styles.hint}>{hint}</Text>}
      </View>
      <Switch value={value} onValueChange={onChange} />
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
      gap: 8,
    },
    h2: {
      fontSize: 13,
      fontWeight: '800',
      color: theme.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      marginTop: 4,
    },
    label: {fontSize: 15, fontWeight: '600', color: theme.text},
    hint: {fontSize: 12, color: theme.textMuted, lineHeight: 17},
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginVertical: 12,
    },
    profile: {flexDirection: 'row', alignItems: 'center', gap: 14},
    editBadge: {
      position: 'absolute',
      right: -2,
      bottom: -2,
      width: 22,
      height: 22,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
    },
    flex: {flex: 1},
    row: {flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4},
    input: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      color: theme.text,
      backgroundColor: theme.surface,
      fontSize: 15,
    },
    spaced: {marginTop: 8},
    card: {
      padding: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surface,
      gap: 8,
    },
    phrase: {
      color: theme.text,
      fontFamily: 'monospace',
      fontSize: 13,
      lineHeight: 22,
    },
    button: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: theme.surfaceAlt,
      alignSelf: 'flex-start',
    },
    buttonPrimary: {backgroundColor: theme.primary},
    buttonText: {color: theme.text, fontWeight: '600', fontSize: 13},
    disabled: {opacity: 0.5},
    action: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 10,
    },
    actionText: {color: theme.text, fontSize: 15, fontWeight: '500'},
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
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 6,
    },
  });
}
