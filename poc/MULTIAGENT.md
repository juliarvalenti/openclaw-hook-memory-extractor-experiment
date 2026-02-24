# Multi-Agent Docker Setup

Three OpenClaw agents (agent-a, agent-b, agent-c) connected to a shared Matrix
homeserver (Synapse), coordinating via the `#agents:local` room. Each agent runs
in its own container, mirroring a distributed deployment where agents live on
separate hosts.

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│   agent-a   │   │   agent-b   │   │   agent-c   │
│  :18789     │   │  :18889     │   │  :18989     │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │ Docker bridge network
                  ┌──────▼──────┐
                  │   Synapse   │
                  │  (Matrix)   │
                  │  :8008      │
                  └─────────────┘
```

## Prerequisites

1. **Build the OpenClaw image** from the openclaw repo root:
   ```bash
   docker build -t openclaw:local .
   ```

2. **Install Docker** with Compose v2 (`docker compose` not `docker-compose`).

## Setup

All setup files live in `docker/`.

### 1. Configure environment

```bash
cd docker
cp .env.example .env
```

Edit `.env` and fill in:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (or swap for `OPENAI_API_KEY` etc.) |
| `AGENT_A_TOKEN` | Gateway auth token for agent-a — `openssl rand -hex 24` |
| `AGENT_B_TOKEN` | Gateway auth token for agent-b |
| `AGENT_C_TOKEN` | Gateway auth token for agent-c |
| `AGENT_A_MATRIX_PASSWORD` | Matrix password for agent-a — `openssl rand -hex 16` |
| `AGENT_B_MATRIX_PASSWORD` | Matrix password for agent-b |
| `AGENT_C_MATRIX_PASSWORD` | Matrix password for agent-c |
| `OBSERVER_MATRIX_PASSWORD` | Password for the observer account (defaults to `observer123`) |

### 2. Build the agent image

The `docker/Dockerfile` extends `openclaw:local` with the Matrix plugin
dependencies that the upstream build misses:

```bash
cd docker
docker compose build
```

### 3. Run one-time setup

```bash
cd docker
./setup.sh
```

This will:
- Generate the Synapse homeserver config and signing key
- Start the Matrix server
- Register Matrix accounts for agent-a, agent-b, agent-c, and observer
- Auto-join all accounts to `#agents:local`

### 4. Start everything

```bash
cd docker
docker compose up
```

To run in the background: `docker compose up -d`

## Connecting with Element

Element is the standard Matrix client. Install it:

```bash
brew install --cask element
```

Or use the web version at **https://app.element.io** (no install needed).

### Sign in

1. Open Element
2. On the sign-in screen, click the homeserver name (e.g. "matrix.org") to change it
3. Enter: `http://localhost:8008`
4. Sign in with:
   - **Username:** `@observer:local`
   - **Password:** value of `OBSERVER_MATRIX_PASSWORD` in `.env` (default: `observer123`)
5. Join the `#agents:local` room (search for it or use the `+` next to Rooms)

## Talking to agents

Agents only respond when @mentioned — they ignore unaddressed messages.

```
@agent-a:local can you summarize what agent-b just said?
@agent-b:local what is the capital of France?
@agent-c:local please ping agent-a and ask it to count to 5
```

Agents can @mention each other to delegate tasks.

## Useful commands

```bash
# Tail logs for one agent
docker compose logs -f agent-b

# Restart a single agent (picks up openclaw.json changes live)
docker compose restart agent-a

# Stop everything
docker compose down

# Nuclear reset (wipes Synapse data + agent state — requires re-running setup.sh)
docker compose down
rm -rf docker/synapse/data docker/configs/*/credentials docker/configs/*/matrix
```

## Configuration

Each agent's config lives at `docker/configs/agent-{a,b,c}/openclaw.json`.
Changes are hot-reloaded without a restart for most settings (you'll see a
`[reload]` log line). A full restart is only needed for gateway-level changes.

Key settings:

```json
{
  "channels": {
    "matrix": {
      "groupPolicy": "open",
      "groups": {
        "#agents:local": {
          "requireMention": true
        }
      }
    }
  }
}
```

- `groupPolicy: "open"` — any Matrix room can trigger the agent (gated by mention)
- `requireMention: true` — agent only activates when @mentioned in the room
- Set `requireMention: false` to have all agents respond to every message (noisy)

## LLM providers

Swap the model by changing `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` (etc.) in `.env`
and updating `agents.defaults.model.primary` in each `openclaw.json`:

| Provider | Key | Model string example |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-haiku-4-5-20251001` |
| OpenAI | `OPENAI_API_KEY` | `openai/gpt-4o-mini` |
| Gemini | `GEMINI_API_KEY` | `google/gemini-2.0-flash` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter/anthropic/claude-3-haiku` |
