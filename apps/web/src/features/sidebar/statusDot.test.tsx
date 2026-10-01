import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ThreadStatus } from "@/lib/types";
import { STATUS_NAMES, StatusDot } from "./TaskItem";

const STATUSES: ThreadStatus[] = ["idle", "running", "awaiting-approval", "awaiting-input", "interrupted", "error"];

describe("StatusDot", () => {
  it("has a name for every status, so the dot is not only a colour", () => {
    for (const status of STATUSES) {
      const html = renderToStaticMarkup(<StatusDot status={status} />);
      expect(html, status).toContain('role="img"');
      expect(html, status).toContain(`aria-label="${STATUS_NAMES[status]}"`);
    }
  });

  it("gives each status its own name", () => {
    expect(new Set(STATUSES.map((status) => STATUS_NAMES[status])).size).toBe(STATUSES.length);
  });
});
