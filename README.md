# openclaw-hook-memory-extractor-experiment

An experimental OpenClaw hook that extracts structured conversation data from agent sessions — thinking chains, tool calls, tool results, and responses — designed as a proof of concept for building memory services targeting multi-agent systems.

This is the groundwork for a memory layer built specifically for multi-agent architectures, with OpenClaw as the first integration target.

---

## What it does

OpenClaw agents write every turn to a session `.jsonl` file on disk. This hook taps into the `agent:bootstrap` lifecycle event (fires at the start of each turn) to read that file and emit a structured payload containing the full prior conversation — including the model's chain-of-thought thinking, every tool call with its inputs and result, and the final response.

The output is designed to be forwarded to a telemetry collector or memory service without shipping excessive data over the wire.

### Output schema (`openclaw-conversation-v1`)

```json
{
  "schema": "openclaw-conversation-v1",
  "extractedAt": "...",
  "session": {
    "agentId": "main",
    "sessionId": "...",
    "sessionKey": "agent:main:main",
    "channel": "discord",
    "model": "anthropic/claude-sonnet-4-5-20250929"
  },
  "stats": {
    "totalEntries": 439,
    "turns": 83,
    "toolCallCount": 92,
    "thinkingTurnCount": 83
  },
  "turns": [
    {
      "index": 0,
      "timestamp": "...",
      "userMessage": "...",
      "thinking": "...",
      "toolCalls": [
        {
          "name": "exec",
          "inputKeys": ["command"],
          "inputPreview": "{\"command\":\"pwd\"}",
          "resultPreview": "/workspace",
          "isError": false
        }
      ],
      "response": "..."
    }
  ]
}
```

See [`sample-output.json`](./sample-output.json) for a real captured session.

---

## How the session binding works

The `agent:bootstrap` event provides enough metadata to unambiguously locate the session file:

```
agent:bootstrap event
  ├── agentId    ─────────────────────────────────┐
  └── sessionId  ─────────────────────────────────┤
                                                   ▼
                    ~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl
```

This is the same mechanism used by OpenClaw's bundled `session-memory` hook.

---

## Wire optimization

The optimized output (default) is designed to be small enough to forward to a remote collector:

- Tool call **inputs are represented as `inputKeys` + a 200-char preview** — avoids shipping full file contents across the wire
- Thinking and responses are **truncated with length hints** (`… [+N]`) so downstream services know what was cut without receiving it
- Verbose mode is **opt-in and writes to a separate file**, keeping the hot path lean

For full untruncated payloads (useful for local analysis), set `OPENCLAW_EXTRACTOR_VERBOSE=1`.

---

## Hook lifecycle

The hook fires on two events:

| Event | When | Purpose |
|---|---|---|
| `agent:bootstrap` | Start of every agent turn | Capture prior conversation state |
| `command:new` | User issues `/new` to reset session | Capture final session state before reset |

Because `agent:bootstrap` fires *before* the current turn runs, the session file contains turns `0..N-1` at bootstrap N. This means the extractor is always one turn behind — which is intentional and appropriate for a memory service (you're capturing what just happened, not what's happening now).

---

## Security note — hook system threat model

**This is worth understanding before shipping any hook to users.**

The `agent:bootstrap` (and `gateway:startup`) events pass `event.context.cfg` — the full OpenClaw config object — directly to hook handlers. This includes:

- `cfg.channels.discord.token` — Discord bot token
- `cfg.gateway.auth.token` — gateway WebSocket auth token
- Any other credentials configured in `~/.openclaw/openclaw.json`

This hook deliberately does **not** read or log `cfg`. But a malicious hook could trivially exfiltrate all credentials with a single `fetch()` call. The hook runtime has no sandboxing — it runs with full process permissions.

The threat model is identical to installing an npm package or a VS Code extension: **installing a hook from an untrusted source is implicitly trusting it with your credentials.** This should be called out clearly in any installer or marketplace UI.

---

## Install

```bash
git clone https://github.com/juliavalenti/openclaw-hook-memory-extractor-experiment
cd openclaw-hook-memory-extractor-experiment
chmod +x setup.sh
./setup.sh
```

Then restart the gateway:

```bash
openclaw gateway stop && openclaw gateway
```

### Verbose mode

```bash
OPENCLAW_EXTRACTOR_VERBOSE=1 openclaw gateway
```

Writes full untruncated entries to `~/.openclaw/conversation-extractor-verbose.log`.

### Uninstall

```bash
./setup.sh --remove
```

---

## Output files

| File | Contents |
|---|---|
| `~/.openclaw/conversation-extractor.log` | Optimized structured payloads (default) |
| `~/.openclaw/conversation-extractor-verbose.log` | Full raw session entries (verbose mode only) |

### Viewing output

```bash
# latest capture, last 8 turns
grep -v '^=*$' ~/.openclaw/conversation-extractor.log | jq -s '.[-1] | .turns = .turns[-8:]' | bat -l json
```

---

## Architecture notes (multi-agent context)

The `session.sessionKey` field is the join key for multi-agent graphs. It encodes agent ID, channel, and conversation scope:

- `agent:main:main` — direct/web session
- `agent:main:discord:channel:1234` — Discord channel session
- `agent:main:discord:dm:5678` — Discord DM session

A memory service would index by `sessionKey` and emit each bootstrap as a delta into a telemetry collector. The `agentId` disambiguates which agent in a multi-agent system produced the turn.

---

## Multi-agent setup

A Docker Compose environment for running three agents coordinating via a shared
Matrix room is in `docker/`. See [`MULTIAGENT.md`](./MULTIAGENT.md) for full
setup and Element connection instructions.

---

## Files

```
hook/
  HOOK.md           — OpenClaw hook metadata (name, events, emoji)
  handler.js        — Hook handler (the extractor)
docker/
  docker-compose.yml  — Three-agent + Synapse Matrix setup
  Dockerfile          — Extends openclaw:local with Matrix plugin deps
  setup.sh            — One-time Synapse init + user registration
  configs/agent-{a,b,c}/openclaw.json  — Per-agent config (volume-mounted)
  .env.example        — Environment variable template
MULTIAGENT.md       — Multi-agent Docker + Element setup guide
sample-output.json  — Real captured session (15 turns)
setup.sh            — Hook install/uninstall script
```

### Reference — OpenClaw internals consulted

These files were read during development and are useful for understanding the hook system:

| File | Notes |
|---|---|
| [docs.openclaw.ai/cli/hooks](https://docs.openclaw.ai/cli/hooks) | Hook enable/disable/install CLI |
| [docs.openclaw.ai/automation/hooks](https://docs.openclaw.ai/automation/hooks) | Custom hook authoring, event list |
| `$(npm root -g)/openclaw/dist/bundled/session-memory/handler.js` | Bundled hook — session file reading pattern |
| `$(npm root -g)/openclaw/dist/bundled/command-logger/handler.js` | Bundled hook — simplest handler example |
| `$(npm root -g)/openclaw/dist/bundled/boot-md/handler.js` | Bundled hook — `gateway:startup` event usage |
| `$(npm root -g)/openclaw/dist/bundled/bootstrap-extra-files/handler.js` | Bundled hook — `agent:bootstrap` event usage |
