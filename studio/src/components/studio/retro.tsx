"use client";

/**
 * Win95/98 accent icons: the original pixel icons from @react95/icons, plus two animated ones drawn here as
 * pixel SVG (a spinning globe, the hourglass). Always crisp: integer sizes only (16 / 32), crispEdges.
 */
import { memo } from "react";
import { Binoc } from "@react95/icons/Binoc";
import { Computer } from "@react95/icons/Computer";
import { Explorer100 } from "@react95/icons/Explorer100";
import { FileText } from "@react95/icons/FileText";
import { FolderOpen } from "@react95/icons/FolderOpen";
import { Globe as Globe95 } from "@react95/icons/Globe";
import { HelpBook } from "@react95/icons/HelpBook";
import { Ie } from "@react95/icons/Ie";
import { Mplayer10 } from "@react95/icons/Mplayer10";
import { MsDos } from "@react95/icons/MsDos";
import { Download } from "@react95/icons/Download";
import { Sysmon1000 } from "@react95/icons/Sysmon1000";
import { Network } from "@react95/icons/Network";
import { Network3 } from "@react95/icons/Network3";
import { Notepad } from "@react95/icons/Notepad";
import { Pen } from "@react95/icons/Pen";
import { Regedit } from "@react95/icons/Regedit";
import { Settings } from "@react95/icons/Settings";
import { Tick } from "@react95/icons/Tick";
import { Wordpad } from "@react95/icons/Wordpad";
import { cn } from "@/lib/utils";

const ICONS = {
  globe: Globe95, ie: Ie, research: HelpBook, find: Binoc, schema: FileText, expected: Wordpad, manifest: Notepad,
  machine: Network, net: Network3, run: Mplayer10, gears: Settings, parity: Tick, highlight: Pen, view: Regedit,
  both: Explorer100, computer: Computer, folder: FolderOpen, msdos: MsDos, download: Download, bench: Sysmon1000,
} as const;
export type RetroName = keyof typeof ICONS | "spinning-globe" | "hourglass";

/** icons whose black line art needs inverting on dark backgrounds */
const MONO = new Set<RetroName>(["parity"]);

const crisp = "shrink-0 select-none [image-rendering:pixelated] [shape-rendering:crispEdges]";
/** explicit size classes: parent `[&_svg]:size-*` rules (buttons, toggles) must never rescale the pixels */
const px = (size: number) => (size >= 32 ? "size-8" : "size-4");

export const Retro = memo(function Retro({ name, size = 16, className }: { name: RetroName; size?: 16 | 32; className?: string }) {
  if (name === "spinning-globe") return <SpinningGlobe size={size} className={className} />;
  if (name === "hourglass") return <Hourglass size={size} className={className} />;
  const Icon = ICONS[name] as React.ComponentType<React.SVGProps<SVGSVGElement> & { variant?: string }>;
  // every icon here ships a 16×16 variant; 32 scales it ×2 when no 32×32 exists, which stays pixel-exact
  const native32 = size === 32 && !["ie", "find", "parity", "highlight", "download"].includes(name);
  return (
    <Icon
      aria-hidden
      variant={name === "msdos" ? (size === 32 ? "32x32_32" : "16x16_32") : name === "bench" ? "32x32_4" : native32 ? "32x32_4" : name === "ie" ? "16x16_8" : "16x16_4"}
      width={size}
      height={size}
      className={cn(crisp, px(size), MONO.has(name) && "dark:invert", className)}
    />
  );
});

// ---------------------------------------------------------------- animated, hand-drawn pixel art

/** One 16-px wide strip of land, scrolled behind a round mask: the classic spinning globe. */
const LAND: [number, number, number, number][] = [
  [1, 3, 3, 2], [0, 5, 4, 2], [1, 7, 3, 2], [2, 9, 2, 3], [3, 12, 1, 1],
  [7, 2, 3, 1], [6, 3, 5, 2], [7, 5, 3, 1], [8, 6, 2, 4], [9, 10, 1, 1],
  [12, 4, 3, 2], [11, 6, 4, 1], [13, 7, 2, 2], [12, 11, 3, 2],
];
const FRAMES = Array.from({ length: 16 }, (_, i) => `${-i} 0`).join(";");

export function SpinningGlobe({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" className={cn(crisp, px(size), className)}>
      <defs>
        <clipPath id="r95-globe"><circle cx="8" cy="8" r="6.6" /></clipPath>
      </defs>
      <g clipPath="url(#r95-globe)">
        <rect width="16" height="16" fill="#0000a8" />
        <rect x="2" y="2" width="5" height="3" fill="#0054e3" />
        <g fill="#00a800">
          <animateTransform attributeName="transform" type="translate" values={FRAMES} dur="1.6s" calcMode="discrete" repeatCount="indefinite" />
          {[0, 16].flatMap((o) => LAND.map(([x, y, w, h], i) => <rect key={`${o}-${i}`} x={x + o} y={y} width={w} height={h} />))}
        </g>
        <path d="M2 8h12" stroke="#5cf" strokeOpacity=".45" strokeWidth="1" />
      </g>
      <circle cx="8" cy="8" r="7" fill="none" stroke="#000" strokeWidth="1" />
    </svg>
  );
}

/** The Win95 wait cursor: sand runs down, then the glass flips. */
export function Hourglass({ size = 16, className }: { size?: number; className?: string }) {
  // 8 sand frames + a flip; heights are pixels of sand in each bulb
  const top = [5, 4, 4, 3, 2, 2, 1, 0];
  const dur = "2.4s";
  const keyTimes = Array.from({ length: top.length + 1 }, (_, i) => (i / (top.length + 1)).toFixed(3)).join(";");
  const topY = [...top.map((h) => 7 - h), 7].join(";");
  const topH = [...top, 0].join(";");
  const botY = [...top.map((h) => 14 - (5 - h)), 9].join(";");
  const botH = [...top.map((h) => 5 - h), 5].join(";");
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" className={cn(crisp, px(size), className)}>
      <defs>
        <clipPath id="r95-hg-top"><path d="M4 3h8v2l-3 3h-2l-3-3z" /></clipPath>
        <clipPath id="r95-hg-bot"><path d="M7 8h2l3 3v3h-8v-3z" /></clipPath>
      </defs>
      <g>
        <animateTransform attributeName="transform" type="rotate" values="0 8 8;180 8 8" keyTimes={`0;${(top.length / (top.length + 1)).toFixed(3)}`} dur={dur} calcMode="discrete" repeatCount="indefinite" />
        <rect x="3" y="1" width="10" height="2" fill="#000" />
        <rect x="3" y="13" width="10" height="2" fill="#000" />
        <path d="M4 3h8v2l-3 3 3 3v3h-8v-3l3-3-3-3z" fill="#fff" stroke="#000" strokeWidth="1" />
        <rect x="4" width="8" fill="#c0a000" clipPath="url(#r95-hg-top)">
          <animate attributeName="y" values={topY} keyTimes={keyTimes} dur={dur} calcMode="discrete" repeatCount="indefinite" />
          <animate attributeName="height" values={topH} keyTimes={keyTimes} dur={dur} calcMode="discrete" repeatCount="indefinite" />
        </rect>
        <rect x="4" width="8" fill="#c0a000" clipPath="url(#r95-hg-bot)">
          <animate attributeName="y" values={botY} keyTimes={keyTimes} dur={dur} calcMode="discrete" repeatCount="indefinite" />
          <animate attributeName="height" values={botH} keyTimes={keyTimes} dur={dur} calcMode="discrete" repeatCount="indefinite" />
        </rect>
        <rect x="7.5" y="8" width="1" height="4" fill="#c0a000">
          <animate attributeName="opacity" values="1;1;1;1;1;1;1;0;0" keyTimes={keyTimes} dur={dur} calcMode="discrete" repeatCount="indefinite" />
        </rect>
      </g>
    </svg>
  );
}
