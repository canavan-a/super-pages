import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import type {Role} from '../api';
import {Theme, useTheme} from '../theme';
import {Icon, IconName} from './Icon';

export const ROLES: {
  role: Role;
  label: string;
  icon: IconName;
  hint: string;
}[] = [
  {
    role: 'owner',
    label: 'Owner',
    icon: 'crown',
    hint: 'Full control: edit, share, change roles, delete',
  },
  {
    role: 'edit',
    label: 'Edit',
    icon: 'pencil',
    hint: 'Can edit. Can’t share or delete',
  },
  {role: 'view', label: 'View', icon: 'eye', hint: 'Can read only'},
];

export const roleLabel = (r: Role) => ROLES.find(x => x.role === r)!.label;

/** Three segments: Owner / Edit / View. */
export function RolePicker({
  value,
  onChange,
  roles = ['owner', 'edit', 'view'],
  disabled,
}: {
  value: Role;
  onChange: (r: Role) => void;
  roles?: Role[];
  disabled?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return (
    <View style={styles.row} accessibilityRole="radiogroup">
      {ROLES.filter(r => roles.includes(r.role)).map(r => {
        const on = r.role === value;
        return (
          <Pressable
            key={r.role}
            style={[
              styles.seg,
              on && styles.segOn,
              disabled && styles.disabled,
            ]}
            onPress={() => !disabled && onChange(r.role)}
            accessibilityRole="radio"
            accessibilityState={{selected: on, disabled}}
            accessibilityHint={r.hint}>
            <Icon
              name={r.icon}
              size={14}
              color={on ? theme.primaryText : theme.textMuted}
            />
            <Text style={[styles.text, on && styles.textOn]}>{r.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.border,
      overflow: 'hidden',
    },
    seg: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 6,
      backgroundColor: theme.surface,
    },
    segOn: {backgroundColor: theme.primary},
    text: {fontSize: 12, fontWeight: '600', color: theme.textMuted},
    textOn: {color: theme.primaryText},
    disabled: {opacity: 0.5},
  });
}
