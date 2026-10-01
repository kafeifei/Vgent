import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, type HookHandle } from "@/lib/testing/renderHook";
import { syncMirror, useMirrorScroll, type MirrorTarget, type ScrollSource } from "./mirrorScroll";

const textarea = (init: Partial<ScrollSource> = {}): ScrollSource => ({ scrollTop: 0, scrollLeft: 0, offsetWidth: 400, clientWidth: 400, ...init });
const mirror = (): MirrorTarget => ({ scrollTop: 0, scrollLeft: 0, style: { right: "" } });

describe("syncMirror", () => {
  it("puts the mirror at the textarea's scroll offset — the long paste whose end the user is looking at", () => {
    const layer = mirror();
    syncMirror(textarea({ scrollTop: 640 }), layer);
    expect(layer.scrollTop).toBe(640);
    syncMirror(textarea({ scrollTop: 0 }), layer);
    expect(layer.scrollTop).toBe(0);
  });

  it("follows sideways scroll too", () => {
    const layer = mirror();
    syncMirror(textarea({ scrollLeft: 12 }), layer);
    expect(layer.scrollLeft).toBe(12);
  });

  it("gives the mirror the text width the textarea's scrollbar leaves it, so both wrap alike", () => {
    const layer = mirror();
    syncMirror(textarea({ offsetWidth: 400, clientWidth: 385 }), layer);
    expect(layer.style.right).toBe("15px");
    // Overlay scrollbars (or none) take nothing: back to the layer's own edge.
    syncMirror(textarea({ offsetWidth: 400, clientWidth: 400 }), layer);
    expect(layer.style.right).toBe("");
  });
});

/** A `ResizeObserver` the test can fire. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: unknown[] = [];
  disconnected = false;
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: unknown): void {
    this.observed.push(target);
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

const handles: Array<HookHandle<unknown, unknown>> = [];

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.unmount();
  vi.unstubAllGlobals();
});

async function mount(source: ScrollSource, layer: MirrorTarget, value: string) {
  const textareaRef = { current: source } as unknown as RefObject<HTMLTextAreaElement | null>;
  const mirrorRef = { current: layer } as unknown as RefObject<HTMLElement | null>;
  const hook = await renderHook((props: { value: string }) => useMirrorScroll(textareaRef, mirrorRef, props.value), { props: { value } });
  handles.push(hook as unknown as HookHandle<unknown, unknown>);
  return hook;
}

describe("useMirrorScroll", () => {
  it("follows the textarea after the text changes — the browser scrolled it to keep the caret in view", async () => {
    const source = textarea();
    const layer = mirror();
    const hook = await mount(source, layer, "短");
    expect(layer.scrollTop).toBe(0);

    // The paste: the textarea has scrolled to the caret at the end by the time the new text is committed.
    source.scrollTop = 900;
    await hook.rerender({ value: "很长很长的日志" });
    expect(layer.scrollTop).toBe(900);
  });

  it("follows every scroll event through the function it hands back", async () => {
    const source = textarea();
    const layer = mirror();
    const hook = await mount(source, layer, "x");
    source.scrollTop = 30;
    hook.result.current();
    expect(layer.scrollTop).toBe(30);
    source.scrollTop = 45;
    hook.result.current();
    expect(layer.scrollTop).toBe(45);
  });

  it("follows the textarea's size: a pane dragged, the window resized, the box grown", async () => {
    const source = textarea({ scrollTop: 10 });
    const layer = mirror();
    await mount(source, layer, "x");
    const observer = FakeResizeObserver.instances[0];
    expect(observer?.observed).toEqual([source]);

    source.scrollTop = 200;
    source.clientWidth = 385;
    observer?.callback();
    expect(layer.scrollTop).toBe(200);
    expect(layer.style.right).toBe("15px");
  });

  it("stops watching when the composer goes away", async () => {
    const hook = await mount(textarea(), mirror(), "x");
    await hook.unmount();
    expect(FakeResizeObserver.instances[0]?.disconnected).toBe(true);
  });

  it("does not need ResizeObserver to keep up with the text and the scroll", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const source = textarea();
    const layer = mirror();
    const hook = await mount(source, layer, "a");
    source.scrollTop = 77;
    await hook.rerender({ value: "ab" });
    expect(layer.scrollTop).toBe(77);
  });

  it("leaves alone a mirror that is not there (yet, or any more)", async () => {
    const textareaRef = { current: textarea({ scrollTop: 5 }) } as unknown as RefObject<HTMLTextAreaElement | null>;
    const mirrorRef = { current: null } as RefObject<HTMLElement | null>;
    const hook = await renderHook(() => useMirrorScroll(textareaRef, mirrorRef, "x"));
    handles.push(hook as unknown as HookHandle<unknown, unknown>);
    expect(() => hook.result.current()).not.toThrow();
  });
});
