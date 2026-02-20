/**
 * conversation-extractor
 *
 * Reads the session JSONL at agent bootstrap time and emits a structured
 * conversation payload — optimized for ingestion into a memory/analytics
 * service targeting multi-agent systems.
 *
 * Output:
 *   ~/.openclaw/conversation-extractor.log   — optimized (default)
 *   ~/.openclaw/conversation-extractor-verbose.log — full raw entries
 *     (set OPENCLAW_EXTRACTOR_VERBOSE=1 to enable)
 *
 * Hook events: agent:bootstrap, command:new
 */

import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import os from "os";

const STATE_DIR = path.join(os.homedir(), ".openclaw");
const LOG_FILE = path.join(STATE_DIR, "conversation-extractor.log");
const VERBOSE_LOG_FILE = path.join(STATE_DIR, "conversation-extractor-verbose.log");
const VERBOSE = process.env.OPENCLAW_EXTRACTOR_VERBOSE === "1";

// How much to preview before truncating (bytes)
const THINKING_PREVIEW = 400;
const RESPONSE_PREVIEW = 600;
const TOOL_RESULT_PREVIEW = 300;

// ── Session file resolution ──────────────────────────────────────────────────

function resolveSessionFile(agentId, sessionId) {
  return path.join(STATE_DIR, "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

async function readSessionEntries(filePath) {
  try {
    const raw = await fsPromises.readFile(filePath, "utf-8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
  } catch {
    return [];
  }
}

// ── Conversation turn extraction ─────────────────────────────────────────────
//
// Session JSONL structure (per entry):
//   { type: "message", message: { role: "user"|"assistant"|"toolResult", content: [...] } }
//
// Assistant content block types: "thinking", "text", "toolCall"
// toolResult content: [{ toolUseId, type, text, isError }]

function extractTextFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text")
      .map((b) => b.text || "")
      .join("");
  }
  return "";
}

function extractTurns(entries) {
  const turns = [];
  let current = null;

  // Index tool calls by id so we can match results later
  const pendingToolCalls = {};

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const { role, content } = entry.message;

    if (role === "user") {
      if (current) turns.push(finalizeTurn(current));
      current = {
        index: turns.length,
        timestamp: entry.timestamp ?? null,
        userMessage: extractTextFromContent(content),
        thinking: [],
        toolCalls: [],
        response: "",
      };

    } else if (role === "assistant" && current) {
      const blocks = Array.isArray(content) ? content : [];
      for (const block of blocks) {
        if (!block?.type) continue;
        switch (block.type) {
          case "thinking":
            if (block.thinking) current.thinking.push(block.thinking);
            break;
          case "toolCall":
          case "tool_use": {
            const tc = {
              id: block.id ?? null,
              name: block.name ?? block.toolName ?? "unknown",
              input: block.arguments ?? block.input ?? block.parameters ?? {},
              result: null,
              isError: null,
            };
            current.toolCalls.push(tc);
            if (tc.id) pendingToolCalls[tc.id] = tc;
            break;
          }
          case "text":
            current.response += block.text ?? "";
            break;
        }
      }

    } else if (role === "toolResult" && current) {
      // toolCallId is on the message, isError is on the message
      const id = entry.message.toolCallId ?? entry.message.toolUseId ?? null;
      const tc = id ? pendingToolCalls[id] : null;
      if (tc) {
        tc.result = extractTextFromContent(content);
        tc.isError = entry.message.isError ?? false;
        delete pendingToolCalls[id];
      }
    }
  }

  if (current) turns.push(finalizeTurn(current));
  return turns;
}

function finalizeTurn(turn) {
  return {
    ...turn,
    thinking: turn.thinking.join("\n\n"),
  };
}

// ── Optimized payload ─────────────────────────────────────────────────────────
//
// Strips bulk, keeps structure. Designed to be small enough to ship to a
// remote collector without crazy wire overhead.

function buildOptimizedPayload(sessionMeta, turns, entries) {
  return {
    schema: "openclaw-conversation-v1",
    extractedAt: new Date().toISOString(),
    session: sessionMeta,
    stats: {
      totalEntries: entries.length,
      turns: turns.length,
      toolCallCount: turns.reduce((n, t) => n + t.toolCalls.length, 0),
      thinkingTurnCount: turns.filter((t) => t.thinking.length > 0).length,
    },
    turns: turns.map((t) => ({
      index: t.index,
      timestamp: t.timestamp,
      userMessage: truncate(t.userMessage, RESPONSE_PREVIEW),
      thinking: truncate(t.thinking, THINKING_PREVIEW) || null,
      toolCalls: t.toolCalls.map((tc) => ({
        name: tc.name,
        // Omit full input — just surface the keys so the collector knows what
        // was invoked without shipping potentially large file contents etc.
        inputKeys: tc.input ? Object.keys(tc.input) : [],
        inputPreview: truncate(JSON.stringify(tc.input), 200),
        resultPreview: truncate(tc.result, TOOL_RESULT_PREVIEW),
        isError: tc.isError,
      })),
      response: truncate(t.response, RESPONSE_PREVIEW),
    })),
  };
}

function truncate(str, max) {
  if (!str) return str;
  return str.length <= max ? str : str.slice(0, max) + `… [+${str.length - max}]`;
}

// ── I/O ───────────────────────────────────────────────────────────────────────

function appendLog(filePath, data) {
  const sep = "\n" + "=".repeat(80) + "\n";
  fs.appendFileSync(filePath, sep + JSON.stringify(data, null, 2) + "\n");
}

// ── Session metadata from hook event ─────────────────────────────────────────

function resolveSessionMeta(event) {
  const ctx = event.context ?? {};
  const agentId = ctx.agentId ?? null;
  const sessionId = ctx.sessionId ?? null;
  const sessionKey = event.sessionKey ?? null;

  // Pull model from cfg if available
  const model =
    ctx.cfg?.agents?.defaults?.model?.primary ?? null;

  // Pull channel from sessionKey heuristic
  // sessionKey format: "agent:{agentId}:{channel}:{...}" or "agent:{agentId}:main"
  const channelFromKey = sessionKey
    ? sessionKey.replace(`agent:${agentId}:`, "").split(":")[0]
    : null;

  return { agentId, sessionId, sessionKey, channel: channelFromKey, model };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function HookHandler(event) {
  const isBootstrap = event.type === "agent" && event.action === "bootstrap";
  const isCommandNew = event.type === "command" && event.action === "new";

  if (!isBootstrap && !isCommandNew) return;

  const meta = resolveSessionMeta(event);
  if (!meta.agentId || !meta.sessionId) return;

  const sessionFile = resolveSessionFile(meta.agentId, meta.sessionId);
  const entries = await readSessionEntries(sessionFile);
  if (entries.length === 0) return;

  const turns = extractTurns(entries);
  if (turns.length === 0) return;

  const optimized = buildOptimizedPayload(meta, turns, entries);
  appendLog(LOG_FILE, optimized);

  if (VERBOSE) {
    appendLog(VERBOSE_LOG_FILE, {
      schema: "openclaw-conversation-raw-v1",
      session: meta,
      extractedAt: new Date().toISOString(),
      entries,
    });
  }
}
