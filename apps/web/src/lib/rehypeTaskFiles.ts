import { localPathOf, taskFileUrl } from "./preview";

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** The element a link to a local file becomes; its one attribute is the path. */
export const TASK_FILE_TAG = "task-file";

const localTarget = (value: unknown): string | undefined => (typeof value === "string" ? localPathOf(value) : undefined);

function visit(node: HastNode): void {
  if (node.type === "element" && node.properties != null) {
    if (node.tagName === "img") {
      const path = localTarget(node.properties.src);
      if (path != null) node.properties.src = taskFileUrl(path);
    } else if (node.tagName === "a") {
      const path = localTarget(node.properties.href);
      if (path != null) {
        node.tagName = TASK_FILE_TAG;
        node.properties = { path };
      }
    }
  }
  for (const child of node.children ?? []) visit(child);
}

/**
 * Rehype: what points at a local file is taken out of the web's hands. An
 * image gets a URL the rest of the pipeline lets through (see `taskFileUrl`);
 * a link stops being a link — it becomes an element of our own, because a link
 * is something the renderer offers to open in a browser, and this is a file to
 * show in the right pane. It runs first, before the sanitizer has the chance
 * to drop what it does not recognise.
 */
export function rehypeTaskFiles() {
  return (tree: HastNode): void => visit(tree);
}
