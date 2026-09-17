import type { UIMessage } from "ai";
import { useState } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { baseName } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  asChildMessage,
  asChildToolPart,
  describeTool,
  diffStatOf,
  exitCodeOf,
  isToolStreaming,
  outputText,
  type ToolPart,
} from "./toolMeta";

/** The running indicator: the only spinner in the log. */
export function Spinner() {
  return <span className="size-md flex-none animate-spin rounded-full border border-border-strong border-t-brand" />;
}

/** `tokens.css +84 −12` — a write/edit result, not a text line. */
export function FileChip({
  file,
  stat,
  onClick,
}: {
  file: string;
  stat?: { added: number; removed: number };
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={file}
      className="inline-flex h-xl max-w-full items-center gap-2xs rounded-sm bg-bg-inset px-xs text-xs hover:bg-bg-active"
    >
      <span className="min-w-0 truncate font-mono text-code text-fg">{baseName(file)}</span>
      {stat != null && stat.added > 0 && <span className="font-mono text-diff-add-fg">+{stat.added}</span>}
      {stat != null && stat.removed > 0 && <span className="font-mono text-diff-del-fg">−{stat.removed}</span>}
    </button>
  );
}

/**
 * A subagent's transcript: its own text, and for every tool it called the same
 * one-liner the parent's rows use. It is shown inline rather than folded away,
 * because it is the only place the child's work is ever visible — the parent
 * model itself receives nothing but the closing summary.
 */
function ChildTranscript({ parts, preliminary }: { parts: UIMessage["parts"]; preliminary: boolean }) {
  return (
    <div className="mt-2xs ml-lg border-border border-l pl-sm">
      {parts.map((part, index) => {
        const tool = asChildToolPart(part);
        if (tool != null) {
          const display = describeTool(tool);
          return (
            <div key={index} className="flex h-row-tool items-center gap-xs text-fg-faint text-sm">
              <span className={cn("flex-none", display.kind === "bash" && "font-mono text-code")}>{display.verb}</span>
              <span className="min-w-0 truncate font-mono text-code">{display.target}</span>
            </div>
          );
        }
        if (part.type === "text" && part.text.trim() !== "") {
          return (
            <p key={index} className="whitespace-pre-wrap py-3xs text-fg-muted text-sm">
              {part.text}
            </p>
          );
        }
        return null;
      })}
      {preliminary && <div className="py-3xs text-fg-faint text-sm">进行中…</div>}
    </div>
  );
}

/**
 * One tool call as one muted line (the prototype's "去卡片化" rule). Clicking it
 * opens an inset body with the raw input and output.
 */
export function ToolRow({ part, onOpenFile }: { part: ToolPart; onOpenFile: (file: string) => void }) {
  const [open, setOpen] = useState(false);
  const display = describeTool(part);
  const streaming = isToolStreaming(part);
  const exitCode = part.state === "output-available" ? exitCodeOf(part.output) : undefined;
  const stat = part.state === "output-available" ? diffStatOf(part.output) : undefined;
  const child = part.state === "output-available" ? asChildMessage(part.output) : undefined;
  const body = part.state === "output-available" && child == null ? outputText(part.output) : undefined;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-row-tool w-full items-center gap-xs rounded-sm px-2xs text-left text-fg-muted text-sm hover:text-fg"
      >
        <span
          className={cn(
            "flex-none text-2xs text-fg-faint transition-transform duration-[var(--duration-fast)]",
            open && "rotate-90",
          )}
        >
          ▸
        </span>
        {streaming && <Spinner />}
        <span className={cn("flex-none", display.kind === "bash" && "font-mono text-code")}>{display.verb}</span>
        <span className="min-w-0 truncate font-mono text-code">{display.target}</span>
        <span className="ml-auto flex-none text-fg-faint text-xs">
          {part.state === "output-error" ? (
            <span className="text-danger">失败</span>
          ) : exitCode != null ? (
            <span className={cn("font-mono", exitCode !== 0 && "text-danger")}>exit {exitCode}</span>
          ) : streaming ? (
            "运行中"
          ) : null}
        </span>
      </button>

      {child != null && (
        <ChildTranscript parts={child} preliminary={part.state === "output-available" && part.preliminary === true} />
      )}

      {display.file != null && part.state === "output-available" && (
        <div className="flex flex-wrap gap-2xs px-2xs py-3xs">
          <FileChip file={display.file} {...(stat != null ? { stat } : {})} onClick={() => onOpenFile(display.file as string)} />
        </div>
      )}

      {open && (
        <div className="mt-2xs mb-2xs ml-lg overflow-hidden rounded-sm bg-bg-inset px-sm py-xs text-fg-muted text-sm">
          <div className="mb-2xs text-2xs text-fg-faint tracking-widest">输入</div>
          <CodeBlock code={JSON.stringify(part.input ?? {}, null, 2)} language="json" />
          {part.state === "output-error" && (
            <>
              <div className="mt-xs mb-2xs text-2xs text-fg-faint tracking-widest">错误</div>
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-code text-danger leading-code">{part.errorText}</pre>
            </>
          )}
          {part.state === "output-available" && (
            <>
              <div className="mt-xs mb-2xs text-2xs text-fg-faint tracking-widest">输出</div>
              {body != null ? (
                <pre className="max-h-[calc(var(--spacing-3xl)*6)] overflow-auto whitespace-pre-wrap font-mono text-code leading-code">
                  {body}
                </pre>
              ) : (
                <CodeBlock code={JSON.stringify(part.output ?? null, null, 2)} language="json" />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
