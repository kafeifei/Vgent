import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * Renders a component tree into a hand-made DOM, for the tests that need the
 * elements themselves — a menu that turns into a confirm step when a row is
 * clicked, a memoised row that must not render again — where the suite has no
 * `jsdom`. The nodes only remember what React tells them (children, attributes,
 * text) and do no layout; clicks are delivered by calling the element's own
 * `onClick`, with bubbling, the way React would after a native event.
 *
 * `renderHook` covers hooks that draw nothing; this is for what draws.
 */

export interface TreeDocument {
  nodeType: number;
  defaultView: EventTarget | null;
  activeElement: TreeNode | null;
  hidden: boolean;
  visibilityState: string;
  createElement(tag: string): TreeNode;
  createElementNS(namespace: string, tag: string): TreeNode;
  createTextNode(text: string): TreeNode;
  addEventListener(): void;
  removeEventListener(): void;
  hasFocus(): boolean;
}

const noop = (): void => {};

export class TreeNode {
  namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly tagName: string;
  readonly nodeName: string;
  childNodes: TreeNode[] = [];
  parentNode: TreeNode | null = null;
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, unknown> = { setProperty: noop, removeProperty: noop };
  nodeValue: string | null = null;
  /** False once React has taken the node out of the tree. */
  isConnected = true;

  constructor(
    readonly ownerDocument: TreeDocument,
    tag: string,
    readonly nodeType = 1,
  ) {
    this.tagName = tag.toUpperCase();
    this.nodeName = nodeType === 3 ? "#text" : this.tagName;
  }

  get firstChild(): TreeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): TreeNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  get nextSibling(): TreeNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings == null ? null : (siblings[siblings.indexOf(this) + 1] ?? null);
  }

  appendChild(child: TreeNode): TreeNode {
    return this.insertBefore(child, null);
  }
  insertBefore(child: TreeNode, before: TreeNode | null): TreeNode {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    child.isConnected = true;
    const at = before == null ? -1 : this.childNodes.indexOf(before);
    if (at < 0) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    return child;
  }
  removeChild(child: TreeNode): TreeNode {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    child.isConnected = false;
    return child;
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  addEventListener = noop;
  removeEventListener = noop;
  onclick: unknown = null;

  contains(other: TreeNode | null): boolean {
    for (let node = other; node != null; node = node.parentNode) if (node === this) return true;
    return false;
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  getClientRects(): object[] {
    return [{}];
  }
  querySelectorAll(): TreeNode[] {
    return [];
  }

  set textContent(text: string) {
    this.childNodes = [];
    if (text === "") return;
    const node = this.ownerDocument.createTextNode(text);
    this.appendChild(node);
  }
  get textContent(): string {
    return this.nodeType === 3 ? (this.nodeValue ?? "") : this.childNodes.map((child) => child.textContent).join("");
  }

  /** What React last gave this element as props (it keeps them on the node). */
  get props(): Record<string, unknown> {
    const key = Object.keys(this).find((name) => name.startsWith("__reactProps$"));
    return key == null ? {} : ((Reflect.get(this, key) as Record<string, unknown> | undefined) ?? {});
  }

  /** The text this element itself holds, without its descendants'. */
  get ownText(): string {
    return this.childNodes.filter((child) => child.nodeType === 3).map((child) => child.nodeValue ?? "").join("");
  }

  /** Every element under this one, this one first, in document order. */
  descendants(): TreeNode[] {
    return [this, ...this.childNodes.filter((child) => child.nodeType === 1).flatMap((child) => child.descendants())];
  }
}

function stubDocument(): { document: TreeDocument; view: EventTarget } {
  const view = new EventTarget();
  const document: TreeDocument = {
    nodeType: 9,
    defaultView: view,
    activeElement: null,
    hidden: false,
    visibilityState: "visible",
    createElement: (tag) => new TreeNode(document, tag),
    createElementNS: (namespace, tag) => {
      const node = new TreeNode(document, tag);
      node.namespaceURI = namespace;
      return node;
    },
    createTextNode: (text) => {
      const node = new TreeNode(document, "#text", 3);
      node.nodeValue = text;
      return node;
    },
    addEventListener: noop,
    removeEventListener: noop,
    hasFocus: () => true,
  };
  Object.assign(view, { document, event: undefined, HTMLIFrameElement: class {}, getSelection: () => null, innerWidth: 1280, innerHeight: 800 });
  return { document, view };
}

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

/** An event as the element's handlers see it; `stopped()` says whether one of them stopped it bubbling. */
function syntheticEvent(type: string, target: TreeNode, extra: Record<string, unknown>): { event: Record<string, unknown>; stopped: () => boolean } {
  let stopped = false;
  const event: Record<string, unknown> = {
    type,
    target,
    detail: 1,
    button: 0,
    key: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: noop,
    stopPropagation: () => {
      stopped = true;
    },
    ...extra,
  };
  return { event, stopped: () => stopped };
}

export interface Tree {
  readonly container: TreeNode;
  /** All the text on screen. */
  text(): string;
  /** The elements matching `test`, in document order. */
  all(test: (node: TreeNode) => boolean): TreeNode[];
  /** The one element whose own text is `text` (or matches it); throws when there is not exactly one. */
  byText(text: string | RegExp): TreeNode;
  /** The elements with this ARIA role, optionally only those whose text matches. */
  byRole(role: string, name?: string | RegExp): TreeNode[];
  /** Clicks: `onClick` on the element and then on each ancestor, unless one stops it; a disabled button takes no click. */
  click(node: TreeNode): Promise<void>;
  /** Any other React handler (`onMouseDown`, `onKeyDown`…), delivered the same way; `extra` fills in the event (`key`, `target`…). */
  fire(node: TreeNode, handler: string, extra?: Record<string, unknown>): Promise<void>;
  rerender(element: ReactNode): Promise<void>;
  /** Runs `work` inside `act`, so what it sets is committed before this resolves. */
  act(work: () => void | Promise<void>): Promise<void>;
  unmount(): Promise<void>;
}

const matches = (text: string, wanted: string | RegExp): boolean => (typeof wanted === "string" ? text === wanted : wanted.test(text));

export async function renderTree(element: ReactNode): Promise<Tree> {
  const { document, view } = stubDocument();
  const container = new TreeNode(document, "div");
  roots += 1;
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!Reflect.has(globalThis, "window")) setGlobal("window", view);
  setGlobal("document", document);

  const root: Root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(element);
  });

  const all: Tree["all"] = (test) => container.descendants().filter(test);
  const fire = (node: TreeNode, handler: string, extra: Record<string, unknown> = {}): Promise<void> =>
    act(async () => {
      const { event, stopped } = syntheticEvent(handler.replace(/^on/, "").toLowerCase(), node, extra);
      for (let current: TreeNode | null = node; current != null && !stopped(); current = current.parentNode) {
        const props = current.props;
        // React never delivers a click to a disabled button.
        if (handler === "onClick" && props.disabled === true && current.tagName === "BUTTON") return;
        const listener = props[handler];
        if (typeof listener === "function") (listener as (event: unknown) => void)({ ...event, currentTarget: current });
      }
    });
  let mounted = true;
  return {
    container,
    text: () => container.textContent,
    all,
    byText(text) {
      const found = all((node) => matches(node.ownText, text));
      if (found.length !== 1) throw new Error(`Expected one element with text ${String(text)}, found ${found.length}`);
      return found[0] as TreeNode;
    },
    byRole: (role, name) => all((node) => node.props.role === role && (name == null || matches(node.textContent, name))),
    click: (node) => fire(node, "onClick"),
    fire: (node, handler, extra = {}) => fire(node, handler, extra),
    async rerender(next) {
      await act(async () => {
        root.render(next);
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
