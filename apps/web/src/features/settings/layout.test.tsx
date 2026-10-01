import { renderToStaticMarkup } from "react-dom/server";
import { Dialog as DialogPrimitive } from "radix-ui";
import { describe, expect, it } from "vitest";
import { DialogShell } from "./layout";

/**
 * The settings dialog is Radix's, so the focus trap, the hidden page behind it
 * and Esc are Radix's to keep; what is ours is what it renders. The portal only
 * mounts in a browser, so the shell is rendered inside a bare `Dialog.Root`.
 */
const shell = (props: { wide?: boolean } = {}) =>
  renderToStaticMarkup(
    <DialogPrimitive.Root open>
      <DialogShell title="连接 OpenAI" {...props}>
        <p>正文</p>
      </DialogShell>
    </DialogPrimitive.Root>,
  );

describe("the settings Dialog", () => {
  it("is a dialog Radix manages, not a bare div that only claims to be modal", () => {
    const html = shell();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    // Radix marks its scrim and panel open; a hand-rolled div carries no such state.
    expect(html.match(/data-state="open"/g)).toHaveLength(2);
    // A panel focus can be moved onto when nothing inside it takes it.
    expect(html).toMatch(/role="dialog"[^>]*tabindex="-1"|tabindex="-1"[^>]*role="dialog"/);
  });

  it("is named by its title, which is the heading Radix points the dialog at", () => {
    const html = shell();
    expect(html).toMatch(/<h2 id="[^"]+"[^>]*>连接 OpenAI<\/h2>/);
    expect(html).not.toContain('aria-label="连接 OpenAI"');
  });

  it("has a close button a screen reader can name", () => {
    expect(shell()).toMatch(/<button[^>]*aria-label="关闭"/);
  });

  it("is laid out as it always was: a scrim that centres the panel, the panel's width by `wide`", () => {
    const html = shell();
    expect(html).toContain("fixed inset-0 z-30 flex items-start justify-center bg-bg-scrim");
    expect(html).toContain("w-[calc(var(--spacing-log-max)*0.6)]");
    expect(shell({ wide: true })).toContain("w-[calc(var(--spacing-log-max)*0.8)]");
    expect(html).toContain("<p>正文</p>");
  });

  it("puts nothing under a transform, or the popovers inside it would be placed against the panel", () => {
    expect(shell()).not.toMatch(/translate|transform/);
  });
});
