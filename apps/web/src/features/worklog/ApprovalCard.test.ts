import { describe, expect, it } from "vitest";
import { alwaysAllowOffer } from "./ApprovalCard";

/** What the button offers for one `bash` call. */
const offer = (command: string, allowlist: string[] = []) => alwaysAllowOffer("bash", { command }, allowlist);

describe("alwaysAllowOffer", () => {
  it("writes the command the entry will name, down to the sub-command", () => {
    expect(offer("git push")).toEqual({ label: "git push", entries: ["bash(git push)"] });
    expect(offer("docker compose up -d")).toEqual({ label: "docker compose", entries: ["bash(docker compose)"] });
    expect(offer("rm -rf build")).toEqual({ label: "rm", entries: ["bash(rm)"] });
  });

  it("offers one entry per segment the list is still missing", () => {
    expect(offer("git commit -m wip && git push")).toEqual({
      label: "git commit、git push",
      entries: ["bash(git commit)", "bash(git push)"],
    });
    // `git status` is on the built-in safe list, so only `git push` is left.
    expect(offer("git status && git push", ["bash(git status)"])).toEqual({ label: "git push", entries: ["bash(git push)"] });
    expect(offer("git commit -m wip && git push", ["bash(git commit)"])).toEqual({
      label: "git push",
      entries: ["bash(git push)"],
    });
  });

  it("offers nothing for a command it cannot name honestly, or one already covered", () => {
    // A flag before the sub-command, a wrapper, a substitution: no offer at all.
    expect(offer("git -C /other status")).toBeNull();
    expect(offer("sudo git push")).toBeNull();
    expect(offer("git push $(cat x)")).toBeNull();
    expect(offer("git push", ["bash(git push)"])).toBeNull();
    // A legacy `bash(git)` covers nothing now, so the offer is the real entry.
    expect(offer("git push", ["bash(git)"])).toEqual({ label: "git push", entries: ["bash(git push)"] });
  });

  it("offers the tool itself for everything that is not bash", () => {
    expect(alwaysAllowOffer("write", { file_path: "a.txt" }, [])).toMatchObject({ entries: ["write"] });
  });
});
