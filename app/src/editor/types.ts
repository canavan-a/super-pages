import type {DocKind} from '../crypto';
import type {Theme} from '../theme';
import type {EditorColors, EditorUser, Peer, Snapshot} from './core';

export type {EditorUser, Peer, Snapshot};

export interface DocEditorProps {
  /** A page of text (the default) or a canvas. */
  kind?: DocKind;
  /** The page as it was opened. Later changes come from the editor itself. */
  markdown: string;
  /** The shared state as it was opened (b64url), or null for a markdown-only page. */
  y: string | null;
  title: string;
  user: EditorUser;
  readOnly: boolean;
  autoFocus?: boolean;
  onChange: (markdown: string, local: boolean) => void;
  onTitle: (title: string) => void;
  onLocalChange: (update: string) => void;
  onAware: (aware: string) => void;
  onPickImage: () => void;
  resolveImage: (url: string) => Promise<string>;
  onOpenLink?: (href: string) => void;
}

export interface DocEditorRef {
  insertImage(url: string, alt?: string): void;
  applyChanges(updates: string[]): void;
  setPeers(peers: Peer[]): void;
  setTitle(title: string): void;
  snapshot(): Promise<Snapshot>;
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
