/**
 * abort.js — sends chat.abort RPC to the OpenClaw gateway via WebSocket
 *
 * Uses the local paired device identity (private key + device token) to
 * authenticate with operator.admin scope, then fires chat.abort.
 *
 * Usage:
 *   node abort.js [sessionKey]
 *   node abort.js agent:main:main
 */

import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { sign as cryptoSign, createPrivateKey } from "crypto";

const SESSION_KEY = process.argv[2] ?? "agent:main:main";
const OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");
const DEVICE_FILE = path.join(OPENCLAW_DIR, "identity", "device.json");
const DEVICES_FILE = path.join(OPENCLAW_DIR, "devices", "paired.json");
const GATEWAY_URL = "ws://127.0.0.1:18789";

function loadIdentity() {
  const device = JSON.parse(fs.readFileSync(DEVICE_FILE, "utf8"));
  const paired = JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8"));
  const pairedEntry = paired[device.deviceId];
  const deviceToken = pairedEntry?.tokens?.operator?.token;
  return { ...device, deviceToken };
}

// Payload is a pipe-delimited string: version|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce
function buildPayload({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce }) {
  return ["v2", deviceId, clientId, clientMode, role, scopes.join(","), String(signedAtMs), token ?? "", nonce ?? ""].join("|");
}

function signPayload(privateKeyPem, payloadStr) {
  const keyObj = createPrivateKey(privateKeyPem);
  return cryptoSign(null, Buffer.from(payloadStr, "utf8"), keyObj).toString("base64url");
}

function publicKeyRawBase64Url(pem) {
  // Extract raw 32-byte public key from Ed25519 SPKI DER (last 32 bytes)
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const der = Buffer.from(b64, "base64");
  return der.slice(-32).toString("base64url");
}

async function run() {
  const identity = loadIdentity();
  const ws = new WebSocket(GATEWAY_URL);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timeout")), 10000);

    ws.addEventListener("error", (e) => {
      clearTimeout(timeout);
      reject(new Error(`WS error: ${e.message ?? e}`));
    });

    ws.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve();
    });

    ws.addEventListener("message", (raw) => {
      const frame = JSON.parse(raw.data);

      // Step 1: gateway sends challenge nonce
      if (frame.type === "event" && frame.event === "connect.challenge") {
        const nonce = frame.payload.nonce;
        const signedAtMs = Date.now();
        const scopes = ["operator.admin"];

        const payloadStr = buildPayload({
          deviceId: identity.deviceId,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          scopes,
          signedAtMs,
          token: identity.deviceToken ?? null,
          nonce,
        });

        const signature = signPayload(identity.privateKeyPem, payloadStr);

        ws.send(JSON.stringify({
          type: "req",
          id: randomUUID(),
          method: "connect",
          params: {
            auth: { token: identity.deviceToken },
            minProtocol: 1,
            maxProtocol: 10,
            scopes,
            client: { id: "cli", version: "0.0.1", platform: process.platform, mode: "cli" },
            device: {
              id: identity.deviceId,
              publicKey: publicKeyRawBase64Url(identity.publicKeyPem),
              signature,
              signedAt: signedAtMs,
              nonce,
            },
          },
        }));
        return;
      }

      // Step 2: hello-ok — authenticated, send sessions.reset to abort active run
      if (frame.type === "res" && frame.payload?.type === "hello-ok") {
        process.stderr.write(`[auth] scopes: ${JSON.stringify(frame.payload?.auth?.scopes ?? "none")}\n`);
        // sessions.reset aborts the active embedded run (ACTIVE_EMBEDDED_RUNS path)
        // and also kills any subagents. It resets the session history.
        // Use sessions.delete if you want to fully remove the session.
        ws.send(JSON.stringify({
          type: "req",
          id: randomUUID(),
          method: "sessions.reset",
          params: { key: SESSION_KEY },
        }));
        return;
      }

      // Step 3: abort response
      if (frame.type === "res") {
        console.log(JSON.stringify(frame, null, 2));
        ws.close();
      }
    });
  });
}

run().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
