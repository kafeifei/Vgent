import { describe, expect, it } from "vitest";
import { NotImplementedError, VgentServerError } from "./errors.js";
import { pickFolder, type ExecFileFn } from "./folder-picker.js";

const succeeds =
  (stdout: string): ExecFileFn =>
  () =>
    Promise.resolve({ stdout });

const fails =
  (error: unknown): ExecFileFn =>
  () =>
    Promise.reject(error);

describe("pickFolder", () => {
  it("returns the chosen directory without the trailing slash AppleScript adds", async () => {
    await expect(pickFolder({ platform: "darwin", exec: succeeds("/Users/me/Codes/vgent/\n") })).resolves.toBe("/Users/me/Codes/vgent");
    await expect(pickFolder({ platform: "darwin", exec: succeeds("/\n") })).resolves.toBe("/");
  });

  it("treats Cancel as no choice, not an error", async () => {
    const cancel = Object.assign(new Error("Command failed"), { stderr: "execution error: User canceled. (-128)\n" });
    await expect(pickFolder({ platform: "darwin", exec: fails(cancel) })).resolves.toBeNull();
    await expect(pickFolder({ platform: "darwin", exec: succeeds("  \n") })).resolves.toBeNull();
  });

  it("turns any other osascript failure into a typed 500", async () => {
    const boom = Object.assign(new Error("osascript 挂了"), { stderr: "" });
    await expect(pickFolder({ platform: "darwin", exec: fails(boom) })).rejects.toMatchObject({
      status: 500,
      code: "picker_failed",
    });
    await expect(pickFolder({ platform: "darwin", exec: fails(boom) })).rejects.toBeInstanceOf(VgentServerError);
  });

  it("is a 501 off macOS so the UI can fall back to typing a path", async () => {
    const result = pickFolder({ platform: "linux", exec: succeeds("/never") });
    await expect(result).rejects.toBeInstanceOf(NotImplementedError);
    await expect(result).rejects.toMatchObject({ status: 501, code: "picker_unavailable" });
  });
});
