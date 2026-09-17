import { useEffect, useRef } from "react";
import { ArrowUp, Plus, Square } from "lucide-react";
import { ModelPicker, modelLabel } from "@/components/ModelPicker";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export const COMPOSER_PLACEHOLDER = "规划、构建，/ 输入命令，@ 引用上下文";

/**
 * The composer, shared by the thread view and the empty state.
 *
 * The review bar above it keeps its slot — 审查 pill, context ring and 运行位置
 * dropdown are later steps, so it carries only the static 本机 chip for now.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  live,
  model,
  onPickModel,
  autoFocus = false,
  big = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  live: boolean;
  model: string | undefined;
  onPickModel: (model: string | null) => void;
  autoFocus?: boolean;
  big?: boolean;
}) {
  const toast = useToast();
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow: reset, then take the content height.
  useEffect(() => {
    const element = textarea.current;
    if (element == null) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  return (
    <div className="mx-auto w-full max-w-log-max">
      <div className="flex min-h-review-bar items-center gap-2xs pb-2xs">
        <span className="inline-flex h-xl items-center rounded-full border border-border bg-bg-elevated px-sm text-fg-muted text-xs">
          本机
        </span>
      </div>

      <div className="relative rounded-lg border border-border bg-bg-elevated focus-within:border-border-strong">
        <textarea
          ref={textarea}
          value={value}
          autoFocus={autoFocus}
          rows={2}
          placeholder={COMPOSER_PLACEHOLDER}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSubmit();
            }
          }}
          className={cn(
            "block w-full resize-none bg-transparent px-md py-sm text-body leading-body outline-none placeholder:text-fg-faint",
            big ? "min-h-[calc(var(--spacing-xl)*3)]" : "min-h-[calc(var(--spacing-xl)*2)]",
          )}
        />

        <div className="flex items-center gap-2xs px-xs pt-2xs pb-xs">
          <button
            type="button"
            aria-label="添加上下文"
            onClick={() => toast("下一步")}
            className="grid size-xl flex-none place-items-center rounded-full bg-bg-inset text-fg-muted hover:bg-bg-active hover:text-fg"
          >
            <Plus className="size-md" />
          </button>
          <span className="inline-flex h-xl items-center rounded-sm px-xs text-fg-muted text-xs">Agent</span>
          <ModelPicker
            model={model}
            onPick={onPickModel}
            side="top"
            trigger={(props) => (
              <button
                type="button"
                {...props}
                className="inline-flex h-xl items-center gap-3xs rounded-sm px-xs text-fg-muted text-xs hover:bg-bg-hover hover:text-fg"
              >
                <span className="font-mono">{modelLabel(model)}</span>
                <span className="opacity-60">▾</span>
              </button>
            )}
          />
          <span className="flex-1" />
          <button
            type="button"
            aria-label={live ? "停止" : "发送"}
            onClick={() => (live ? onStop?.() : onSubmit())}
            className="grid size-2xl flex-none place-items-center rounded-full bg-brand text-brand-fg hover:bg-brand-hover"
          >
            {live ? <Square className="size-md fill-current" /> : <ArrowUp className="size-lg" />}
          </button>
        </div>
      </div>
    </div>
  );
}
