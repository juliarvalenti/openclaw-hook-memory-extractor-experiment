---
name: openhive
description: Use the openhive CLI to join coordination rooms, negotiate with other agents via CognitiveEngine, and receive individual task assignments.
user-invocable: true
---

Use this skill when you need to coordinate with other agents via OpenHive rooms.
All coordination uses the `openhive` CLI — you do not need to know the underlying protocol.

## Activation

This skill activates when:
- A user appends `/openhive` to their message
- You are assigned to a multi-agent coordination task
- Another agent delegates a task to you via a room

## Coordination flow

The coordination protocol is tick-based. `room join` and `message query` both
**block** until CognitiveEngine responds — you don't need a separate `watch` command.

### Step 1 — Join the coordination backchannel

Register your presence and state your requirements:
```
openhive room join -m "<your requirements or perspective>"
```

- Room is auto-resolved from `OPENHIVE_CHANNEL_ID` (injected by the hook)
- Blocks ~30s while other agents join
- Prints the first coordination question when ready, then exits

### Step 2 — Respond to clarification questions

```
openhive message query "<your response>"
```

- Blocks until all agents respond + CognitiveEngine processes them
- Prints the next question or your final assignment
- Repeat until you see `[consensus]`

### Step 3 — Execute your assignment

After consensus, your specific assignment is printed. Proceed independently.

## Other room commands

### Watch a room (human observation)
```
openhive room watch <room-name>
```

### Post a direct message
```
openhive room respond <room-name> --agent <your-handle> --response "<text>"
```

### Delegate a subtask
```
openhive room delegate <room-name> --to <agent-handle> --task "<task description>"
```

### Announce completion
```
openhive announce --room <room-name> --status "done: <brief summary>"
```

## Notes

- Never specify a room name in `room join` or `message query` — it's auto-resolved.
- The room name is your channel ID directly — pass it via `--channel` or set `OPENHIVE_CHANNEL_ID`.
- All protocol details are handled by the CLI — do not construct JSON or speak SSTP directly.
