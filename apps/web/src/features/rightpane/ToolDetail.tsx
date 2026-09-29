import { getToolName, type UIMessage } from "ai";
import { buildTurns } from "@/features/worklog/turns";
import { DataSection, StructuredData, ToolResult, isRecord } from "./StructuredData";
import { PlanList } from "@/features/plan/PlanList";
import { planItemsOf } from "@/features/plan/plan";
import { ChildTranscript, FileChip } from "@/features/worklog/ToolRow";
import { asChildMessage, describeTool, diffStatOf, exitCodeOf, field, isToolStreaming, type ToolPart } from "@/features/worklog/toolMeta";
import { cn } from "@/lib/utils";

/** The call a row in the log pointed at, or nothing once its thread is gone. */
export function findToolPart(messages: readonly UIMessage[], toolCallId: string | undefined): ToolPart | undefined {
  if (toolCallId == null) return undefined;
  // Use the same per-turn display state as the log, not the raw stream flags.
  for (const turn of buildTurns(messages)) {
    for (const block of turn.blocks) {
      if (block.kind === "tool" && block.part.toolCallId === toolCallId) return block.part;
    }
  }
  return undefined;
}

/**
 * One tool call, in full: what it was asked and what came back. The log's
 * rows are one line each; this is where a click on one of them lands.
 */
export function ToolDetail({ part, onOpenFile }: { part: ToolPart | undefined; onOpenFile: (file: string) => void }) {
  if (part == null) return <p className="text-fg-faint text-xs">这条调用已经不在了</p>;
  const display = describeTool(part);
  const exitCode = part.state === "output-available" ? exitCodeOf(part.output) : undefined;
  const stat = part.state === "output-available" ? diffStatOf(part.output) : undefined;
  const child = part.state === "output-available" ? asChildMessage(part.output) : undefined;
  const childModel = child != null && isRecord(child.metadata) ? field(child.metadata.subagent, "modelId") : undefined;
  const name = getToolName(part);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const plan = planItemsOf(part);
  const extraInput = plan != null && isRecord(part.input) ? Object.fromEntries(Object.entries(part.input).filter(([key]) => !["items", "plan", "todos"].includes(key))) : null;
  const failed = part.state === "output-error" || (part.state === "output-available" && isRecord(part.output) && part.output.isError === true);
  const status = part.interrupted ? "已中断" : part.state === "approval-requested" ? "等待审批" : part.state === "approval-responded" ? "审批已处理" : part.state === "output-denied" ? "已拒绝" : part.state === "output-error" ? "失败" : part.state === "output-available" ? (part.preliminary ? "运行中" : "已完成") : "运行中";
  const running = isToolStreaming(part);
  return (
    <div className="flex min-w-0 flex-col gap-md">
      <div className="flex flex-wrap items-start gap-xs text-fg-muted text-sm">
        <span title={name} className={cn("min-w-0 break-all", display.kind === "bash" && "font-mono text-code")}>{mcp?.[2] ?? display.verb}</span>
        <span className={cn("min-w-0 break-all text-fg", display.kind === "bash" && "font-mono text-code")}>{display.target}</span>
        <span className="ml-auto flex-none text-fg-faint text-xs">
          {part.interrupted ? (
            status
          ) : failed ? (
            <span className="text-danger">失败</span>
          ) : part.state === "output-denied" ? (
            "已拒绝"
          ) : exitCode != null ? (
            <span className={cn("font-mono", exitCode !== 0 && "text-danger")}>exit {exitCode}</span>
          ) : status}
        </span>
      </div>

      {part.interrupted && part.state === "output-available" && <p className="text-xs text-fg-muted">回合已中断，以下保留已收到的部分输出。</p>}
      {mcp != null && <p className="-mt-sm text-xs text-fg-faint">{mcp[1]} · MCP</p>}

      {display.file != null && part.state === "output-available" && (
        <div className="flex flex-wrap gap-2xs">
          <FileChip file={display.file} {...(stat != null ? { stat } : {})} onClick={() => onOpenFile(display.file as string)} />
        </div>
      )}

      <DataSection key={`${part.toolCallId}-input`} title="输入" value={part.input} onOpenFile={onOpenFile}>
        {plan != null ? <><PlanList items={plan} live={running} />{extraInput != null && Object.keys(extraInput).length > 0 && <StructuredData value={extraInput} onOpenFile={onOpenFile} />}</> : undefined}
      </DataSection>

      {part.state === "output-error" && (
        <>
          <div className="text-2xs text-fg-faint tracking-widest">错误</div>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-code text-danger leading-code">{part.errorText}</pre>
        </>
      )}
      {child != null && (
        <section aria-label="子代理详情" className="min-w-0 space-y-sm border-t border-border pt-md">
          <h3 className="text-xs font-medium text-fg-muted">子代理</h3>
          <dl className="flex items-baseline gap-sm text-xs">
            <dt className="shrink-0 text-fg-muted">模型</dt>
            <dd className="min-w-0 break-all text-fg" title={childModel == null ? "这条历史记录没有保存子代理模型" : childModel}>{childModel ?? "未记录"}</dd>
          </dl>
          <ChildTranscript parts={child.parts} preliminary={running} />
        </section>
      )}
      {part.state === "output-available" && child == null && (
        <DataSection key={`${part.toolCallId}-output`} title="输出" value={part.output} onOpenFile={onOpenFile}>
          <ToolResult value={part.output} onOpenFile={onOpenFile} />
        </DataSection>
      )}
    </div>
  );
}
