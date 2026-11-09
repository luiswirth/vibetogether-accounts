# vibetogether-accounts

Vibe Together's account service: people sign in with GitHub, and their account holds their rooms, their friends and their tokens.
It is the agentwire relay's access service, which the relay asks who may join a session and whether an owned session is still a room.
Its interface is `api.md`. Vibe Together's design is in `../project/design.md`, whose Accounts entry holds Luis's decisions: read it before working here.

- Better Auth, Luis's decision, with its device authorization (OTPs), MCP plugin (the OAuth server for MCP clients) and bearer plugins.
  It runs on Hono and Node, which runs the TypeScript sources as they are.
- One SQLite database, `node:sqlite`, holds Better Auth's tables and the service's own (`src/db.ts`).
- A token is an opaque Better Auth session token (from an OTP) or OAuth access token (prefixed `vt_at_`), looked up at each request, so that revoking one cuts its agent off at once.
- The account page and agents use the same requests: nothing is only for the page.
- Served from lwirth-cloud (`~/dev/dotcloud`) through `nixosModules.default`, under `vibetogether.agentics.lwirth.com/api/`.
- `just ci` runs every check. `just dev` runs a local instance against the public relay, `just stack` one with a local relay that asks it, and `just seed <login>` and `just stack-seed <login>` sign a person in on them, since GitHub can't call back to them.
