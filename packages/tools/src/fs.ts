/**
 * `FileSystemLike` is the seam between the file-reading/writing tools and
 * where the bytes actually live: the host disk (`node:fs/promises`) or an
 * `Experimental_SandboxSession`. Keeping it this small lets tests exercise
 * the exact same tool logic against a temp directory and against
 * `@ai-sdk/sandbox-just-bash`.
 */
import type { Experimental_SandboxSession } from "ai";
import { mkdir, readFile, stat as fsStat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileStat {
  size: number;
}

export interface FileSystemLike {
  /** `null` when the path does not exist. */
  stat(path: string): Promise<FileStat | null>;
  /** Raw bytes. `null` when the path does not exist. */
  readBinaryFile(path: string): Promise<Uint8Array | null>;
  /** UTF-8 text. `null` when the path does not exist. */
  readTextFile(path: string): Promise<string | null>;
  /** Writes UTF-8 text, creating parent directories as needed. */
  writeTextFile(path: string, content: string): Promise<{ created: boolean }>;
}

function isErrnoException(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

/** Backs file tools directly with the host filesystem. */
export function createNodeFileSystem(): FileSystemLike {
  return {
    async stat(path) {
      try {
        const info = await fsStat(path);
        return { size: info.size };
      } catch (error) {
        if (isErrnoException(error, "ENOENT")) return null;
        throw error;
      }
    },
    async readBinaryFile(path) {
      try {
        return new Uint8Array(await readFile(path));
      } catch (error) {
        if (isErrnoException(error, "ENOENT")) return null;
        throw error;
      }
    },
    async readTextFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (isErrnoException(error, "ENOENT")) return null;
        throw error;
      }
    },
    async writeTextFile(path, content) {
      const existed = (await this.stat(path)) !== null;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      return { created: !existed };
    },
  };
}

/**
 * Backs file tools with an `Experimental_SandboxSession`. The sandbox
 * contract has no `stat`; size is derived from a full binary read, which is
 * acceptable given the tools already cap file size in the low single-digit
 * megabytes.
 */
export function createSandboxFileSystem(sandbox: Experimental_SandboxSession): FileSystemLike {
  return {
    async stat(path) {
      const bytes = await sandbox.readBinaryFile({ path });
      return bytes === null ? null : { size: bytes.byteLength };
    },
    async readBinaryFile(path) {
      return sandbox.readBinaryFile({ path });
    },
    async readTextFile(path) {
      return sandbox.readTextFile({ path });
    },
    async writeTextFile(path, content) {
      const existed = (await sandbox.readTextFile({ path })) !== null;
      await sandbox.writeTextFile({ path, content });
      return { created: !existed };
    },
  };
}
