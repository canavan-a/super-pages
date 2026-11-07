import {Alert} from 'react-native';

// Alert.alert is callback-based (onPress only fires once the user actually
// taps a button), while window.confirm is synchronous — this normalizes
// both into "call onConfirm only if the user actually confirmed" so a
// destructive action never runs just because a confirm dialog appeared.
export function platformConfirm(
  title: string,
  message: string,
  confirmLabel: string,
  onConfirm: () => void,
  destructive = true,
  onCancel?: () => void,
): void {
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    if (window.confirm(message)) {
      onConfirm();
    } else {
      onCancel?.();
    }
    return;
  }
  Alert.alert(
    title,
    message,
    [
      {text: 'Cancel', style: 'cancel', onPress: onCancel},
      {
        text: confirmLabel,
        style: destructive ? 'destructive' : 'default',
        onPress: onConfirm,
      },
    ],
    {cancelable: true, onDismiss: onCancel},
  );
}
