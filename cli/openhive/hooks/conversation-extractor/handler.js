/**
 * conversation-extractor/handler.js
 *
 * Reads the session JSONL after each agent response and emits a structured
 * conversation payload for ingestion into a memory/analytics service.
 *
 * Output: $OPENCLAW_EXTRACTOR_OUTPUT/conversation-extractor.log
 *         (falls back to ~/.openclaw/conversation-extractor.log)
 *
 * Hook events: agent:bootstrap, message:sent
 *
 * Installed by: openhive agent configure <framework>
 */

import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import os from "os";

// Write to /logs if OPENCLAW_EXTRACTOR_OUTPUT is set (Docker mount), else ~/.openclaw
const OUTPUT_DIR   = process.env.OPENCLAW_EXTRACTOR_OUTPUT ?? path.join(os.homedir(), ".openclaw");
const LOG_FILE     = path.join(OUTPUT_DIR, "conversation-extractor.log");

const STATE_DIR    = path.join(os.homedir(), ".openclaw");
const SESSIONS_DIR = path.join(STATE_DIR, "agents", "main", "sessions");

function resolveSessionFile(agentId, sessionId) {
  return path.join(STATE_DIR, "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

/** On message:sent we don't get agentId/sessionId — find the newest session file. */
async function findNewestSessionFile() {
  try {
    const files = (await fsPromises.readdir(SESSIONS_DIR)).filter(f => f.endsWith(".jsonl"));
    if (files.length === 0) return null;
    const stats = await Promise.all(
      files.map(async f => ({ f, mtime: (await fsPromises.stat(path.join(SESSIONS_DIR, f))).mtimeMs }))
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    return path.join(SESSIONS_DIR, stats[0].f);
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

  if (current) turns.push(finalizeTurn(current));
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

function buildPayload(sessionMeta, turns, entries) {
  const totalCost = turns.reduce((sum, t) => sum + (t.usage?.cost?.total ?? 0), 0);
  return {
    schema: "openclaw-conversation-v1",
    extractedAt: new Date().toISOString(),
    session: sessionMeta,
    stats: {
      totalEntries: entries.length,
      turns: turns.length,
      toolCallCount: turns.reduce((n, t) => n + t.toolCalls.length, 0),
      thinkingTurnCount: turns.filter((t) => t.thinking.length > 0).length,
      totalCost,
    },
    turns: turns.map((t) => ({
      index: t.index,
      timestamp: t.timestamp,
      model: t.model,
      stopReason: t.stopReason,
      usage: t.usage,
      userMessage: t.userMessage,
      thinking: t.thinking || null,
      toolCalls: t.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
        result: tc.result,
        isError: tc.isError,
      })),
      response: t.response || null,
    })),
  };
}

function appendLog(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sep = "\n" + "=".repeat(80) + "\n";
  fs.appendFileSync(filePath, sep + JSON.stringify(data, null, 2) + "\n");
}

export default async function HookHandler(event) {
  const isBootstrap   = event.type === "agent"   && event.action === "bootstrap";
  const isMessageSent = event.type === "message"  && event.action === "sent";
  if (!isBootstrap && !isMessageSent) return;

  let sessionFile;

  if (isBootstrap) {
    const ctx       = event.context ?? {};
    const agentId   = ctx.agentId  ?? "main";
    const sessionId = ctx.sessionId ?? null;
    if (!sessionId) return;
    sessionFile = resolveSessionFile(agentId, sessionId);
  } else {
    // message:sent — no agentId/sessionId in context, find the newest session file
    sessionFile = await findNewestSessionFile();
    if (!sessionFile) return;
  }

  const entries = await readSessionEntries(sessionFile);
  if (entries.length === 0) return;

  const turns = extractTurns(entries);
  if (turns.length === 0) return;

  const meta    = resolveSessionMeta(event, entries);
  const payload = buildPayload(meta, turns, entries);
  appendLog(LOG_FILE, payload);
}
