/**
 * `@vgent/sandbox-local` — a `HarnessV1SandboxProvider` that runs harness
 * bridges on the host machine, with every server they open pinned to loopback.
 */
export {
  createLocalSandboxSession,
  loopbackPreloadUrl,
  localProcessEnvironment,
  type LocalSandboxOptions,
} from "./session.js";
export {
  BOOTSTRAP_MARKER,
  createLocalSandboxProvider,
  type LocalSandboxProviderOptions,
} from "./provider.js";
