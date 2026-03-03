# OpenHive Integration Plan

Wire OpenClaw experiment agents into the OpenHive coordination back channel so
multi-agent experiments can use `CognitiveEngine` tick-based consensus and be
observed via `openhive watch`.

---

## Architecture

```
Mac (dev machine)
  └── OpenHive backend   localhost:8000  (FastAPI + Postgres in Docker)
       └── SSH reverse tunnel → server:8000

Server (18.216.86.206)
  └── experiment run <name>
       ├── agent-1 (Docker) ──┐
       ├── agent-2 (Docker) ──┤── openhive CLI → host.docker.internal:8000
       └── agent-3 (Docker) ──┘
            ↓ Matrix room (existing)
            ↓ OpenHive room oh-<experiment-name> (new back channel)

Mac
  └── openhive watch oh-<experiment-name>   ← observe coordination live
```

---

## Code Changes

### 1. `openhive-cli` adapter — `handler.js` (+3 lines)

File: `openhive/openhive-cli/src/openhive/adapters/openclaw/hooks/openhive-inject/handler.js`

Add `OPENHIVE_API_URL` pass-through so the server's env var reaches agents:

```js
// After the existing OPENHIVE_CHANNEL_ID block:
if (process.env.OPENHIVE_API_URL) {
  ctx.env.OPENHIVE_API_URL = process.env.OPENHIVE_API_URL;
}
```

Commit + push to `cisco-eti/openhive`.

---

### 2. `generate-compose.ts` — add 2 env vars + `extra_hosts`

File: `cli/src/generate-compose.ts`

In the `environment` block of each agent service, add:

```typescript
OPENHIVE_API_URL: "${OPENHIVE_API_URL:-}",
OPENHIVE_CHANNEL_ID: experimentName,   // already computed at line 199
```

Also add `extra_hosts` so containers can reach the SSH-tunneled backend:

```typescript
extra_hosts: ["host.docker.internal:host-gateway"],
```

`experimentName` is the experiment slug — all agents in one experiment automatically
share the same OpenHive room (`oh-<experimentName>`).

---

### 3. `experiments/_base-skills/openhive/SKILL.md` — new file

Copy from:
`openhive/openhive-cli/src/openhive/adapters/openclaw/skills/openhive/SKILL.md`

`scaffold_agent` auto-installs everything in `_base-skills/` into every new agent's
`workspace/skills/` — no other wiring needed.

---

### 4. `experiments/_template/agents/agent-example/workspace/hooks/openhive-inject/` — 2 new files

Copy from `openhive/openhive-cli/src/openhive/adapters/openclaw/hooks/openhive-inject/`:
- `handler.js`  (already has OPENHIVE_CHANNEL_ID injection; add OPENHIVE_API_URL per change #1)
- `OPENHIVE_INSTRUCTIONS.md`

`scaffold_agent` copies the template workspace into each new agent — hooks land
automatically from here.

---

### 5. `cli/experiment` — remove dead OpenHive install block (~12 lines)

Lines 605–616 reference `${SCRIPT_DIR}/openhive/node_modules/.bin/tsx` which
no longer applies. Delete the entire block:

```bash
# ── Install OpenHive hooks into each agent workspace ─────────────────────
echo "==> Configuring agents (openhive)..."
local openhive_tsx=...
...
```

Hooks now come from the template (change #4) so this is fully redundant.

---

### 6. Agent Dockerfile — install `openhive-cli`

The `openclaw-agents:local` image needs the `openhive` CLI available at runtime.
Find the base Dockerfile (referenced as `${REPO_ROOT}/docker/Dockerfile` in the
experiment script) and add:

```dockerfile
RUN pip install --no-cache-dir \
    "openhive-cli @ git+https://github.com/cisco-eti/openhive.git#subdirectory=openhive-cli"
```

After this, rebuild the image on the server:
```bash
docker build -f docker/Dockerfile -t openclaw-agents:local .
```

---

## Server Setup (one-time)

### A. SSH reverse tunnel (Mac → server)

Run from Mac (keep this session alive during experiments):

```bash
ssh -R 0.0.0.0:8000:localhost:8000 -i ~/.ssh/ioc-oclw-poc-1.key ubuntu@18.216.86.206
```

Requires `GatewayPorts yes` in `/etc/ssh/sshd_config` on the server.
Check/set:
```bash
grep GatewayPorts /etc/ssh/sshd_config
# if not set:
echo "GatewayPorts yes" | sudo tee -a /etc/ssh/sshd_config
sudo systemctl reload sshd
```

### B. `cli/.env` on the server

```bash
# In openclaw-hook-memory-extractor-experiment/cli/.env
OPENHIVE_API_URL=http://host.docker.internal:8000
# ... existing LLM keys etc.
```

### C. Pull updated experiment repo

```bash
ssh -i ~/.ssh/ioc-oclw-poc-1.key ubuntu@18.216.86.206
cd openclaw-hook-memory-extractor-experiment
git pull
npm install   # if package changes
```

### D. Rebuild agent Docker image

```bash
docker build -f docker/Dockerfile -t openclaw-agents:local .
```

---

## Running an Experiment

### Mac — ensure backend is up

```bash
openhive up   # or: docker compose -f services/docker-compose.yml up -d
```

### Mac — open tunnel (separate terminal, keep alive)

```bash
ssh -R 0.0.0.0:8000:localhost:8000 -i ~/.ssh/ioc-oclw-poc-1.key ubuntu@18.216.86.206
```

### Mac — watch the coordination channel

```bash
openhive watch oh-<experiment-name>
```

### Server — create and run experiment

```bash
experiment create trip-planner agent-1 agent-2 agent-3
# edit experiment.json, IDENTITY.md, etc.
experiment run trip-planner-<timestamp>
```

Agents join their Matrix room (existing behavior) AND call `openhive room join`
via the coordination hook. `CognitiveEngine` runs tick-based consensus.
`openhive watch` on the Mac shows the full coordination flow live.

---

## Known Issues to Fix First

### Room alias mismatch bug in `experiment` script

`createRoom` uses `${name}` as the alias but `room_alias` variable has
`${name}-${timestamp}`. All subsequent room lookups fail on re-runs.

Fix in `cmd_run` (line ~594):
```bash
# Change:
"room_alias_name": "${name}",
# To:
"room_alias_name": "${name}-${timestamp}",
```

---

## Files Changed Summary

| Repo | File | Change |
|---|---|---|
| `cisco-eti/openhive` | `openhive-cli/.../hooks/openhive-inject/handler.js` | +3 lines: pass OPENHIVE_API_URL |
| experiment repo | `cli/src/generate-compose.ts` | +OPENHIVE_API_URL, +OPENHIVE_CHANNEL_ID, +extra_hosts |
| experiment repo | `experiments/_base-skills/openhive/SKILL.md` | new file (copy from openhive) |
| experiment repo | `experiments/_template/.../hooks/openhive-inject/handler.js` | new file (copy from openhive) |
| experiment repo | `experiments/_template/.../hooks/openhive-inject/OPENHIVE_INSTRUCTIONS.md` | new file (copy from openhive) |
| experiment repo | `cli/experiment` lines 605-616 | delete dead block |
| experiment repo | `docker/Dockerfile` | +pip install openhive-cli |
| experiment repo | `cli/experiment` line ~594 | fix room alias mismatch bug |
