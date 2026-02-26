/**
 * matrix-client.ts
 *
 * Shared Matrix helpers — login, fetch, and long-poll room watch.
 * Used by both watch-room.ts (CLI) and server.ts (REST API / SSE).
 */

export interface MatrixEvent {
  type: string;
  sender: string;
  origin_server_ts: number;
  content: { body?: string; msgtype?: string };
}

const POLL_TIMEOUT_MS = 30_000;

type SyncResponse = {
  next_batch: string;
  rooms?: { join?: Record<string, { timeline: { events: MatrixEvent[] } }> };
};

export async function matrixFetch(
  homeserver: string,
  token: string | null,
  path: string,
  options: RequestInit = {},
): Promise<unknown> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${homeserver}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Matrix ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

export async function matrixLogin(
  homeserver: string,
  user: string,
  password: string,
): Promise<string> {
  const data = await matrixFetch(homeserver, null, "/_matrix/client/r0/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "m.login.password", user, password }),
  }) as { access_token: string };
  return data.access_token;
}

export async function resolveRoomId(
  homeserver: string,
  token: string,
  alias: string,
): Promise<string> {
  const encoded = encodeURIComponent(alias);
  const data = await matrixFetch(
    homeserver,
    token,
    `/_matrix/client/r0/directory/room/${encoded}`,
  ) as { room_id: string };
  return data.room_id;
}

/**
 * Long-poll a Matrix room, calling onMessage for each m.room.message event.
 * Includes the backlog from the initial sync.
 * Resolves when signal is aborted.
 */
export async function watchRoom(
  homeserver: string,
  password: string,
  roomAlias: string,
  onMessage: (event: MatrixEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = await matrixLogin(homeserver, "observer", password);
  const roomId = await resolveRoomId(homeserver, token, roomAlias);

  // Initial sync — backlog + establish next_batch
  let since: string;
  {
    const url = `/_matrix/client/r0/sync?filter=${encodeURIComponent(
      JSON.stringify({ room: { timeline: { limit: 30 } } }),
    )}`;
    const data = await matrixFetch(homeserver, token, url) as SyncResponse;
    since = data.next_batch;
    const room = data.rooms?.join?.[roomId];
    if (room?.timeline?.events) {
      for (const ev of room.timeline.events) {
        if (ev.type === "m.room.message") onMessage(ev);
      }
    }
  }

  // Long-poll loop
  while (!signal?.aborted) {
    try {
      const url = `/_matrix/client/r0/sync?since=${encodeURIComponent(since)}&timeout=${POLL_TIMEOUT_MS}`;
      const data = await matrixFetch(homeserver, token, url, {
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS + 5_000),
      }) as SyncResponse;
      since = data.next_batch;
      const room = data.rooms?.join?.[roomId];
      if (room?.timeline?.events) {
        for (const ev of room.timeline.events) {
          if (ev.type === "m.room.message") onMessage(ev);
        }
      }
    } catch (err) {
      if (signal?.aborted) break;
      if (err instanceof Error && err.name === "AbortError") continue;
      console.error("Poll error:", err);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
}
