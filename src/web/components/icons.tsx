import type { JSX, SVGProps } from 'react';
import {
  CreditCard as LucideCreditCard,
  FileAudio as LucideFileAudio,
  FileImage as LucideFileImage,
  FileSpreadsheet as LucideFileSpreadsheet,
  FileVideo as LucideFileVideo,
  Gamepad2 as LucideGamepad2,
  Hand as LucideHand,
  Heart as LucideHeart,
  Highlighter as LucideHighlighter,
  KeyRound as LucideKeyRound,
  Leaf as LucideLeaf,
  Merge as LucideMerge,
  ListOrdered as LucideListOrdered,
  MapPin as LucideMapPin,
  Monitor as LucideMonitor,
  MonitorSmartphone as LucideMonitorSmartphone,
  Moon as LucideMoon,
  Pause as LucidePause,
  Plane as LucidePlane,
  Presentation as LucidePresentation,
  Repeat as LucideRepeat,
  Route as LucideRoute,
  Scan as LucideScan,
  Utensils as LucideUtensils,
  Webhook as LucideWebhook,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { iconDrawings, type IconDrawing } from './icon-drawings';

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & {
  size?: number;
  solid?: boolean;
  strokeWidth?: number | string;
};

export type IconComponent = (props: IconProps) => JSX.Element;

function n8n(slug: keyof typeof iconDrawings): IconComponent {
  const drawing: IconDrawing = iconDrawings[slug];
  return function Icon({ size = 16, solid = false, strokeWidth, className, ...props }) {
    void strokeWidth;
    const small = size <= 14 ? (solid ? drawing.solid12 : drawing.outline12) : undefined;
    const path = small ?? (solid ? drawing.solid16 : drawing.outline16);
    const grid = small ? 12 : 16;
    const pixels = small ? 12 : size <= 18 ? 16 : size;
    const labelled = Boolean(props['aria-label'] || props['aria-labelledby'] || props.role);
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={pixels}
        height={pixels}
        viewBox={typeof path === 'string' ? `0 0 ${grid} ${grid}` : path.viewBox}
        fill="currentColor"
        aria-hidden={labelled ? undefined : true}
        className={cn('icon', className)}
        {...props}
      >
        <path d={typeof path === 'string' ? path : path.d} />
      </svg>
    );
  };
}

function lucide(Component: LucideIcon): IconComponent {
  return function Icon({ solid, ...props }) {
    void solid;
    return <Component {...props} />;
  };
}

export const AlertCircle = n8n('exclamation-circle');
export const ArrowDown = n8n('arrow-down');
export const ArrowLeft = n8n('arrow-left');
export const ArrowRight = n8n('arrow-right');
export const ArrowUp = n8n('arrow-up');
export const ArrowUpRight = n8n('arrow-up-right');
export const Bell = n8n('bell');
export const Bold = n8n('text-b');
export const Bot = n8n('robot');
export const Brain = n8n('brain');
export const Bug = n8n('bug');
export const CalendarClock = n8n('calendar');
export const ChartColumn = n8n('chart-bars');
export const Check = n8n('check');
export const ChevronDown = n8n('chevron-down');
export const ChevronLeft = n8n('chevron-left');
export const ChevronRight = n8n('chevron-right');
export const Circle = n8n('circle');
export const CircleAlert = n8n('exclamation-circle');
export const CircleCheck = n8n('check-circle');
export const CircleDashed = n8n('circle-dashed');
export const CircleHelp = n8n('question-circle');
export const CircleSlash = n8n('slash-circle');
export const Clock = n8n('clock');
export const Clock3 = n8n('clock');
export const Code = n8n('brackets-curly');
export const CodeXml = n8n('brackets-curly');
export const Copy = n8n('copy');
export const CornerUpLeft = n8n('arrow-u-up-left');
export const Database = n8n('database');
export const Download = n8n('arrow-circle-down');
export const Ellipsis = n8n('dots-horizontal');
export const ExternalLink = n8n('arrow-square-out');
export const Eye = n8n('eyes');
export const EyeOff = n8n('eyes-slash');
export const File = n8n('file');
export const FileArchive = n8n('archive');
export const FileCode = n8n('file-code');
export const FileJson = n8n('file-code');
export const FileText = n8n('file-text');
export const Filter = n8n('filter');
export const Flag = n8n('flag');
export const Folder = n8n('folder');
export const Globe = n8n('globe');
export const Globe2 = n8n('globe');
export const Hash = n8n('hash');
export const History = n8n('history');
export const Hourglass = n8n('hourglass');
export const Italic = n8n('text-italics');
export const LayoutGrid = n8n('grid');
export const Lightbulb = n8n('lightbulb');
export const Link2 = n8n('link');
export const List = n8n('list-bullets');
export const ListChecks = n8n('list-checks');
export const ListFilter = n8n('filter');
export const LoaderCircle = n8n('spinner');
export const LockKeyhole = n8n('lock-locked');
export const Maximize2 = n8n('arrows-out');
export const MessageCircle = n8n('chat-bubble');
export const MessageSquare = n8n('chat-bubble');
export const MessageSquarePlus = n8n('chat-bubble-plus');
export const MessageSquareText = n8n('chat-bubble');
export const Minimize2 = n8n('arrows-in');
export const Minus = n8n('minus');
export const MousePointer2 = n8n('mouse-pointer');
export const MousePointerClick = n8n('mouse-pointer');
export const PanelLeftClose = n8n('sidebar-left');
export const PanelLeftOpen = n8n('sidebar-left');
export const Paperclip = n8n('paperclip');
export const PenLine = n8n('pencil');
export const Pencil = n8n('pencil');
export const Play = n8n('play');
export const PlugZap = n8n('plug');
export const Plus = n8n('plus');
export const Power = n8n('power');
export const Radio = n8n('satellite-dish');
export const Redo2 = n8n('arrow-u-up-right');
export const RefreshCw = n8n('arrows-cw');
export const RotateCcw = n8n('arrows-ccw');
export const RotateCw = n8n('arrows-cw');
export const ScanSearch = n8n('binoculars');
export const Search = n8n('magnifying-glass');
export const Send = n8n('paperplane');
export const Server = n8n('hard-drive');
export const Settings = n8n('wrench');
export const ShieldCheck = n8n('shield');
export const SlidersHorizontal = n8n('toggles');
export const Smile = n8n('smiley-square');
export const SmilePlus = n8n('smiley-square');
export const Sparkles = n8n('sparkle');
export const Split = n8n('arrows-split');
export const Square = n8n('square');
export const Sun = n8n('sun');
export const Trash2 = n8n('trash');
export const Underline = n8n('text-underline');
export const Undo2 = n8n('arrow-u-up-left');
export const Unlink = n8n('link-slash');
export const Upload = n8n('cloud-arrow-up');
export const User = n8n('person');
export const UserRound = n8n('person');
export const Vault = n8n('vault');
export const Workflow = n8n('workflow');
export const Wrench = n8n('wrench');
export const X = n8n('x');
export const Zap = n8n('lightning');

export const CreditCard = lucide(LucideCreditCard);
export const FileAudio = lucide(LucideFileAudio);
export const FileImage = lucide(LucideFileImage);
export const FileSpreadsheet = lucide(LucideFileSpreadsheet);
export const FileVideo = lucide(LucideFileVideo);
export const Gamepad2 = lucide(LucideGamepad2);
export const Hand = lucide(LucideHand);
export const Heart = lucide(LucideHeart);
export const Highlighter = lucide(LucideHighlighter);
export const KeyRound = lucide(LucideKeyRound);
export const Leaf = lucide(LucideLeaf);
export const ListOrdered = lucide(LucideListOrdered);
export const MapPin = lucide(LucideMapPin);
export const Merge = lucide(LucideMerge);
export const Monitor = lucide(LucideMonitor);
export const MonitorSmartphone = lucide(LucideMonitorSmartphone);
export const Moon = lucide(LucideMoon);
export const Pause = lucide(LucidePause);
export const Plane = lucide(LucidePlane);
export const Presentation = lucide(LucidePresentation);
export const Repeat = lucide(LucideRepeat);
export const Route = lucide(LucideRoute);
export const Scan = lucide(LucideScan);
export const Utensils = lucide(LucideUtensils);
export const Webhook = lucide(LucideWebhook);
