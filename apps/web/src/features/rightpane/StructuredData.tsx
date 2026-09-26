import { useId, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Copy } from "lucide-react";
import { RichMarkdown } from "@/components/RichMarkdown";
import { UrlFigure } from "@/components/Figure";

const PAGE = 20;
const TEXT_PAGE = 2000;
const LABELS: Record<string, string> = {
  node: "节点", include: "检查项", spacing: "间距", tokens: "样式变量", warnings: "警告",
  path: "路径", file_path: "文件", filePath: "文件", filename: "文件名", command: "命令", cwd: "工作目录",
  stdout: "标准输出", stderr: "错误输出", exitCode: "退出码", exit_code: "退出码",
  content: "内容", text: "文本", description: "说明", error: "错误", message: "消息",
  pattern: "匹配表达式", query: "查询", glob: "文件匹配", limit: "数量限制", offset: "起始位置",
  results: "结果", matches: "匹配项", files: "文件", count: "数量", total: "总计", status: "状态",
  name: "名称", url: "链接", title: "标题", line: "行号", lineNumber: "行号", line_number: "行号",
  success: "成功", ok: "成功", isError: "错误标记", truncated: "内容已截断", duration: "耗时",
  structuredContent: "结构化结果", metadata: "附加信息", oldText: "原内容", newText: "新内容",
  old_string: "原内容", new_string: "新内容", diff: "差异", code: "代码", output: "输出",
};
const FILE_FIELDS = new Set(["path", "file_path", "filePath", "filename"]);
const CODE_FIELDS = new Set(["command", "stdout", "stderr", "diff", "code", "oldText", "newText", "old_string", "new_string"]);
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const scalar = (value: unknown) => value == null || ["string", "number", "boolean"].includes(typeof value);
const shortList = (value: unknown): value is unknown[] => Array.isArray(value) && value.length <= 6 && value.every(scalar);
const label = (key: string) => LABELS[key] ?? key;
const brief = (value: unknown): string => {
  if (value == null) return "未提供";
  if (Array.isArray(value)) return value.length === 0 ? "无" : `${value.length} 项`;
  if (isRecord(value)) return Object.keys(value).length === 0 ? "无字段" : `${Object.keys(value).length} 个字段`;
  if (typeof value === "boolean") return value ? "是" : "否";
  return value === "" ? "空字符串" : String(value);
};

/** Some engines and MCP tools return a JSON string instead of a structured value. */
export function readableValue(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 1_000_000 || !/^[\s]*[\[{]/.test(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
}
export function recordColumns(value: readonly unknown[]): string[] | undefined {
  if (value.length === 0 || !value.every(isRecord)) return undefined;
  const keys = [...new Set(value.flatMap((row) => Object.keys(row as Record<string, unknown>)))];
  return keys.length > 0 && keys.length <= 6 && value.every((row) => Object.values(row as Record<string, unknown>).every(scalar)) ? keys : undefined;
}
const rawText = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "未提供";

/** Progressive disclosure, with an exact source view for debugging and copying. */
export function DataSection({ title, value, onOpenFile, children }: { title: string; value: unknown; onOpenFile: (path: string) => void; children?: ReactNode }) {
  const [raw, setRaw] = useState(false);
  const id = useId();
  const [copyStatus, setCopyStatus] = useState("");
  const readable = useMemo(() => readableValue(value), [value]);
  return <section aria-labelledby={id} className="min-w-0 border-t border-border pt-md">
    <div className="mb-sm flex items-center gap-xs">
      <h3 id={id} className="mr-auto text-xs font-medium text-fg-muted">{title}</h3>
      <button type="button" aria-label={`${title}原始数据`} aria-pressed={raw} onClick={() => setRaw(!raw)} className="rounded-sm px-xs py-2xs text-xs text-fg-faint hover:bg-bg-hover hover:text-fg">{raw ? "返回详情" : "原始数据"}</button>
      <span role="status" className="text-xs text-fg-faint">{copyStatus}</span>
      <button type="button" aria-label={`复制${title}`} title={`复制${title}`} onClick={async () => { try { await navigator.clipboard.writeText(rawText(value)); setCopyStatus("已复制"); } catch { setCopyStatus("复制失败"); } }} className="rounded-sm p-2xs text-fg-faint hover:bg-bg-hover hover:text-fg"><Copy className="size-sm" /></button>
    </div>
    {raw ? <LongText value={rawText(value)} code /> : children ?? <StructuredData value={readable} onOpenFile={onOpenFile} />}
  </section>;
}

function LongText({ value, code = false }: { value: string; code?: boolean }) {
  const [limit, setLimit] = useState(TEXT_PAGE);
  return <div className="min-w-0">
    {code ? <pre className="max-h-figure overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-inset px-sm py-xs font-mono text-code leading-code text-fg-secondary">{value.slice(0, limit)}</pre> : <span className="whitespace-pre-wrap break-words text-sm text-fg">{value.slice(0, limit)}</span>}
    {value.length > limit && <button type="button" onClick={() => setLimit((current) => current + TEXT_PAGE)} className="mt-xs text-xs text-fg-muted hover:text-fg">展开更多（剩余 {value.length - limit} 字）</button>}
  </div>;
}

function ScalarValue({ value, name = "", onOpenFile }: { value: unknown; name?: string; onOpenFile: (path: string) => void }) {
  if (typeof value !== "string") return <span className={value == null ? "text-fg-faint" : "text-fg"}>{brief(value)}</span>;
  if (FILE_FIELDS.has(name) && value !== "" && !/^\w+:\/\//.test(value)) return <button type="button" onClick={() => onOpenFile(value)} className="break-all text-left text-sm text-brand hover:underline">{value}</button>;
  return <LongText value={brief(value)} code={CODE_FIELDS.has(name) || value.includes("\n")} />;
}

function More({ count, limit, expand }: { count: number; limit: number; expand: () => void }) {
  return count > limit ? <button type="button" onClick={expand} className="mt-xs py-xs text-xs text-fg-muted hover:text-fg">显示更多（剩余 {count - limit} 项）</button> : null;
}

/** Keep large arrays and deeply nested payloads readable without mounting them all. */
export function StructuredData({ value, name = "", depth = 0, onOpenFile }: { value: unknown; name?: string; depth?: number; onOpenFile: (path: string) => void }) {
  const [expanded, setExpanded] = useState(depth === 0);
  const [limit, setLimit] = useState(PAGE);
  if (scalar(value)) return <ScalarValue value={value} name={name} onOpenFile={onOpenFile} />;
  const list = Array.isArray(value);
  const entries = list ? value.map((item, index) => [String(index + 1), item] as const) : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span className="text-xs text-fg-faint">{list ? "无" : "无字段"}</span>;
  if (depth > 12) return <span className="text-xs text-fg-faint">更多层级请查看原始数据。</span>;
  const compactList = shortList(value);
  if (depth > 0 && !expanded && !compactList) return <button type="button" onClick={() => setExpanded(true)} aria-expanded={false} className="inline-flex items-center gap-2xs text-xs text-fg-muted hover:text-fg"><ChevronRight className="size-sm" />{brief(value)}</button>;
  const columns = list ? recordColumns(value) : undefined;
  const show = () => setLimit((current) => current + PAGE);
  return <div className="min-w-0">
    {depth > 0 && !compactList && <button type="button" onClick={() => setExpanded(false)} aria-expanded={true} className="mb-xs inline-flex items-center gap-2xs text-xs text-fg-faint hover:text-fg"><ChevronRight className="size-sm rotate-90" />{brief(value)}</button>}
    {columns ? <div className="overflow-x-auto rounded-md border border-border"><table className="w-full border-collapse text-left text-xs">
      <thead className="bg-bg-inset text-fg-muted"><tr>{columns.map((key) => <th className="whitespace-nowrap px-sm py-xs font-medium" title={key} key={key}>{label(key)}</th>)}</tr></thead>
      <tbody>{(value as Record<string, unknown>[]).slice(0, limit).map((row, index) => <tr className="border-t border-border align-top" key={index}>{columns.map((key) => <td className="max-w-figure px-sm py-xs" key={key}><ScalarValue value={row[key]} name={key} onOpenFile={onOpenFile} /></td>)}</tr>)}</tbody>
    </table></div> : list && value.every(scalar) ? <ul className="flex flex-wrap gap-xs">{value.slice(0, limit).map((item, index) => <li key={index} className="min-w-0 rounded-sm bg-bg-inset px-xs py-2xs text-xs"><ScalarValue value={item} onOpenFile={onOpenFile} /></li>)}</ul> : <dl className="min-w-0 space-y-sm">{entries.slice(0, limit).map(([key, item]) => <div key={key} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-x-sm gap-y-2xs">
      <dt title={key} className="break-words py-2xs text-xs text-fg-muted">{list ? `第 ${key} 项` : label(key)}</dt>
      <dd className={`min-w-0 py-2xs text-sm ${!scalar(item) && !shortList(item) ? "col-span-2 border-l border-border pl-sm" : typeof item === "string" && (CODE_FIELDS.has(key) || item.includes("\n")) ? "col-span-2" : ""}`}><StructuredData value={item} name={key} depth={depth + 1} onOpenFile={onOpenFile} /></dd>
    </div>)}</dl>}
    <More count={entries.length} limit={limit} expand={show} />
  </div>;
}

/** MCP's content envelope is already typed: render its text/images rather than exposing the transport shape. */
export function ToolResult({ value, onOpenFile }: { value: unknown; onOpenFile: (path: string) => void }) {
  const [limit, setLimit] = useState(PAGE);
  const data = readableValue(value);
  if (!isRecord(data) || !Array.isArray(data.content)) return <StructuredData value={data} onOpenFile={onOpenFile} />;
  const { content, ...rest } = data;
  return <div className="min-w-0 space-y-md">
    {content.slice(0, limit).map((item, index) => {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
        const parsed = readableValue(item.text);
        return typeof parsed === "string" ? <RichMarkdown key={index}>{parsed}</RichMarkdown> : <StructuredData key={index} value={parsed} onOpenFile={onOpenFile} />;
      }
      if (isRecord(item) && item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string" && /^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(item.mimeType)) {
        return <UrlFigure key={index} src={`data:${item.mimeType};base64,${item.data}`} alt={`工具返回的图片 ${index + 1}`} />;
      }
      return <StructuredData key={index} value={item} onOpenFile={onOpenFile} />;
    })}
    <More count={content.length} limit={limit} expand={() => setLimit((current) => current + PAGE)} />
    {Object.keys(rest).length > 0 && <StructuredData value={rest} onOpenFile={onOpenFile} />}
    {content.length === 0 && Object.keys(rest).length === 0 && <p className="text-xs text-fg-faint">没有返回内容。</p>}
  </div>;
}
