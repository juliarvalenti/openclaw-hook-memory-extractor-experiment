#!/usr/bin/env bash
# One-time setup: initialize Synapse and register Matrix users.
# Run this once before "docker compose up".
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "Error: .env not found. Copy .env.example → .env and fill in values."
  exit 1
fi

# shellcheck disable=SC1091
source .env

: "${AGENT_A_MATRIX_PASSWORD:?AGENT_A_MATRIX_PASSWORD is required in .env}"
: "${AGENT_B_MATRIX_PASSWORD:?AGENT_B_MATRIX_PASSWORD is required in .env}"
: "${AGENT_C_MATRIX_PASSWORD:?AGENT_C_MATRIX_PASSWORD is required in .env}"

# ── Step 1: Generate Synapse config ──────────────────────────────────────────
if [ ! -f synapse/data/homeserver.yaml ]; then
  echo "==> Generating Synapse config..."
  mkdir -p synapse/data
  docker compose run --rm \
    -e SYNAPSE_SERVER_NAME=local \
    -e SYNAPSE_REPORT_STATS=no \
    matrix generate

  # Enable password registration (PoC only — not for production).
  cat >> synapse/data/homeserver.yaml << 'EOF'

# ── PoC additions (appended by setup.sh) ─────────────────────────────────────
enable_registration: true
enable_registration_without_verification: true
registration_shared_secret: "poc-local-secret"
# Auto-join every new user to the agents room on registration.
auto_join_rooms:
  - "#agents:local"
auto_join_rooms_for_guests: false
EOF
  echo "==> Config generated at synapse/data/homeserver.yaml"
else
  echo "==> Synapse config already exists, skipping generate."
fi

# ── Step 2: Start Synapse ─────────────────────────────────────────────────────
echo "==> Starting Synapse..."
docker compose up -d matrix

echo -n "==> Waiting for Synapse to be ready"
for i in $(seq 1 30); do
  if docker compose exec matrix curl -sf http://localhost:8008/health > /dev/null 2>&1; then
    echo " ok"
    break
  fi
  echo -n "."
  sleep 2
  if [ "$i" -eq 30 ]; then
    echo ""
    echo "Error: Synapse did not become healthy in time. Check: docker compose logs matrix"
    exit 1
  fi
done

# ── Step 3: Register users ────────────────────────────────────────────────────
register() {
  local user="$1"
  local pass="$2"
  echo "==> Registering @${user}:local..."
  docker compose exec matrix register_new_matrix_user \
    --no-admin \
    -u "$user" \
    -p "$pass" \
    -c /data/homeserver.yaml \
    http://localhost:8008 \
    2>&1 | grep -v "^$" || true
}

register "agent-a" "${AGENT_A_MATRIX_PASSWORD}"
register "agent-b" "${AGENT_B_MATRIX_PASSWORD}"
register "agent-c" "${AGENT_C_MATRIX_PASSWORD}"
register "observer" "${OBSERVER_MATRIX_PASSWORD:-observer123}"

# ── Step 4: Seed agent workspace defaults ─────────────────────────────────────
echo "==> Seeding agent workspace defaults..."
for agent in agent-a agent-b agent-c; do
  mkdir -p "configs/${agent}/workspace"
  cp agent-defaults/MATRIX.md "configs/${agent}/workspace/MATRIX.md"
done

echo ""
echo "==> Setup complete!"
echo "    Start all agents: docker compose up"
echo "    View logs:        docker compose logs -f"
echo ""
echo "    Observe the #agents:local room in Element (or any Matrix client):"
echo "      Homeserver: http://localhost:8008"
echo "      Username:   @observer:local"
echo "      Password:   ${OBSERVER_MATRIX_PASSWORD:-observer123}"
