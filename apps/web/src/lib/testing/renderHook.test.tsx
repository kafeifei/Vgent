import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { renderHook } from "./renderHook";

describe("renderHook", () => {
  it("commits state and effects without a DOM", async () => {
    const log: string[] = [];
    const hook = renderHook(({ label }: { label: string }) => {
      const [count, setCount] = useState(0);
      useEffect(() => {
        log.push(`up ${label}`);
        return () => void log.push(`down ${label}`);
      }, [label]);
      return { count, bump: () => setCount((value) => value + 1) };
    }, { props: { label: "a" } });
    const handle = await hook;

    expect(handle.result.current.count).toBe(0);
    await handle.act(() => handle.result.current.bump());
    expect(handle.result.current.count).toBe(1);

    await handle.rerender({ label: "b" });
    expect(log).toEqual(["up a", "down a", "up b"]);

    await handle.unmount();
    expect(log.at(-1)).toBe("down b");
  });

  it("puts the globals back once the last root is gone", async () => {
    expect(Reflect.has(globalThis, "window")).toBe(false);
    const first = await renderHook(() => 1);
    const second = await renderHook(() => 2);
    expect(Reflect.has(globalThis, "window")).toBe(true);
    await first.unmount();
    expect(Reflect.has(globalThis, "window")).toBe(true);
    await second.unmount();
    expect(Reflect.has(globalThis, "window")).toBe(false);
    expect(Reflect.has(globalThis, "IS_REACT_ACT_ENVIRONMENT")).toBe(false);
  });
});
