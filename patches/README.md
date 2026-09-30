# Claude steer lifecycle

The pinned `@ai-sdk/harness 1.0.121` / `harness-claude-code 1.0.125` patches add an optional message ID to the existing steer/submit chain. Callers that omit it keep the upstream behavior. The Claude bridge forwards `command_lifecycle` through the existing `raw` stream event as `vgent-steer-lifecycle`.

Vgent keeps the accepted-but-not-started message actionable. Its server consumes `started` / `completed` events before forwarding later output, using the same ID as the queue, message bubble and manual-send endpoint. Merely resolving `experimental_steer()` does not imply application.

Both published runtime files and their source/types are patched. pnpm installs and desktop deployment apply these version-pinned patches; the bridge asset is included in the bootstrap recipe. Reassess these patches when upgrading either package, and remove them if upstream exposes equivalent identity and lifecycle support.

Validation: `engines/claude-steer.test.ts`, `queue-delivery.test.ts`, and `queue-durability.test.ts` cover receipt identity, reconnect, queued versus started, and late delivery/stop races without operating a user's live task.

# Claude question expiry

Claude Code's AskUserQuestion reaches the host through a PreToolUse hook in the bridge. Upstream registers that hook without a timeout, so the CLI gives up after its default ten minutes: Claude gets an error, finishes the turn, and the answer the user gives later goes to a bridge turn that no longer exists. The continuation then waits forever (thread stuck running, steers rejected), and the stale request left behind swallows the answer or keeps it buffered to auto-answer a later identical question.

The same two patches fix it at both ends:

- Bridge runtime (`@ai-sdk/harness` `src/bridge/index.ts` + `dist/bridge/index.{js,d.ts}`, and its bundled copy in `harness-claude-code` `dist/bridge/index.mjs`): `BridgeTurn.requestToolResult` takes an optional `abortSignal`. When it aborts, the request is withdrawn and its `toolCallId` remembered as expired; a `tool-result` for an expired id is dropped — never buffered, never handed to another request's `matches` — and the bridge emits a `raw` `vgent-tool-result-expired` event naming it, so the host can still deliver that answer.
- Claude bridge (`harness-claude-code` `src/bridge/index.ts` + `dist/bridge/index.mjs`): the AskUserQuestion matcher gets `timeout: 86400` seconds (override with `HARNESS_QUESTION_TIMEOUT_SECONDS` in the engine env or the bridge's own env; invalid values are ignored), and the hook passes the SDK's `signal` to `requestToolResult`, returning at once when the CLI stops waiting.
- Adapter session (`harness-claude-code` `src/claude-code-harness.ts` + `dist/index.js`): `createSession` tracks whether the bridge holds an open turn (opened by every `start`; closed by any turn's `finish` / `error`, an abort it sends, or the channel closing; on attach it takes the bridge hello's `state`, so a turn that ended while no host was attached counts as ended). `doContinueTurn` against an ended turn (on an open channel) collects the continuation's tool results and approvals and sends one `start` in the same conversation whose prompt tells Claude, in English, what came back (question texts and chosen labels, other tool results as JSON, approvals). A result the bridge reports expired goes the same way once the turn that gave up on it finishes. Until the new turn's `stream-start`, a `finish` (the ended turn's, or its replay after an attach) does not end the continuation, and that turn's own question error results are not forwarded over the user's answer. A turn wired on an already-closed channel fails at once. The three `start` builders share one helper; the adapter exports `__createClaudeCodeSessionForTesting` for the tests. The patched `dist` files drop their `sourceMappingURL`, since the maps no longer match.

Validation: `engines/claude-code-question.test.ts` drives the real bridge runtime over a WebSocket (abort withdraws, late result dropped and reported, no mis-delivery), checks that the bundled Claude bridge carries the fix, and runs the adapter session against a scripted channel (in-time answer, answer after the turn ended, answer the bridge dropped mid-finish, attach replay, abort, closed channel). `VGENT_SMOKE=1 pnpm --filter @vgent/engines test claude-code-question.smoke` runs the real Claude Code with a five-second question timeout: an answer given in time, and one given after the question expired and the bridge turn ended; both must finish with the chosen color.

Upstream-worthy: the missing hook timeout, the ignored hook `signal`, and the unbounded `bufferedToolResults` / stale `pendingToolResults` are bugs in the published packages. Drop these hunks once upstream sets a long AskUserQuestion timeout, withdraws requests on the hook's signal, and has `doContinueTurn` handle a continuation whose bridge turn already ended.

# OpenCode permission order

`@ai-sdk/harness-opencode 1.0.123`, bridge only (`src/bridge/index.ts` + `dist/bridge/index.mjs`, the latter without its `sourceMappingURL`):

- OpenCode publishes `permission.asked` while the tool part is still `pending`, one event before the `running` update that makes the bridge emit the `tool-call`. The bridge forwarded the approval request at once, and the host (`HarnessAgent`) refuses an approval for a call it has not seen: "emitted approval request … for unknown tool call", and the turn died. The patched event loop holds such a request until the bridge has emitted that call (checked after each emitted event), and answers it after three seconds regardless; a subagent's request is never held. Timers are cleared when the loop ends.
- `apply_patch` — what OpenCode gives GPT models in place of edit and write — goes on the wire as `edit`. Unmapped, the host did not know the tool, marked the call as an input error, and the approval answer for it was rejected as a malformed message.

Validation: `engines/opencode.test.ts` checks that the bootstrap's bridge carries the hold. `VGENT_SMOKE=1 pnpm --filter @vgent/engines test opencode.smoke` runs real OpenCode on the machine's Codex login: one read turn, and one edit under `allow-reads` that must emit the call before its approval request and write the file once approved.

Upstream-worthy: both. Drop them when the bridge emits pending tool calls (or waits for them) and maps `apply_patch`.
