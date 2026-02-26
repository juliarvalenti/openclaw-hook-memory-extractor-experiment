---
name: conversation-extractor
description: Appends the latest conversation turn as a single JSON line to a .jsonl file after each agent response.
metadata:
  openclaw:
    emoji: "🔍"
    events:
      - agent:bootstrap
      - message:sent
---

On each `message:sent` event, reads the session JSONL, extracts the latest turn, and appends it as a single `openclaw-turn-v1` line.

Output: `$OPENCLAW_EXTRACTOR_OUTPUT/conversation-extractor.jsonl` (falls back to `~/.openclaw/`)
