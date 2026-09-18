/** Build id computed from git at bundle time — see `apps/web/vite.config.ts`. */
export const BUILD_ID: string = typeof __VGENT_BUILD__ === "string" ? __VGENT_BUILD__ : "dev";
