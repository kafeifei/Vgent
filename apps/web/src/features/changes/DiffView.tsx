import { cn } from "@/lib/utils";
import type { DiffLine } from "./diff";

const ROW: Record<DiffLine["kind"], string> = {
  hunk: "bg-bg",
  add: "bg-diff-add-bg",
  del: "bg-diff-del-bg",
  ctx: "",
  note: "bg-bg",
};

const TEXT: Record<DiffLine["kind"], string> = {
  hunk: "text-fg-faint",
  add: "text-diff-add-fg",
  del: "text-diff-del-fg",
  ctx: "text-fg-muted",
  note: "text-fg-faint",
};

/** The gutter: the line the reader would jump to, `@@` for a hunk header. */
function gutter(line: DiffLine): string {
  if (line.kind === "hunk") return "@@";
  return String(line.newNo ?? line.oldNo ?? "");
}

/** The prototype's `.diff`: a number gutter, then the raw line, never wrapped. */
export function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="overflow-hidden rounded-sm border border-border bg-bg-inset font-mono text-code leading-code">
      {lines.map((line, index) => (
        // The index is the identity: a diff is a flat list, replaced wholesale.
        <div key={index} className={cn("flex", ROW[line.kind])}>
          <span className="w-xl flex-none select-none whitespace-pre border-border border-r bg-bg pr-xs text-right text-fg-faint">
            {gutter(line)}
          </span>
          <span className={cn("min-w-0 flex-1 overflow-x-auto whitespace-pre px-xs", TEXT[line.kind])}>{line.text}</span>
        </div>
      ))}
    </div>
  );
}
