/**
 * openhive-cfn — OpenClaw Plugin
 *
 * Bridges OpenClaw agents to the OpenHive coordination backend, covering the
 * full CFN adapter hook surface identified in the architecture analysis:
 *
 *   gateway_start      — verify connectivity to OpenHive on startup
 *   gateway_stop       — graceful shutdown log
 *   session_start      — register agent in coordination room (Begin Session)
 *   session_end        — announce agent departure (End Session)
 *   before_agent_start — inject coordination instructions + latest tick/consensus as prependContext
 *   message_sent       — forward agent output to coordination room
 *
 * Environment variables (injected by generate-compose.ts):
 *   OPENHIVE_API_URL     — OpenHive backend base URL, e.g. http://host.docker.internal:8000
 *   OPENHIVE_CHANNEL_ID  — Experiment/channel ID (used as-is as the room name)
 *   MATRIX_USER_ID       — Agent Matrix ID, e.g. @city-selector-abc123:local; used as handle
 */

// ── Coordination instructions injected into every agent turn ─────────────────

const OPENHIVE_INSTRUCTIONS = `\
# OpenHive Multi-Agent Coordination

You are operating in a shared coordination session with other AI agents managed by OpenHive.
Use the \`openhive\` CLI to participate. Do not attempt to speak SSTP JSON directly.

The coordination room is automatically resolved from your environment — you do not specify a room name.

## Triggering coordination

When a user appends \`/openhive\` to their message, or when you are assigned to a
multi-agent coordination task, start the coordination flow:

## Step 1 — Join the coordination backchannel

\`\`\`
openhive room join -m "<your requirements or perspective>"
\`\`\`

This command **blocks** (~30s) while other agents join and post their requirements.
When the first tick fires, it prints a clarification question from CognitiveEngine and returns.

## Step 2 — Respond to coordination questions

Read the printed question, then respond:

\`\`\`
openhive message query "<your response to the coordination question>"
\`\`\`

This command **blocks** until all agents respond and CognitiveEngine processes them.
It then prints the next question or your final assignment.

## Step 3 — Repeat until consensus

Repeat step 2 until you receive a \`[consensus]\` message — your specific assignment
will be printed. Then proceed with your assignment independently.

## Room discipline

- Speak only when you have something new to contribute.
- Do not echo, acknowledge, or confirm receipt of messages.
- If another agent has already answered adequately, stay silent.
- Default to silence.
`;

// ─────────────────────────────────────────────────────────────────────────────

const API_URL = (process.env.OPENHIVE_API_URL ?? "").replace(/\/$/, "");
const CHANNEL_ID = process.env.OPENHIVE_CHANNEL_ID ?? "";
const WORKSPACE_ID = process.env.OPENHIVE_WORKSPACE_ID ?? "";
const MAS_ID = process.env.OPENHIVE_MAS_ID ?? "";
const AGENT_ID = process.env.OPENHIVE_AGENT_ID ?? "";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derive a stable handle for this agent.
 * Prefers OPENHIVE_AGENT_HANDLE (set explicitly by generate-compose.ts),
 * falls back to stripping MATRIX_USER_ID ("@name-runid:local" → "name-runid").
 */
function resolveHandle(): string {
  if (process.env.OPENHIVE_AGENT_HANDLE) {
    return process.env.OPENHIVE_AGENT_HANDLE;
  }
  const matrixId = process.env.MATRIX_USER_ID ?? "";
  if (matrixId.startsWith("@")) {
    return matrixId.slice(1).split(":")[0];
  }
  return matrixId || "unknown-agent";
}

function roomName(): string | null {
  return CHANNEL_ID || null;
}

async function apiPost(
  path: string,
  body: unknown,
  log: { warn: (s: string) => void }
): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.warn(`[openhive-cfn] POST ${path} → ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    log.warn(`[openhive-cfn] POST ${path} error: ${e}`);
    return false;
  }
}

async function apiGet(
  path: string,
  log: { warn: (s: string) => void }
): Promise<unknown> {
  try {
    const res = await fetch(`${API_URL}${path}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    log.warn(`[openhive-cfn] GET ${path} error: ${e}`);
    return null;
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export default function register(api: {
  logger: { info: (s: string) => void; warn: (s: string) => void };
  on: (event: string, handler: (...args: any[]) => any, opts?: object) => void;
}): void {
  if (!API_URL) {
    api.logger.warn("[openhive-cfn] OPENHIVE_API_URL not set — plugin inactive");
    return;
  }

  const log = api.logger;
  const handle = resolveHandle();

  // ── gateway_start ──────────────────────────────────────────────────────────

  api.on("gateway_start", async () => {
    const room = roomName();
    if (!room) {
      log.warn("[openhive-cfn] OPENHIVE_CHANNEL_ID not set — room-scoped hooks inactive");
      return;
    }
    try {
      const res = await fetch(`${API_URL}/health`);
      if (res.ok) {
        log.info(`[openhive-cfn] Ready | backend: ${API_URL} | room: ${room} | handle: ${handle}`);
      } else {
        log.warn(`[openhive-cfn] Backend unhealthy (${res.status}) — will retry per call`);
      }
    } catch {
      log.warn(`[openhive-cfn] Cannot reach ${API_URL} — will retry per call`);
    }
  });

  // ── gateway_stop ───────────────────────────────────────────────────────────

  api.on("gateway_stop", async () => {
    log.info("[openhive-cfn] Gateway stopping — plugin shutdown");
  });

  // ── session_start ──────────────────────────────────────────────────────────
  // Register the agent in the coordination room when a new session begins.
  // This is the "Begin Session" event from the CFN adapter spec; triggers
  // Semantic Negotiation on the OpenHive side.

  api.on("session_start", async (event: { sessionId: string; resumedFrom?: string }) => {
    const room = roomName();
    if (!room) return;

    if (event.resumedFrom) {
      log.info(`[openhive-cfn] Session resumed (${event.sessionId}) — skipping re-registration`);
      return;
    }

    const ok = await apiPost(`/rooms/${room}/sessions`, {
      agent_handle: handle,
      intent: null,
    }, log);

    if (ok) {
      log.info(`[openhive-cfn] Registered ${handle} in ${room} (session ${event.sessionId})`);
    }
  });

  // ── session_end ────────────────────────────────────────────────────────────

  api.on("session_end", async (event: { sessionId: string; messageCount: number }) => {
    const room = roomName();
    if (!room) return;

    log.info(`[openhive-cfn] Session ${event.sessionId} ended (${event.messageCount} messages)`);

    await apiPost(`/rooms/${room}/messages`, {
      sender_handle: handle,
      recipient_handle: null,
      message_type: "announce",
      content: `agent offline (session ended)`,
    }, log);
  });

  // ── before_agent_start ─────────────────────────────────────────────────────
  // Always inject coordination instructions. If a room is active, also fetch
  // the latest coordination tick/consensus and append it so the agent sees its
  // current assignment before every turn.
  //
  // Note: this fires every turn. For high-frequency agents, add a short TTL
  // cache here to avoid hammering the backend.

  api.on("before_agent_start", async (): Promise<{ prependContext?: string } | undefined> => {
    const parts: string[] = [OPENHIVE_INSTRUCTIONS];

    const room = roomName();
    if (room) {
      const data = await apiGet(`/rooms/${room}/messages?limit=30`, log) as any;
      const coord = data?.messages?.find(
        (m: any) =>
          m.message_type === "coordination_consensus" ||
          m.message_type === "coordination_tick"
      );

      if (coord) {
        let summary: string;
        try {
          const parsed = JSON.parse(coord.content);
          if (coord.message_type === "coordination_consensus") {
            const plan = parsed.plan ? `Plan: ${parsed.plan}\n` : "";
            const myAssignment = parsed.assignments?.[handle];
            const assignBlock = myAssignment
              ? `Your assignment: ${myAssignment}`
              : `Assignments:\n${JSON.stringify(parsed.assignments ?? {}, null, 2)}`;
            summary = `[OpenHive — consensus reached]\n${plan}${assignBlock}`;
          } else {
            const questions = (parsed.ambiguities ?? [])
              .map((q: string, i: number) => `  ${i + 1}. ${q}`)
              .join("\n");
            summary =
              `[OpenHive — coordination tick ${parsed.round ?? "?"}]\n` +
              `Pending clarifications:\n${questions}`;
          }
        } catch {
          summary = `[OpenHive]\n${coord.content}`;
        }
        parts.push(summary);
      }
    }

    return { prependSystemContext: parts.join("\n\n") };
  });

  // ── message_sent ───────────────────────────────────────────────────────────
  // Forward each successful outbound message to the coordination room so other
  // agents and the observer can track this agent's output. Covers "Output Gen
  // Post" from the CFN adapter spec.
  //
  // Also POST the turn to /api/knowledge/ingest (fire-and-forget) so the
  // knowledge graph is populated with each completed turn.

  api.on(
    "message_sent",
    async (event: { to: string; content: string; success: boolean }) => {
      const room = roomName();
      if (!room || !event.success) return;

      // Skip empty or trivially short messages
      if (!event.content?.trim() || event.content.trim().length < 5) return;

      await apiPost(`/rooms/${room}/messages`, {
        sender_handle: handle,
        recipient_handle: null,
        message_type: "broadcast",
        content: event.content,
      }, log);

      // Knowledge ingestion — fire-and-forget, non-fatal
      if (WORKSPACE_ID && MAS_ID) {
        const turn: Record<string, unknown> = { response: event.content };
        apiPost("/api/knowledge/ingest", {
          workspace_id: WORKSPACE_ID,
          mas_id: MAS_ID,
          agent_id: AGENT_ID || undefined,
          records: [turn],
        }, log).catch((err) => log.warn(`[openhive-cfn] ingest failed: ${err}`));
      }
    }
  );
}
