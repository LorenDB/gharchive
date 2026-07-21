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

## Data

- `DATA_DIR` (default `./data`): `db.json`, `mirrors/`, `releases/`
- Linked GitHub PAT lives in `db.json` → `github_account.token` (local only)

## Key features

- Repo mirror + release asset archive
- File tree / blob browser from bare mirrors
- Settings: auto-sync interval, asset download limits
- Lists/tags (local + imported from GitHub star lists)
- Import starred repos segmented by GitHub lists (`/import`)
