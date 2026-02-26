---
name: session-start
description: Appends a session-start marker to the conversation JSONL when an agent bootstraps.
metadata:
  openclaw:
    emoji: "🟢"
    events:
      - agent:bootstrap
---

On `agent:bootstrap`, records a `openclaw-session-start-v1` line into the shared conversation JSONL.

Output: `$OPENCLAW_EXTRACTOR_OUTPUT/conversation-extractor.jsonl` (falls back to `~/.openclaw/`)
