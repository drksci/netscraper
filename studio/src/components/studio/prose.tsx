import { Fragment } from "react";
import { cn } from "@/lib/utils";

/** `code` and **bold** inside a line. */
function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith("`")
      ? <code key={i++} className="rounded-[4px] bg-muted px-1 py-px font-mono text-[0.85em]">{t.slice(1, -1)}</code>
      : <strong key={i++} className="font-medium text-foreground">{t.slice(2, -2)}</strong>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block = { kind: "p" | "h" | "ul" | "ol" | "pre"; lines: string[] };

function blocks(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("```")) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      out.push({ kind: "pre", lines: body });
      continue;
    }
    if (!l.trim()) { out.push({ kind: "p", lines: [] }); continue; }
    const kind: Block["kind"] = /^#{1,6}\s/.test(l) ? "h" : /^\s*[-*•]\s/.test(l) ? "ul" : /^\s*\d+[.)]\s/.test(l) ? "ol" : "p";
    const text = kind === "h" ? l.replace(/^#+\s*/, "") : kind === "ul" ? l.replace(/^\s*[-*•]\s/, "") : kind === "ol" ? l.replace(/^\s*\d+[.)]\s/, "") : l;
    const prev = out.at(-1);
    if (prev && prev.kind === kind && kind !== "h" && prev.lines.length) prev.lines.push(text);
    else out.push({ kind, lines: [text] });
  }
  return out.filter((b) => b.lines.length);
}

/** Just enough markdown for agent messages: paragraphs, headings, lists, fences, `code`, **bold**. */
export function Prose({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1.5 leading-snug", className)}>
      {blocks(text).map((b, i) => {
        if (b.kind === "pre") return <pre key={i} className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-[11px] leading-[18px]">{b.lines.join("\n")}</pre>;
        if (b.kind === "h") return <p key={i} className="pt-0.5 font-medium text-foreground">{inline(b.lines[0])}</p>;
        if (b.kind === "ul" || b.kind === "ol") {
          const List = b.kind === "ul" ? "ul" : "ol";
          return (
            <List key={i} className={cn("flex flex-col gap-0.5 pl-4", b.kind === "ul" ? "list-disc marker:text-muted-foreground/50" : "list-decimal marker:text-muted-foreground")}>
              {b.lines.map((l, j) => <li key={j} className="pl-0.5">{inline(l)}</li>)}
            </List>
          );
        }
        return <p key={i}>{b.lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}</p>;
      })}
    </div>
  );
}
