"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export interface SegmentedItem<T extends string> {
  id: T;
  label: React.ReactNode;
  hint?: string;
  /** small pulsing dot (e.g. the doc being streamed) */
  live?: boolean;
  disabled?: boolean;
}

/** The one compact switch used everywhere: a muted track with the selected item lifted onto the background. */
export function Segmented<T extends string>({
  value,
  onChange,
  items,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  items: SegmentedItem<T>[];
  label: string;
  className?: string;
}) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(v) => v[0] && onChange(v[0] as T)}
      spacing={0.5}
      aria-label={label}
      className={cn("h-6 shrink-0 rounded-md bg-muted p-0.5", className)}
    >
      {items.map((it) => (
        <ToggleGroupItem
          key={it.id}
          value={it.id}
          disabled={it.disabled}
          title={it.hint}
          aria-label={it.hint}
          className="h-5 min-w-0 gap-1.5 rounded-[5px] [&_svg]:opacity-60 [&_svg]:grayscale data-pressed:[&_svg]:opacity-100 data-pressed:[&_svg]:grayscale-0 px-2 text-[11px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground data-pressed:bg-background data-pressed:text-foreground data-pressed:ring-1 data-pressed:ring-border aria-pressed:bg-background"
        >
          {it.label}
          {it.live && <span className="size-1 animate-pulse rounded-full bg-foreground" />}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
