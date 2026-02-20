/**
 * bootstrap-inject-test handler — PoC #3
 *
 * Injects a synthetic MEMORY.md into context.bootstrapFiles at agent:bootstrap.
 * The content is a recognizable codeword payload simulating what a CFN memory
 * query result would look like.
 *
 * If the agent can recite the codeword when asked, injection is confirmed.
 *
 * The injected content is built from a JSON file on disk so it can be swapped
 * without restarting the gateway:
 *   ~/.openclaw/inject-payload.json
 *
 * If that file doesn't exist, a hardcoded test payload is used.
 */

import fs from "fs";
import os from "os";
import path from "path";

const PAYLOAD_FILE = path.join(os.homedir(), ".openclaw", "inject-payload.json");
const LOG_FILE = path.join(os.homedir(), ".openclaw", "bootstrap-inject.log");

function buildContent() {
  if (fs.existsSync(PAYLOAD_FILE)) {
    try {
      const payload = JSON.parse(fs.readFileSync(PAYLOAD_FILE, "utf8"));
      return payload.content ?? buildDefaultContent();
    } catch {
      // fall through to default
    }
  }
  return buildDefaultContent();
}

function buildDefaultContent() {
  return [
    "# Injected Memory (PoC #3 test)",
    "",
    "This content was injected by the bootstrap-inject-test hook.",
    "Codeword: ZEPHYR-7742",
    "",
    "If you can see this, bootstrapFiles injection is working.",
  ].join("\n");
}

export default async function HookHandler(event) {
  if (event.type !== "agent" || event.action !== "bootstrap") return;

  const content = buildContent();

  // Inject as MEMORY.md — a recognized bootstrap filename.
  // content is provided directly so no file needs to exist on disk.
  const injected = {
    name: "MEMORY.md",
    path: path.join(os.homedir(), ".openclaw", "poc-inject-memory.md"),
    content,
    missing: false,
  };

  event.context.bootstrapFiles = [...(event.context.bootstrapFiles ?? []), injected];

  const entry = {
    ts: new Date().toISOString(),
    sessionKey: event.context?.sessionKey ?? "unknown",
    injectedChars: content.length,
    contentPreview: content.slice(0, 80),
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}
