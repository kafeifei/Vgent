import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { Logger, Project } from "../types.js";
import { silentLogger } from "../types.js";
import { readJsonOrQuarantine, writeJsonAtomic } from "./atomic-file.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;

interface ProjectsFile {
  version: 1;
  projects: Project[];
}

/** A newly created (or deduped) project, with a note when its path was redirected. */
export type CreatedProject = Project & { note?: string };

export interface ProjectStore {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | undefined>;
  create(input: { name?: string; repoPath: string }): Promise<CreatedProject>;
  remove(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

const isProjectsFile = (value: unknown): value is ProjectsFile =>
  typeof value === "object" && value !== null && Array.isArray((value as ProjectsFile).projects);

/**
 * A linked git worktree (`.git` is a file pointing at
 * `<main>/.git/worktrees/<name>`) must not become its own project — it
 * belongs to the main checkout. Resolves `repoPath` to that checkout when it
 * is one; otherwise returns it unchanged, only canonicalized via `realpath`
 * (including when it is not a git repo at all, or is a bare repo with no
 * working tree to redirect to). `redirected` is true only for the actual
 * worktree case, so a plain symlink normalization never gets mistaken for one.
 */
async function resolveWorktree(repoPath: string): Promise<{ repoPath: string; redirected: boolean }> {
  // Canonicalized up front so every return path is comparable/dedup-able,
  // regardless of which symlinked form the caller passed in (e.g. macOS's
  // /var → /private/var temp dirs).
  const canonicalPath = await realpath(repoPath).catch(() => repoPath);

  let commonDirRaw: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { timeout: GIT_TIMEOUT_MS },
    );
    commonDirRaw = stdout.trim();
  } catch {
    return { repoPath: canonicalPath, redirected: false }; // not a git repo (or git unavailable): leave as is
  }

  const [commonDir, ownGitDir] = await Promise.all([
    realpath(commonDirRaw).catch(() => commonDirRaw),
    realpath(join(repoPath, ".git")).catch(() => join(repoPath, ".git")),
  ]);
  if (commonDir === ownGitDir) return { repoPath: canonicalPath, redirected: false }; // a normal repo, not a linked worktree
  if (basename(commonDir) !== ".git") return { repoPath: canonicalPath, redirected: false }; // e.g. a bare repo: no working tree

  return { repoPath: dirname(commonDir), redirected: true }; // the main checkout, already realpath'd via commonDir
}

export function createProjectStore(dataDir: string, log: Logger = silentLogger): ProjectStore {
  const path = join(dataDir, "projects.json");
  const listeners = new Set<() => void>();
  let projects: Project[] | undefined;
  let ready: Promise<void> | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const ensureReady = (): Promise<void> => {
    ready ??= (async () => {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      projects = (await readJsonOrQuarantine<ProjectsFile>(path, { validate: isProjectsFile, log }))?.projects ?? [];
    })();
    return ready;
  };

  const commit = async () => {
    const work = async () => {
      await writeJsonAtomic(path, { version: 1, projects: projects ?? [] } satisfies ProjectsFile);
    };
    chain = chain.then(work, work);
    await chain;
    for (const listener of [...listeners]) listener();
  };

  return {
    async list() {
      await ensureReady();
      return [...(projects ?? [])];
    },
    async get(id) {
      await ensureReady();
      return (projects ?? []).find((project) => project.id === id);
    },
    async create(input) {
      await ensureReady();
      const requestedPath = resolve(input.repoPath);
      if (!(await stat(requestedPath).catch(() => null))?.isDirectory()) {
        throw new BadRequestError(`仓库路径不是目录: ${requestedPath}`, "invalid_repo_path");
      }
      const { repoPath, redirected } = await resolveWorktree(requestedPath);
      const note = redirected ? `${requestedPath} 是一个 git worktree，已归到主仓库 ${repoPath}` : undefined;

      const existing = (projects ?? []).find((project) => project.repoPath === repoPath);
      if (existing != null) return note != null ? { ...existing, note } : existing;
      const project: Project = {
        id: randomUUID(),
        name: input.name?.trim() || basename(repoPath),
        repoPath,
        createdAt: new Date().toISOString(),
      };
      projects = [...(projects ?? []), project];
      await commit();
      return note != null ? { ...project, note } : project;
    },
    async remove(id) {
      await ensureReady();
      const current = projects ?? [];
      if (!current.some((project) => project.id === id)) throw new NotFoundError(`项目不存在: ${id}`, "project_not_found");
      projects = current.filter((project) => project.id !== id);
      await commit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
