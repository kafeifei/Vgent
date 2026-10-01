import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * Runs a hook in a real React root without a DOM, so state, effects and timers
 * can be tested where the suite has no `jsdom`. The container is a stub nothing
 * is ever appended to: the probe component renders `null`, so React only asks
 * it for the handful of members below. Anything that draws host elements is
 * still tested as markup (`renderToStaticMarkup`) or as a pure function.
 */

interface StubNode {
  nodeType: number;
  tagName: string;
  ownerDocument: StubDocument;
  childNodes: unknown[];
  style: Record<string, unknown>;
  addEventListener(): void;
  removeEventListener(): void;
  appendChild(child: unknown): void;
  removeChild(): void;
  insertBefore(): void;
  setAttribute(): void;
}

interface StubDocument {
  nodeType: number;
  defaultView: EventTarget | null;
  activeElement: null;
  addEventListener(): void;
  removeEventListener(): void;
  createElement(tag: string): unknown;
  createTextNode(text: string): unknown;
}

const noop = (): void => {};

function stubContainer(): { container: StubNode; view: EventTarget } {
  const view = new EventTarget();
  const document: StubDocument = {
    nodeType: 9,
    defaultView: view,
    activeElement: null,
    addEventListener: noop,
    removeEventListener: noop,
    createElement: (tag) => ({ tagName: tag, nodeType: 1, style: {}, childNodes: [], addEventListener: noop, removeEventListener: noop, appendChild: noop, setAttribute: noop }),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
  };
  const container: StubNode = {
    nodeType: 1,
    tagName: "DIV",
    ownerDocument: document,
    childNodes: [],
    style: {},
    addEventListener: noop,
    removeEventListener: noop,
    appendChild(child) {
      this.childNodes.push(child);
    },
    removeChild: noop,
    insertBefore: noop,
    setAttribute: noop,
  };
  Object.assign(view, { document, event: undefined, HTMLIFrameElement: class {}, getSelection: () => null });
  return { container, view };
}

/** React reads `window.event` and the act flag from the globals; both are put back once the last root is gone. */
const saved = new Map<string, { present: boolean; value: unknown }>();
let roots = 0;

function setGlobal(name: string, value: unknown): void {
  if (!saved.has(name)) saved.set(name, { present: Reflect.has(globalThis, name), value: Reflect.get(globalThis, name) });
  Reflect.set(globalThis, name, value);
}

function restoreGlobals(): void {
  for (const [name, before] of saved) {
    if (before.present) Reflect.set(globalThis, name, before.value);
    else Reflect.deleteProperty(globalThis, name);
  }
  saved.clear();
}

export interface HookHandle<Result, Props> {
  /** What the hook returned on its latest render. */
  readonly result: { current: Result };
  /** Renders again with new props (and any state the hook has kept). */
  rerender(props: Props): Promise<void>;
  /** Runs `work` inside `act`, so the state it sets is committed before this resolves. */
  act(work: () => void | Promise<void>): Promise<void>;
  unmount(): Promise<void>;
}

export async function renderHook<Result, Props = undefined>(
  hook: (props: Props) => Result,
  options: { props?: Props; wrap?: (children: ReactNode) => ReactNode } = {},
): Promise<HookHandle<Result, Props>> {
  const { container, view } = stubContainer();
  roots += 1;
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // A test that stubbed `window` itself (for `dispatchEvent` and the like) keeps its own.
  if (!Reflect.has(globalThis, "window")) setGlobal("window", view);

  const result = { current: undefined as Result };
  function Probe({ props }: { props: Props }): null {
    result.current = hook(props);
    return null;
  }
  const tree = (props: Props): ReactNode => {
    const probe = createElement(Probe, { props });
    return options.wrap == null ? probe : options.wrap(probe);
  };

  const root: Root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(tree(options.props as Props));
  });

  let mounted = true;
  return {
    result,
    async rerender(props) {
      await act(async () => {
        root.render(tree(props));
      });
    },
    async act(work) {
      await act(async () => {
        await work();
      });
    },
    async unmount() {
      if (!mounted) return;
      mounted = false;
      await act(async () => {
        root.unmount();
      });
      roots -= 1;
      if (roots === 0) restoreGlobals();
    },
  };
}
