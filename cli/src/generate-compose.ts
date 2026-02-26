#!/usr/bin/env tsx
/**
 * generate-compose.ts
 *
 * Reads an experiment directory and emits a docker-compose.yml to stdout.
 *
 * Usage:
 *   npx tsx src/generate-compose.ts <experiment-dir> <run-dir> <room-alias>
 *
 * Also:
 *   - Writes MATRIX.md into each agent's workspace (room roster + conventions)
 *   - Patches each agent's openclaw.json to use the correct room alias
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { execSync } from "child_process";
import type { ComposeFile, ComposeService } from "./types.js";

const BASE_PORT = 18800;
const MATRIX_NETWORK = "openclaw-matrix";
const MATRIX_HOST = "http://openclaw-matrix:8008";

// ── Args ──────────────────────────────────────────────────────────────────────

const [, , experimentDir, runDir, roomAlias, runId] = process.argv;

if (!experimentDir || !runDir || !roomAlias || !runId) {
  console.error("Usage: generate-compose.ts <experiment-dir> <run-dir> <room-alias> <run-id>");
  process.exit(1);
}

const agentsDir = path.resolve(experimentDir, "agents");

if (!fs.existsSync(agentsDir)) {
  console.error(`No agents/ directory found in ${experimentDir}`);
  process.exit(1);
}

const agentNames: string[] = fs
  .readdirSync(agentsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

if (agentNames.length === 0) {
  console.error(`No agent directories found in ${agentsDir}`);
  process.exit(1);
}

// ── MATRIX.md — write into each agent workspace ───────────────────────────────

// User IDs are scoped to the run to avoid conflicts across parallel experiments
const userId = (name: string) => `@${name}-${runId}:local`;
const rosterLines = agentNames.map((n) => `- \`${userId(n)}\` — ${n}`).join("\n");

for (const name of agentNames) {
  const wsDir = path.join(experimentDir, "agents", name, "workspace");
  fs.mkdirSync(wsDir, { recursive: true });

  const content = `# Matrix Chat Conventions

## How mentions work

When someone addresses you in the room, the message arrives prefixed with your name:

\`\`\`
${name}: <message text>
\`\`\`

\`was_mentioned: true\` in message metadata is the authoritative signal that the
message is directed at you.

## Agents in this room

${rosterLines}

To address another agent you **must** use the full \`@user:server\` format —
the \`:local\` suffix is required or the mention won't be detected.

✅ Correct: \`@other-agent-${runId}:local can you handle the next step?\`
❌ Wrong:   \`@other-agent:local can you handle the next step?\`
❌ Wrong:   \`@other-agent can you handle the next step?\`

## Room

This experiment's room: \`${roomAlias}\`

## Tone

Working group chat. Keep responses concise. No greetings or sign-offs needed.
`;

  fs.writeFileSync(path.join(wsDir, "MATRIX.md"), content);
}

// ── Patch each agent's openclaw.json with the correct room alias ──────────────
// The template uses "#agents:local" as a placeholder. Replace it with the
// actual room for this experiment so agents join the right room.

const PLACEHOLDER_ROOM = "#agents:local";

for (const name of agentNames) {
  const configPath = path.join(experimentDir, "agents", name, "openclaw.json");
  if (!fs.existsSync(configPath)) continue;

  const raw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(raw) as {
    channels?: {
      matrix?: {
        groups?: Record<string, unknown>;
      };
    };
  };

  const groups = config.channels?.matrix?.groups;
  if (!groups) continue;

  // If the room key is already correct, skip
  if (groups[roomAlias] !== undefined) continue;

  // Replace placeholder key with actual room alias, preserving settings
  const oldKey = groups[PLACEHOLDER_ROOM] !== undefined ? PLACEHOLDER_ROOM : Object.keys(groups)[0];
  if (!oldKey) continue;

  const settings = groups[oldKey];
  delete groups[oldKey];
  groups[roomAlias] = settings;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

// ── Env var helpers ───────────────────────────────────────────────────────────

/** AGENT_MY_AGENT_NAME_TOKEN — uppercased, hyphens → underscores */
function tokenVar(agentName: string): string {
  return `AGENT_${agentName.toUpperCase().replace(/-/g, "_")}_TOKEN`;
}

function passwordVar(agentName: string): string {
  return `AGENT_${agentName.toUpperCase().replace(/-/g, "_")}_MATRIX_PASSWORD`;
}

// ── Port allocation ───────────────────────────────────────────────────────────
// Find the next free port block by checking what's already bound on the host.
// This prevents collisions when multiple experiments run simultaneously.

function findNextAvailablePort(): number {
  try {
    const output = execSync('docker ps --format "{{.Ports}}"', { encoding: "utf8" });
    let maxUsed = BASE_PORT - 1;
    for (const match of output.matchAll(/:(\d+)->/g)) {
      const port = parseInt(match[1], 10);
      if (port >= BASE_PORT && port > maxUsed) maxUsed = port;
    }
    return maxUsed + 1;
  } catch {
    return BASE_PORT;
  }
}

const startPort = findNextAvailablePort();

// ── Build compose object ──────────────────────────────────────────────────────

const agentServices: Record<string, ComposeService> = {};

agentNames.forEach((name, i) => {
  const port = startPort + i;

  agentServices[name] = {
    build: {
      context: ".",
      dockerfile: "${OPENCLAW_DOCKERFILE:-Dockerfile}",
    },
    image: "${OPENCLAW_IMAGE:-openclaw-agents:local}",
    environment: {
      HOME: "/home/node",
      // LLM provider key — set whichever is active; others are no-ops if unset
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY:-}",
      OPENAI_API_KEY: "${OPENAI_API_KEY:-}",
      GEMINI_API_KEY: "${GEMINI_API_KEY:-}",
      OPENROUTER_API_KEY: "${OPENROUTER_API_KEY:-}",
      // Bedrock / custom endpoint
      ANTHROPIC_BASE_URL: "${ANTHROPIC_BASE_URL:-}",
      AWS_ACCESS_KEY_ID: "${AWS_ACCESS_KEY_ID:-}",
      AWS_SECRET_ACCESS_KEY: "${AWS_SECRET_ACCESS_KEY:-}",
      AWS_REGION: "${AWS_REGION:-}",
      AWS_SESSION_TOKEN: "${AWS_SESSION_TOKEN:-}",
      // Gateway + Matrix
      OPENCLAW_GATEWAY_TOKEN: `\${${tokenVar(name)}:?${tokenVar(name)} is required}`,
      MATRIX_HOMESERVER: MATRIX_HOST,
      MATRIX_USER_ID: userId(name),
      MATRIX_PASSWORD: `\${${passwordVar(name)}:?${passwordVar(name)} is required}`,
      OPENCLAW_EXTRACTOR_OUTPUT: "/logs",
    },
    volumes: [
      `${experimentDir}/agents/${name}:/home/node/.openclaw`,
      `${runDir}/logs/${name}:/logs`,
    ],
    ports: [`${port}:18789`],
    networks: [MATRIX_NETWORK],
    command: ["node", "dist/index.js", "gateway", "--bind", "lan"],
  };
});

const compose: ComposeFile = {
  services: agentServices,
  networks: {
    [MATRIX_NETWORK]: {
      external: true,
      name: MATRIX_NETWORK,
    },
  },
};

// ── Emit ──────────────────────────────────────────────────────────────────────

const experimentName = path.basename(experimentDir);
const runName = path.basename(runDir);

const header = [
  `# Auto-generated by generate-compose.ts — do not edit by hand.`,
  `# Experiment: ${experimentName}`,
  `# Run:        ${runName}`,
  `# Room:       ${roomAlias}`,
  `#`,
  `# Regenerate: npx tsx cli/src/generate-compose.ts <experiment-dir> <run-dir> <room-alias> <run-id>`,
  ``,
].join("\n");

process.stdout.write(header + yaml.dump(compose, { lineWidth: -1, noRefs: true }));
