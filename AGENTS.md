# GHArchive — agent notes

## Dev server

**Do not start `npm run dev` (or `npm start`) yourself.** The user runs the Next.js
server. After code changes, assume they will restart or hot-reload as needed.

You may still run:

- `npx tsc --noEmit` for typechecks (only verification tool — no linter, no formatter, no tests)
- one-off `curl` against a server **if the user already has it running**
- builds only when explicitly asked

## Stack & quirks

- Next.js 14 App Router + TypeScript + Tailwind
- `next.config.js`: `output: 'standalone'` (Docker), `instrumentationHook: true`
- Hidden entrypoint: `src/instrumentation.ts` spawns the in-process sync scheduler via `startScheduler()` (first tick at 15s, then every 60s)
- No real database — all state in `data/db.json` (JSON file, in-memory cache + sync-on-write)
- Multi-user data isolation via `AsyncLocalStorage` (`user-context.ts`). API routes use `withApiUser()` wrapper to set the user context.
- `data/` is gitignored. Default `DATA_DIR = ./data`; contains `db.json`, `mirrors/`, `releases/`
- Local JSON schema versioning (`SCHEMA_VERSION = 2`) with migration in `db.ts:migrate()`

## Auth / OIDC

- SSO on when `OIDC_ISSUER` + `OIDC_CLIENT_ID` are set (plus `SESSION_SECRET`, `APP_URL`)
- Optional: `OIDC_CLIENT_SECRET`, `OIDC_SCOPES`, `OIDC_REDIRECT_URI`
- See `.env.example`. Routes: `/login`, `/api/auth/{login,callback,logout,me}`
- No SSO → autologin as admin; `AuthWarningBanner` at top of every page
- Multi-user: each SSO user has isolated repos/lists/settings/GitHub account
- First SSO login claims legacy no-auth (`autologin`) data (`legacy_claimed_by`)
- Docker: entrypoint chowns `/data` to uid 1001 so bind mounts are writable
- Always set `APP_URL` to the browser-facing origin (not the container id)
- Session cookies: HMAC-SHA256 signed, 7-day expiry, base64url(payload).base64url(sig)

## Git mirrors

- Bare mirrors under `data/mirrors/`. Autologin: `{platform}/{owner}/{name}.git`. SSO: `users/{userId}/{platform}/...`
- `src/lib/git.ts` wraps raw `git` CLI via `child_process.exec`. No libgit2/nodegit.
- GC is disabled (`gc.auto 0`, `gc.pruneExpire never`) to preserve history snapshots.
- Pre-fetch refs are snapshotted to `refs/archive/{timestamp}/` before each `git fetch`.
- History-wipe detection: non-fast-forward branches, mass branch/tag deletion.

## Scheduler & memory awareness

- In-process scheduler (`scheduler.ts`): starts 15s after boot, ticks every 60s.
- Per-user tick: checks due repos based on `sync_interval_hours`, scans GitHub stars/owned.
- Memory-aware: `hasEnoughMemory()` checks free memory/cgroup limit before starting sync jobs. Low memory defers work.
- Alerts (`storage_low`, `memory_low`) fire on system health ticks.

## Apprise alerts

- Requires a reachable Apprise API base URL (`apprise_api_url`)
- Stateless: one or more Apprise service URLs in settings
- Stateful: optional `apprise_config_key` → `POST /notify/{key}`
- Categories (Apprise tags when enabled): `new_release`, `releases_wiped`, `history_wiped`, `repo_deleted`, `repo_archived`, `sync_failed`, `storage_low`, `memory_low`
- In-process cooldown dedup per `(userId, category, subject)` key
- Test: `POST /api/alerts/test` with `{ "category": "new_release" }`

## Key features

- Repo mirror + release asset archive (GitHub REST API, GitLab API)
- File tree / blob browser from bare mirrors (`/api/repos/[id]/tree`, `/blob`, `/raw`)
- Settings: auto-sync interval, asset download limits, memory thresholds
- Lists/tags (local + imported from GitHub star lists via GraphQL)
- Import starred repos segmented by GitHub lists (`/import`), or owned repos
- Docker build: `docker build` (no compose needed single-container), `npm ci` in multi-stage
