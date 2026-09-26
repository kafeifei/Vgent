import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { DataSection, StructuredData, ToolResult, isRecord } from "./StructuredData";
import { PlanList } from "@/features/plan/PlanList";
import { planItemsOf } from "@/features/plan/plan";
import { ChildTranscript, FileChip } from "@/features/worklog/ToolRow";
import { asChildMessage, describeTool, diffStatOf, exitCodeOf, type ToolPart } from "@/features/worklog/toolMeta";
import { cn } from "@/lib/utils";

/** The call a row in the log pointed at, or nothing once its thread is gone. */
export function findToolPart(messages: readonly UIMessage[], toolCallId: string | undefined): ToolPart | undefined {
  if (toolCallId == null) return undefined;
  for (const message of messages) {
    for (const part of message.parts) {
      if (isToolUIPart(part) && part.toolCallId === toolCallId) return part;
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
  const name = getToolName(part);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const plan = planItemsOf(part);
  const extraInput = plan != null && isRecord(part.input) ? Object.fromEntries(Object.entries(part.input).filter(([key]) => !["items", "plan", "todos"].includes(key))) : null;
  const failed = part.state === "output-error" || (part.state === "output-available" && isRecord(part.output) && part.output.isError === true);
  const status = part.state === "approval-requested" ? "等待审批" : part.state === "approval-responded" ? "审批已处理" : part.state === "output-denied" ? "已拒绝" : part.state === "output-error" ? "失败" : part.state === "output-available" ? (part.preliminary ? "运行中" : "已完成") : "运行中";
  const running = part.state === "input-streaming" || part.state === "input-available" || (part.state === "output-available" && part.preliminary === true);
  return (
    <div className="flex min-w-0 flex-col gap-md">
      <div className="flex flex-wrap items-start gap-xs text-fg-muted text-sm">
        <span title={name} className={cn("min-w-0 break-all", display.kind === "bash" && "font-mono text-code")}>{mcp?.[2] ?? display.verb}</span>
        <span className={cn("min-w-0 break-all text-fg", display.kind === "bash" && "font-mono text-code")}>{display.target}</span>
        <span className="ml-auto flex-none text-fg-faint text-xs">
          {failed ? (
            <span className="text-danger">失败</span>
          ) : part.state === "output-denied" ? (
            "已拒绝"
          ) : exitCode != null ? (
            <span className={cn("font-mono", exitCode !== 0 && "text-danger")}>exit {exitCode}</span>
          ) : status}
        </span>
      </div>

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
        <>
          <div className="text-2xs text-fg-faint tracking-widest">子代理</div>
          <ChildTranscript parts={child} preliminary={part.state === "output-available" && part.preliminary === true} />
        </>
      )}
      {part.state === "output-available" && child == null && (
        <DataSection key={`${part.toolCallId}-output`} title="输出" value={part.output} onOpenFile={onOpenFile}>
          <ToolResult value={part.output} onOpenFile={onOpenFile} />
        </DataSection>
      )}
    </div>
  );
}
