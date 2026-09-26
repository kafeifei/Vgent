import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { createContext, type ComponentProps, type ReactNode, memo, useContext, useMemo, useState } from "react";
import { Streamdown, CodeBlock, type CustomRendererProps, defaultRehypePlugins } from "streamdown";
import { RICH_CONTENT, mermaidAppearance } from "./richContent";
import { usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { Figure, PictureDialogContent, RemoteFigure } from "@/components/Figure";
import { Dialog } from "@/components/ui/dialog";
import { DrawnPicture, TaskPicture } from "@/features/files/TaskPicture";
import { download, drawingPicture, fromBase, useFileAccess } from "@/features/files/fileAccess";
import { normalizeMathDelimiters } from "@/lib/mathDelimiters";
import { isSvgFence, previewKindOf, taskFileOf } from "@/lib/preview";
import { TASK_FILE_TAG, rehypeTaskFiles } from "@/lib/rehypeTaskFiles";
import { fenceBareSvg } from "@/lib/svgFences";
import { drawingFor } from "@/features/worklog/outputs";
import "katex/dist/katex.min.css";

const TurnDrawings = createContext<ReadonlyMap<string, string> | null>(null);

export function TurnDrawingProvider({ drawings, children }: { drawings: ReadonlyMap<string, string>; children: ReactNode }) {
  return <TurnDrawings.Provider value={drawings}>{children}</TurnDrawings.Provider>;
}

function MarkdownImage({ src, alt }: ComponentProps<"img">) {
  const source = typeof src === "string" ? src : "";
  const path = taskFileOf(source);
  const drawings = useContext(TurnDrawings);
  const svg = path != null && previewKindOf(path) === "svg" && drawings != null ? drawingFor(drawings, { raw: path, path }) : undefined;
  if (svg != null) return <DrawnPicture svg={svg} alt={alt ?? ""} />;
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
  if (isIncomplete) return <Figure alt="" note="正在画…" pending />;
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

/** A local file link goes through the task's file action: pictures enlarge, documents open in the file pane. */
function TaskFileLink({ path, children }: { path?: string; children?: ReactNode }) {
  const access = useFileAccess();
  const drawings = useContext(TurnDrawings);
  const [open, setOpen] = useState(false);
  const svg = path != null && previewKindOf(path) === "svg" && drawings != null ? drawingFor(drawings, { raw: path, path }) : undefined;
  const picture = useMemo(() => svg == null ? undefined : drawingPicture(svg), [svg]);
  if (path == null) return <>{children}</>;
  return (
    <>
      <button
        type="button"
        title={path}
        onClick={() => picture != null ? setOpen(true) : access?.openFile(fromBase(access.baseDir, path))}
        className="wrap-anywhere appearance-none text-left font-medium text-primary underline"
      >
        {children}
      </button>
      {picture != null && (
        <Dialog open={open} onOpenChange={setOpen}>
          <PictureDialogContent picture={picture} alt={path} {...(access != null && svg != null ? { onDownload: () => download(access, { svg }) } : {})} />
        </Dialog>
      )}
    </>
  );
}

const COMPONENTS = { img: MarkdownImage, [TASK_FILE_TAG]: TaskFileLink } as NonNullable<ComponentProps<typeof Streamdown>["components"]>;

type RehypePlugins = NonNullable<ComponentProps<typeof Streamdown>["rehypePlugins"]>;

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
  const { resolvedTheme, density } = usePrefs();
  const text = useMemo(() => normalizeMathDelimiters(fenceBareSvg(children)), [children]);
  const hasMermaid = /^\s*(?:`{3,}|~{3,})mermaid\b/m.test(text);
  const mermaidOptions = useMemo(() => hasMermaid ? mermaidAppearance() : {}, [hasMermaid, resolvedTheme, density]);
  // Streamdown caches unchanged blocks; an appearance change must also redraw their SVGs.
  return (
    <Streamdown key={hasMermaid ? `${resolvedTheme}-${density}` : "text"} plugins={PLUGINS} mermaid={mermaidOptions} components={COMPONENTS} rehypePlugins={REHYPE} className={cn(RICH_CONTENT, className)}>
      {text}
    </Streamdown>
  );
});
