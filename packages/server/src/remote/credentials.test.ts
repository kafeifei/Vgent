import { expect, test, vi } from "vitest";
import { createRemoteCredentials } from "./credentials.js";

test("fresh installs never prompt to read Keychain, and store no plaintext credential in settings", async () => {
  let configured = false;
  const values: boolean[] = [];
  const value = { accessToken: "github-private", refreshToken: "refresh-private" };
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
  const command = vi.fn(async (args: string[], _input?: string) => args[0] === "find-generic-password" ? encoded : "");
  const store = createRemoteCredentials("/isolated/vgent", { get: () => configured, set: (next) => { configured = next; values.push(next); } }, command);
  expect(await store.read()).toBeUndefined();
  expect(command).not.toHaveBeenCalled();
  await store.write(value);
  expect(values).toEqual([true]);
  expect(command.mock.calls[0]?.[0]).toEqual(["-i"]);
  expect(command.mock.calls[0]?.[1]).toContain(encoded);
  expect(JSON.stringify(command.mock.calls.map(([args]) => args))).not.toContain(encoded);
  expect(await store.read()).toEqual(value);
  await store.clear();
  expect(values).toEqual([true, false]);
  expect(command.mock.calls.at(-1)?.[0][0]).toBe("delete-generic-password");
});

test("failed writes cannot mark a login saved or expose credential-bearing errors", async () => {
  const set = vi.fn();
  const store = createRemoteCredentials("/isolated/vgent", { get: () => false, set }, async () => { throw new Error("private-token transport headers"); });
  await expect(store.write({ accessToken: "private-token" })).rejects.toThrow("Remote credential storage unavailable");
  expect(set).not.toHaveBeenCalled();
});

test("successful command exit alone does not count as a saved credential", async () => {
  let saved = false;
  const store = createRemoteCredentials("/isolated/vgent", { get: () => saved, set: (value) => { saved = value; } }, async (args) => {
    if (args[0] === "find-generic-password") throw Object.assign(new Error("not found"), { code: 44 });
    return "";
  });
  await expect(store.write({ accessToken: "private-token" })).rejects.toThrow("not saved");
});

test("each data directory uses its own Vgent credential item", async () => {
  const names: string[] = [];
  for (const directory of ["/isolated/vgent-a", "/isolated/vgent-b"]) {
    const store = createRemoteCredentials(directory, { get: () => true, set: () => {} }, async (args) => {
      names.push(args[args.indexOf("-s") + 1]!);
      throw Object.assign(new Error("not found"), { code: 44 });
    });
    expect(await store.read()).toBeUndefined();
  }
  expect(names.every((name) => name.startsWith("dev.vgent.remote."))).toBe(true);
  expect(names[0]).not.toBe(names[1]);
});
