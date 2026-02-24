---
name: conversation-extractor
description: Extracts structured conversation payloads from session JSONL files for memory and analytics ingestion.
metadata:
  openclaw:
    emoji: "🔍"
    events:
      - agent:bootstrap
      - command:new
---

Reads the session JSONL at bootstrap time and emits a structured `openclaw-conversation-v1` payload.

Output: `~/.openclaw/conversation-extractor.log`
