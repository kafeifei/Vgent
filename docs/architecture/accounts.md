# Shared platform accounts

Every backend exposes one account service (`packages/server/src/accounts/service.ts`). The sidebar, settings, quota adapters and model access reuse the existing login owners. The service creates no credential files or additional platform accounts.

| Platform | Authoritative login | Consumers |
| --- | --- | --- |
| GitHub | Existing remote controller and Vgent keychain item, scoped to backend data directory | Remote access, Copilot quotas and Copilot models in the Vgent Engine |
| Codex | Official Codex home and its configured file/keyring store | Quotas, model catalogs, Vgent Engine and native Codex Engine |
| Claude | Official Claude Code CLI, its home/config directory and keychain | Claude quotas and native Claude Code Engine |

GitHub account access is an internal controller method, never part of the HTTP payload. Copilot exchanges that same credential for temporary model access; this derived credential is kept only in memory and checked against account identity and authentication generation on every use. Switching off remote hosting does not sign out the account or disable Copilot. Signing out GitHub revokes all its consumers. Account management links always return to the existing login UI.

Codex has one token owner per canonical original home in the process. It rereads the original store so another CLI's logout or account switch takes effect. Concurrent calls share refresh; a refresh rechecks the store before writing. Logout blocks new calls and drains refresh before asking the official CLI to clear its store. Native Codex receives the shared credential for each turn, while its isolated runtime home remains separate from the original login home. It does not start another OAuth login.

Claude quota access only reads the official CLI's credential. The profile must match the CLI-reported email before usage is associated with the account. Vgent never refreshes or persists Claude OAuth credentials. Native Claude Code keeps ownership of refreshing credentials while executing. Custom API keys remain distinct billing channels and do not display subscription quotas. A custom Claude profile cannot silently fall back to the default account's keychain item.

Public snapshots contain identity, plan, quota windows, timestamps and redacted status only. Usage is queried while the account panel is open, cached for one minute, and refreshed on request. Account changes invalidate public snapshots and model catalogs; late responses cannot repopulate state from a completed logout. The frontend shares a store per backend client and invalidates model pickers after account changes. Identity-only reads cannot evict a complete quota snapshot. The account panel publishes all three accounts and their quotas together, retains the previous complete view during refresh, and coalesces repeated opens. Login-change notifications from accepted snapshots do not refetch the snapshot that produced them. Settings load the shared account rows, providers, saved order and catalog as one batch. Successful model visibility and provider mutations notify all pickers through a separate catalog event; they never invalidate account or quota snapshots.

Quota parsers retain missing values as unknown, preserve genuine zero usage, and show only reset dates actually returned by the platform. HTTP failures never become zero usage. Copilot model discovery exposes enabled models with tool support through both Chat Completions and Responses; protocol selection comes from the live catalog and model calls use that same account adapter. Copilot uses the same subscription model table, persisted per-Engine visibility settings and provider ordering as the native subscriptions. GitHub login and logout remain owned by remote access. Subscription endpoints can change independently of Vgent, so unavailable capabilities are shown as such.

Remote browser authentication is the access device's authorization to the host. It is not another host model account; host credentials are never transferred to the browser. Remote account summaries describe the host.

Validation includes concurrent refresh, account replacement during refresh, logout during pending usage, credential redaction, quota parsing, and an SDK model request through the Copilot adapter. UI verification uses isolated fixture data. Packaging and installation must follow the repository's local delivery contract.
