import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { Logger, Project } from "../types.js";
import { silentLogger } from "../types.js";
import { readJsonOrQuarantine, writeJsonAtomic } from "./atomic-file.js";

interface ProjectsFile {
  version: 1;
  projects: Project[];
}

export interface ProjectStore {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | undefined>;
  create(input: { name?: string; repoPath: string }): Promise<Project>;
  remove(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

const isProjectsFile = (value: unknown): value is ProjectsFile =>
  typeof value === "object" && value !== null && Array.isArray((value as ProjectsFile).projects);

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
      const repoPath = resolve(input.repoPath);
      if (!(await stat(repoPath).catch(() => null))?.isDirectory()) {
        throw new BadRequestError(`仓库路径不是目录: ${repoPath}`, "invalid_repo_path");
      }
      const existing = (projects ?? []).find((project) => project.repoPath === repoPath);
      if (existing != null) return existing;
      const project: Project = {
        id: randomUUID(),
        name: input.name?.trim() || basename(repoPath),
        repoPath,
        createdAt: new Date().toISOString(),
      };
      projects = [...(projects ?? []), project];
      await commit();
      return project;
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
