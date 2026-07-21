# GHArchive — agent notes

## Dev server

**Do not start `npm run dev` (or `npm start`) yourself.** The user runs the Next.js
server. After code changes, assume they will restart or hot-reload as needed.

You may still run:

- `npx tsc --noEmit` for typechecks
- one-off `curl` against a server **if the user already has it running**
- builds only when explicitly asked

## Stack

- Next.js 14 App Router + TypeScript + Tailwind
- Local JSON DB + bare git mirrors under `data/`
- GitHub stars/lists: REST for stars, GraphQL for star lists (UserList)
- Auth: OIDC SSO when configured; otherwise autologin + warning banner

## Data

- `DATA_DIR` (default `./data`): `db.json`, `mirrors/`, `releases/`
- Linked GitHub PAT lives in `db.json` → `github_account.token` (local only)

## Auth / OIDC (Docker `.env`)

- SSO on when `OIDC_ISSUER` + `OIDC_CLIENT_ID` are set (plus `SESSION_SECRET`, `APP_URL`)
- Optional: `OIDC_CLIENT_SECRET`, `OIDC_SCOPES`, `OIDC_REDIRECT_URI`
- See `.env.example`. Routes: `/login`, `/api/auth/{login,callback,logout,me}`
- No SSO → autologin as admin; `AuthWarningBanner` at top of every page
- Multi-user: each SSO user has isolated repos/lists/settings/GitHub account
- First SSO login claims legacy no-auth (`autologin`) data (`legacy_claimed_by`)
- Docker: entrypoint chowns `/data` to uid 1001 so bind mounts are writable
- Always set `APP_URL` to the browser-facing origin (not the container id)

## Key features

- Repo mirror + release asset archive
- File tree / blob browser from bare mirrors
- Settings: auto-sync interval, asset download limits
- Lists/tags (local + imported from GitHub star lists)
- Import starred repos segmented by GitHub lists (`/import`)
