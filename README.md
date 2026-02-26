# openclaw-hook-memory-extractor-experiment

A multi-agent experiment framework built on [OpenClaw](https://openclaw.ai). Spins up isolated agent sessions in Docker containers, coordinates them via a shared Matrix room, and captures structured per-turn logs via lifecycle hooks.

Started as a proof of concept for extracting conversation data from OpenClaw sessions. Evolved into a platform for running and observing multi-agent scenarios.

---

## Quick start

```bash
# 1. Start the shared Matrix server (once — leave it running)
./cli/experiment matrix start

# 2. Create an experiment
./cli/experiment create my-experiment agent-a agent-b

# 3. Edit the experiment
#    experiments/my-experiment-<ts>/experiment.json   — seed message + acceptance criteria
#    experiments/my-experiment-<ts>/agents/*/workspace/IDENTITY.md  — who each agent is

# 4. Run it
./cli/experiment run my-experiment-<ts> --timeout 10m

# 5. Watch the room live
./cli/experiment watch my-experiment-<ts>

# 6. Stop it
./cli/experiment stop my-experiment-<ts>
```

---

## How it works

Each `experiment run` does the following:

1. Registers per-run Matrix users (`@agent-name-<runid>:local`) on the shared homeserver
2. Creates a dedicated Matrix room for the run (`#experiment-name-runid:local`)
3. Generates a `docker-compose.yml` and launches one container per agent
4. Force-joins agents into the room and waits for them to connect
5. Posts the seed message to kick off the scenario
6. Auto-stops after the configured timeout (default 5m)

Ports are allocated dynamically so multiple experiments can run simultaneously without collisions.

---

## Experiment structure

```
experiments/
  <name>-<timestamp>/
    experiment.json          # name, description, seed, acceptance_criteria
    agents/
      <agent-name>/
        openclaw.json        # model, Matrix channel config
        workspace/
          IDENTITY.md        # who this agent is
          SOUL.md            # behavioral constraints
          CONSTRAINTS.md     # artificial limitations (optional)
          skills/sstp/       # auto-installed: Structured Semantic Turn Protocol
          hooks/             # auto-installed: session-start, conversation-extractor
    runs/
      <timestamp>/           # generated per run — do not edit
        docker-compose.yml
        .env
        logs/
          <agent-name>/
            conversation-extractor.jsonl
```

---

## Hooks

Two hooks are auto-installed into every agent workspace on each run.

### `session-start`

Fires on `agent:bootstrap`. Writes a single line to the JSONL when a session begins.

```json
{
  "schema": "openclaw-session-start-v1",
  "extractedAt": "2026-02-26T00:16:24.652Z",
  "session": { "agentId": "main", "sessionId": "...", "cwd": null }
}
```

### `conversation-extractor`

Fires on `agent:bootstrap` and `message:sent`. Appends any completed turns not yet written, deduplicated by `sessionId + turn.index`.

```json
{
  "schema": "openclaw-turn-v1",
  "extractedAt": "2026-02-26T00:16:33.260Z",
  "session": {
    "agentId": "main",
    "sessionId": "...",
    "sessionKey": "agent:main:matrix:channel:!abc:local",
    "channel": "matrix",
    "cwd": "/home/node/.openclaw/workspace"
  },
  "turn": {
    "index": 1,
    "timestamp": "...",
    "model": "...",
    "stopReason": "stop",
    "usage": { "input": 3, "output": 125, "cacheRead": 0, "cacheWrite": 15702, "totalTokens": 15830 },
    "userMessage": "...",
    "thinking": null,
    "toolCalls": [{ "name": "read", "input": {...}, "result": "...", "isError": false }],
    "response": "..."
  }
}
```

Each agent gets its own `conversation-extractor.jsonl` under `runs/<ts>/logs/<agent>/`.

---

## SSTP skill

All agents get the **Structured Semantic Turn Protocol** skill installed automatically. It defines a JSON-only inter-agent communication schema with message kinds: `intent`, `query`, `knowledge`, `delegation`, `commit`, `evidence_bundle`, `memory_delta`.

See `cli/openhive/skills/sstp/SKILL.md` for the full protocol.

---

## CLI reference

```bash
# Matrix server
./cli/experiment matrix start|stop|status

# Experiments
./cli/experiment create <name> [agent1] [agent2] ...
./cli/experiment run    <name> [--timeout 5m|10m|1h]
./cli/experiment stop   <name>
./cli/experiment list
./cli/experiment status <name>
./cli/experiment logs   <name> [agent] [--follow]
./cli/experiment messages <name> [limit]
./cli/experiment watch  <name>

# REST API (mirrors all CLI commands over HTTP)
./cli/experiment server [--port 7777]
```

---

## Original POC

The original single-agent hook work is preserved in `poc/` and `hook/`. The `POC_CHECKLIST.md` documents what was validated:

| # | Hypothesis | Status |
|---|---|---|
| 1 | Conversation extraction from session JSONL | ✅ |
| 2 | Programmatic agent invocation | ✅ |
| 3 | Context injection via `bootstrapFiles` | ✅ |
| 4 | Hook blocking behavior | ✅ |
| 5 | Guardrail / flow interruption via `sessions.reset` RPC | ✅ |
| 6 | Agent-to-agent conversation (channel-native via Matrix) | ✅ |

---

## Requirements

- Docker + Docker Compose
- Node.js 20+
- `ANTHROPIC_API_KEY` (or another supported LLM provider key) in `cli/.env`
