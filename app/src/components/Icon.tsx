import React from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  File,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  Link,
  Lock,
  LucideIcon,
  LogOut,
  Mail,
  MoreVertical,
  Plus,
  Paperclip,
  RefreshCw,
  Rows3,
  Pencil,
  Eye,
  Bold,
  Italic,
  List,
  ListOrdered,
  ListChecks,
  Heading1,
  Heading2,
  Quote,
  Code,
  Crown,
  Settings,
  Shield,
  Trash2,
  TriangleAlert,
  UserPlus,
  Users,
  X,
} from 'lucide-react-native';

// lucide-react-native is the icon set used everywhere in the app, the same
// one super-badger uses, so both apps draw icons the same way. It renders
// through react-native-svg, whose web resolution is fixed in vite.config.ts.
export type IconName =
  | 'kebab'
  | 'gear'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'trash'
  | 'close'
  | 'check'
  | 'copy'
  | 'pencil'
  | 'eye'
  | 'crown'
  | 'image'
  | 'mail'
  | 'logout'
  | 'bold'
  | 'italic'
  | 'list'
  | 'list-ordered'
  | 'list-checks'
  | 'h1'
  | 'h2'
  | 'quote'
  | 'code'
  | 'attach'
  | 'file'
  | 'download'
  | 'invite'
  | 'members'
  | 'shield'
  | 'lock'
  | 'link'
  | 'plus'
  | 'info'
  | 'warning'
  | 'retry'
  | 'grid'
  | 'rows';

const ICONS: Record<IconName, LucideIcon> = {
  kebab: MoreVertical,
  gear: Settings,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  trash: Trash2,
  close: X,
  check: Check,
  copy: Copy,
  pencil: Pencil,
  eye: Eye,
  crown: Crown,
  image: ImageIcon,
  mail: Mail,
  logout: LogOut,
  bold: Bold,
  italic: Italic,
  list: List,
  'list-ordered': ListOrdered,
  'list-checks': ListChecks,
  h1: Heading1,
  h2: Heading2,
  quote: Quote,
  code: Code,
  attach: Paperclip,
  file: File,
  download: Download,
  invite: UserPlus,
  members: Users,
  shield: Shield,
  lock: Lock,
  link: Link,
  plus: Plus,
  info: Info,
  warning: TriangleAlert,
  retry: RefreshCw,
  grid: LayoutGrid,
  rows: Rows3,
};

export function Icon({
  name,
  size = 20,
  color = '#000',
  strokeWidth = 2,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}): React.JSX.Element {
  const IconComponent = ICONS[name];
  return (
    <IconComponent
      size={size}
      color={color}
      strokeWidth={strokeWidth}
      fill="none"
    />
  );
}
