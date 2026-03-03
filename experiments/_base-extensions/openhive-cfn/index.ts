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
 *   before_agent_start — inject latest coordination tick/consensus as prependContext
 *   message_sent       — forward agent output to coordination room
 *
 * Environment variables (injected by generate-compose.ts):
 *   OPENHIVE_API_URL     — OpenHive backend base URL, e.g. http://host.docker.internal:8000
 *   OPENHIVE_CHANNEL_ID  — Experiment/channel ID; coordination room = oh-{channelId}
 *   MATRIX_USER_ID       — Agent Matrix ID, e.g. @city-selector-abc123:local; used as handle
 */

const API_URL = (process.env.OPENHIVE_API_URL ?? "").replace(/\/$/, "");
const CHANNEL_ID = process.env.OPENHIVE_CHANNEL_ID ?? "";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derive a stable handle from the Matrix user ID.
 * "@city-selector-abc123:local" → "city-selector-abc123"
 */
function resolveHandle(): string {
  const matrixId = process.env.MATRIX_USER_ID ?? "";
  if (matrixId.startsWith("@")) {
    return matrixId.slice(1).split(":")[0];
  }
  return matrixId || "unknown-agent";
}

function roomName(): string | null {
  return CHANNEL_ID ? `oh-${CHANNEL_ID}` : null;
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
  // Fetch the latest coordination event from OpenHive and inject it as
  // prependContext — covers "Input Pre Processing" and "Output Gen Pre" from
  // the CFN adapter spec. The agent sees its assignment before every turn.
  //
  // Note: this fires every turn. For high-frequency agents, add a short TTL
  // cache here to avoid hammering the backend.

  api.on("before_agent_start", async (): Promise<{ prependContext?: string } | undefined> => {
    const room = roomName();
    if (!room) return undefined;

    const data = await apiGet(`/rooms/${room}/messages?limit=30`, log) as any;
    if (!data?.messages?.length) return undefined;

    // Messages are returned newest-first; find the most recent coordination event
    const coord = data.messages.find(
      (m: any) =>
        m.message_type === "coordination_consensus" ||
        m.message_type === "coordination_tick"
    );
    if (!coord) return undefined;

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

    return { prependContext: summary };
  });

  // ── message_sent ───────────────────────────────────────────────────────────
  // Forward each successful outbound message to the coordination room so other
  // agents and the observer can track this agent's output. Covers "Output Gen
  // Post" from the CFN adapter spec.

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
    }
  );
}
