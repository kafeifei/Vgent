import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { type ComponentProps, type ReactNode, memo, useMemo } from "react";
import { CodeBlock, type CustomRendererProps, defaultRehypePlugins } from "streamdown";
import { MessageResponse } from "@/components/ai-elements/message";
import { Figure, RemoteFigure } from "@/components/Figure";
import { TaskPicture } from "@/features/files/TaskPicture";
import { download, drawingPicture, fromBase, useFileAccess } from "@/features/files/fileAccess";
import { normalizeMathDelimiters } from "@/lib/mathDelimiters";
import { isSvgFence, taskFileOf } from "@/lib/preview";
import { TASK_FILE_TAG, rehypeTaskFiles } from "@/lib/rehypeTaskFiles";
import { fenceBareSvg } from "@/lib/svgFences";
import "katex/dist/katex.min.css";

function MarkdownImage({ src, alt }: ComponentProps<"img">) {
  const source = typeof src === "string" ? src : "";
  const path = taskFileOf(source);
  if (path != null) return <TaskPicture path={path} alt={alt ?? ""} />;
  return source === "" ? null : <RemoteFigure src={source} alt={alt ?? ""} />;
}

/**
 * A fenced block that is a drawing is shown as the drawing, like any other
 * picture; 下载 gives the source back as a file. `xml` and `html`
 * fences land here too, and the ones that are not SVG go back to being code.
 */
function SvgFence({ code: source, language, isIncomplete }: CustomRendererProps) {
  const access = useFileAccess();
  const drawing = isSvgFence(language, source);
  const picture = useMemo(() => (drawing && !isIncomplete ? drawingPicture(source) : undefined), [drawing, isIncomplete, source]);

  if (!drawing) return <CodeBlock code={source} language={language} isIncomplete={isIncomplete} />;
  if (isIncomplete) return <Figure alt="" note="正在画…" />;
  // Markup that is no drawing after all stays readable as what it is.
  if (picture == null) return <CodeBlock code={source} language="xml" />;
  return (
    <Figure
      picture={picture}
      alt="模型画的图"
      {...(access != null ? { onDownload: () => download(access, { svg: source }) } : {})}
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
