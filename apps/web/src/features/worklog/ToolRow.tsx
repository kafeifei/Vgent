import type { UIMessage } from "ai";
import { useState } from "react";
import { Bot, ChevronDown } from "lucide-react";
import { RichMarkdown } from "@/components/RichMarkdown";
import { baseName } from "@/lib/format";
import { planItemsOf } from "@/features/plan/plan";
import { PlanList } from "@/features/plan/PlanList";
import { cn } from "@/lib/utils";
import {
  asChildToolPart,
  describeTool,
  diffStatOf,
  exitCodeOf,
  field,
  isToolStreaming,
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
 * A subagent's transcript for the tool detail pane. The main log keeps only
 * a compact entry for the child; its individual steps remain available here.
 */
export function ChildTranscript({ parts, preliminary }: { parts: UIMessage["parts"]; preliminary: boolean }) {
  return (
    <div className="min-w-0">
      {parts.map((part, index) => {
        const tool = asChildToolPart(part);
        if (tool != null) {
          const display = describeTool(tool);
          return (
            <div key={index} className="flex min-h-row-tool items-center gap-xs text-fg-muted text-sm">
              <span className={cn("flex-none", display.verb === "$" && "font-mono text-code")}>{display.verb}</span>
              <span className={cn("min-w-0 truncate text-fg-faint", display.verb === "$" && "font-mono text-code")}>{display.target}</span>
            </div>
          );
        }
        if (part.type === "reasoning") {
          const text = part.text.trim();
          return <details key={index} className="group/child-thought min-w-0 py-3xs">
            <summary className="flex min-h-row-tool cursor-pointer list-none items-center gap-xs text-sm text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden">
              <span>{preliminary && part.state === "streaming" ? "思考中…" : "思考"}</span>
              <ChevronDown className="size-sm -rotate-90 transition-transform group-open/child-thought:rotate-0" />
            </summary>
            <div className="max-h-figure overflow-y-auto pb-xs text-sm text-fg-muted">
              {text === "" ? <p className="text-xs text-fg-faint">没有可展示的思考内容。</p> : <RichMarkdown className="text-sm">{text}</RichMarkdown>}
            </div>
          </details>;
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
      {!preliminary && !parts.some((part) => part.type === "reasoning") && <p className="py-xs text-xs text-fg-faint">没有可展示的思考记录。</p>}
      {preliminary && <div className="py-3xs text-fg-faint text-sm">进行中…</div>}
    </div>
  );
}

/**
 * One tool call as one muted line (the prototype's "去卡片化" rule). Clicking
 * it opens the call where it belongs — a command in 终端, a file in 文件, the
 * rest as a detail view — never a box inside the log. A plan is the one
 * exception: its list is the content, and it toggles in place.
 */
export function ToolRow({
  part,
  onOpenFile,
  onInspect,
}: {
  part: ToolPart;
  onOpenFile: (file: string) => void;
  onInspect: (part: ToolPart) => void;
}) {
  const [planOpen, setPlanOpen] = useState(true);
  const display = describeTool(part);
  const plan = display.kind === "plan" ? planItemsOf(part) : null;
  const streaming = isToolStreaming(part) || (display.kind === "agent" && part.state === "output-available" && part.preliminary === true);
  const exitCode = part.state === "output-available" ? exitCodeOf(part.output) : undefined;
  const stat = part.state === "output-available" ? diffStatOf(part.output) : undefined;

  return (
    <div>
      <button
        type="button"
        onClick={() => (plan != null ? setPlanOpen((value) => !value) : onInspect(part))}
        title={display.kind === "agent" ? "查看子代理详情" : display.kind === "bash" ? field(part.input, "command") : undefined}
        className="group/tool flex min-h-row-tool w-full items-center gap-xs text-left text-fg-muted text-md leading-chat hover:text-fg"
      >
        {streaming && <Spinner />}
        {display.kind === "agent" && <Bot className="size-md flex-none text-fg-faint" aria-hidden="true" />}
        <span className={cn("flex-none", display.verb === "$" && "font-mono text-code")}>{display.verb}</span>
        {display.kind !== "agent" && (
          <span className={cn("min-w-0 truncate text-fg-faint group-hover/tool:text-fg-muted", display.verb === "$" && "font-mono text-code")}>
            {display.target}
          </span>
        )}
        {plan != null && (
          <ChevronDown
            className={cn(
              "size-md flex-none text-fg-faint opacity-0 transition-transform duration-[var(--duration-fast)] group-hover/tool:opacity-100",
              planOpen ? "opacity-100" : "-rotate-90",
            )}
          />
        )}
        <span className="ml-auto flex-none text-fg-faint text-xs">
          {part.state === "output-error" ? (
            <span className="text-danger">失败</span>
          ) : part.state === "output-denied" ? (
            <span className="text-danger">已拒绝</span>
          ) : exitCode != null ? (
            <span className={cn("font-mono", exitCode !== 0 && "text-danger")}>exit {exitCode}</span>
          ) : streaming ? (
            "运行中"
          ) : null}
        </span>
      </button>

      {display.file != null && part.state === "output-available" && (
        <div className="flex flex-wrap gap-2xs py-3xs">
          <FileChip file={display.file} {...(stat != null ? { stat } : {})} onClick={() => onOpenFile(display.file as string)} />
        </div>
      )}

      {planOpen && plan != null && <PlanList items={plan} className="mb-2xs" />}
    </div>
  );
}
