# Everything CI runs.
ci:
    nix fmt -- --ci
    pnpm install --frozen-lockfile
    biome check
    pnpm exec tsc
    node --test

# A local instance, as a page's dev server at `url` reaches it through a proxy for /api and /.well-known.
# GitHub can't call back to it, so `just seed` signs a person in.
dev url="http://localhost:5173" relay="https://agentwire.agentics.lwirth.com":
    mkdir -p .dev
    ACCOUNTS_URL={{ url }} ACCOUNTS_PORT=8793 ACCOUNTS_DATABASE=.dev/accounts.db ACCOUNTS_SECRET=a-local-secret-that-is-only-for-development \
    GITHUB_CLIENT_ID=Ov23lioG1e2zHhmOML3d GITHUB_CLIENT_SECRET=none AGENTWIRE_RELAY={{ relay }} node --watch src/main.ts

# Signs `login` in on the local instance, and prints the session's token and cookie.
seed login url="http://localhost:5173" relay="https://agentwire.agentics.lwirth.com":
    ACCOUNTS_URL={{ url }} ACCOUNTS_DATABASE=.dev/accounts.db ACCOUNTS_SECRET=a-local-secret-that-is-only-for-development \
    GITHUB_CLIENT_ID=Ov23lioG1e2zHhmOML3d GITHUB_CLIENT_SECRET=none AGENTWIRE_RELAY={{ relay }} node dev/seed.ts {{ login }}
