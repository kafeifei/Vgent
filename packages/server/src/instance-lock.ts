import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

/** The lock file a server drops in its data directory for as long as it owns it. */
export const INSTANCE_LOCK_FILE = "server.lock";

/**
 * Exit code for "another Vgent already owns this data directory" — `EX_TEMPFAIL`
 * from sysexits(3): nothing is wrong with the install, the resource is just busy.
 * Mirrored by `INSTANCE_LOCKED_EXIT_CODE` in `apps/desktop/src-tauri/src/backend.rs`,
 * which turns it into the shell's "Vgent 已在运行" dialog. Change both together.
 */
export const INSTANCE_LOCKED_EXIT_CODE = 75;

/** The data directory belongs to a live server; this process must not touch it. */
export class InstanceLockedError extends Error {
  readonly pid: number;
  readonly lockPath: string;

  constructor(options: { message: string; pid: number; lockPath: string }) {
    super(options.message);
    this.name = "InstanceLockedError";
    this.pid = options.pid;
    this.lockPath = options.lockPath;
  }
}

interface LockIdentity {
  pid: number;
  nonce: string;
  createdAt: string;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}

/**
 * `kill(pid, 0)` only probes. `ESRCH` is the one answer that means the process
 * is gone: `EPERM` says it exists but belongs to someone else, which for us is
 * still "occupied".
 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function parseIdentity(raw: string, lockPath: string): LockIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`数据目录的进程锁无法读取：${lockPath}。请先确认没有其他 Vgent 服务使用该目录。`);
  }
  const identity = parsed as Partial<LockIdentity>;
  if (!Number.isInteger(identity.pid) || (identity.pid ?? 0) <= 0 || typeof identity.nonce !== "string" || identity.nonce.length === 0) {
    throw new Error(`数据目录包含无效进程锁，已保留原文件：${lockPath}。`);
  }
  return identity as LockIdentity;
}

/**
 * One server owns a data directory. A second launch cannot silently overwrite
 * its state — it either finds the owner alive and is refused, or finds a stale
 * lock (the owner crashed or was SIGKILLed) and takes it over.
 *
 * Resolves to a release function; it removes the lock only while it is still ours.
 */
export async function acquireInstanceLock(dataDir: string): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(dataDir, INSTANCE_LOCK_FILE);
  const recoveryPath = `${lockPath}.recovery`;
  const identity: LockIdentity = { pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() };

  const create = async () => {
    const file = await open(lockPath, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(identity));
    } finally {
      await file.close();
    }
  };

  try {
    await create();
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    const owner = parseIdentity(await readFile(lockPath, "utf8"), lockPath);
    if (isRunning(owner.pid)) {
      throw new InstanceLockedError({
        message: `此数据目录已有 Vgent 服务运行（进程 ${owner.pid}）：${dataDir}。请使用现有服务，或指定其他 VGENT_DATA_DIR。`,
        pid: owner.pid,
        lockPath,
      });
    }
    // A nonce re-read alone is not a CAS: two stale reclaimers could both pass
    // it, then the second could unlink the first's newly acquired lock. Only one
    // reclaimer can enter this directory guard. A crash inside recovery leaves an
    // explicit guard for inspection; it is never blindly reclaimed in turn.
    try {
      await mkdir(recoveryPath, { mode: 0o700 });
    } catch (guardError) {
      if (!hasCode(guardError, "EEXIST")) throw guardError;
      throw new Error(`另一个启动进程正在恢复进程锁，或上次恢复中断：${recoveryPath}。请确认现有服务状态后重试。`);
    }
    try {
      const latest = parseIdentity(await readFile(lockPath, "utf8"), lockPath);
      if (latest.pid !== owner.pid || latest.nonce !== owner.nonce) throw new Error("进程锁发生变化，请重试启动。");
      if (isRunning(owner.pid)) {
        throw new InstanceLockedError({
          message: `进程锁对应的进程已存在（进程 ${owner.pid}），未替换锁：${lockPath}。`,
          pid: owner.pid,
          lockPath,
        });
      }
      await unlink(lockPath);
      await create();
    } finally {
      // Remove only our empty guard, never recursively remove unfamiliar data.
      await rmdir(recoveryPath);
    }
  }

  return async () => {
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockIdentity>;
      if (current.pid === identity.pid && current.nonce === identity.nonce) await unlink(lockPath);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  };
}
