import type {Theme} from '../theme';
import type {EditorColors} from './core';

export interface DocEditorProps {
  /** The page as it was opened. Later changes come from the editor itself. */
  markdown: string;
  readOnly: boolean;
  autoFocus?: boolean;
  onChange: (markdown: string) => void;
  onPickImage: () => void;
  resolveImage: (url: string) => Promise<string>;
  onOpenLink?: (href: string) => void;
}

export interface DocEditorRef {
  insertImage(url: string, alt?: string): void;
}

export function colorsFor(t: Theme): EditorColors {
  return {
    bg: t.bg,
    surface: t.surface,
    surfaceAlt: t.surfaceAlt,
    border: t.border,
    text: t.text,
    textMuted: t.textMuted,
    primary: t.primary,
    primaryText: t.primaryText,
    codeBg: t.codeBg,
    inlineCodeBg: t.inlineCodeBg,
  };
}
