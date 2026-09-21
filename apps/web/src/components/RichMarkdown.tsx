import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { type ComponentProps, type ReactNode, memo, useMemo, useState } from "react";
import { CodeBlock, type CustomRendererProps, defaultRehypePlugins } from "streamdown";
import { MessageResponse } from "@/components/ai-elements/message";
import { Figure } from "@/components/Figure";
import { fromBase, openInBrowser, useFileAccess, useFilePicture } from "@/features/files/fileAccess";
import { baseName } from "@/lib/format";
import { normalizeMathDelimiters } from "@/lib/mathDelimiters";
import { isSvgFence, svgDataUri, taskFileOf } from "@/lib/preview";
import { TASK_FILE_TAG, rehypeTaskFiles } from "@/lib/rehypeTaskFiles";
import { cleanSvg } from "@/lib/sanitizeSvg";
import { fenceBareSvg } from "@/lib/svgFences";
import "katex/dist/katex.min.css";

/** `![](pelican.svg)` in a reply: one of the task's own files. */
function TaskPicture({ path: written, alt }: { path: string; alt: string }) {
  const access = useFileAccess();
  const path = fromBase(access?.baseDir, written);
  const picture = useFilePicture(path);
  return (
    <Figure
      title={baseName(path)}
      alt={alt}
      {...(picture.status === "ready" ? { src: picture.src } : { note: picture.status === "loading" ? "加载中…" : "无法显示这个文件" })}
      {...(access != null && picture.status === "ready"
        ? { onOpenSide: () => access.openFile(path), onOpenBrowser: () => openInBrowser(access, { path }) }
        : {})}
    />
  );
}

function MarkdownImage({ src, alt }: ComponentProps<"img">) {
  const source = typeof src === "string" ? src : "";
  const path = taskFileOf(source);
  if (path != null) return <TaskPicture path={path} alt={alt ?? ""} />;
  if (source === "") return null;
  // The web's own picture: there is nothing of it to open in the right pane, and the browser can load it as is.
  const remote = /^https?:/i.test(source);
  return (
    <Figure
      title={alt != null && alt !== "" ? alt : remote ? new URL(source).hostname : "图片"}
      src={source}
      alt={alt ?? ""}
      {...(remote ? { onOpenBrowser: () => void window.open(source, "_blank", "noreferrer") } : {})}
    />
  );
}

/**
 * A fenced block that is a drawing is shown as the drawing; its source stays
 * one click away. `xml` and `html` fences land here too, and the ones that are
 * not SVG go back to being code.
 */
function SvgFence({ code: source, language, isIncomplete }: CustomRendererProps) {
  const access = useFileAccess();
  const [showSource, setShowSource] = useState(false);
  const drawing = isSvgFence(language, source);
  const clean = useMemo(() => (drawing && !isIncomplete ? cleanSvg(source) : undefined), [drawing, isIncomplete, source]);

  if (!drawing) return <CodeBlock code={source} language={language} isIncomplete={isIncomplete} />;
  const picture = clean == null ? "" : svgDataUri(clean);
  const drawn = clean != null && picture !== "";
  return (
    <Figure
      title="SVG"
      alt="模型画的图"
      {...(drawn ? { src: picture } : { note: isIncomplete ? "正在画…" : "这段 SVG 画不出来" })}
      {...(isIncomplete ? {} : { source: { on: showSource || !drawn, onToggle: () => setShowSource((on) => !on), body: <CodeBlock code={source} language="xml" /> } })}
      {...(drawn && access?.openDrawing != null ? { onOpenSide: () => access.openDrawing?.(clean) } : {})}
      {...(drawn && access != null ? { onOpenBrowser: () => openInBrowser(access, { svg: clean }) } : {})}
    />
  );
}

const PLUGINS = { cjk, code, math, mermaid, renderers: [{ language: ["svg", "xml", "html"], component: SvgFence }] };

/** `[guide](docs/guide.md)` in a reply: opens the file in the right pane rather than a browser. */
function TaskFileLink({ path, children }: { path?: string; children?: ReactNode }) {
  const access = useFileAccess();
  if (path == null) return <>{children}</>;
  return (
    <button
      type="button"
      title={path}
      onClick={() => access?.openFile(fromBase(access.baseDir, path))}
      className="wrap-anywhere appearance-none text-left font-medium text-primary underline"
    >
      {children}
    </button>
  );
}

const COMPONENTS = { img: MarkdownImage, [TASK_FILE_TAG]: TaskFileLink } as NonNullable<ComponentProps<typeof MessageResponse>["components"]>;

type RehypePlugins = NonNullable<ComponentProps<typeof MessageResponse>["rehypePlugins"]>;

/** The stock pipeline, with our element let through its sanitizer. */
const REHYPE = ((): RehypePlugins => {
  const [sanitize, schema] = defaultRehypePlugins.sanitize as [unknown, { tagNames?: string[]; attributes?: Record<string, unknown> }];
  const widened = {
    ...schema,
    tagNames: [...(schema.tagNames ?? []), TASK_FILE_TAG],
    attributes: { ...schema.attributes, [TASK_FILE_TAG]: ["path"] },
  };
  return [rehypeTaskFiles, defaultRehypePlugins.raw, [sanitize, widened], defaultRehypePlugins.harden] as RehypePlugins;
})();

/**
 * Markdown as the work log, the plan and the file viewer all show it: formulas
 * typeset, diagrams drawn, a fenced SVG shown as a picture, and an image that
 * points at one of the task's files loaded from that task.
 */
export const RichMarkdown = memo(function RichMarkdown({ children, className }: { children: string; className?: string }) {
  const text = useMemo(() => normalizeMathDelimiters(fenceBareSvg(children)), [children]);
  return (
    <MessageResponse plugins={PLUGINS} components={COMPONENTS} rehypePlugins={REHYPE} {...(className != null ? { className } : {})}>
      {text}
    </MessageResponse>
  );
});
