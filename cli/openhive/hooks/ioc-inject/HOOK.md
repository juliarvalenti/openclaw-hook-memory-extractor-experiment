---
name: ioc-inject
description: Injects OpenHive multi-agent coordination instructions into every agent turn via bootstrapFiles.
metadata:
  openclaw:
    emoji: "🐝"
    events:
      - agent:bootstrap
---

Injects `IOC_INSTRUCTIONS.md` into the agent system prompt on every turn via `context.bootstrapFiles`.
