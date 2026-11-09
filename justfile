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
seed login db=".dev/accounts.db" url="http://localhost:5173" relay="https://agentwire.agentics.lwirth.com":
    ACCOUNTS_URL={{ url }} ACCOUNTS_DATABASE={{ db }} ACCOUNTS_SECRET=a-local-secret-that-is-only-for-development \
    GITHUB_CLIENT_ID=Ov23lioG1e2zHhmOML3d GITHUB_CLIENT_SECRET=none AGENTWIRE_RELAY={{ relay }} node dev/seed.ts {{ login }}

# A local relay with this service as its access service, from the sibling checkout of agentwire, for testing the stack:
# the relay at 127.0.0.1:8797, the service at 127.0.0.1:8798, for a site at `url` that proxies /api and /.well-known to it.
stack url="http://localhost:5173":
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p .stack
    (cd ../../agentwire && direnv exec . cargo build -q --release -p agentwire-relay --target-dir {{ justfile_directory() }}/.stack/target)
    AGENTWIRE_ADDRESS=127.0.0.1:8797 AGENTWIRE_DATABASE=.stack/relay.db AGENTWIRE_FILES=../../agentwire \
      AGENTWIRE_ACCESS=http://127.0.0.1:8798/agentwire .stack/target/release/agentwire-relay &
    trap 'kill $!' EXIT
    ACCOUNTS_URL={{ url }} ACCOUNTS_PORT=8798 ACCOUNTS_DATABASE=.stack/accounts.db ACCOUNTS_SECRET=a-local-secret-that-is-only-for-development \
      GITHUB_CLIENT_ID=Ov23lioG1e2zHhmOML3d GITHUB_CLIENT_SECRET=none AGENTWIRE_RELAY=http://127.0.0.1:8797 node src/main.ts

# Signs `login` in on `just stack`'s instance, whose rooms live on the stack's relay.
stack-seed login: (seed login ".stack/accounts.db" "http://localhost:5173" "http://127.0.0.1:8797")
