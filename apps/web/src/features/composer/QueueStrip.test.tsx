import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QueuedMessageSummary } from "@/lib/types";
import { canSaveQueuedText, QueueStrip } from "./QueueStrip";

const item: QueuedMessageSummary = {
  id: "queued", text: "", mode: "queue", createdAt: "2026-09-29T00:00:00Z",
  files: [{ type: "file", filename: "layout.png", mediaType: "image/png" }, { type: "file", filename: "requirements.txt", mediaType: "text/plain" }],
};
const noop = () => {};
const render = (entry: QueuedMessageSummary) => renderToStaticMarkup(<QueueStrip items={[entry]} onEdit={noop} onDelete={noop} onInterrupt={noop} onSteer={noop} />);

describe("queued attachment summaries", () => {
  it("shows attachment-only filenames and count without a steer action", () => {
    const html = render(item);
    expect(html).toContain("2 个附件");
    expect(html).toContain("layout.png、requirements.txt");
    expect(html).toContain('title="layout.png、requirements.txt"');
    expect(html).not.toContain("把这条消息引导进当前回合");
    expect(html).toContain("打断并发送");
  });
  it("labels unnamed files and preserves text-only steering", () => {
    expect(render({ ...item, files: [{ type: "file", mediaType: "text/plain" }] })).toContain("未命名附件");
    expect(render({ ...item, text: "hello", files: [] })).toContain("把这条消息引导进当前回合");
  });
  it("allows clearing only the text of an attachment message", () => {
    expect(canSaveQueuedText(item, " \n ")).toBe(true);
    expect(canSaveQueuedText({ ...item, files: [] }, " \n ")).toBe(false);
    expect(canSaveQueuedText({ ...item, files: [] }, "hello")).toBe(true);
  });
});
