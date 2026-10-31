// Copy text, on phones (React Native's Clipboard) and in the browser.
import {Clipboard, Platform} from 'react-native';

export async function copyText(text: string): Promise<void> {
  if (
    Platform.OS === 'web' &&
    typeof navigator !== 'undefined' &&
    navigator.clipboard
  ) {
    await navigator.clipboard.writeText(text);
    return;
  }
  Clipboard.setString(text);
}
