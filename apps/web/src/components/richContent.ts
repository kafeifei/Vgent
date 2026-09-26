import type { MermaidOptions } from "streamdown";

/** Scope stock Streamdown chrome to this renderer; fullscreen portals keep their own controls. */
export const RICH_CONTENT = [
  "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_[data-streamdown=table-wrapper]]:relative [&_[data-streamdown=table-wrapper]]:border-0 [&_[data-streamdown=table-wrapper]]:bg-transparent [&_[data-streamdown=table-wrapper]]:p-0 [&_[data-streamdown=table-wrapper]]:gap-0",
  "[&_[data-streamdown=table-wrapper]>div:first-child]:absolute [&_[data-streamdown=table-wrapper]>div:first-child]:right-xs [&_[data-streamdown=table-wrapper]>div:first-child]:top-xs [&_[data-streamdown=table-wrapper]>div:first-child]:z-10 [&_[data-streamdown=table-wrapper]>div:first-child]:rounded-md [&_[data-streamdown=table-wrapper]>div:first-child]:bg-bg-elevated [&_[data-streamdown=table-wrapper]>div:first-child]:p-2xs [&_[data-streamdown=table-wrapper]>div:first-child]:shadow-xs",
  "[@media(hover:hover)]:[&_[data-streamdown=table-wrapper]>div:first-child]:opacity-0 [@media(hover:hover)]:[&_[data-streamdown=table-wrapper]>div:first-child]:pointer-events-none",
  "[&_[data-streamdown=table-wrapper]:hover>div:first-child]:opacity-100 [&_[data-streamdown=table-wrapper]:hover>div:first-child]:pointer-events-auto [&_[data-streamdown=table-wrapper]:focus-within>div:first-child]:opacity-100 [&_[data-streamdown=table-wrapper]:focus-within>div:first-child]:pointer-events-auto",
  "[&_[data-streamdown=mermaid-block]]:gap-0 [&_[data-streamdown=mermaid-block]]:rounded-lg [&_[data-streamdown=mermaid-block]]:bg-transparent [&_[data-streamdown=mermaid-block]]:p-xs",
  "[&_[data-streamdown=mermaid]_[role=img]]:w-full",
  "[&_[data-streamdown=mermaid-block]>div:first-child]:hidden [&_[data-streamdown=mermaid-block]>div:last-child]:border-0 [&_[data-streamdown=mermaid-block]>div:last-child]:bg-transparent",
  "[&_[data-streamdown=mermaid-block]>div:nth-child(2)]:absolute [&_[data-streamdown=mermaid-block]>div:nth-child(2)]:top-xs [&_[data-streamdown=mermaid-block]>div:nth-child(2)]:right-xs [&_[data-streamdown=mermaid-block]>div:nth-child(2)]:mt-0",
  "[&_[data-streamdown=mermaid-block-actions]]:border-border [&_[data-streamdown=mermaid-block-actions]]:bg-bg-elevated [&_[data-streamdown=mermaid-block-actions]]:gap-2xs [&_[data-streamdown=mermaid-block-actions]]:p-2xs [&_[data-streamdown=mermaid-block-actions]]:shadow-xs",
  "[&_[data-streamdown=mermaid-block]_.absolute]:flex-row [&_[data-streamdown=mermaid-block]_.absolute]:border-border [&_[data-streamdown=mermaid-block]_.absolute]:bg-bg-elevated",
  "[@media(hover:hover)]:[&_[data-streamdown=mermaid-block-actions]]:opacity-0 [@media(hover:hover)]:[&_[data-streamdown=mermaid-block-actions]]:pointer-events-none [@media(hover:hover)]:[&_[data-streamdown=mermaid-block]_.absolute]:opacity-0 [@media(hover:hover)]:[&_[data-streamdown=mermaid-block]_.absolute]:pointer-events-none",
  "[&_[data-streamdown=mermaid-block]:hover_[data-streamdown=mermaid-block-actions]]:opacity-100 [&_[data-streamdown=mermaid-block]:hover_[data-streamdown=mermaid-block-actions]]:pointer-events-auto [&_[data-streamdown=mermaid-block]:focus-within_[data-streamdown=mermaid-block-actions]]:opacity-100 [&_[data-streamdown=mermaid-block]:focus-within_[data-streamdown=mermaid-block-actions]]:pointer-events-auto",
  "[&_[data-streamdown=mermaid-block]:hover_.absolute]:opacity-100 [&_[data-streamdown=mermaid-block]:hover_.absolute]:pointer-events-auto [&_[data-streamdown=mermaid-block]:focus-within_.absolute]:opacity-100 [&_[data-streamdown=mermaid-block]:focus-within_.absolute]:pointer-events-auto",
  "[&_[data-streamdown=table-wrapper]>div:first-child]:transition-opacity [&_[data-streamdown=mermaid-block-actions]]:transition-opacity [&_[data-streamdown=mermaid-block]_.absolute]:transition-opacity motion-reduce:[&_*]:transition-none",
].join(" ");

/** Mermaid's color parser needs RGB hex; canvas resolves our CSS color-mix/OKLCH tokens to sRGB. */
export function mermaidAppearance(): MermaidOptions {
  if (typeof document === "undefined") return {};
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (context == null) return {};
  const tokens = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const color = (name: string) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = body.backgroundColor;
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = tokens.getPropertyValue(name).trim();
    context.fillRect(0, 0, 1, 1);
    return "#" + Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map((channel) => channel.toString(16).padStart(2, "0")).join("");
  };
  return { config: {
    theme: "base",
    fontFamily: body.fontFamily,
    themeVariables: {
      background: color("--color-bg"), primaryColor: color("--color-bg-inset"), primaryTextColor: color("--color-fg"),
      primaryBorderColor: color("--color-border-strong"), lineColor: color("--color-fg-muted"), textColor: color("--color-fg"),
      secondaryColor: color("--color-bg-elevated"), tertiaryColor: color("--color-bg-inset"),
      clusterBkg: color("--color-bg-inset"), clusterBorder: color("--color-border"), edgeLabelBackground: color("--color-bg"),
      fontFamily: body.fontFamily, fontSize: body.fontSize,
    },
  } };
}
