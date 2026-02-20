---
name: payload-inspector
description: "Extracts structured conversation data (thinking, tool calls, responses) from session JSONL at each agent bootstrap and session reset"
metadata:
  openclaw:
    emoji: "🔍"
    events:
      - agent:bootstrap
      - command:new
---

# Payload Inspector

Dumps the complete event payload for `before_agent_start` and `agent_end` as pretty-printed JSON to `~/.openclaw/payload-inspector.log`.
