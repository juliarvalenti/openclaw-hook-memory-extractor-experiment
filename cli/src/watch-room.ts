#!/usr/bin/env tsx
/**
 * watch-room.ts
 *
 * Long-polls a Matrix room and streams messages to stdout.
 *
 * Usage:
 *   npx tsx src/watch-room.ts <homeserver-url> <observer-password> [room-alias]
 */

const [, , homeserver, password, roomAliasArg] = process.argv;

if (!homeserver || !password) {
  console.error("Usage: watch-room.ts <homeserver-url> <observer-password> [room-alias]");
  process.exit(1);
}

const ROOM_ALIAS = roomAliasArg || "#agents:local";
const POLL_TIMEOUT_MS = 30_000;

// ANSI colors per sender
const COLORS = ["\x1b[36m", "\x1b[33m", "\x1b[32m", "\x1b[35m", "\x1b[34m", "\x1b[31m"];
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

const senderColors = new Map<string, string>();
let colorIdx = 0;
function colorFor(sender: string): string {
  if (!senderColors.has(sender)) {
    senderColors.set(sender, COLORS[colorIdx++ % COLORS.length]);
  }
  return senderColors.get(sender)!;
}

async function matrixFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${homeserver}${path}`, options);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Matrix ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

async function login(): Promise<string> {
  const data = await matrixFetch("/_matrix/client/r0/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "m.login.password", user: "observer", password }),
  }) as { access_token: string };
  return data.access_token;
}

async function resolveRoomId(token: string, alias: string): Promise<string> {
  const encoded = encodeURIComponent(alias);
  const data = await matrixFetch(`/_matrix/client/r0/directory/room/${encoded}`, {
    headers: { Authorization: `Bearer ${token}` },
  }) as { room_id: string };
  return data.room_id;
}

function formatMessage(sender: string, body: string, ts: number): string {
  const time = new Date(ts).toLocaleTimeString();
  // Strip @, :local suffix, and run unix timestamp suffix (e.g. -1740341820)
  const name = sender.replace("@", "").replace(":local", "").replace(/-\d{10}$/, "");
  const color = colorFor(name);
  return `${DIM}${time}${RESET} ${color}${BOLD}${name}${RESET}  ${body}`;
}

async function main() {
  console.log(`Connecting to ${homeserver}...`);
  const token = await login();

  const roomId = await resolveRoomId(token, ROOM_ALIAS);
  console.log(`Watching ${ROOM_ALIAS} (${roomId})\n${"─".repeat(60)}`);

  // Initial sync — get current room state and establish next_batch
  let since: string | undefined;
  {
    const url = `/_matrix/client/r0/sync?filter=${encodeURIComponent(JSON.stringify({
      room: { timeline: { limit: 30 } },
    }))}`;
    const data = await matrixFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    }) as { next_batch: string; rooms?: { join?: Record<string, { timeline: { events: MatrixEvent[] } }> } };

    since = data.next_batch;

    // Print backlog
    const room = data.rooms?.join?.[roomId];
    if (room?.timeline?.events) {
      for (const ev of room.timeline.events) {
        if (ev.type === "m.room.message") {
          console.log(formatMessage(ev.sender, ev.content.body ?? "", ev.origin_server_ts));
        }
      }
    }
  }

  // Long-poll loop
  while (true) {
    try {
      const url = `/_matrix/client/r0/sync?since=${encodeURIComponent(since!)}&timeout=${POLL_TIMEOUT_MS}`;
      const data = await matrixFetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS + 5_000),
      }) as { next_batch: string; rooms?: { join?: Record<string, { timeline: { events: MatrixEvent[] } }> } };

      since = data.next_batch;

      const room = data.rooms?.join?.[roomId];
      if (room?.timeline?.events) {
        for (const ev of room.timeline.events) {
          if (ev.type === "m.room.message") {
            console.log(formatMessage(ev.sender, ev.content.body ?? "", ev.origin_server_ts));
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") continue; // timeout, retry
      console.error("Poll error:", err);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
}

interface MatrixEvent {
  type: string;
  sender: string;
  origin_server_ts: number;
  content: { body?: string; msgtype?: string };
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
