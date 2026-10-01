import { describe, expect, it } from "vitest";
import { shareUnchanged } from "./shareUnchanged";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface Row {
  id: string;
  title: string;
  queue?: Array<{ id: string; text: string }>;
  workspace?: { branch: string };
}

describe("shareUnchanged", () => {
  it("hands back the very same value when nothing changed, however fresh the copy is", () => {
    const previous = { threads: [{ id: "a", title: "A", workspace: { branch: "x" } }], settings: { allowlist: ["read"] } };
    expect(shareUnchanged(previous, clone(previous))).toBe(previous);
  });

  it("replaces only what changed and keeps every other task's identity", () => {
    const previous: Row[] = [
      { id: "a", title: "A", queue: [{ id: "q1", text: "one" }] },
      { id: "b", title: "B", workspace: { branch: "vgent/b" } },
      { id: "c", title: "C" },
    ];
    const next = clone(previous);
    next[1] = { ...next[1]!, title: "B renamed" };
    const shared = shareUnchanged(previous, next);
    expect(shared).not.toBe(previous);
    expect(shared[0]).toBe(previous[0]);
    expect(shared[2]).toBe(previous[2]);
    expect(shared[1]).toEqual({ id: "b", title: "B renamed", workspace: { branch: "vgent/b" } });
    // Inside the changed task, the part that did not change is shared too.
    expect(shared[1]?.workspace).toBe(previous[1]?.workspace);
  });

  it("matches lists of records by id, so a reordered or shortened list still shares what is left", () => {
    const previous: Row[] = [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }];
    const reordered = shareUnchanged(previous, clone([previous[2]!, previous[0]!, previous[1]!]));
    expect(reordered.map((row) => row.id)).toEqual(["c", "a", "b"]);
    expect(reordered[0]).toBe(previous[2]);
    expect(reordered[1]).toBe(previous[0]);

    const shorter = shareUnchanged(previous, clone(previous.slice(1)));
    expect(shorter).toHaveLength(2);
    expect(shorter[0]).toBe(previous[1]);

    const longer = shareUnchanged(previous, clone([{ id: "z", title: "Z" }, ...previous]));
    expect(longer[1]).toBe(previous[0]);
  });

  it("compares lists without ids by position", () => {
    const previous = { allowlist: ["read", "bash(ls)"] };
    expect(shareUnchanged(previous, { allowlist: ["read", "bash(ls)"] })).toBe(previous);
    const changed = shareUnchanged(previous, { allowlist: ["read", "bash(git status)"] });
    expect(changed).not.toBe(previous);
    expect(changed.allowlist).toEqual(["read", "bash(git status)"]);
  });

  it("notices a key that appeared, disappeared or became undefined", () => {
    const previous: { a: number; b?: number } = { a: 1 };
    expect(shareUnchanged(previous, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(shareUnchanged<{ a?: number; b?: number }>({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 });
    const withUndefined = shareUnchanged<{ a: number; b?: number | undefined }>({ a: 1 }, { a: 1, b: undefined });
    expect(Object.keys(withUndefined)).toEqual(["a", "b"]);
  });

  it("copes with null, primitives and a first snapshot that has no previous", () => {
    expect(shareUnchanged<string | null>(null, "x")).toBe("x");
    expect(shareUnchanged<{ a: number } | null>(null, { a: 1 })).toEqual({ a: 1 });
    expect(shareUnchanged(1, 2)).toBe(2);
    const fresh = { threads: [] as Row[] };
    expect(shareUnchanged(undefined as typeof fresh | undefined, fresh)).toBe(fresh);
  });

  it("does not treat class instances as JSON", () => {
    const first = new Date(0);
    const second = new Date(1);
    expect(shareUnchanged(first, second)).toBe(second);
  });
});
