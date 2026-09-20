/**
 * 无项目: the id of the project a task has when it belongs to none. The server
 * owns the meaning (`packages/server/src/no-project.ts` — such a task runs in a
 * directory of its own); the web app only imports types from that package, so
 * the two strings are written down here as well.
 */
export const NO_PROJECT_ID = "no-project";
export const NO_PROJECT_NAME = "无项目";

export const isNoProject = (projectId: string | null | undefined): boolean => projectId === NO_PROJECT_ID;
