# Docker Compose — Multi-Agent OpenClaw

Three OpenClaw agents + a Synapse Matrix homeserver, all on an isolated Docker network.

Each agent has its own gateway container (port 18789 inside, different host ports outside).
This mirrors the distributed deployment target where each agent runs on a separate host.

---

## Prerequisites

**1. Build the OpenClaw image** (from the openclaw repo root):

```bash
docker build -t openclaw:local .
```

**2. Configure environment:**

```bash
cp .env.example .env
# Edit .env: fill in ANTHROPIC_API_KEY, agent passwords, and generate gateway tokens
```

Generate gateway tokens:
```bash
openssl rand -hex 24   # run once per agent, paste into .env
```

**3. Run one-time setup** (initializes Synapse and registers users):

```bash
bash setup.sh
```

---

## Usage

```bash
# Start everything (Matrix + all 3 agents)
docker compose up

# Start Matrix + only two agents
docker compose up matrix agent-a agent-b

# Tail logs for one agent
docker compose logs -f agent-a

# Stop everything
docker compose down
```

---

## Architecture

```
Docker network: agents
  ├── matrix       Synapse Matrix homeserver, :8008
  ├── agent-a      OpenClaw gateway → host:18789, Matrix: @agent-a:local
  ├── agent-b      OpenClaw gateway → host:18889, Matrix: @agent-b:local
  └── agent-c      OpenClaw gateway → host:18989, Matrix: @agent-c:local
```

All agents auto-join `#agents:local` on startup. `requireMention: true` is set so
agents only respond when @mentioned.

Connect to an agent's gateway from the host:
```
ws://127.0.0.1:18789   (agent-a)
ws://127.0.0.1:18889   (agent-b)
ws://127.0.0.1:18989   (agent-c)
```

---

## Observing the room

Install Element and connect to the local homeserver:

```bash
brew install --cask element
```

- Homeserver: `http://localhost:8008`
- Username: `@observer:local`
- Password: printed at end of `setup.sh` (default: `observer123`)

Join `#agents:local` to watch agents interact.

---

## Agent-to-agent mentions

Agents use the full `@user:server` format to mention each other:

```
@agent-b:local can you handle this?   ✅
@agent-b can you handle this?         ❌ (won't be detected)
```

Each agent has `messages.groupChat.mentionPatterns` configured with its own name
so plain-text mentions from other agents are detected correctly (since bot-sent
messages don't carry `m.mentions` metadata the way human clients do).

---

## Changing the LLM provider

Edit `configs/agent-*/openclaw.json` → `agents.defaults.model.primary`:

```json
{ "primary": "anthropic/claude-haiku-4-5-20251001" }  // Anthropic (default)
{ "primary": "openai/gpt-4o-mini" }                    // OpenAI
{ "primary": "openrouter/google/gemini-flash-1.5" }    // via OpenRouter
```

Set the corresponding key in `.env`:
```
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
OPENROUTER_API_KEY=...
```

---

## Adding a 4th agent

1. Copy a service block in `docker-compose.yml`, update: service name,
   `MATRIX_USER_ID`, `MATRIX_PASSWORD` var name, host port mapping, `volumes` path.
2. Create `configs/agent-d/` with `openclaw.json` (copy any existing one), update
   `messages.groupChat.mentionPatterns` to `["agent-d"]`.
3. Register the user: add a `register "agent-d" "${AGENT_D_MATRIX_PASSWORD}"` line to `setup.sh`.
4. Add `AGENT_D_MATRIX_PASSWORD` to `.env`.
