import { afterEach, describe, expect, it } from "vitest";
import { pickNativePath } from "./nativePicker";

const host = globalThis as { __TAURI__?: unknown };

afterEach(() => {
  delete host.__TAURI__;
});

describe("pickNativePath", () => {
  it("returns undefined in a plain browser so the caller falls back to the server", async () => {
    await expect(pickNativePath("folder")).resolves.toBeUndefined();
  });

  it("asks the Tauri dialog plugin for a directory and returns the path", async () => {
    const calls: unknown[] = [];
    host.__TAURI__ = {
      dialog: {
        open: (options: unknown) => {
          calls.push(options);
          return Promise.resolve("/Users/me/repo");
        },
      },
    };
    await expect(pickNativePath("folder")).resolves.toBe("/Users/me/repo");
    expect(calls).toEqual([{ directory: true, multiple: false, title: "选择仓库目录" }]);
  });

  it("reads a cancelled file dialog as null", async () => {
    host.__TAURI__ = { dialog: { open: () => Promise.resolve(null) } };
    await expect(pickNativePath("file")).resolves.toBeNull();
  });
});
