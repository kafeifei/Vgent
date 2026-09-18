import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { Settings, ThreadStatus, ThreadSummary } from "@/lib/types";
import { decideNotification, notificationsEnabled, pendingApprovalLabel } from "./notify";

const thread = (status: ThreadStatus, extra: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({ id: "t1", title: "修一下登录", status, ...extra }) as ThreadSummary;

const decide = (input: {
  status: ThreadStatus;
  previous: ThreadStatus | undefined;
  enabled?: boolean;
  focused?: boolean;
  error?: string;
  detail?: string;
}) =>
  decideNotification({
    thread: thread(input.status, input.error == null ? {} : { error: input.error }),
    previous: input.previous,
    enabled: input.enabled ?? true,
    focused: input.focused ?? false,
    ...(input.detail == null ? {} : { detail: input.detail }),
  });

describe("decideNotification", () => {
  it("每种结束都有自己的一句话", () => {
    expect(decide({ previous: "running", status: "idle" })).toMatchObject({ reason: "done", title: "修一下登录", body: "已完成" });
    expect(decide({ previous: "running", status: "error", error: "engine exited\nwith code 1" })).toMatchObject({
      reason: "error",
      body: "出错了：engine exited with code 1",
    });
    expect(decide({ previous: "running", status: "awaiting-approval", detail: "$ pnpm test" })).toMatchObject({
      reason: "approval",
      body: "等你审批：$ pnpm test",
    });
    expect(decide({ previous: "running", status: "awaiting-input" })).toMatchObject({ reason: "input", body: "等你回答" });
  });

  it("不知道审批的是什么、也没有错误文字时，只说要什么", () => {
    expect(decide({ previous: "running", status: "awaiting-approval" })?.body).toBe("等你审批");
    expect(decide({ previous: "running", status: "error" })?.body).toBe("出错了");
  });

  it("长的东西都截断", () => {
    const long = "x".repeat(200);
    const decision = decide({ previous: "running", status: "awaiting-approval", detail: long });
    expect(decision?.body.length).toBeLessThan(60);
    expect(decision?.body.endsWith("…")).toBe(true);
  });

  it("窗口在前台、或者设置关了，就不发", () => {
    expect(decide({ previous: "running", status: "idle", focused: true })).toBeUndefined();
    expect(decide({ previous: "running", status: "idle", enabled: false })).toBeUndefined();
  });

  it("第一次看到这个任务不发（刷新页面、断线重连都算第一次）", () => {
    expect(decide({ previous: undefined, status: "idle" })).toBeUndefined();
    expect(decide({ previous: undefined, status: "awaiting-approval" })).toBeUndefined();
  });

  it("同一个状态再来一遍不发，一次转变只发一次", () => {
    expect(decide({ previous: "idle", status: "idle" })).toBeUndefined();
    expect(decide({ previous: "awaiting-approval", status: "awaiting-approval" })).toBeUndefined();
  });

  it("只有「刚才还是引擎的回合」才发；被你停掉的不发", () => {
    // 等审批 → 空闲：批完之后那一轮真的结束了，该叫。
    expect(decide({ previous: "awaiting-approval", status: "idle" })).toMatchObject({ reason: "done" });
    // 你自己动手发起的一轮（空闲 → 运行中）不是结束。
    expect(decide({ previous: "idle", status: "running" })).toBeUndefined();
    // 中断是你按的停止。
    expect(decide({ previous: "running", status: "interrupted" })).toBeUndefined();
    expect(decide({ previous: "interrupted", status: "idle" })).toBeUndefined();
  });
});

describe("notificationsEnabled", () => {
  it("默认开，只有明确关掉才是关", () => {
    expect(notificationsEnabled({} as Settings)).toBe(true);
    expect(notificationsEnabled({ systemNotifications: true } as Settings)).toBe(true);
    expect(notificationsEnabled({ systemNotifications: false } as Settings)).toBe(false);
    expect(notificationsEnabled(null)).toBe(false);
  });
});

describe("pendingApprovalLabel", () => {
  const message = (parts: UIMessage["parts"]): UIMessage => ({ id: "m1", role: "assistant", parts });

  it("读出最后一个等审批的工具", () => {
    const label = pendingApprovalLabel(
      message([
        { type: "tool-Bash", toolCallId: "c1", state: "output-available", input: { command: "ls" }, output: {} },
        { type: "tool-Bash", toolCallId: "c2", state: "approval-requested", input: { command: "pnpm test" } },
      ] as unknown as UIMessage["parts"]),
    );
    expect(label).toBe("$ pnpm test");
  });

  it("没有等审批的部分、或者根本没消息时是 undefined", () => {
    expect(pendingApprovalLabel(undefined)).toBeUndefined();
    expect(pendingApprovalLabel(message([{ type: "text", text: "好了" }]))).toBeUndefined();
    expect(pendingApprovalLabel({ id: "u1", role: "user", parts: [{ type: "text", text: "跑一下测试" }] })).toBeUndefined();
  });
});
