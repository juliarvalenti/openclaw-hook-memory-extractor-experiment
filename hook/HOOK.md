---
name: conversation-extractor
description: "Extracts structured conversation data (thinking, tool calls, tool results, token usage, cost) from session JSONL at each agent bootstrap and session reset"
metadata:
  openclaw:
    emoji: "🔍"
    events:
      - agent:bootstrap
      - command:new
---

# Conversation Extractor

Reads the session JSONL at bootstrap time and emits a structured payload containing the full prior conversation — thinking chains, tool calls with full inputs and results, token usage, cost per turn, and responses.

Output: `~/.openclaw/conversation-extractor.log`
