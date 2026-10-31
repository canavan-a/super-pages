// The privacy policy (policy.ts) and terms of use (terms.ts) as screens: in
// the app from Settings and the welcome and lock screens, and on the web as
// pages of their own at /privacy and /terms.
import React, {useEffect, useMemo} from 'react';
import {
  BackHandler,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {Icon} from '../components/Icon';
import {Theme, useTheme} from '../theme';
import {
  CONTACT,
  POLICY,
  UPDATED,
  type PolicyBlock,
  type PolicySection,
} from './policy';
import {TERMS, TERMS_UPDATED} from './terms';

/** Text with **bold** runs. */
function Rich({
  text,
  style,
  bold,
}: {
  text: string;
  style: object;
  bold: object;
}) {
  const parts = text.split('**');
  return (
    <Text style={style}>
      {parts.map((part, i) =>
        i % 2 ? (
          <Text key={i} style={bold}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

function Block({
  b,
  styles,
}: {
  b: PolicyBlock;
  styles: ReturnType<typeof makeStyles>;
}) {
  if ('p' in b) return <Rich text={b.p} style={styles.p} bold={styles.bold} />;
  if ('list' in b) {
    return (
      <View style={styles.list}>
        {b.list.map((item, i) => (
          <View key={i} style={styles.item}>
            <Text style={styles.bullet}>•</Text>
            <Rich
              text={item}
              style={[styles.p, styles.itemText]}
              bold={styles.bold}
            />
          </View>
        ))}
      </View>
    );
  }
  // A table as stacked cards: rows of three columns don't fit a phone.
  return (
    <View style={styles.cards}>
      {b.table.rows.map((row, i) => (
        <View key={i} style={styles.card}>
          <Text style={styles.cardTitle}>{row[0]}</Text>
          {row.slice(1).map((cell, j) => (
            <Text key={j} style={styles.cardLine}>
              <Text style={styles.cardLabel}>{b.table.head[j + 1]}: </Text>
              {cell}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

/** onClose: shows a close button (in the app); omit on the web page. */
export function PrivacyPolicy({
  onClose,
}: {
  onClose?: () => void;
}): React.JSX.Element {
  return (
    <LegalDoc
      barTitle="Privacy policy"
      title="Super Pages Privacy Policy"
      updated={UPDATED}
      sections={POLICY}
      onClose={onClose}
    />
  );
}

/** The terms of use (terms.ts), shown like the privacy policy. */
export function TermsOfUse({
  onClose,
}: {
  onClose?: () => void;
}): React.JSX.Element {
  return (
    <LegalDoc
      barTitle="Terms of use"
      title="Super Pages Terms of Use"
      updated={TERMS_UPDATED}
      sections={TERMS}
      onClose={onClose}
    />
  );
}

function LegalDoc({
  barTitle,
  title,
  updated,
  sections,
  onClose,
}: {
  barTitle: string;
  title: string;
  updated: string;
  sections: PolicySection[];
  onClose?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  useEffect(() => {
    if (!onClose) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);
  return (
    <View style={styles.fill}>
      {onClose ? (
        <View style={styles.bar}>
          <Text style={styles.barTitle}>{barTitle}</Text>
          <Pressable
            onPress={onClose}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Close">
            <Icon name="close" size={20} color={theme.text} />
          </Pressable>
        </View>
      ) : null}
      <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
        {!onClose ? <Text style={styles.title}>{title}</Text> : null}
        <Text style={styles.updated}>Last updated {updated}</Text>
        {sections.map(section => (
          <View key={section.title} style={styles.section}>
            <Text style={styles.h2} accessibilityRole="header">
              {section.title}
            </Text>
            {section.blocks.map((b, i) => (
              <Block key={i} b={b} styles={styles} />
            ))}
          </View>
        ))}
        <Pressable
          onPress={() => Linking.openURL(`mailto:${CONTACT}`).catch(() => {})}>
          <Text style={styles.link}>{CONTACT}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

/** The quiet "Privacy policy" link at the bottom of a screen: small, muted, no button around it. */
export function PrivacyLink({
  onPress,
}: {
  onPress: () => void;
}): React.JSX.Element {
  return <QuietLink label="Privacy policy" onPress={onPress} />;
}

/** The terms and privacy links side by side, as at the bottom of Settings. */
export function LegalLinks({
  onTerms,
  onPrivacy,
}: {
  onTerms: () => void;
  onPrivacy: () => void;
}): React.JSX.Element {
  return (
    <View style={linkStyles.row}>
      <QuietLink label="Terms of use" onPress={onTerms} />
      <QuietLink label="Privacy policy" onPress={onPrivacy} />
    </View>
  );
}

/**
 * Under the welcome screen's buttons: continuing is agreeing to the terms
 * (App Review asks for that before anyone can post).
 */
export function AgreeToTerms({
  onTerms,
  onPrivacy,
}: {
  onTerms: () => void;
  onPrivacy: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const muted = [linkStyles.text, {color: theme.textMuted}];
  const link = [muted, linkStyles.underline];
  return (
    <Text style={[muted, linkStyles.agree]}>
      By continuing you agree to the{' '}
      <Text style={link} onPress={onTerms} accessibilityRole="link">
        Terms of use
      </Text>{' '}
      and{' '}
      <Text style={link} onPress={onPrivacy} accessibilityRole="link">
        Privacy policy
      </Text>
      .
    </Text>
  );
}

function QuietLink({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="link"
      style={linkStyles.wrap}>
      <Text style={[linkStyles.text, {color: theme.textMuted}]}>{label}</Text>
    </Pressable>
  );
}

const linkStyles = StyleSheet.create({
  wrap: {alignSelf: 'center', paddingVertical: 10, marginTop: 8},
  row: {flexDirection: 'row', justifyContent: 'center', gap: 20},
  text: {fontSize: 11, opacity: 0.6},
  underline: {textDecorationLine: 'underline'},
  agree: {
    textAlign: 'center',
    paddingVertical: 10,
    marginTop: 8,
    lineHeight: 16,
  },
});

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    fill: {flex: 1, backgroundColor: theme.bg},
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    barTitle: {fontSize: 16, fontWeight: '700', color: theme.text},
    content: {
      padding: 20,
      paddingBottom: 48,
      maxWidth: 720,
      width: '100%',
      alignSelf: 'center',
    },
    title: {
      fontSize: 24,
      fontWeight: '800',
      color: theme.text,
      marginBottom: 4,
    },
    updated: {fontSize: 12, color: theme.textMuted, marginBottom: 8},
    section: {marginTop: 18, gap: 8},
    h2: {fontSize: 17, fontWeight: '700', color: theme.text},
    p: {fontSize: 14, lineHeight: 21, color: theme.text},
    bold: {fontWeight: '700'},
    list: {gap: 6},
    item: {flexDirection: 'row', gap: 8},
    bullet: {fontSize: 14, lineHeight: 21, color: theme.textMuted},
    itemText: {flex: 1},
    cards: {gap: 8},
    card: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      padding: 12,
      backgroundColor: theme.surface,
      gap: 4,
    },
    cardTitle: {fontSize: 14, fontWeight: '700', color: theme.text},
    cardLine: {fontSize: 13, lineHeight: 19, color: theme.text},
    cardLabel: {color: theme.textMuted},
    link: {marginTop: 20, fontSize: 14, color: theme.primary},
  });
}
