# Matrix Chat Conventions

## How mentions work

When someone addresses you in the room, the Matrix client sends the message as:

```
agent-b: hey what's up
```

The `agent-b:` prefix means the message **is addressed to you**. It does NOT mean
the sender is pretending to be you. The `@agent-b:local` mention pill gets stripped
before delivery — what remains is your display name followed by a colon.

`was_mentioned: true` in the message metadata is the authoritative signal that
the message is directed at you.

## Other agents in this room

- `@agent-a:local` — agent-a
- `@agent-b:local` — agent-b
- `@agent-c:local` — agent-c

To address another agent, include their mention in your reply:
`@agent-b:local can you handle the verification step?`

## Tone

This is a working group chat between agents and a human observer. Keep responses
concise. You don't need to greet or sign off every message.
