import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {Icon} from '../components/Icon';
import {TypingDots} from '../components/TypingDots';
import {loadIdentity, Stored} from '../keystore';
import {splashHold} from '../logo/splashHold';
import {LogoArt} from '../logo/LogoArt';
import {useTheme} from '../theme';
import {PrivacyLink, PrivacyPolicy} from '../privacy/PrivacyPolicy';
import {makeStyles} from './OnboardingScreen';

/** Longest a fingerprint/PIN unlock may take before the screen gives up on it. */
const UNLOCK_TIMEOUT_MS = 45_000;
/**
 * No answer by now usually means the system prompt never appeared (asked for
 * before the app was really in front, e.g. right after an update). Uncover
 * the screen and let Unlock be tapped again; a late answer still counts.
 */
const PROMPT_STUCK_MS = 6_000;
/** Let the app finish coming to the front before asking for the fingerprint. */
const AUTO_PROMPT_DELAY_MS = 300;

/** Keystore failures arrive as Java exception text; say something a person can act on. */
function friendlyError(e: Error): string {
  const m = e.message || '';
  if (/cancel/i.test(m)) return 'Unlock cancelled.';
  if (/javax|keystore|wrapped|cipher/i.test(m))
    return "Couldn't unlock with your fingerprint or PIN. Tap Unlock to try again.";
  return m || 'Could not unlock.';
}

/**
 * Shown on a phone when the key is stored but not unlocked: it asks for
 * biometrics or the screen-lock PIN straight away.
 */
export function LockScreen({
  onUnlock,
  onForget,
}: {
  onUnlock: (stored: Stored) => void;
  onForget: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Unlocked: the app is getting the rooms ready. A spinner, not the Unlock
  // button again (which looked like the unlock had missed or hung).
  const [opening, setOpening] = useState(false);
  const [privacy, setPrivacy] = useState(false);

  // Each attempt's number: a late answer from an attempt that already timed
  // out may still unlock, but mustn't overwrite a newer attempt's state.
  const attempt = useRef(0);
  const unlock = useCallback(async () => {
    const mine = ++attempt.current;
    setBusy(true);
    setError(null);
    // The Keystore call has been seen to never answer; don't leave the
    // buttons disabled forever waiting for it.
    const timer = setTimeout(() => {
      if (attempt.current !== mine) return;
      attempt.current++;
      splashHold.release();
      setBusy(false);
      setError("Unlock didn't respond. Tap Unlock to try again.");
    }, UNLOCK_TIMEOUT_MS);
    const stuck = setTimeout(() => {
      if (attempt.current !== mine) return;
      splashHold.release();
      setBusy(false);
    }, PROMPT_STUCK_MS);
    try {
      const stored = await loadIdentity();
      if (stored) {
        attempt.current++; // nothing after this may touch the screen's state
        clearTimeout(timer);
        clearTimeout(stuck);
        setOpening(true);
        // Let the spinner draw before the app starts building the rooms.
        requestAnimationFrame(() => setTimeout(() => onUnlock(stored), 0));
        return;
      }
      if (attempt.current !== mine) return;
      setError('Unlock cancelled.');
      // The lock screen has something to say: stop showing the splash over it.
      splashHold.release();
    } catch (e) {
      if (attempt.current !== mine) return;
      splashHold.release();
      setError(friendlyError(e as Error));
    } finally {
      clearTimeout(timer);
      clearTimeout(stuck);
      if (attempt.current === mine) setBusy(false);
    }
  }, [onUnlock]);

  // Ask for the fingerprint by itself, but only once the app is really in
  // front: asked any earlier (say, launched by the installer after an
  // update), the system prompt can silently never appear.
  useEffect(() => {
    let asked = false;
    let alive = true;
    let delay: ReturnType<typeof setTimeout> | null = null;
    const ask = () => {
      if (asked) return;
      asked = true;
      requestAnimationFrame(() => {
        delay = setTimeout(() => alive && unlock(), AUTO_PROMPT_DELAY_MS);
      });
    };
    if (AppState.currentState === 'active') ask();
    const sub = AppState.addEventListener(
      'change',
      st => st === 'active' && ask(),
    );
    // At launch React Native can report a non-active state and then switch
    // to active without a change event, so look again for a few seconds.
    const poll = setInterval(() => {
      if (AppState.currentState === 'active') ask();
    }, 250);
    // Never leave the splash covering the lock screen: if no prompt has
    // been asked for by now, show the Unlock button.
    const uncover = setTimeout(() => {
      clearInterval(poll);
      if (!asked) splashHold.release();
    }, 3000);
    return () => {
      alive = false;
      if (delay) clearTimeout(delay);
      clearInterval(poll);
      clearTimeout(uncover);
      sub.remove();
    };
  }, [unlock]);

  if (privacy) return <PrivacyPolicy onClose={() => setPrivacy(false)} />;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled">
      <View style={styles.center}>
        <LogoArt height={190} />
      </View>
      <View style={[styles.center, local.lockArea]}>
        {opening ? (
          <TypingDots color={theme.textMuted} accessibilityLabel="Opening" />
        ) : (
          <>
            <Icon name="lock" size={28} color={theme.textMuted} />
            <Pressable
              style={styles.primary}
              onPress={() => unlock()}
              disabled={busy}>
              <Text style={styles.primaryText}>Unlock</Text>
            </Pressable>
          </>
        )}
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable style={styles.secondary} onPress={onForget}>
        <Text style={styles.secondaryText}>
          Sign in to a different account…
        </Text>
      </Pressable>
      <PrivacyLink onPress={() => setPrivacy(true)} />
    </ScrollView>
  );
}

const local = StyleSheet.create({
  lockArea: {marginTop: 40, gap: 16},
});
