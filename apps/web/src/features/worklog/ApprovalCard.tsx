import { getToolName } from "ai";
import { describeTool, toolTitle, type ToolPart } from "./toolMeta";

/**
 * An `approval-requested` tool call, inline in the log — Vgent's own thing,
 * Cursor has no equivalent. Warning-tinted so it reads as "waiting on you".
 */
export function ApprovalCard({
  part,
  id,
  onRespond,
  onAlwaysAllow,
}: {
  part: ToolPart;
  id: string;
  onRespond: (approved: boolean) => void;
  /** Approves this call *and* adds the tool to the task's allowlist. */
  onAlwaysAllow: (toolName: string) => void;
}) {
  const display = describeTool(part);
  const toolName = getToolName(part);

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
          <button
            type="button"
            onClick={() => onAlwaysAllow(toolName)}
            title={`本任务之后的 ${toolName} 调用不再询问`}
            className="inline-flex h-xl items-center rounded-md border border-border bg-bg-elevated px-sm text-fg text-xs hover:border-border-strong hover:bg-bg-hover"
          >
            本任务内一直允许 {toolTitle(toolName)}
          </button>
        </div>
      </div>
    </article>
  );
}
