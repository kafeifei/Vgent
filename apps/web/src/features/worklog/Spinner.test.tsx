import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Spinner } from "./ToolRow";
import { Turn, type TurnActions } from "./Turn";
import { buildTurns } from "./turns";

/**
 * The spinner says 「运行中」 by turning, which a screen reader cannot see. It is
 * not colour alone either — but it is a status with no text: where nothing
 * beside it spells the state out, it has to carry the words itself.
 */

describe("Spinner", () => {
  it("is decoration until it is given the words", () => {
    const plain = renderToStaticMarkup(createElement(Spinner));
    expect(plain).toContain('aria-hidden="true"');
    expect(plain).not.toContain("aria-label");
    expect(plain).toContain("animate-spin");
  });

  it("is an image named by its label", () => {
    const named = renderToStaticMarkup(createElement(Spinner, { label: "运行中" }));
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="运行中"');
    expect(named).not.toContain("aria-hidden");
  });
});

const actions: TurnActions = {
  respondToApproval: () => {},
  alwaysAllow: () => {},
  answerQuestions: () => {},
  openFile: () => {},
  inspect: () => {},
  fork: () => {},
  restoreLatest: () => {},
};

const read = (id: string, state: string) =>
  ({ type: "tool-Read", toolCallId: id, state, input: { file_path: `${id}.ts` } }) as unknown as UIMessage["parts"][number];

const liveHtml = (parts: UIMessage["parts"]) => {
  const turn = buildTurns([{ id: "u", role: "user", parts: [{ type: "text", text: "问" }] }, { id: "a", role: "assistant", parts }])[0]!;
  return renderToStaticMarkup(createElement(Turn, { turn, isLast: true, live: true, dimmed: false, actions, allowlist: [], drawings: new Map() }));
};

describe("a running turn's spinners", () => {
  it("names the one on a group of looks, which has no 「运行中」 beside it", () => {
    const html = liveHtml([read("c1", "input-available"), read("c2", "output-available")]);
    expect(html).toContain("读取 2 次");
    expect(html).toContain('role="img" aria-label="运行中"');
  });

  it("leaves the one on a single tool row to that row's own 「运行中」", () => {
    const html = liveHtml([read("c1", "input-available")]);
    expect(html).toContain("运行中");
    expect(html).not.toContain('aria-label="运行中"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("shows no spinner for a group that has finished", () => {
    const html = liveHtml([read("c1", "output-available"), read("c2", "output-available")]);
    expect(html).toContain("读取 2 次");
    expect(html).not.toContain("animate-spin");
  });
});
