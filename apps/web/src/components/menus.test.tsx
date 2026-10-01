import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CascadeLevel, type CascadeNode } from "./CascadeMenu";
import { PopItem, PopTitle, Popover } from "./Popover";

/**
 * What the two menus put in the markup for a keyboard and a screen reader. The
 * behaviour itself — what ↑ ↓ → ← Esc Tab do — is `menuKeys.test.ts`; there is
 * no DOM here, so this is the half that is visible without one.
 */

const attribute = (html: string, name: string): string[] => [...html.matchAll(new RegExp(`${name}="([^"]*)"`, "g"))].map((match) => match[1] as string);

describe("PopItem", () => {
  it("is a menu row that Tab does not walk: the menu is one stop, the arrow keys move inside it", () => {
    const html = renderToStaticMarkup(<PopItem>重命名</PopItem>);
    expect(html).toContain('role="menuitem"');
    expect(html).toContain('tabindex="-1"');
  });

  it("shows keyboard focus the way it shows hover", () => {
    const html = renderToStaticMarkup(<PopItem>重命名</PopItem>);
    expect(html).toContain("focus-visible:bg-bg-active");
    expect(html).toContain("hover:bg-bg-active");
  });

  it("keeps its shortcut and disabled state", () => {
    const html = renderToStaticMarkup(
      <PopItem shortcut="d" disabled>
        删除任务…
      </PopItem>,
    );
    expect(html).toContain('data-pop-key="d"');
    expect(html).toContain('aria-keyshortcuts="d"');
    expect(html).toContain("disabled");
  });
});

describe("Popover", () => {
  it("hands its trigger a key handler beside the click: ↓ / ↑ open a menu on its first / last row", () => {
    let given: Parameters<Parameters<typeof Popover>[0]["trigger"]>[0] | undefined;
    const html = renderToStaticMarkup(
      <Popover
        trigger={(props) => {
          given = props;
          return (
            <button type="button" aria-expanded={props["aria-expanded"]} aria-haspopup={props["aria-haspopup"]}>
              open
            </button>
          );
        }}
      >
        {() => <PopItem>x</PopItem>}
      </Popover>,
    );
    expect(typeof given?.onKeyDown).toBe("function");
    expect(typeof given?.onClick).toBe("function");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    // Closed, there is no panel to hold focus.
    expect(html).not.toContain('role="menu"');
  });
});

describe("CascadeLevel", () => {
  const nodes: CascadeNode[] = [
    { key: "fast", label: "Fast", toggle: true, onPick: () => {} },
    { key: "context", label: "上下文", hint: "200K", children: [{ key: "200k", label: "200K", selected: true }] },
    { key: "model", label: "模型", separated: true, content: <div>list</div> },
    { key: "engine", label: "引擎", disabled: true, onPick: () => {} },
  ];
  const html = renderToStaticMarkup(<CascadeLevel nodes={nodes} />);

  it("has every row out of the tab order and named as a menu row", () => {
    expect(attribute(html, "tabindex")).toEqual(["-1", "-1", "-1", "-1"]);
    expect(html.match(/role="menuitem"/g)).toHaveLength(3);
    expect(html.match(/role="menuitemcheckbox"/g)).toHaveLength(1);
  });

  it("says which rows open a submenu, and that none is open yet", () => {
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(2);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
  });

  it("says a switch's state to a screen reader, not only with its colour", () => {
    expect(html).toContain('aria-checked="true"');
  });

  it("shows keyboard focus the way it shows hover", () => {
    expect(html).toContain("focus-visible:bg-bg-active");
    expect(html).toContain("hover:bg-bg-active");
  });
});

describe("PopTitle", () => {
  it("is unchanged: a caption, not a row", () => {
    expect(renderToStaticMarkup(<PopTitle>分组方式</PopTitle>)).not.toContain("menuitem");
  });
});
