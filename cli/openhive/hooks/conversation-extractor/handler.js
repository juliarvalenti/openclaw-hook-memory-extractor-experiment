/**
 * conversation-extractor/handler.js
 *
 * Appends new completed turns to a .jsonl file on each agent:bootstrap or
 * message:sent event. Tracks already-written turns by sessionId+index so the
 * handler is idempotent regardless of which event fires first.
 *
 * Output: $OPENCLAW_EXTRACTOR_OUTPUT/conversation-extractor.jsonl
 *         (falls back to ~/.openclaw/conversation-extractor.jsonl)
 *
 * Hook events: agent:bootstrap, message:sent
 *
 * Installed by: openhive agent configure <framework>
 */

import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import os from "os";

const OUTPUT_DIR   = process.env.OPENCLAW_EXTRACTOR_OUTPUT ?? path.join(os.homedir(), ".openclaw");
const LOG_FILE     = path.join(OUTPUT_DIR, "conversation-extractor.jsonl");

const STATE_DIR    = path.join(os.homedir(), ".openclaw");
const SESSIONS_DIR = path.join(STATE_DIR, "agents", "main", "sessions");

function resolveSessionFile(agentId, sessionId) {
  return path.join(STATE_DIR, "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

/** Find the newest session file that contains at least one user-role message.
 *  Skips Matrix context-only files (assistant-only). */
async function findNewestSessionFile() {
  try {
    const files = (await fsPromises.readdir(SESSIONS_DIR)).filter(f => f.endsWith(".jsonl"));
    if (files.length === 0) return null;
    const stats = await Promise.all(
      files.map(async f => ({ f, mtime: (await fsPromises.stat(path.join(SESSIONS_DIR, f))).mtimeMs }))
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    for (const { f } of stats) {
      const filePath = path.join(SESSIONS_DIR, f);
      const raw = await fsPromises.readFile(filePath, "utf-8").catch(() => "");
      const hasUserMessage = raw.split("\n").some(line => {
        try { return JSON.parse(line)?.message?.role === "user"; } catch { return false; }
      });
      if (hasUserMessage) return filePath;
    }
    return null;
  } catch {
    return null;
  }
}

async function readSessionEntries(filePath) {
  try {
    const raw = await fsPromises.readFile(filePath, "utf-8");
    return raw.trim().split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function extractTextFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === "text").map((b) => b.text || "").join("");
  }
  return "";
}

function addUsage(acc, usage) {
  if (!usage) return acc;
  return {
    input:       (acc.input       ?? 0) + (usage.input       ?? 0),
    output:      (acc.output      ?? 0) + (usage.output      ?? 0),
    cacheRead:   (acc.cacheRead   ?? 0) + (usage.cacheRead   ?? 0),
    cacheWrite:  (acc.cacheWrite  ?? 0) + (usage.cacheWrite  ?? 0),
    totalTokens: (acc.totalTokens ?? 0) + (usage.totalTokens ?? 0),
    cost: {
      input:      (acc.cost?.input      ?? 0) + (usage.cost?.input      ?? 0),
      output:     (acc.cost?.output     ?? 0) + (usage.cost?.output     ?? 0),
      cacheRead:  (acc.cost?.cacheRead  ?? 0) + (usage.cost?.cacheRead  ?? 0),
      cacheWrite: (acc.cost?.cacheWrite ?? 0) + (usage.cost?.cacheWrite ?? 0),
      total:      (acc.cost?.total      ?? 0) + (usage.cost?.total      ?? 0),
    },
  };
}

function extractTurns(entries) {
  const turns = [];
  let current = null;
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
        model: null,
        stopReason: null,
        usage: {},
      };
    } else if (role === "assistant" && current) {
      current.usage = addUsage(current.usage, entry.message.usage);
      if (entry.message.model) current.model = entry.message.model;
      if (entry.message.stopReason) current.stopReason = entry.message.stopReason;

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
      const id = entry.message.toolCallId ?? entry.message.toolUseId ?? null;
      const tc = id ? pendingToolCalls[id] : null;
      if (tc) {
        tc.result = extractTextFromContent(content);
        tc.isError = entry.message.isError ?? false;
        delete pendingToolCalls[id];
      }
    }
  }

  // Only include finalized turns (current is still in-progress — skip it)
  return turns;
}

function finalizeTurn(turn) {
  return {
    ...turn,
    thinking: turn.thinking.join("\n\n"),
    usage: Object.keys(turn.usage).length ? turn.usage : null,
  };
}

function resolveSessionMeta(event, entries) {
  const ctx = event.context ?? {};
  const agentId = ctx.agentId ?? "main";
  const sessionId = ctx.sessionId ?? null;
  const sessionKey = event.sessionKey ?? null;
  const channelFromKey = sessionKey
    ? sessionKey.replace(`agent:${agentId}:`, "").split(":")[0]
    : null;
  const sessionEntry = entries.find((e) => e.type === "session");
  const cwd = sessionEntry?.cwd ?? null;
  return { agentId, sessionId, sessionKey, channel: channelFromKey, cwd };
}

function buildTurnPayload(sessionMeta, turn) {
  return {
    schema: "openclaw-turn-v1",
    extractedAt: new Date().toISOString(),
    session: sessionMeta,
    turn: {
      index: turn.index,
      timestamp: turn.timestamp,
      model: turn.model,
      stopReason: turn.stopReason,
      usage: turn.usage,
      userMessage: turn.userMessage,
      thinking: turn.thinking || null,
      toolCalls: turn.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
        result: tc.result,
        isError: tc.isError,
      })),
      response: turn.response || null,
    },
  };
}

function appendJsonlLine(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(data) + "\n");
}

/** Read the highest turn index already written for a given sessionId. */
function getLastWrittenTurnIndex(sessionId) {
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf-8").trim().split("\n").filter(Boolean);
    let max = -1;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.schema === "openclaw-turn-v1" && obj.session?.sessionId === sessionId) {
          if (obj.turn?.index > max) max = obj.turn.index;
        }
      } catch {}
    }
    return max;
  } catch {
    return -1;
  }
}

export default async function HookHandler(event) {
  const isBootstrap   = event.type === "agent"   && event.action === "bootstrap";
  const isMessageSent = event.type === "message"  && event.action === "sent";
  if (!isBootstrap && !isMessageSent) return;

  let sessionFile;
  let sessionId = null;

  if (isBootstrap) {
    const ctx = event.context ?? {};
    const agentId   = ctx.agentId   ?? "main";
    sessionId       = ctx.sessionId ?? null;
    if (sessionId) {
      sessionFile = resolveSessionFile(agentId, sessionId);
    } else {
      sessionFile = await findNewestSessionFile();
    }
  } else {
    sessionFile = await findNewestSessionFile();
  }

  if (!sessionFile) return;

  const entries = await readSessionEntries(sessionFile);
  if (entries.length === 0) return;

  // Resolve sessionId from file if not already known
  if (!sessionId) {
    const sessionEntry = entries.find(e => e.type === "session");
    sessionId = sessionEntry?.id ?? path.basename(sessionFile, ".jsonl");
  }

  const turns = extractTurns(entries);
  if (turns.length === 0) return;

  const lastWritten = getLastWrittenTurnIndex(sessionId);
  const newTurns = turns.filter(t => t.index > lastWritten);
  if (newTurns.length === 0) return;

  const meta = resolveSessionMeta(event, entries);
  // Ensure sessionId is in meta for dedup to work on next call
  meta.sessionId = meta.sessionId ?? sessionId;

  for (const turn of newTurns) {
    appendJsonlLine(LOG_FILE, buildTurnPayload(meta, turn));
  }
}
