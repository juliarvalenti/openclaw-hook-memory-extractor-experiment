# Proof of Concept Checklist

Validating the building blocks for a multi-agent memory architecture using OpenClaw + HiveMind daemon + CFN.

---

## Status

| # | Hypothesis | Status |
|---|---|---|
| 1 | [Conversation extraction](#1-conversation-extraction) | ✅ Done |
| 2 | [Programmatic agent invocation](#2-programmatic-agent-invocation) | ✅ Done |
| 3 | [Context injection via bootstrapFiles](#3-context-injection-via-bootstrapfiles) | ✅ Done |
| 4 | [Hook blocking behavior](#4-hook-blocking-behavior) | ✅ Done |
| 5 | [Guardrail / flow interruption](#5-guardrail--flow-interruption) | ✅ Done |
| 6 | [Agent-to-agent conversation (channel-native)](#6-agent-to-agent-conversation-channel-native) | ✅ Done |
| 7 | [Protocol via skill or tool](#7-protocol-via-skill-or-tool) | 💤 Low priority |
| 8 | [Multi-agent co-coordination (trivial task)](#8-multi-agent-co-coordination-trivial-task) | 💤 Low priority |
| 9 | [Multi-agent co-coordination (protocol-enhanced)](#9-multi-agent-co-coordination-protocol-enhanced) | 💤 Low priority |

---

## Priority

### 1. Conversation extraction

**Hypothesis:** OpenClaw session JSONL files contain enough signal to extract structured memory — thinking chains, tool calls, tool results, and responses — suitable for ingestion into a knowledge graph.

**Status:** ✅ Done
**Artifact:** `hook/handler.js`, `sample-output.json`
**Notes:** Hook fires on `agent:bootstrap` and `command:new`. Output schema is `openclaw-conversation-v1`. One-turn lag is intentional and appropriate for a memory service.

---

### 2. Programmatic agent invocation

**Hypothesis:** An external service (HiveMind daemon) can invoke an OpenClaw agent without a chat interface, receive a structured response, and maintain session continuity across multiple calls.

**Status:** ✅ Done
**Artifact:** `CONNECTOR_PATTERN.md`
**Notes:** `openclaw agent --agent <name> --message <text> --json --session-id <id>` works. Session continuity via `--session-id` confirmed. Abstract `AgentConnector` interface documented with `OpenClawConnector` as first implementation. Each agent requires its own gateway; `connector_config` needs `gateway_url` for distributed deployments.

---

### 3. Context injection via bootstrapFiles

**Hypothesis:** A hook can inject external context (e.g. CFN memory query results) into an agent's system prompt before each turn, without any explicit request from the agent — enabling the full coordinator loop.

**Status:** ✅ Done
**Artifact:** `poc/bootstrap-inject/handler.js`
**Result:** `context.bootstrapFiles` is mutable and the mutation propagates to the agent runner. Content injected inline (no file on disk required) via `{ name, path, content, missing: false }`. Confirmed: agent received and recited codeword `ZEPHYR-7742` injected as synthetic `MEMORY.md` content.
**Notes:**
- The injected file appears in the system prompt labeled by its `path` value, not its `name` — ask the agent about the path, not "MEMORY.md", for reliable retrieval.
- `systemPromptReport.injectedWorkspaceFiles` in the `--json` response confirms injection at the system level (shows `chars=174`, `missing=false`).
- Content can be updated at runtime via `~/.openclaw/inject-payload.json` without restarting the gateway (hook reads the file on every invocation).

---

### 4. Hook blocking behavior

**Hypothesis:** OpenClaw awaits hook handlers before proceeding with the agent turn, meaning a hook can perform async work (e.g. a CFN query) and the result will be available before the agent runs.

**Status:** ✅ Done
**Artifact:** `poc/hook-blocking/handler.js`
**Results:**
- **Blocking confirmed:** 3s sleep in `agent:bootstrap` delayed agent turn by exactly 3s. Total call ~9.4s (3s hook + ~6s model).
- **Throws are swallowed:** Hook throwing an exception does NOT abort the turn. Gateway catches all exceptions in `triggerInternalHook()` and proceeds. Confirmed in source: `internal-hooks.ts:201` wraps every handler in try/catch.
**Conclusion:** Hooks are safe for async CFN queries. Hooks cannot be used as a guardrail/abort mechanism — they are observability + injection only.

---

### 5. Guardrail / flow interruption

**Hypothesis:** A hook (or the daemon) can stop or modify an agent's execution mid-flow — not just observe it.

**Status:** ✅ Done
**Artifact:** `poc/guardrail-abort/abort.js`, `poc/guardrail-abort/run-test.sh`
**Results:**
- **Hook throw:** swallowed, agent proceeds (see #4)
- **`chat.abort` RPC:** does NOT work for `openclaw agent` CLI-initiated runs — those use the `agent` RPC method and register in `ACTIVE_EMBEDDED_RUNS`, not `chatAbortControllers`. `chat.abort` only affects `chat.send`-initiated runs.
- **`sessions.reset` RPC:** ✅ **Works.** Calls `abortEmbeddedPiRun()` which fires the `AbortController` on the active run. Confirmed by timing: `sleep 30` task aborted mid-execution (~44s total vs 35s+ without abort), agent returned only partial response `"I'll run the sleep command and then tell you the time."`.
- **No CLI stop command:** no `openclaw abort <session>` exists. All abort RPCs are WebSocket-only.
**Caveats:**
- `sessions.reset` resets session history (new sessionId). Use `sessions.delete` to fully remove.
- Auth requires a paired device identity + Ed25519 signature, not just the gateway auth token. Scopes are wiped for unpaired connections (`internal-hooks.ts:420`).
- The daemon must maintain a paired device identity to use abort RPC calls.

---

### 6. Agent-to-agent conversation (channel-native)

**Hypothesis:** Two OpenClaw agents connected to the same channel can converse directly — agent A's response triggers agent B without the daemon relaying each turn.

**Status:** ✅ Done
**Artifact:** `docker/`, `MULTIAGENT.md`
**Results:**
- Three agents (agent-a, agent-b, agent-c) running in Docker Compose, each with their own gateway container
- Shared Matrix homeserver (Synapse) provides the coordination channel (`#agents:local`)
- Agents respond when @mentioned in the room; they can @mention each other to delegate tasks
- Channel-native coordination confirmed: no daemon brokering each hop
- `requireMention: true` recommended — prevents all agents piling on every message
**Notes:**
- Matrix chosen over IRC: Matrix's `startAccount` blocks correctly (no restart loop bug that affects the IRC plugin)
- The `openclaw:local` Docker image is missing Matrix plugin deps (`@vector-im/matrix-bot-sdk`) because the upstream Dockerfile runs `pnpm install` before copying `extensions/*/package.json`. Fixed via a derived `docker/Dockerfile` that re-runs `pnpm install --frozen-lockfile` on top of the base image.
- Hot reload works: changes to `configs/agent-*/openclaw.json` are picked up live without container restart for most settings.

---

## Low Priority / Nice to Have

### 7. Protocol via skill or tool

**Hypothesis:** An OpenClaw agent can be equipped with a skill or tool that causes it to emit structured output in a defined protocol format, enabling reliable machine-readable inter-agent messaging.

**Status:** 💤 Low priority
**Notes:** Useful if channel-native coordination (#6) proves viable. Less relevant if daemon-mediated relay is the pattern.

---

### 8. Multi-agent co-coordination (trivial task)

**Hypothesis:** Three OpenClaw agents can divide and complete a trivial task together — e.g. one plans, one executes, one verifies.

**Status:** 💤 Low priority
**Depends on:** Docker Compose multi-agent setup, and either #2 (daemon relay) or #6 (channel-native).

---

### 9. Multi-agent co-coordination (protocol-enhanced)

**Hypothesis:** The same trivial task from #8 completes more reliably or efficiently when agents communicate via the structured protocol from #7.

**Status:** 💤 Low priority
**Depends on:** #7, #8.

---

## Docker Compose Setup

✅ Implemented in `docker/`. See [`MULTIAGENT.md`](./MULTIAGENT.md) for full setup instructions.

**Actual topology:**
```
docker-compose
  ├── agent-a   (openclaw gateway, host port 18789)
  ├── agent-b   (openclaw gateway, host port 18889)
  ├── agent-c   (openclaw gateway, host port 18989)
  └── matrix    (Synapse homeserver, host port 8008)
```

Each agent container gets its own `openclaw.json` (volume-mounted at `/home/node/.openclaw`), with Matrix credentials supplied via env vars (`MATRIX_HOMESERVER`, `MATRIX_USER_ID`, `MATRIX_PASSWORD`). LLM provider is also env-configurable — swap `ANTHROPIC_API_KEY` for `OPENAI_API_KEY` etc. and update the model string in `openclaw.json`.
