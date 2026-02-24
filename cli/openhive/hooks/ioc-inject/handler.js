/**
 * ioc-inject/handler.js
 *
 * OpenHive IOC hook for OpenClaw.
 * Injects multi-agent coordination instructions into every agent turn via bootstrapFiles.
 *
 * Installed by: openhive agent configure <framework>
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const instructions = fs.readFileSync(
  path.join(__dirname, "IOC_INSTRUCTIONS.md"),
  "utf8"
);

export default async function HookHandler(event) {
  if (event.type !== "agent" || event.action !== "bootstrap") return;

  const ctx = event.context;
  ctx.bootstrapFiles = ctx.bootstrapFiles ?? [];
  ctx.bootstrapFiles.push({
    name: "IOC_INSTRUCTIONS",
    path: "IOC_INSTRUCTIONS.md",
    content: instructions,
    missing: false,
  });
}
