#!/usr/bin/env bash
# Push local server/ to the Pi and recreate the debug pool container. See make sync-debug.
set -euo pipefail

DEBUG_HOST="${DEBUG_HOST:-rhb@gw.mystic.onthegrid.net}"
DEBUG_SSH_PORT="${DEBUG_SSH_PORT:-32746}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

rsync -az --delete --exclude node_modules --exclude .git \
	-e "ssh -p ${DEBUG_SSH_PORT}" \
	"${ROOT}/server/" "${DEBUG_HOST}:~/pool-controller/server/"

# keep compose overlays in sync (debug bind-mount + working RS485 env)
rsync -az -e "ssh -p ${DEBUG_SSH_PORT}" \
	"${ROOT}/docker/docker-compose.debug.yml" \
	"${ROOT}/docker/docker-compose.rs485.yml" \
	"${DEBUG_HOST}:~/pool-controller/docker/"

ssh -p "${DEBUG_SSH_PORT}" "${DEBUG_HOST}" bash -s <<'EOF'
set -euo pipefail
cd ~/pool-controller/docker
export POOL_JWT_SECRET="$(cat ~/.pool-jwt-secret)"
export POOL_HE_DDNS_KEY="$(cat ~/.pool-he-ddns-key)"
files=(-f docker-compose.yml)
test -f docker-compose.ports.yml && files+=(-f docker-compose.ports.yml)
files+=(-f docker-compose.debug.yml)
test -f docker-compose.rs485.yml && files+=(-f docker-compose.rs485.yml)
docker compose "${files[@]}" up -d --force-recreate pool
echo "debug pool recreated; inspector on :9229"
EOF
