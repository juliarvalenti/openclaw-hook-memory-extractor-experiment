/**
 * session-start/handler.js
 *
 * Fires on agent:bootstrap and appends a session-start marker to the
 * shared conversation JSONL so readers know when a new session began.
 *
 * Output: $OPENCLAW_EXTRACTOR_OUTPUT/conversation-extractor.jsonl
 *         (falls back to ~/.openclaw/conversation-extractor.jsonl)
 *
 * Hook events: agent:bootstrap
 *
 * Installed by: openhive agent configure <framework>
 */

import fs from "fs";
import path from "path";
import os from "os";

const OUTPUT_DIR = process.env.OPENCLAW_EXTRACTOR_OUTPUT ?? path.join(os.homedir(), ".openclaw");
const LOG_FILE   = path.join(OUTPUT_DIR, "conversation-extractor.jsonl");

function appendJsonlLine(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(data) + "\n");
}

export default async function HookHandler(event) {
  if (event.type !== "agent" || event.action !== "bootstrap") return;

  const ctx = event.context ?? {};

  const payload = {
    schema:      "openclaw-session-start-v1",
    extractedAt: new Date().toISOString(),
    session: {
      agentId:   ctx.agentId   ?? "main",
      sessionId: ctx.sessionId ?? null,
      cwd:       ctx.cwd       ?? null,
    },
  };

  appendJsonlLine(LOG_FILE, payload);
}
