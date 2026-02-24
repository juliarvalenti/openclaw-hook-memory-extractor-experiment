---
name: conversation-extractor
description: Extracts structured conversation payloads from session JSONL files for memory and analytics ingestion.
metadata:
  openclaw:
    emoji: "🔍"
    events:
      - agent:bootstrap
      - message:sent
---

Reads the session JSONL after each agent response and emits a structured `openclaw-conversation-v1` payload.

Output: `$OPENCLAW_EXTRACTOR_OUTPUT/conversation-extractor.log` (falls back to `~/.openclaw/`)
