import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { type ComponentProps, type ReactNode, memo, useMemo, useState } from "react";
import { CodeBlock, type CustomRendererProps, defaultRehypePlugins } from "streamdown";
import { MessageResponse } from "@/components/ai-elements/message";
import { fromBase, useFileAccess, useFilePicture } from "@/features/files/fileAccess";
import { normalizeMathDelimiters } from "@/lib/mathDelimiters";
import { isSvgFence, taskFileOf } from "@/lib/preview";
import { TASK_FILE_TAG, rehypeTaskFiles } from "@/lib/rehypeTaskFiles";
import { svgPictureOf } from "@/lib/sanitizeSvg";
import { fenceBareSvg } from "@/lib/svgFences";
import { cn } from "@/lib/utils";
import "katex/dist/katex.min.css";

const PICTURE = "my-xs block max-h-[calc(var(--spacing-3xl)*8)] max-w-full rounded-md";

/** What stands where a picture cannot: its name, so the line still reads. */
function PictureNote({ children }: { children: string }) {
  return <span className="my-xs inline-block rounded-md bg-bg-inset px-xs py-3xs text-fg-faint text-sm">{children}</span>;
}

/** `![](pelican.svg)` in a reply: one of the task's own files, shown, and opened in the right pane on click. */
function TaskPicture({ path: written, alt }: { path: string; alt: string }) {
  const access = useFileAccess();
  const path = fromBase(access?.baseDir, written);
  const picture = useFilePicture(path);
  if (picture.status === "loading") return <PictureNote>图片加载中…</PictureNote>;
  if (picture.status === "unavailable") return <PictureNote>{alt === "" ? `无法显示 ${path}` : alt}</PictureNote>;
  return (
    <button type="button" title={path} onClick={() => access?.openFile(path)} className="block max-w-full cursor-zoom-in text-left">
      <img src={picture.src} alt={alt} className={PICTURE} />
    </button>
  );
}

function MarkdownImage({ src, alt }: ComponentProps<"img">) {
  const source = typeof src === "string" ? src : "";
  const path = taskFileOf(source);
  if (path != null) return <TaskPicture path={path} alt={alt ?? ""} />;
  if (source === "") return null;
  return <img src={source} alt={alt ?? ""} referrerPolicy="no-referrer" className={PICTURE} />;
}

/**
 * A fenced block that is a drawing is shown as the drawing; its source stays
 * one click away. `xml` and `html` fences land here too, and the ones that are
 * not SVG go back to being code.
 */
function SvgFence({ code: source, language, isIncomplete }: CustomRendererProps) {
  const [showSource, setShowSource] = useState(false);
  const drawing = isSvgFence(language, source);
  const picture = useMemo(() => (drawing && !isIncomplete ? svgPictureOf(source) : undefined), [drawing, isIncomplete, source]);

  if (!drawing) return <CodeBlock code={source} language={language} isIncomplete={isIncomplete} />;
  if (isIncomplete) return <PictureNote>正在画…</PictureNote>;
  if (picture == null || showSource) {
    return (
      <div>
        <CodeBlock code={source} language="xml" />
        {picture != null && <FenceToggle onClick={() => setShowSource(false)}>预览</FenceToggle>}
      </div>
    );
  }
  return (
    <div>
      <img src={picture} alt="模型画的图" className={cn(PICTURE, "w-full")} />
      <FenceToggle onClick={() => setShowSource(true)}>源码</FenceToggle>
    </div>
  );
}

function FenceToggle({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button type="button" onClick={onClick} className="text-fg-faint text-xs hover:text-fg">
      {children}
    </button>
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
