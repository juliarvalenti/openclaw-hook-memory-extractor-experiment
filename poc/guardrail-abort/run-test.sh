#!/usr/bin/env bash
# run-test.sh — PoC #5: Can the daemon abort an in-flight agent turn via chat.abort RPC?
#
# What this tests:
#   1. Start a long agent task in the background
#   2. Wait 2 seconds (turn is in flight)
#   3. Fire chat.abort via WebSocket RPC
#   4. Report whether the turn was aborted or completed normally
#
# Expected result if abort works:
#   - Agent response JSON shows "aborted": true
#   - chat.abort RPC returns { ok: true, aborted: true, runIds: [...] }
#
# Run from repo root:
#   bash poc/guardrail-abort/run-test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULT_FILE="/tmp/poc-abort-result.json"

echo "=== PoC #5: Guardrail / flow interruption ==="
echo ""
echo "Starting long agent task in background..."

# Use a task long enough that we can abort it mid-flight
openclaw agent \
  --agent main \
  --message "Run the shell command 'sleep 30' and then tell me what time it is." \
  --json > "$RESULT_FILE" 2>&1 &

AGENT_PID=$!

echo "Agent PID: $AGENT_PID"
echo "Waiting 3 seconds for turn to start..."
sleep 3

echo ""
echo "Firing chat.abort RPC..."
node "$SCRIPT_DIR/abort.js" agent:main:main

echo ""
echo "Waiting for agent task to finish..."
wait $AGENT_PID || true

echo ""
echo "=== Agent task result ==="
cat "$RESULT_FILE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    meta = d.get('result', {}).get('meta', {})
    payloads = d.get('result', {}).get('payloads', [])
    print('status:  ', d.get('status'))
    print('aborted: ', meta.get('aborted'))
    print('text:    ', (payloads[0].get('text', '') if payloads else '(none)')[:120])
except Exception as e:
    print('raw output:', open('/tmp/poc-abort-result.json').read()[:500])
"
