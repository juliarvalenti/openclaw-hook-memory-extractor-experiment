# Docker Compose — Multi-Agent OpenClaw

Three OpenClaw agents + an Ergo IRC server, all on an isolated Docker network.

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
# Edit .env: fill in ANTHROPIC_API_KEY and generate tokens
```

Generate gateway tokens:
```bash
openssl rand -hex 24   # run once per agent, paste into .env
```

---

## Usage

```bash
# Start everything (IRC + all 3 agents)
docker compose up

# Start IRC + only two agents
docker compose up irc agent-a agent-b

# Tail logs for one agent
docker compose logs -f agent-a

# Stop everything
docker compose down
```

---

## Architecture

```
Docker network: agents
  ├── irc          Ergo IRC server, :6667 (plain text)
  ├── agent-a      OpenClaw gateway → host:18789, nick: agent-a
  ├── agent-b      OpenClaw gateway → host:18889, nick: agent-b
  └── agent-c      OpenClaw gateway → host:18989, nick: agent-c
```

All agents auto-join `#agents` on startup. `requireMention: false` is set so
agents respond to any message in the channel without needing to be @-mentioned.

Connect to an agent's gateway from the host:
```
ws://127.0.0.1:18789   (agent-a)
ws://127.0.0.1:18889   (agent-b)
ws://127.0.0.1:18989   (agent-c)
```

---

## Debugging the IRC channel

To connect with an IRC client and observe the #agents channel:

```yaml
# Add to irc service in docker-compose.yml:
ports:
  - "6667:6667"
```

Then connect any IRC client to `localhost:6667`, join `#agents`.

---

## Changing the LLM provider

Edit `configs/agent-*/openclaw.json` → `agents.defaults.model.primary`:

```json
{ "primary": "anthropic/claude-haiku-4-5-20251001" }  # Anthropic (default)
{ "primary": "openai/gpt-5-mini" }                     # OpenAI
{ "primary": "openrouter/google/gemini-flash-1.5" }    # via OpenRouter
```

Set the corresponding key in `.env`:
```
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
OPENROUTER_API_KEY=...
```

---

## Adding a 4th agent

1. Copy a service block in `docker-compose.yml`, update: service name, `IRC_NICK`,
   `OPENCLAW_GATEWAY_TOKEN` var name, host port mapping, `volumes` path.
2. Create `configs/agent-d/openclaw.json` (copy any existing one).
3. Add `AGENT_D_TOKEN` to `.env`.
