#!/usr/bin/env tsx
/**
 * server.ts
 *
 * REST API mirroring the experiment CLI.
 * Spawned by: experiment server [--port 7777]
 *
 * Routes:
 *   GET  /health
 *   POST /matrix/start
 *   POST /matrix/stop
 *   GET  /matrix/status
 *   GET  /experiments
 *   POST /experiments                      body: { name, agents?: string[] }
 *   GET  /experiments/:name/status
 *   POST /experiments/:name/run            body: { timeout?: string }
 *   POST /experiments/:name/stop
 *   GET  /experiments/:name/logs           ?agent=<name>
 *   GET  /experiments/:name/logs           ?agent=<name>&follow=true  (SSE)
 *   GET  /experiments/:name/messages       ?limit=20
 *   GET  /experiments/:name/watch          (SSE)
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import type { IncomingMessage, ServerResponse } from "http";
import { watchRoom } from "./matrix-client.js";

const SWAGGER_DIST = path.resolve(process.cwd(), "node_modules/swagger-ui-dist");

// ── Config ────────────────────────────────────────────────────────────────────

const EXPERIMENT_SCRIPT = process.env.EXPERIMENT_SCRIPT;
const EXPERIMENTS_DIR = process.env.EXPERIMENTS_DIR;
const PORT = parseInt(process.argv[2] ?? "8181", 10);

if (!EXPERIMENT_SCRIPT || !EXPERIMENTS_DIR) {
  console.error("EXPERIMENT_SCRIPT and EXPERIMENTS_DIR env vars are required.");
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type Params = Record<string, string>;
type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Params,
  query: URLSearchParams,
) => Promise<void>;

function respond(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(json);
}

function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
  });
}

function runCmd(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = cp.spawn(EXPERIMENT_SCRIPT!, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    proc.stdout!.on("data", (d) => (stdout += d));
    proc.stderr!.on("data", (d) => (stderr += d));
    proc.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 }));
  });
}

function cmdRespond(res: ServerResponse, result: { stdout: string; stderr: string; code: number }): void {
  respond(res, result.code === 0 ? 200 : 500, {
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function latestRunDir(expDir: string): string | null {
  const runsDir = path.join(expDir, "runs");
  if (!fs.existsSync(runsDir)) return null;
  const runs = fs.readdirSync(runsDir).sort();
  return runs.length > 0 ? path.join(runsDir, runs[runs.length - 1]) : null;
}

// ── Router ────────────────────────────────────────────────────────────────────

const routes: Array<{ method: string; re: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, pattern: string, handler: Handler): void {
  const keys: string[] = [];
  const re = new RegExp(
    "^" + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$",
  );
  routes.push({ method, re, keys, handler });
}

// ── OpenAPI spec ──────────────────────────────────────────────────────────────

const OPENAPI_SPEC = {
  openapi: "3.0.0",
  info: { title: "Experiment API", version: "1.0.0", description: "REST interface for the OpenClaw experiment CLI." },
  servers: [{ url: "" }],
  paths: {
    "/health": {
      get: { summary: "Health check", responses: { "200": { description: "OK" } } },
    },
    "/matrix/start": {
      post: { summary: "Start Matrix server", responses: { "200": { description: "Started" } } },
    },
    "/matrix/stop": {
      post: { summary: "Stop Matrix server", responses: { "200": { description: "Stopped" } } },
    },
    "/matrix/status": {
      get: { summary: "Matrix server status", responses: { "200": { description: "Status output" } } },
    },
    "/experiments": {
      get: { summary: "List all experiments", responses: { "200": { description: "Experiment list" } } },
      post: {
        summary: "Create a new experiment",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["name"], properties: {
            name: { type: "string", example: "trip-planner" },
            agents: { type: "array", items: { type: "string" }, example: ["planner", "researcher"] },
          } } } },
        },
        responses: { "200": { description: "Created" } },
      },
    },
    "/experiments/{name}/status": {
      get: {
        summary: "Active run status",
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Status output" } },
      },
    },
    "/experiments/{name}/run": {
      post: {
        summary: "Start a run",
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: {
            timeout: { type: "string", example: "5m", description: "Auto-stop after this duration (default: 5m)" },
          } } } },
        },
        responses: { "200": { description: "Run started" } },
      },
    },
    "/experiments/{name}/stop": {
      post: {
        summary: "Stop the active run",
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Stopped" } },
      },
    },
    "/experiments/{name}/logs": {
      get: {
        summary: "Get run logs",
        parameters: [
          { name: "name", in: "path", required: true, schema: { type: "string" } },
          { name: "agent", in: "query", schema: { type: "string" }, description: "Scope to a specific agent" },
          { name: "follow", in: "query", schema: { type: "boolean" }, description: "SSE stream (tail -f)" },
        ],
        responses: { "200": { description: "Log output or SSE stream" } },
      },
    },
    "/experiments/{name}/messages": {
      get: {
        summary: "Recent Matrix room messages",
        parameters: [
          { name: "name", in: "path", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
        ],
        responses: { "200": { description: "Messages" } },
      },
    },
    "/experiments/{name}/watch": {
      get: {
        summary: "Live Matrix room stream (SSE)",
        description: "Server-Sent Events. Each event: `data: {sender, body, timestamp}`",
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "SSE stream", content: { "text/event-stream": {} } } },
      },
    },
  },
};

const SWAGGER_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Experiment API</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/swagger-ui/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="/swagger-ui/swagger-ui-bundle.js"></script>
<script>
  SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger-ui", presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset] });
</script>
</body>
</html>`;

// ── Routes ────────────────────────────────────────────────────────────────────

route("GET", "/", async (_, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(SWAGGER_HTML);
});

route("GET", "/openapi.json", async (_, res) => {
  respond(res, 200, OPENAPI_SPEC);
});

route("GET", "/health", async (_, res) => {
  respond(res, 200, { ok: true });
});

route("POST", "/matrix/start", async (_, res) => {
  cmdRespond(res, await runCmd(["matrix", "start"]));
});

route("POST", "/matrix/stop", async (_, res) => {
  cmdRespond(res, await runCmd(["matrix", "stop"]));
});

route("GET", "/matrix/status", async (_, res) => {
  cmdRespond(res, await runCmd(["matrix", "status"]));
});

route("GET", "/experiments", async (_, res) => {
  cmdRespond(res, await runCmd(["list"]));
});

route("POST", "/experiments", async (req, res) => {
  const body = await readBody(req) as { name: string; agents?: string[] };
  if (!body.name) { respond(res, 400, { error: "name is required" }); return; }
  cmdRespond(res, await runCmd(["create", body.name, ...(body.agents ?? [])]));
});

route("GET", "/experiments/:name/status", async (_, res, { name }) => {
  cmdRespond(res, await runCmd(["status", name]));
});

route("POST", "/experiments/:name/run", async (req, res, { name }) => {
  const body = await readBody(req) as { timeout?: string };
  const args = ["run", name, ...(body.timeout ? ["--timeout", body.timeout] : [])];
  cmdRespond(res, await runCmd(args));
});

route("POST", "/experiments/:name/stop", async (_, res, { name }) => {
  cmdRespond(res, await runCmd(["stop", name]));
});

route("GET", "/experiments/:name/messages", async (_, res, { name }, query) => {
  const limit = query.get("limit") ?? "20";
  cmdRespond(res, await runCmd(["messages", name, limit]));
});

route("GET", "/experiments/:name/logs", async (req, res, { name }, query) => {
  const agent = query.get("agent") ?? "";
  const follow = query.get("follow") === "true";

  if (follow) {
    const expDir = path.join(EXPERIMENTS_DIR!, name);
    const runDir = latestRunDir(expDir);
    if (!runDir) { respond(res, 404, { error: "No runs found" }); return; }

    const logDir = agent ? path.join(runDir, "logs", agent) : null;
    if (agent && logDir && !fs.existsSync(logDir)) {
      respond(res, 404, { error: `No log dir for agent '${agent}'` });
      return;
    }

    const dir = logDir ?? path.join(runDir, "logs");
    const files = logDir
      ? fs.readdirSync(logDir).map((f) => path.join(logDir!, f))
      : fs.readdirSync(dir)
          .flatMap((a) => {
            const d = path.join(dir, a);
            return fs.statSync(d).isDirectory()
              ? fs.readdirSync(d).map((f) => path.join(d, f))
              : [];
          });

    sseHeaders(res);
    if (files.length === 0) { res.write("data: (no log files yet)\n\n"); res.end(); return; }

    const proc = cp.spawn("tail", ["-f", ...files]);
    proc.stdout!.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) res.write(`data: ${line}\n\n`);
      }
    });
    req.on("close", () => proc.kill());
    return;
  }

  const args = agent ? ["logs", name, agent] : ["logs", name];
  cmdRespond(res, await runCmd(args));
});

route("GET", "/experiments/:name/watch", async (req, res, { name }) => {
  const expDir = path.join(EXPERIMENTS_DIR!, name);
  const runDir = latestRunDir(expDir);
  if (!runDir) { respond(res, 404, { error: "No active run found" }); return; }

  const envContent = fs.readFileSync(path.join(runDir, ".env"), "utf8");
  const password = envContent.match(/OBSERVER_MATRIX_PASSWORD=(.+)/)?.[1]?.trim();
  if (!password) { respond(res, 500, { error: "Could not read observer password" }); return; }

  const runName = path.basename(runDir);
  const roomAlias = `#${name}-${runName}:local`;

  sseHeaders(res);
  res.write(`data: ${JSON.stringify({ type: "connected", room: roomAlias })}\n\n`);

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  try {
    await watchRoom("http://localhost:8008", password, roomAlias, (ev) => {
      const payload = { sender: ev.sender, body: ev.content.body, timestamp: ev.origin_server_ts };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }, ac.signal);
  } catch (err) {
    if (!ac.signal.aborted) console.error("Watch error:", err);
  }
});

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Allow-Headers": "*" });
    res.end();
    return;
  }

  for (const r of routes) {
    if (r.method !== method) continue;
    const match = r.re.exec(url.pathname);
    if (!match) continue;
    const params: Params = {};
    r.keys.forEach((k, i) => (params[k] = match[i + 1]));
    try {
      await r.handler(req, res, params, url.searchParams);
    } catch (err) {
      if (!res.headersSent) respond(res, 500, { error: String(err) });
    }
    return;
  }

  // Static Swagger UI assets
  if (method === "GET" && url.pathname.startsWith("/swagger-ui/")) {
    const file = url.pathname.replace("/swagger-ui/", "");
    const filePath = path.join(SWAGGER_DIST, file);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(file);
      const mime = ext === ".css" ? "text/css" : ext === ".js" ? "application/javascript" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  respond(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Experiment API listening on http://0.0.0.0:${PORT}`);
});
