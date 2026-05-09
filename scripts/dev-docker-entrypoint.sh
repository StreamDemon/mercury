#!/bin/sh
set -e

# Dev container entrypoint. Mirrors the UID/GID remap pattern from
# scripts/docker-entrypoint.sh (production), without the prod-specific
# /mercury chown of the runtime data volume.
#
# The remap matters because docker-compose.dev.yml bind-mounts the host
# repository into /app. When the host is Windows the IDs may be 1000:1000
# already; on Linux/WSL hosts the host user often has a different UID/GID.
# Without remap, files written by the container (e.g. pnpm-lock.yaml after
# `pnpm install`, ui/dist artifacts) end up root-owned on the host.

PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "[dev-entrypoint] Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "[dev-entrypoint] Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

# Always ensure node owns /mercury at startup. Named volumes are created
# root-owned by docker even when UIDs match between host and container.
# Without this, the dev-runner's first `mkdir /mercury/instances` fails
# with EACCES. Recursive so prior-run subdirs also get fixed.
if [ -d /mercury ]; then
    chown -R node:node /mercury
fi

# Make sure node owns its home so global npm/pnpm caches work
if [ -d /home/node ]; then
    chown -R node:node /home/node 2>/dev/null || true
fi

# Build @mercuryai/plugin-sdk on container start so its `mercury-plugin-dev-server`
# bin symlinks resolve. This silences the four `WARN  Failed to create bin at ...
# plugin-sdk/dist/dev-cli.js` warnings that pnpm install emits on a fresh checkout.
# Skipped if dist/ is already up-to-date (pnpm/tsc are incremental).
# The build needs to run as the `node` user to write into the bind-mounted host dir
# with the right ownership, so we run it via gosu and then exec the user's command.
if [ -f /app/packages/plugins/sdk/package.json ] \
  && [ ! -f /app/packages/plugins/sdk/dist/index.js ]; then
    echo "[dev-entrypoint] Building @mercuryai/plugin-sdk (first run only)..."
    cd /app && gosu node pnpm --filter @mercuryai/plugin-sdk build || \
        echo "[dev-entrypoint] WARN: plugin-sdk build failed; pnpm dev will retry on demand"
fi

exec gosu node "$@"
