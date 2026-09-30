import type { UIMessage } from "ai";
import { RichMarkdown } from "@/components/RichMarkdown";
import { compactionSummary, isCompactionMarker } from "@/lib/compaction";
import type { ThreadMessageMetadata } from "@/lib/types";

const timeOf = (at: string): string => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

/**
 * 上下文已压缩: the summary a marker in the log carries — what the model reads
 * in place of everything before it. The messages themselves are still in the log.
 */
export function SummaryPanel({ messages, messageId }: { messages: readonly UIMessage[]; messageId: string | null }) {
  const marker = messages.find((message) => message.id === messageId);
  if (marker == null || !isCompactionMarker(marker)) return <p className="text-fg-faint text-xs">这条摘要已经不在了</p>;
  const compacted = (marker.metadata as ThreadMessageMetadata).compacted!;
  return (
    <div className="flex min-w-0 flex-col gap-sm">
      <div className="flex items-baseline gap-xs text-fg-muted text-xs">
        <span className="text-fg">上下文摘要</span>
        <span className="ml-auto text-fg-faint">{timeOf(compacted.at)}</span>
      </div>
      <RichMarkdown className="text-md leading-chat">{compactionSummary(marker)}</RichMarkdown>
    </div>
  );
}
