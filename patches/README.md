# Claude steer lifecycle

The pinned `@ai-sdk/harness 1.0.121` / `harness-claude-code 1.0.125` patches add an optional message ID to the existing steer/submit chain. Callers that omit it keep the upstream behavior. The Claude bridge forwards `command_lifecycle` through the existing `raw` stream event as `vgent-steer-lifecycle`.

Vgent keeps the accepted-but-not-started message actionable. Its server consumes `started` / `completed` events before forwarding later output, using the same ID as the queue, message bubble and manual-send endpoint. Merely resolving `experimental_steer()` does not imply application.

Both published runtime files and their source/types are patched. pnpm installs and desktop deployment apply these version-pinned patches; the bridge asset is included in the bootstrap recipe. Reassess these patches when upgrading either package, and remove them if upstream exposes equivalent identity and lifecycle support.

Validation: `engines/claude-steer.test.ts`, `queue-delivery.test.ts`, and `queue-durability.test.ts` cover receipt identity, reconnect, queued versus started, and late delivery/stop races without operating a user's live task.
