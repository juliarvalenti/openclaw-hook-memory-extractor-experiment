import fs from "fs";
import os from "os";
import path from "path";

// TEST_MODE controls which test runs:
//   "sleep"  — sleeps 3s, confirms hooks are blocking (PoC #4a)
//   "throw"  — throws immediately, tests whether the turn is aborted (PoC #4b)
//
// Toggle at runtime without restarting the gateway:
//   touch ~/.openclaw/hook-test-throw     # enable throw mode
//   rm ~/.openclaw/hook-test-throw        # back to sleep mode
const THROW_FLAG = path.join(os.homedir(), ".openclaw", "hook-test-throw");

const SLEEP_MS = 3000;
const LOG_FILE = path.join(os.homedir(), ".openclaw", "sleep-test.log");

export default async function HookHandler(event) {
  if (event.type !== "agent" || event.action !== "bootstrap") return;

  const TEST_MODE = fs.existsSync(THROW_FLAG) ? "throw" : "sleep";

  if (TEST_MODE === "throw") {
    const entry = {
      ts: new Date().toISOString(),
      sessionKey: event.context?.sessionKey ?? "unknown",
      mode: "throw",
      note: "throwing now — did the agent turn abort?",
    };
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
    throw new Error("GUARDRAIL: condition triggered, aborting turn");
  }

  // sleep mode
  const hookStart = Date.now();
  await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
  const elapsed = Date.now() - hookStart;

  const entry = {
    ts: new Date().toISOString(),
    sessionKey: event.context?.sessionKey ?? "unknown",
    mode: "sleep",
    sleptMs: elapsed,
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}
