import React, {useEffect, useMemo, useState} from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {api, ApiError, Me, VerifyResult} from '../api';
import {copyText} from '../clipboard';
import {Icon} from '../components/Icon';
import {Notice} from '../components/Notice';
import {
  Account,
  accountFromEntropy,
  b64,
  entropyFromPhrase,
  lockBundle,
  MIN_PASSPHRASE,
  newAccount,
  openBundle,
  passphraseStrength,
  phraseFromEntropy,
} from '../crypto';
import {saveTextFileAs} from '../files';
import {ASK_REMEMBER, storeIdentity} from '../keystore';
import {LogoArt} from '../logo/LogoArt';
import {
  AgreeToTerms,
  PrivacyPolicy,
  TermsOfUse,
} from '../privacy/PrivacyPolicy';
import {homeServer, normalizeServer, settingsStore} from '../settings';
import {Theme, useTheme} from '../theme';

/** Where an onboarding run ends: an unlocked account on a server. */
export type Done = (server: string, entropy: Uint8Array, me: Me) => void;

type Step =
  | {name: 'email'}
  | {name: 'code'}
  | {name: 'regcode'}
  | {name: 'profile'}
  | {name: 'newPass'}
  | {name: 'phrase'; account: Account; me: Me}
  | {name: 'unlock'}
  | {name: 'recover'}
  | {name: 'recoverPass'; account: Account}
  | {name: 'resetWarn'}
  | {name: 'resetPass'};

/**
 * Sign in. An email code proves the address. A new address then picks a
 * name and a passphrase, and is shown its recovery phrase; a known one
 * types its passphrase, which unlocks the account's key on this device.
 */
export function OnboardingScreen({
  onDone,
  initialEmail,
}: {
  onDone: Done;
  initialEmail?: string;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [step, setStep] = useState<Step>({name: 'email'});
  const [server, setServer] = useState(
    () => settingsStore.get().lastServer || homeServer(),
  );
  const [advanced, setAdvanced] = useState(false);
  const [email, setEmail] = useState(initialEmail ?? '');
  const [code, setCode] = useState('');
  const [verified, setVerified] = useState<VerifyResult | null>(null);
  const [regCode, setRegCode] = useState('');
  const [name, setName] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const [terms, setTerms] = useState(false);

  useEffect(() => {
    // A web build served by a Super Pages server signs in to that server.
    if (Platform.OS === 'web') setServer(homeServer());
  }, []);

  const go = (s: Step) => {
    setError(null);
    setBusy(null);
    setStep(s);
  };

  const back: Step | null = (() => {
    switch (step.name) {
      case 'code':
        return {name: 'email'};
      case 'regcode':
      case 'unlock':
        return {name: 'email'};
      case 'profile':
        return verified?.needs_code ? {name: 'regcode'} : {name: 'email'};
      case 'newPass':
        return {name: 'profile'};
      case 'recover':
      case 'resetWarn':
        return {name: 'unlock'};
      case 'recoverPass':
        return {name: 'recover'};
      case 'resetPass':
        return {name: 'resetWarn'};
      default:
        return null;
    }
  })();

  useEffect(() => {
    if (!back) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      go(back);
      return true;
    });
    return () => sub.remove();
  }, [back]);

  const run = async (label: string, f: () => Promise<void>) => {
    setError(null);
    setBusy(label);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const finish = async (entropy: Uint8Array, me: Me) => {
    await storeIdentity(server, entropy, remember);
    await settingsStore.update({lastServer: server});
    onDone(server, entropy, me);
  };

  // ---- steps ----

  const sendCode = () =>
    run('Sending a code…', async () => {
      const cfg = await api.config(server).catch(() => null);
      if (!cfg || cfg.app !== 'superpages')
        throw new Error(
          `${server.replace(/^https?:\/\//, '')} isn't a Super Pages server.`,
        );
      await api.emailStart(server, email.trim());
      setCode('');
      go({name: 'code'});
    });

  const checkCode = (c = code) =>
    run('Checking…', async () => {
      const v = await api.emailVerify(server, email.trim(), c);
      setVerified(v);
      if (v.account) go({name: 'unlock'});
      else go({name: v.needs_code ? 'regcode' : 'profile'});
    });

  const create = (pass: string) =>
    run('Making your keys…', async () => {
      const account = newAccount();
      const bundle = await lockBundle(account.entropy, pass);
      try {
        const me = await api.createAccount(server, account, {
          ticket: verified!.ticket,
          reg_code: regCode.trim(),
          box_pub: b64(account.xPub),
          bundle,
          name: name.trim(),
        });
        go({name: 'phrase', account, me});
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) {
          go({name: 'regcode'});
          setError(e.message);
          return;
        }
        if (e instanceof ApiError && e.status === 401) {
          go({name: 'email'});
          setError(e.message);
          return;
        }
        throw e;
      }
    });

  const unlock = (pass: string) =>
    run('Unlocking…', async () => {
      const acct = verified!.account!;
      const entropy = await openBundle(acct.bundle, pass);
      const account = accountFromEntropy(entropy);
      if (account.keyId !== acct.sign_pub)
        throw new Error(
          "This account's key doesn't match. Ask for a new code and try again.",
        );
      const me = await api.me(server, account);
      await finish(entropy, me);
    });

  const recover = (phrase: string) =>
    run('Checking…', async () => {
      const account = accountFromEntropy(entropyFromPhrase(phrase));
      if (account.keyId !== verified!.account!.sign_pub) {
        throw new Error(
          'That phrase belongs to a different account (or this account was reset since you saved it).',
        );
      }
      go({name: 'recoverPass', account});
    });

  const setNewPass = (account: Account, pass: string) =>
    run('Locking with the new passphrase…', async () => {
      await api.putBundle(
        server,
        account,
        await lockBundle(account.entropy, pass),
      );
      const me = await api.me(server, account);
      await finish(account.entropy, me);
    });

  const reset = (pass: string) =>
    run('Making new keys…', async () => {
      const account = newAccount();
      const me = await api.resetAccount(server, account, {
        ticket: verified!.ticket,
        box_pub: b64(account.xPub),
        bundle: await lockBundle(account.entropy, pass),
      });
      go({name: 'phrase', account, me});
    });

  if (privacy) return <PrivacyPolicy onClose={() => setPrivacy(false)} />;
  if (terms) return <TermsOfUse onClose={() => setTerms(false)} />;

  const rememberToggle = ASK_REMEMBER ? (
    <Pressable
      style={styles.checkRow}
      onPress={() => setRemember(r => !r)}
      accessibilityRole="checkbox"
      accessibilityState={{checked: remember}}>
      <View style={[styles.checkbox, remember && styles.checkboxOn]}>
        {remember && <Icon name="check" size={14} color={theme.primaryText} />}
      </View>
      <Text style={styles.checkText}>Remember this browser</Text>
    </Pressable>
  ) : null;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled">
      {back && (
        <Pressable
          style={styles.backRow}
          onPress={() => go(back)}
          accessibilityLabel="Back">
          <Icon name="chevron-left" size={18} color={theme.textMuted} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
      )}

      {step.name === 'email' && (
        <View>
          <View style={styles.center}>
            <LogoArt height={170} />
          </View>
          <Text style={styles.lead}>Private pages, end-to-end encrypted.</Text>
          <Text style={[styles.body, styles.centerText]}>
            Sign in or sign up with your email. We'll send you a code.
          </Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            inputMode="email"
            onSubmitEditing={() => /@/.test(email) && sendCode()}
            editable={!busy}
          />
          <Pressable
            style={[
              styles.primary,
              (!/^\S+@\S+\.\S+$/.test(email.trim()) || !!busy) &&
                styles.disabled,
            ]}
            disabled={!/^\S+@\S+\.\S+$/.test(email.trim()) || !!busy}
            onPress={sendCode}>
            <Text style={styles.primaryText}>Email me a code</Text>
          </Pressable>
          <Pressable style={styles.quiet} onPress={() => setAdvanced(a => !a)}>
            <Text style={styles.quietText}>
              {advanced ? 'Hide advanced' : 'Advanced'}
            </Text>
          </Pressable>
          {advanced && (
            <View style={styles.card}>
              <Text style={styles.label}>Server</Text>
              <TextInput
                style={styles.input}
                value={server}
                onChangeText={t => setServer(t)}
                onBlur={() => setServer(normalizeServer(server))}
                autoCapitalize="none"
                autoCorrect={false}
                placeholderTextColor={theme.textMuted}
              />
              <Text style={styles.hint}>
                Your account lives on one server. Anyone can run their own.
              </Text>
            </View>
          )}
          <AgreeToTerms
            onTerms={() => setTerms(true)}
            onPrivacy={() => setPrivacy(true)}
          />
        </View>
      )}

      {step.name === 'code' && (
        <View>
          <Text style={styles.h1}>Check your email</Text>
          <Text style={styles.body}>
            We sent a 6-digit code to{' '}
            <Text style={styles.strong}>{email.trim()}</Text>. It lasts 10
            minutes.
          </Text>
          <TextInput
            style={[styles.input, styles.codeInput]}
            value={code}
            onChangeText={t => {
              const digits = t.replace(/\D/g, '').slice(0, 6);
              setCode(digits);
              if (digits.length === 6 && !busy) checkCode(digits);
            }}
            placeholder="123456"
            placeholderTextColor={theme.textMuted}
            keyboardType="number-pad"
            inputMode="numeric"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={12}
            editable={!busy}
            autoFocus
          />
          <Pressable
            style={[
              styles.primary,
              (code.length !== 6 || !!busy) && styles.disabled,
            ]}
            disabled={code.length !== 6 || !!busy}
            onPress={() => checkCode()}>
            <Text style={styles.primaryText}>Continue</Text>
          </Pressable>
          <Pressable style={styles.quiet} onPress={sendCode} disabled={!!busy}>
            <Text style={styles.quietText}>Send a new code</Text>
          </Pressable>
        </View>
      )}

      {step.name === 'regcode' && (
        <View>
          <Text style={styles.h1}>Enter your invite code</Text>
          <Text style={styles.body}>
            Super Pages is in early access. You need an invite code to make an
            account.
          </Text>
          <TextInput
            style={[styles.input, styles.codeInput]}
            value={regCode}
            onChangeText={t => setRegCode(t.toUpperCase())}
            placeholder="XXXX-XXXX-XXXX"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!busy}
          />
          <Pressable
            style={[
              styles.primary,
              regCode.replace(/[^A-Za-z0-9]/g, '').length < 12 &&
                styles.disabled,
            ]}
            disabled={regCode.replace(/[^A-Za-z0-9]/g, '').length < 12}
            onPress={() => go({name: 'profile'})}>
            <Text style={styles.primaryText}>Continue</Text>
          </Pressable>
        </View>
      )}

      {step.name === 'profile' && (
        <View>
          <Text style={styles.h1}>What should people call you?</Text>
          <Text style={styles.body}>
            People you share pages with see this name and, if you add one later,
            your picture.
          </Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Your name"
            placeholderTextColor={theme.textMuted}
            maxLength={64}
            autoComplete="name"
            autoFocus
            onSubmitEditing={() => name.trim() && go({name: 'newPass'})}
          />
          <Pressable
            style={[styles.primary, !name.trim() && styles.disabled]}
            disabled={!name.trim()}
            onPress={() => go({name: 'newPass'})}>
            <Text style={styles.primaryText}>Continue</Text>
          </Pressable>
        </View>
      )}

      {step.name === 'newPass' && (
        <PassphraseForm
          title="Choose a passphrase"
          hint="It encrypts your key before it leaves this device, so not even our server can read your pages. You'll type it when you sign in on a new device. We can't reset it for you."
          confirm
          styles={styles}
          theme={theme}
          busy={busy}
          error={error}
          submitLabel="Create account"
          extra={rememberToggle}
          onOk={create}
        />
      )}

      {step.name === 'phrase' && (
        <PhraseStep
          account={step.account}
          styles={styles}
          theme={theme}
          onDone={() => finish(step.account.entropy, step.me)}
        />
      )}

      {step.name === 'unlock' && (
        <View>
          <PassphraseForm
            title="Welcome back"
            hint={`Enter the passphrase for ${email.trim()}.`}
            confirm={false}
            styles={styles}
            theme={theme}
            busy={busy}
            error={error}
            submitLabel="Unlock"
            extra={rememberToggle}
            onOk={unlock}
          />
          <Pressable style={styles.quiet} onPress={() => go({name: 'recover'})}>
            <Text style={styles.quietText}>Forgot your passphrase?</Text>
          </Pressable>
        </View>
      )}

      {step.name === 'recover' && (
        <PhraseEntry
          styles={styles}
          theme={theme}
          busy={busy}
          error={error}
          onOk={recover}
          onCantRecover={() => go({name: 'resetWarn'})}
        />
      )}

      {step.name === 'recoverPass' && (
        <PassphraseForm
          title="Choose a new passphrase"
          hint="Your recovery phrase checked out. Pick a new passphrase for signing in."
          confirm
          styles={styles}
          theme={theme}
          busy={busy}
          error={error}
          submitLabel="Save and sign in"
          extra={rememberToggle}
          onOk={pass => setNewPass(step.account, pass)}
        />
      )}

      {step.name === 'resetWarn' && (
        <View>
          <Text style={styles.h1}>Start over with new keys?</Text>
          <Notice kind="error" title="This can't be undone">
            Without your passphrase or recovery phrase, nobody can decrypt your
            pages, us included. Resetting keeps your email and name but gives
            you new keys. Pages only you had are deleted. Pages shared with you
            come back once one of their owners opens Super Pages.
          </Notice>
          <Pressable
            style={[styles.primary, styles.dangerButton]}
            onPress={() => go({name: 'resetPass'})}>
            <Text style={styles.primaryText}>Reset my account</Text>
          </Pressable>
        </View>
      )}

      {step.name === 'resetPass' && (
        <PassphraseForm
          title="Choose a passphrase"
          hint="For your new keys."
          confirm
          styles={styles}
          theme={theme}
          busy={busy}
          error={error}
          submitLabel="Reset account"
          extra={rememberToggle}
          onOk={reset}
        />
      )}

      {error &&
        step.name !== 'newPass' &&
        step.name !== 'unlock' &&
        step.name !== 'recoverPass' &&
        step.name !== 'resetPass' &&
        step.name !== 'recover' && (
          <Notice kind="error" title="That didn't work">
            {error}
          </Notice>
        )}
      {busy &&
        step.name !== 'newPass' &&
        step.name !== 'unlock' &&
        step.name !== 'recoverPass' &&
        step.name !== 'resetPass' &&
        step.name !== 'recover' && <Notice kind="working" title={busy} />}
    </ScrollView>
  );
}

const STRENGTH = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

export function PassphraseForm({
  title,
  hint,
  confirm,
  styles,
  theme,
  busy,
  error,
  submitLabel = 'Continue',
  extra,
  onOk,
}: {
  title: string;
  hint: string;
  confirm: boolean;
  styles: Styles;
  theme: Theme;
  busy: string | null;
  error?: string | null;
  submitLabel?: string;
  extra?: React.ReactNode;
  onOk: (pass: string) => void;
}) {
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const strength = passphraseStrength(pass);
  const ok = confirm
    ? pass.length >= MIN_PASSPHRASE && pass === again
    : pass.length > 0;
  const submit = () => ok && !busy && onOk(pass);
  const meter = [
    theme.danger,
    theme.danger,
    '#d29922',
    theme.success,
    theme.success,
  ][strength];
  return (
    <View>
      <Text style={styles.h1}>{title}</Text>
      <Text style={styles.body}>{hint}</Text>
      <TextInput
        style={[styles.input, !!error && styles.inputError]}
        secureTextEntry
        value={pass}
        onChangeText={setPass}
        editable={!busy}
        placeholder={
          confirm ? `At least ${MIN_PASSPHRASE} characters` : 'Passphrase'
        }
        placeholderTextColor={theme.textMuted}
        autoComplete={confirm ? 'new-password' : 'current-password'}
        onSubmitEditing={() => !confirm && submit()}
        autoFocus
      />
      {confirm && pass.length > 0 && (
        <View style={styles.meterRow}>
          <View style={styles.meterTrack}>
            <View
              style={[
                styles.meterFill,
                {
                  width: `${(Math.max(1, strength) / 4) * 100}%`,
                  backgroundColor: meter,
                },
              ]}
            />
          </View>
          <Text style={[styles.hint, {color: meter}]}>
            {STRENGTH[strength]}
          </Text>
        </View>
      )}
      {confirm && (
        <TextInput
          style={[styles.input, styles.spaced]}
          secureTextEntry
          value={again}
          onChangeText={setAgain}
          editable={!busy}
          placeholder="Again"
          placeholderTextColor={theme.textMuted}
          autoComplete="new-password"
          onSubmitEditing={submit}
        />
      )}
      {confirm && again.length > 0 && pass !== again && (
        <Text style={styles.fieldError}>The passphrases don't match.</Text>
      )}
      {extra}
      {error && (
        <Notice kind="error" title="That didn't work">
          {error}
        </Notice>
      )}
      {busy && <Notice kind="working" title={busy} />}
      <Pressable
        style={[styles.primary, (!ok || !!busy) && styles.disabled]}
        disabled={!ok || !!busy}
        onPress={submit}>
        <Text style={styles.primaryText}>{submitLabel}</Text>
      </Pressable>
    </View>
  );
}

/** Shows the 24 words once, with copy and download, and won't go on until they're saved. */
function PhraseStep({
  account,
  styles,
  theme,
  onDone,
}: {
  account: Account;
  styles: Styles;
  theme: Theme;
  onDone: () => void;
}) {
  const words = useMemo(() => phraseFromEntropy(account.entropy), [account]);
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const text = words.join(' ');
  return (
    <View>
      <Text style={styles.h1}>Your recovery phrase</Text>
      <Text style={styles.body}>
        If you ever forget your passphrase, these 24 words are the only way back
        into your pages. Write them down or save them somewhere safe. Anyone
        with them can read your pages.
      </Text>
      <View style={styles.words}>
        {words.map((w, i) => (
          <View key={i} style={styles.word}>
            <Text style={styles.wordNum}>{i + 1}</Text>
            <Text style={styles.wordText}>{w}</Text>
          </View>
        ))}
      </View>
      <View style={styles.rowButtons}>
        <Pressable
          style={[styles.secondary, styles.flex]}
          onPress={async () => {
            try {
              await copyText(text);
              setNote(
                'Copied. Paste it somewhere safe, then clear your clipboard.',
              );
            } catch {
              setNote("Couldn't copy. Write the words down instead.");
            }
          }}>
          <Text style={styles.secondaryText}>Copy</Text>
        </Pressable>
        <Pressable
          style={[styles.secondary, styles.flex]}
          onPress={async () => {
            const f = await saveTextFileAs(
              'super-pages-recovery-phrase.txt',
              async () => `Super Pages recovery phrase\n\n${text}\n`,
            );
            if (f) setNote(`Saved to ${f.location}.`);
          }}>
          <Text style={styles.secondaryText}>Download</Text>
        </Pressable>
      </View>
      {note && <Text style={styles.hint}>{note}</Text>}
      <Pressable
        style={styles.checkRow}
        onPress={() => setSaved(s => !s)}
        accessibilityRole="checkbox"
        accessibilityState={{checked: saved}}>
        <View style={[styles.checkbox, saved && styles.checkboxOn]}>
          {saved && <Icon name="check" size={14} color={theme.primaryText} />}
        </View>
        <Text style={styles.checkText}>I've saved my recovery phrase</Text>
      </Pressable>
      <Pressable
        style={[styles.primary, !saved && styles.disabled]}
        disabled={!saved}
        onPress={onDone}>
        <Text style={styles.primaryText}>Open Super Pages</Text>
      </Pressable>
    </View>
  );
}

function PhraseEntry({
  styles,
  theme,
  busy,
  error,
  onOk,
  onCantRecover,
}: {
  styles: Styles;
  theme: Theme;
  busy: string | null;
  error: string | null;
  onOk: (phrase: string) => void;
  onCantRecover: () => void;
}) {
  const [phrase, setPhrase] = useState('');
  const count = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;
  return (
    <View>
      <Text style={styles.h1}>Use your recovery phrase</Text>
      <Text style={styles.body}>
        Type or paste the 24 words you saved when you made your account.
      </Text>
      <TextInput
        style={[styles.input, styles.phraseInput]}
        value={phrase}
        onChangeText={setPhrase}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="word word word …"
        placeholderTextColor={theme.textMuted}
        editable={!busy}
      />
      <Text style={styles.hint}>{count} of 24 words</Text>
      {error && (
        <Notice kind="error" title="That didn't work">
          {error}
        </Notice>
      )}
      {busy && <Notice kind="working" title={busy} />}
      <Pressable
        style={[styles.primary, (count !== 24 || !!busy) && styles.disabled]}
        disabled={count !== 24 || !!busy}
        onPress={() => onOk(phrase)}>
        <Text style={styles.primaryText}>Continue</Text>
      </Pressable>
      <Pressable style={styles.quiet} onPress={onCantRecover}>
        <Text style={styles.quietText}>I don't have it either</Text>
      </Pressable>
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

export function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {flex: 1, backgroundColor: theme.bg},
    content: {
      padding: 20,
      paddingTop: Platform.OS === 'web' ? 48 : 32,
      paddingBottom: 48,
      maxWidth: 520,
      width: '100%',
      alignSelf: 'center',
    },
    center: {alignItems: 'center'},
    centerText: {textAlign: 'center'},
    h1: {fontSize: 22, fontWeight: '800', color: theme.text, marginBottom: 8},
    lead: {
      fontSize: 16,
      fontWeight: '700',
      color: theme.text,
      textAlign: 'center',
      marginTop: 20,
    },
    body: {
      fontSize: 14,
      lineHeight: 20,
      color: theme.textMuted,
      marginVertical: 10,
    },
    strong: {color: theme.text, fontWeight: '700'},
    hint: {fontSize: 12, color: theme.textMuted, marginTop: 4},
    words: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 12},
    word: {
      width: '31%',
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 8,
      borderRadius: 6,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
    },
    wordNum: {
      fontSize: 10,
      color: theme.textMuted,
      fontWeight: '700',
      width: 16,
    },
    wordText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.text,
      fontFamily: 'monospace',
    },
    card: {
      padding: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surface,
      marginTop: 8,
    },
    label: {
      fontSize: 12,
      fontWeight: '700',
      color: theme.textMuted,
      marginBottom: 4,
    },
    input: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: theme.text,
      backgroundColor: theme.surface,
      fontSize: 15,
      marginTop: 6,
    },
    codeInput: {
      fontSize: 22,
      letterSpacing: 6,
      textAlign: 'center',
      fontFamily: 'monospace',
    },
    spaced: {marginTop: 8},
    phraseInput: {
      minHeight: 120,
      textAlignVertical: 'top',
      fontFamily: 'monospace',
    },
    primary: {
      alignSelf: 'stretch',
      marginTop: 16,
      paddingVertical: 13,
      borderRadius: 8,
      backgroundColor: theme.primary,
      alignItems: 'center',
    },
    primaryText: {color: theme.primaryText, fontWeight: '700', fontSize: 15},
    dangerButton: {backgroundColor: theme.danger},
    secondary: {
      alignSelf: 'stretch',
      marginTop: 10,
      paddingVertical: 12,
      borderRadius: 8,
      backgroundColor: theme.surfaceAlt,
      alignItems: 'center',
    },
    secondaryText: {color: theme.text, fontWeight: '600'},
    rowButtons: {flexDirection: 'row', gap: 10},
    flex: {flex: 1},
    quiet: {alignSelf: 'center', marginTop: 14, padding: 6},
    quietText: {
      color: theme.textMuted,
      fontSize: 13,
      fontWeight: '600',
      textDecorationLine: 'underline',
    },
    disabled: {opacity: 0.5},
    error: {color: theme.danger, marginTop: 12, fontWeight: '600'},
    inputError: {borderColor: theme.danger},
    fieldError: {color: theme.danger, fontSize: 12, marginTop: 4},
    meterRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 6,
    },
    meterTrack: {
      flex: 1,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.surfaceAlt,
      overflow: 'hidden',
    },
    meterFill: {height: 4, borderRadius: 2},
    checkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginTop: 14,
      paddingVertical: 4,
    },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: 5,
      borderWidth: 2,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkboxOn: {backgroundColor: theme.primary, borderColor: theme.primary},
    checkText: {color: theme.text, fontSize: 14},
    backRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      alignSelf: 'flex-start',
      marginBottom: 12,
      paddingVertical: 4,
    },
    backText: {color: theme.textMuted, fontSize: 14, fontWeight: '600'},
  });
}
