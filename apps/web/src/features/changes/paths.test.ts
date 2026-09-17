import { describe, expect, it } from "vitest";
import type { ChangedFile } from "@/lib/types";
import { dirName, groupByDir, repoRelative } from "./paths";

const file = (path: string): ChangedFile => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 0,
  binary: false,
});

describe("dirName", () => {
  it("splits off the trailing segment", () => {
    expect(dirName("apps/web/src/App.tsx")).toBe("apps/web/src");
    expect(dirName("README.md")).toBe("");
  });
});

describe("groupByDir", () => {
  it("groups consecutive files under their directory", () => {
    const groups = groupByDir([file("README.md"), file("src/a.ts"), file("src/b.ts"), file("test/c.ts")]);

    expect(groups.map((group) => [group.dir, group.files.map((entry) => entry.path)])).toEqual([
      ["", ["README.md"]],
      ["src", ["src/a.ts", "src/b.ts"]],
      ["test", ["test/c.ts"]],
    ]);
  });
});

describe("repoRelative", () => {
  it("strips the repo prefix", () => {
    expect(repoRelative("/repos/vgent/apps/web/src/App.tsx", "/repos/vgent")).toBe("apps/web/src/App.tsx");
  });

  it("ignores a trailing slash on the repo path", () => {
    expect(repoRelative("/repos/vgent/a.ts", "/repos/vgent/")).toBe("a.ts");
  });

  it("keeps an already relative path", () => {
    expect(repoRelative("apps/web/src/App.tsx", "/repos/vgent")).toBe("apps/web/src/App.tsx");
  });

  it("rejects a path outside the repo", () => {
    expect(repoRelative("/etc/hosts", "/repos/vgent")).toBeNull();
    expect(repoRelative("/repos/vgent-other/a.ts", "/repos/vgent")).toBeNull();
  });
});
