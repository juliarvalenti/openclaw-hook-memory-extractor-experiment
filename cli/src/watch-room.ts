#!/usr/bin/env tsx
/**
 * watch-room.ts
 *
 * Long-polls a Matrix room and streams messages to stdout.
 *
 * Usage:
 *   npx tsx src/watch-room.ts <homeserver-url> <observer-password> [room-alias]
 */

import type { MatrixEvent } from "./matrix-client.js";
import { watchRoom } from "./matrix-client.js";

const [, , homeserver, password, roomAliasArg] = process.argv;

if (!homeserver || !password) {
  console.error("Usage: watch-room.ts <homeserver-url> <observer-password> [room-alias]");
  process.exit(1);
}

const ROOM_ALIAS = roomAliasArg || "#agents:local";

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

function formatMessage(sender: string, body: string, ts: number): string {
  const time = new Date(ts).toLocaleTimeString();
  const name = sender.replace("@", "").replace(":local", "").replace(/-\d{10}$/, "");
  const color = colorFor(name);
  return `${DIM}${time}${RESET} ${color}${BOLD}${name}${RESET}  ${body}`;
}

async function main() {
  console.log(`Connecting to ${homeserver}...`);
  console.log(`Watching ${ROOM_ALIAS}\n${"─".repeat(60)}`);

  await watchRoom(homeserver, password, ROOM_ALIAS, (ev: MatrixEvent) => {
    console.log(formatMessage(ev.sender, ev.content.body ?? "", ev.origin_server_ts));
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
