import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireInstanceLock, INSTANCE_LOCK_FILE, InstanceLockedError } from "./instance-lock.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-lock-"));
  dirs.push(dir);
  return dir;
}

/** A pid that is certainly gone: spawn something that exits immediately and wait for it. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

const readLock = async (dir: string) => JSON.parse(await readFile(join(dir, INSTANCE_LOCK_FILE), "utf8")) as { pid: number; nonce: string };
const exists = async (path: string) => (await stat(path).catch(() => undefined)) != null;

describe("acquireInstanceLock", () => {
  it("writes a lock naming this process", async () => {
    const dir = await tempDir();
    await acquireInstanceLock(dir);
    expect((await readLock(dir)).pid).toBe(process.pid);
  });

  it("refuses a data directory whose owner is alive", async () => {
    const dir = await tempDir();
    await acquireInstanceLock(dir);
    const error = await acquireInstanceLock(dir).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(InstanceLockedError);
    expect((error as InstanceLockedError).pid).toBe(process.pid);
    expect((error as InstanceLockedError).lockPath).toBe(join(dir, INSTANCE_LOCK_FILE));
  });

  it("takes over a lock left behind by a dead owner", async () => {
    const dir = await tempDir();
    const stale = { pid: await deadPid(), nonce: "stale-nonce", createdAt: new Date().toISOString() };
    await writeFile(join(dir, INSTANCE_LOCK_FILE), JSON.stringify(stale));
    await acquireInstanceLock(dir);
    expect((await readLock(dir)).pid).toBe(process.pid);
    // The recovery guard is never left behind for the next launch to trip over.
    expect(await exists(join(dir, `${INSTANCE_LOCK_FILE}.recovery`))).toBe(false);
  });

  it("removes the lock on release, and the directory can be locked again", async () => {
    const dir = await tempDir();
    const release = await acquireInstanceLock(dir);
    await release();
    expect(await exists(join(dir, INSTANCE_LOCK_FILE))).toBe(false);
    await expect(acquireInstanceLock(dir)).resolves.toBeTypeOf("function");
  });

  it("never removes someone else's lock", async () => {
    const dir = await tempDir();
    const release = await acquireInstanceLock(dir);
    const other = { pid: process.pid, nonce: "another-servers-nonce", createdAt: new Date().toISOString() };
    await writeFile(join(dir, INSTANCE_LOCK_FILE), JSON.stringify(other));
    await release();
    expect((await readLock(dir)).nonce).toBe("another-servers-nonce");
  });

  it("fails loudly on a corrupt lock and keeps the file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, INSTANCE_LOCK_FILE), "not json at all");
    await expect(acquireInstanceLock(dir)).rejects.toThrow(/无法读取/);
    expect(await readFile(join(dir, INSTANCE_LOCK_FILE), "utf8")).toBe("not json at all");
  });

  it("fails loudly on a lock without a usable owner and keeps the file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, INSTANCE_LOCK_FILE), JSON.stringify({ pid: 0, nonce: "" }));
    await expect(acquireInstanceLock(dir)).rejects.toThrow(/无效进程锁/);
    expect(await exists(join(dir, INSTANCE_LOCK_FILE))).toBe(true);
  });
});
