// Octicons (GitHub's icon set) under the names the views use. One place to change iconography.
import {
  AlertIcon,
  ArrowRightIcon,
  BeakerIcon,
  CheckCircleFillIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleIcon,
  CloudIcon,
  CopilotIcon,
  CopyIcon,
  DeviceDesktopIcon,
  DotFillIcon,
  DownloadIcon,
  FileCodeIcon,
  GitBranchIcon,
  GitCommitIcon,
  HomeIcon,
  LinkExternalIcon,
  MarkGithubIcon,
  MoonIcon,
  PackageIcon,
  PlayIcon,
  PlusIcon,
  RedoIcon,
  RocketIcon,
  SearchIcon,
  ShieldCheckIcon,
  SignInIcon,
  SquareFillIcon,
  StopIcon,
  SunIcon,
  SyncIcon,
  TerminalIcon,
  ToolsIcon,
  TrashIcon,
  UndoIcon,
  XCircleFillIcon,
  XIcon,
  type Icon as OcticonType,
} from "@primer/octicons-react";
import clsx from "clsx";

export type IconProps = { className?: string; size?: number; "aria-label"?: string };
type Octicon = OcticonType;

function wrap(Octicon: Octicon, displayName: string) {
  const Component = ({ className, size = 16, ...rest }: IconProps) => <Octicon size={size} className={className} {...rest} />;
  Component.displayName = displayName;
  return Component;
}

export const AlertCircle = wrap(StopIcon, "AlertCircle");
export const AlertTriangle = wrap(AlertIcon, "AlertTriangle");
export const ArrowRight = wrap(ArrowRightIcon, "ArrowRight");
export const Boxes = wrap(PackageIcon, "Boxes");
export const Check = wrap(CheckIcon, "Check");
export const CheckCircle2 = wrap(CheckCircleFillIcon, "CheckCircle2");
export const ChevronDown = wrap(ChevronDownIcon, "ChevronDown");
export const ChevronUp = wrap(ChevronUpIcon, "ChevronUp");
export const Circle = wrap(CircleIcon, "Circle");
export const CircleDot = wrap(DotFillIcon, "CircleDot");
export const Cloud = wrap(CloudIcon, "Cloud");
export const Copilot = wrap(CopilotIcon, "Copilot");
export const Copy = wrap(CopyIcon, "Copy");
export const Download = wrap(DownloadIcon, "Download");
export const ExternalLink = wrap(LinkExternalIcon, "ExternalLink");
export const FileCode2 = wrap(FileCodeIcon, "FileCode2");
export const FlaskConical = wrap(BeakerIcon, "FlaskConical");
export const GitBranch = wrap(GitBranchIcon, "GitBranch");
export const GitCommitHorizontal = wrap(GitCommitIcon, "GitCommitHorizontal");
export const GitHubMark = wrap(MarkGithubIcon, "GitHubMark");
export const Hammer = wrap(ToolsIcon, "Hammer");
export const Laptop = wrap(DeviceDesktopIcon, "Laptop");
export const LayoutDashboard = wrap(HomeIcon, "LayoutDashboard");
export const LogIn = wrap(SignInIcon, "LogIn");
export const Moon = wrap(MoonIcon, "Moon");
export const Play = wrap(PlayIcon, "Play");
export const Plus = wrap(PlusIcon, "Plus");
export const Redo = wrap(RedoIcon, "Redo");
export const RefreshCw = wrap(SyncIcon, "RefreshCw");
export const Rocket = wrap(RocketIcon, "Rocket");
export const RotateCcw = wrap(UndoIcon, "RotateCcw");
export const RotateCw = wrap(SyncIcon, "RotateCw");
export const Save = wrap(CheckIcon, "Save");
export const Search = wrap(SearchIcon, "Search");
export const ShieldCheck = wrap(ShieldCheckIcon, "ShieldCheck");
export const Square = wrap(SquareFillIcon, "Square");
export const Sun = wrap(SunIcon, "Sun");
export const TerminalSquare = wrap(TerminalIcon, "TerminalSquare");
export const Trash2 = wrap(TrashIcon, "Trash2");
export const Undo = wrap(UndoIcon, "Undo");
export const Wrench = wrap(ToolsIcon, "Wrench");
export const X = wrap(XIcon, "X");
export const XCircle = wrap(XCircleFillIcon, "XCircle");

/** Primer-style spinner (track plus rotating arc). */
export function Loader2({ className, size = 16 }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      className={clsx("gh-spinner shrink-0", className?.replace("animate-spin", ""))}
    >
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <path d="M15 8a7.002 7.002 0 00-7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
