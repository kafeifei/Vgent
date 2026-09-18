import { BASH_TOOL, bashEntry, unlistedCommands } from "@vgent/engine/allowlist";
import { getToolName } from "ai";
import { describeTool, toolTitle, type ToolPart } from "./toolMeta";

/** What 「一直允许」 would write, and what the button calls it. */
type AlwaysAllow = { label: string; entries: string[] };

/**
 * The always-allow offer for one call, or null when there is nothing honest to
 * offer: a shell command we cannot read confidently, or one the list already
 * covers. A `bash` entry names the *command* (`bash(git push)`), never the whole
 * shell — one click must not sign off every future command in every task. The
 * label is what will be written, verbatim and one per segment, so 「一直允许 git
 * push」 never quietly means every `git`.
 */
export function alwaysAllowOffer(toolName: string, input: unknown, allowlist: readonly string[]): AlwaysAllow | null {
  if (toolName !== BASH_TOOL) return { label: toolTitle(toolName), entries: [toolName] };
  const command = (input as { command?: unknown } | null | undefined)?.command;
  if (typeof command !== "string") return null;
  const missing = unlistedCommands(command, allowlist);
  if (missing == null || missing.length === 0) return null;
  return { label: missing.join("、"), entries: missing.map(bashEntry) };
}

/**
 * An `approval-requested` tool call, inline in the log — Vgent's own thing,
 * Cursor has no equivalent. Warning-tinted so it reads as "waiting on you".
 */
export function ApprovalCard({
  part,
  id,
  allowlist,
  onRespond,
  onAlwaysAllow,
}: {
  part: ToolPart;
  id: string;
  /** The global 「一直允许」 list, so the offer only names what is still missing. */
  allowlist: readonly string[];
  onRespond: (approved: boolean) => void;
  /** Approves this call *and* adds these entries to the global allowlist. */
  onAlwaysAllow: (entries: string[]) => void;
}) {
  const display = describeTool(part);
  const offer = alwaysAllowOffer(getToolName(part), part.input, allowlist);

  return (
    <article id={id} className="rounded-md border border-warning bg-warning-bg">
      <div className="flex min-h-row-tool items-center gap-xs px-sm py-2xs text-fg-muted text-sm">
        <span className={display.kind === "bash" ? "flex-none font-mono text-code text-fg" : "flex-none text-fg"}>
          {display.verb}
        </span>
        <span className="min-w-0 truncate font-mono text-code">{display.target}</span>
        <span className="ml-auto flex-none text-fg-faint text-xs">等待批准</span>
      </div>
      <div className="border-warning border-t px-sm py-card-pad">
        <p className="m-0 mb-2xs text-fg-muted text-xs">当前权限模式不放行这个操作，需要你确认。</p>
        <div className="mt-xs flex flex-wrap items-center gap-xs">
          <button
            type="button"
            onClick={() => onRespond(true)}
            className="inline-flex h-xl items-center rounded-md border border-brand bg-brand px-sm font-semibold text-brand-fg text-xs hover:bg-brand-hover"
          >
            允许
          </button>
          <button
            type="button"
            onClick={() => onRespond(false)}
            className="inline-flex h-xl items-center rounded-md border border-border bg-bg-elevated px-sm text-danger text-xs hover:border-danger hover:bg-danger-bg"
          >
            拒绝
          </button>
          {offer != null && (
            <button
              type="button"
              onClick={() => onAlwaysAllow(offer.entries)}
              title="以后所有任务都不再询问这个工具，可在设置里撤销"
              className="inline-flex h-xl items-center rounded-md border border-border bg-bg-elevated px-sm text-fg text-xs hover:border-border-strong hover:bg-bg-hover"
            >
              一直允许 {offer.label}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
