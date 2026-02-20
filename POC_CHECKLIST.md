# Proof of Concept Checklist

Validating the building blocks for a multi-agent memory architecture using OpenClaw + HiveMind daemon + CFN.

---

## Status

| # | Hypothesis | Status |
|---|---|---|
| 1 | [Conversation extraction](#1-conversation-extraction) | ✅ Done |
| 2 | [Programmatic agent invocation](#2-programmatic-agent-invocation) | ✅ Done |
| 3 | [Context injection via bootstrapFiles](#3-context-injection-via-bootstrapfiles) | 🔲 Not started |
| 4 | [Hook blocking behavior](#4-hook-blocking-behavior) | ✅ Done |
| 5 | [Guardrail / flow interruption](#5-guardrail--flow-interruption) | ✅ Done |
| 6 | [Agent-to-agent conversation (channel-native)](#6-agent-to-agent-conversation-channel-native) | 🔲 Not started |
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

**Status:** 🔲 Not started
**Mechanism:** `agent:bootstrap` event exposes a mutable `context.bootstrapFiles` array. Writing to it injects content into the agent's context before the turn runs.
**Validation:** Write a hook that appends a test file to `bootstrapFiles`. Confirm the agent receives and acknowledges the injected content in its response.
**Depends on:** [#4 Hook blocking behavior](#4-hook-blocking-behavior) — injection is only reliable if the hook is awaited before the turn starts.
**Reference:** `$(npm root -g)/openclaw/dist/bundled/bootstrap-extra-files/handler.js`

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

**Hypothesis:** Two OpenClaw agents connected to the same channel (e.g. IRC) can converse directly — agent A's response triggers agent B without the daemon relaying each turn.

**Status:** 🔲 Not started
**Context:** Daemon-mediated relay (PoC #2) already works. This tests whether a *channel-native* pattern is viable — agents coordinate autonomously, daemon observes but doesn't broker every hop.
**Setup required:** Docker Compose with two agent gateways + an IRC server (or OpenClaw WebChat), both agents subscribed to the same channel.
**Open question:** Does OpenClaw treat one agent's outbound message as an inbound trigger for another agent on the same channel? Or are responses "outbound only"?

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

Required for PoCs #6, #8, #9. Each agent runs its own gateway container — this mirrors the distributed deployment target (separate gateways on separate hosts).

**Planned topology:**
```
docker-compose
  ├── agent-a-gateway   (openclaw gateway, port 18789)
  ├── agent-b-gateway   (openclaw gateway, port 18789, different host)
  ├── agent-c-gateway   (openclaw gateway, port 18789, different host)
  ├── irc-server        (for channel-native PoC #6)
  └── daemon            (HiveMind daemon, coordinates via connector pattern)
```

Config is parameterized so N agents can be added without restructuring. Each agent container gets:
- Its own `openclaw.json` (agent name, model, channel config)
- `ANTHROPIC_API_KEY` from env
- Optional: mounted hook directory for the conversation extractor

**Status:** 🔲 Not started
