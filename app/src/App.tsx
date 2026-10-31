import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  AppState,
  AppStateStatus,
  BackHandler,
  Dimensions,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TextStyle,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import {api, Me, Member} from './api';
import {useThemedAppIcon} from './appIcon';
import {AvatarStack, PresenceStack} from './components/AvatarStack';
import {CrashScreen} from './components/CrashScreen';
import {Icon, IconName} from './components/Icon';
import {PixelField} from './components/PixelField';
import {PortalOutlet, PortalProvider} from './components/Portal';
import {parseShareLink} from './crypto';
import {hasStoredIdentity, HAS_LOCK, loadIdentity, Stored} from './keystore';
import {LogoLine} from './logo/LogoArt';
import {SplashGate} from './logo/SplashGate';
import {splashHold} from './logo/splashHold';
import {refreshDocs, resetStore, useStore} from './pagesStore';
import {PrivacyPolicy, TermsOfUse} from './privacy/PrivacyPolicy';
import {applyUpdateIfSafe, setThemeColor, startPwa} from './pwa/pwa';
import {Route} from './routes';
import {DocScreen} from './screens/DocScreen';
import {DocSettingsScreen} from './screens/DocSettingsScreen';
import {DocsScreen} from './screens/DocsScreen';
import {JoinScreen} from './screens/JoinScreen';
import {LockScreen} from './screens/LockScreen';
import {OnboardingScreen} from './screens/OnboardingScreen';
import {SettingsScreen} from './screens/SettingsScreen';
import {session} from './session';
import {settingsStore} from './settings';
import {Theme, ThemeProvider, useTheme} from './theme';

const TITLES: Record<Route['name'], string> = {
  home: 'Super Pages',
  doc: 'Page',
  docSettings: 'Sharing',
  join: 'Shared page',
  settings: 'Settings',
  privacy: 'Privacy policy',
  terms: 'Terms of use',
};

// Screens report their own title/subtitle/actions up here so they render in
// the one top bar.
/** One open copy of the page (a tab, a device), shown as its person's face. */
export interface HeaderViewer {
  key: string;
  user: string;
  name: string;
  avatar: string | null;
  /** Its cursor color, drawn as a ring around the face. */
  color: string;
}

export interface HeaderInfo {
  title: string;
  /** Makes the title an input (shown as "Untitled" while empty); called as it's typed. */
  onRename?: (title: string) => void;
  subtitle?: string;
  /** Who the page is shared with, drawn as a cluster beside the actions. */
  members?: Member[];
  /** Who has the page open right now; shown instead of members. */
  viewers?: HeaderViewer[];
  actions?: {label: string; onPress: () => void; icon: IconName}[];
}

type Gate = 'loading' | 'onboard' | 'locked' | 'ready';

/** A share link the app was opened with, kept until there's an account to join with. */
function initialShareLink(): string | null {
  if (
    Platform.OS === 'web' &&
    typeof location !== 'undefined' &&
    /^\/s\//.test(location.pathname)
  ) {
    return location.href;
  }
  return null;
}

/**
 * Decides what's on screen before any page is: sign-in (no key on this
 * device), the lock screen (a phone's key not unlocked yet, or locked again
 * after time away), or the app itself.
 */
function AccountGate(): React.JSX.Element {
  const theme = useTheme();
  const [gate, setGate] = useState<Gate>('loading');
  const [pendingLink, setPendingLink] = useState<string | null>(
    initialShareLink,
  );
  const backgroundedAt = useRef<number | null>(null);

  const open = useCallback(
    async (server: string, entropy: Uint8Array, me: Me | null) => {
      session.unlock(server, entropy, me);
      setGate('ready');
      if (!me) {
        api
          .me(server, session.require().account)
          .then(m => session.setMe(m))
          .catch(() => {});
      }
      refreshDocs().catch(() => {});
    },
    [],
  );

  // The launch splash doubles as the loading screen (see splashHold).
  useEffect(() => {
    splashHold.hold();
    (async () => {
      await settingsStore.load();
      if (!(await hasStoredIdentity())) {
        setGate('onboard');
        return;
      }
      if (HAS_LOCK) {
        setGate('locked');
        return;
      }
      // The browser: a remembered key opens without a prompt.
      const stored = await loadIdentity();
      if (stored) open(stored.server, stored.entropy, null);
      else setGate('onboard');
    })();
  }, [open]);

  useEffect(() => {
    if (gate === 'onboard') splashHold.release();
  }, [gate]);

  // Phones lock again after time in the background.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background') {
        backgroundedAt.current = Date.now();
      } else if (state === 'active' && backgroundedAt.current !== null) {
        const away = Date.now() - backgroundedAt.current;
        backgroundedAt.current = null;
        if (
          session.get() &&
          away >= settingsStore.get().lockAfterMin * 60_000
        ) {
          setGate(g => (g === 'ready' ? 'locked' : g));
        }
      }
    });
    return () => sub.remove();
  }, []);

  // Share links opened from outside (superpages:// or https://…/s/…).
  useEffect(() => {
    const handle = (url: string | null) => {
      if (url && parseShareLink(url)) setPendingLink(url);
    };
    Linking.getInitialURL()
      .then(handle)
      .catch(() => {});
    const sub = Linking.addEventListener('url', e => handle(e.url));
    return () => sub.remove();
  }, []);

  if (gate === 'loading') {
    return (
      <View style={[styles.fill, {backgroundColor: theme.bg}]}>
        <ActivityIndicator color={theme.textMuted} />
      </View>
    );
  }
  if (gate === 'onboard')
    return (
      <OnboardingScreen
        onDone={(server, entropy, me) => open(server, entropy, me)}
      />
    );
  if (gate === 'locked') {
    return (
      <LockScreen
        onUnlock={(stored: Stored) => {
          if (session.get()) setGate('ready');
          else open(stored.server, stored.entropy, null);
        }}
        onForget={() => {
          resetStore();
          session.clear();
          setGate('onboard');
        }}
      />
    );
  }
  return (
    <AppInner
      pendingLink={pendingLink}
      onLinkHandled={() => setPendingLink(null)}
      onSignedOut={() => setGate('onboard')}
    />
  );
}

function AppInner({
  pendingLink,
  onLinkHandled,
  onSignedOut,
}: {
  pendingLink: string | null;
  onLinkHandled: () => void;
  onSignedOut: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  useThemedAppIcon();
  const styles = makeStyles(theme);
  const loaded = useStore(s => s.loaded);
  useEffect(() => {
    if (loaded) splashHold.release();
  }, [loaded]);
  const [route, setRoute] = useState<Route>({name: 'home'});
  const [headerInfo, setHeaderInfo] = useState<HeaderInfo | null>(null);
  const [me, setMe] = useState(session.get()?.me ?? null);
  useEffect(() => session.subscribe(s => setMe(s?.me ?? null)), []);

  const navigate = useCallback((next: Route) => {
    setHeaderInfo(null);
    setRoute(next);
    if (
      Platform.OS === 'web' &&
      typeof history !== 'undefined' &&
      location.pathname !== '/'
    ) {
      // Drop /s/<link> from the address bar once it's been handled.
      history.replaceState(null, '', '/');
    }
  }, []);

  useEffect(() => {
    if (pendingLink) {
      navigate({name: 'join', link: pendingLink});
      onLinkHandled();
    }
  }, [pendingLink, navigate, onLinkHandled]);

  const goBack = useCallback(() => {
    if (route.name === 'docSettings') navigate({name: 'doc', id: route.id});
    else if (route.name === 'privacy' || route.name === 'terms')
      navigate({name: 'settings'});
    else {
      navigate({name: 'home'});
      refreshDocs().catch(() => {});
    }
  }, [route, navigate]);

  // Coming back to the app: catch up on what changed.
  useEffect(() => {
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active' && session.get()) refreshDocs().catch(() => {});
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route.name === 'home') return false;
      goBack();
      return true;
    });
    return () => sub.remove();
  }, [route, goBack]);

  const showDocHeader =
    (route.name === 'doc' || route.name === 'docSettings') && headerInfo;

  return (
    <View style={styles.container}>
      <StatusBar
        barStyle={
          theme.name === 'light' || theme.name === 'sepia'
            ? 'dark-content'
            : 'light-content'
        }
      />
      <View style={styles.header}>
        <PixelField />
        {route.name !== 'home' && (
          <Pressable
            style={styles.headerBack}
            onPress={goBack}
            accessibilityLabel="Back"
            hitSlop={8}>
            <Icon name="chevron-left" size={22} color={theme.text} />
          </Pressable>
        )}
        <View style={styles.headerTextArea}>
          {route.name === 'home' ? (
            <LogoLine height={22} />
          ) : showDocHeader && headerInfo!.onRename ? (
            <TitleInput
              value={headerInfo!.title}
              onChange={headerInfo!.onRename}
              style={styles.headerTitle}
              placeholderColor={theme.textMuted}
            />
          ) : (
            <Text style={styles.headerTitle} numberOfLines={1}>
              {showDocHeader && headerInfo!.title
                ? headerInfo!.title
                : TITLES[route.name]}
            </Text>
          )}
          {showDocHeader && headerInfo!.subtitle ? (
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {headerInfo!.subtitle}
            </Text>
          ) : null}
        </View>
        {showDocHeader && headerInfo!.viewers ? (
          <Pressable
            style={styles.headerStack}
            onPress={() =>
              route.name === 'doc' &&
              navigate({name: 'docSettings', id: route.id})
            }
            accessibilityLabel={`Open now: ${headerInfo!.viewers
              .map(v => v.name)
              .join(', ')}`}>
            <PresenceStack viewers={headerInfo!.viewers} size={28} />
          </Pressable>
        ) : null}
        {showDocHeader && !headerInfo!.viewers && headerInfo!.members && (
          <Pressable
            style={styles.headerStack}
            onPress={() =>
              route.name === 'doc' &&
              navigate({name: 'docSettings', id: route.id})
            }
            accessibilityLabel="Shared with">
            <AvatarStack
              members={headerInfo!.members}
              exclude={me?.id}
              size={26}
              ring={theme.bg}
            />
          </Pressable>
        )}
        {showDocHeader && headerInfo!.actions
          ? headerInfo!.actions.map(a => (
              <Pressable
                key={a.label}
                style={styles.headerIconButton}
                onPress={a.onPress}
                accessibilityLabel={a.label}>
                <Icon name={a.icon} size={20} color={theme.text} />
              </Pressable>
            ))
          : null}
        {route.name === 'home' && (
          <Pressable
            style={styles.headerIconButton}
            onPress={() => navigate({name: 'settings'})}
            accessibilityLabel="Settings">
            <Icon name="gear" size={20} color={theme.text} />
          </Pressable>
        )}
      </View>

      <View style={styles.body}>
        {route.name === 'home' && <DocsScreen onNavigate={navigate} />}
        {route.name === 'doc' && (
          <DocScreen
            key={route.id}
            id={route.id}
            fresh={route.fresh}
            onNavigate={navigate}
            onHeaderChange={setHeaderInfo}
          />
        )}
        {route.name === 'docSettings' && (
          <DocSettingsScreen
            key={route.id}
            id={route.id}
            onNavigate={navigate}
          />
        )}
        {route.name === 'join' && (
          <JoinScreen
            key={route.link}
            link={route.link}
            onNavigate={navigate}
          />
        )}
        {route.name === 'settings' && (
          <SettingsScreen
            onSignedOut={onSignedOut}
            onOpenPrivacy={() => navigate({name: 'privacy'})}
            onOpenTerms={() => navigate({name: 'terms'})}
          />
        )}
        {route.name === 'privacy' && <PrivacyPolicy />}
        {route.name === 'terms' && <TermsOfUse />}
      </View>
      {/* Modal sheets (Overlay modal), over everything. */}
      <PortalOutlet />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  fillBox: {flex: 1},
});

/**
 * The page title in the top bar, edited in place. It keeps what's typed
 * itself, so the round trip through the screen's header never moves the
 * cursor, and only takes the value from outside while it isn't focused.
 */
function TitleInput({
  value,
  onChange,
  style,
  placeholderColor,
}: {
  value: string;
  onChange: (v: string) => void;
  style: TextStyle;
  placeholderColor: string;
}): React.JSX.Element {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  return (
    <TextInput
      value={text}
      onChangeText={t => {
        setText(t);
        onChange(t);
      }}
      onFocus={() => (focused.current = true)}
      onBlur={() => (focused.current = false)}
      placeholder="Untitled"
      placeholderTextColor={placeholderColor}
      accessibilityLabel="Page title"
      maxLength={120}
      returnKeyType="done"
      blurOnSubmit
      style={[style, styles2.titleInput]}
    />
  );
}

const styles2 = StyleSheet.create({
  titleInput: {
    padding: 0,
    margin: 0,
    borderWidth: 0,
    minWidth: 0,
  },
});

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {flex: 1, backgroundColor: theme.bg},
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 10,
      minHeight: 56,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    headerBack: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
      marginLeft: -6,
    },
    headerTextArea: {flex: 1, minWidth: 0},
    headerTitle: {fontSize: 16, fontWeight: '700', color: theme.text},
    headerSubtitle: {fontSize: 11, color: theme.textMuted, marginTop: 1},
    headerStack: {paddingHorizontal: 4},
    headerIconButton: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    body: {flex: 1, backgroundColor: theme.bg},
  });
}

// Web: the installable app's service worker and update policy (src/pwa).
// A new version only switches in (a reload) when nothing is lost.
const launchedAt = Date.now();
startPwa(
  () =>
    !!session.get() ||
    (typeof document !== 'undefined' &&
      document.visibilityState === 'visible' &&
      Date.now() - launchedAt > 8000),
);
session.subscribe(s => {
  if (!s) applyUpdateIfSafe();
});

/** Keeps the browser's status bar / title bar in the theme's background (web). */
function ThemeChrome(): null {
  const theme = useTheme();
  useEffect(() => setThemeColor(theme.bg), [theme.bg]);
  return null;
}

/**
 * Android draws the app edge to edge, so keep everything clear of the
 * system bars with the real insets, and lift it above the keyboard. The web
 * build does both in index.html.
 */
function SystemBars({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [keyboard, setKeyboard] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', e => {
      const covered =
        Dimensions.get('screen').height - e.endCoordinates.screenY;
      setKeyboard(
        covered > 0 ? covered : e.endCoordinates.height + insets.bottom,
      );
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [insets.bottom]);
  if (Platform.OS === 'web') return <>{children}</>;
  return (
    <View
      style={[
        styles.fillBox,
        {
          backgroundColor: theme.bg,
          paddingTop: insets.top,
          paddingBottom: keyboard || insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}>
      {children}
    </View>
  );
}

function App(): React.JSX.Element {
  return (
    <CrashScreen>
      <SafeAreaProvider>
        <ThemeProvider>
          <ThemeChrome />
          <SystemBars>
            <PortalProvider>
              <SplashGate>
                <AccountGate />
              </SplashGate>
            </PortalProvider>
          </SystemBars>
        </ThemeProvider>
      </SafeAreaProvider>
    </CrashScreen>
  );
}

export default App;
