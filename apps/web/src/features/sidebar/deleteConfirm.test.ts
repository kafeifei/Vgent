import { describe, expect, it } from "vitest";
import { deleteWarning } from "./DeleteConfirm";

describe("deleteWarning", () => {
  it("says how many files' changes go with the worktree", () => {
    expect(deleteWarning(1)).toBe("1 个文件的改动没提交，会随 worktree 一起丢失。");
    expect(deleteWarning(12)).toBe("12 个文件的改动没提交，会随 worktree 一起丢失。");
  });

  it("says nothing when there is nothing to lose", () => {
    expect(deleteWarning(0)).toBeNull();
  });

  it("says so when the count could not be read — it is not taken for zero", () => {
    expect(deleteWarning(undefined)).toBe("没能确认有没有没提交的改动，删除后无法找回。");
  });
});
