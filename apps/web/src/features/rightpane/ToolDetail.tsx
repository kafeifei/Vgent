import { isToolUIPart, type UIMessage } from "ai";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { ChildTranscript, FileChip } from "@/features/worklog/ToolRow";
import { asChildMessage, describeTool, diffStatOf, exitCodeOf, outputText, type ToolPart } from "@/features/worklog/toolMeta";
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
  const body = part.state === "output-available" && child == null ? outputText(part.output) : undefined;
  const running = part.state === "input-streaming" || part.state === "input-available" || part.state === "approval-requested";
  return (
    <div className="flex flex-col gap-xs">
      <div className="flex items-center gap-xs text-fg-muted text-sm">
        <span className={cn("flex-none", display.kind === "bash" && "font-mono text-code")}>{display.verb}</span>
        <span className={cn("min-w-0 break-all text-fg", display.kind === "bash" && "font-mono text-code")}>{display.target}</span>
        <span className="ml-auto flex-none text-fg-faint text-xs">
          {part.state === "output-error" ? (
            <span className="text-danger">失败</span>
          ) : part.state === "output-denied" ? (
            "已拒绝"
          ) : exitCode != null ? (
            <span className={cn("font-mono", exitCode !== 0 && "text-danger")}>exit {exitCode}</span>
          ) : running ? (
            "运行中"
          ) : null}
        </span>
      </div>

      {display.file != null && part.state === "output-available" && (
        <div className="flex flex-wrap gap-2xs">
          <FileChip file={display.file} {...(stat != null ? { stat } : {})} onClick={() => onOpenFile(display.file as string)} />
        </div>
      )}

      <div className="text-2xs text-fg-faint tracking-widest">输入</div>
      <CodeBlock code={JSON.stringify(part.input ?? {}, null, 2)} language="json" />

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
        <>
          <div className="text-2xs text-fg-faint tracking-widest">输出</div>
          {body != null ? (
            <pre className="overflow-auto whitespace-pre-wrap rounded-sm bg-bg-inset px-xs py-2xs font-mono text-code text-fg-muted leading-code">{body}</pre>
          ) : (
            <CodeBlock code={JSON.stringify(part.output ?? null, null, 2)} language="json" />
          )}
        </>
      )}
    </div>
  );
}
