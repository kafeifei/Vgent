/** Build info computed at bundle time — see `apps/web/vite.config.ts`. */
export const BUILD: { version: string; number: number; sha: string; dirty: boolean } =
  typeof __VGENT_BUILD__ === "object" && __VGENT_BUILD__ !== null
    ? __VGENT_BUILD__
    : { version: "dev", number: 0, sha: "dev", dirty: false };

export const BUILD_LABEL = `v${BUILD.version}`;
export const BUILD_DETAIL = `build ${BUILD.number} · ${BUILD.sha}${BUILD.dirty ? "+" : ""}`;
