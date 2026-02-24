---
name: sstp
description: Structured Semantic Turn Protocol — inter-agent communication schema for coordinated multi-agent sessions.
user-invocable: false
---

You communicate using the Structured Semantic Turn Protocol (SSTP). Every message you send must be a single valid JSON object conforming to one of the message kinds below. No prose, no markdown, no wrapping.

## Turn discipline

- **One agent speaks at a time.** After you send a message, wait for a response before sending another.
- **Only send when you have something to contribute.** Do not acknowledge, echo, or confirm receipt.
- **`directed_to` means only that agent should respond.** All others stay silent until addressed.

## Message kinds

### `intent` — Declare a goal or frame the session
```json
{
  "header": {
    "kind": "intent",
    "actor_id": "<your-agent-id>",
    "schema_id": "ioc.intent.v0",
    "session_id": "<session>",
    "policy_labels": [],
    "logical_clock": 1
  },
  "payload": {
    "goal": "<what you are trying to achieve>",
    "assumptions": [],
    "success_criteria": "<measurable outcome>",
    "constraints": []
  }
}
```

### `query` — Ask a specific agent for information
```json
{
  "header": {
    "kind": "query",
    "actor_id": "<your-agent-id>",
    "schema_id": "ioc.query.v0",
    "session_id": "<session>",
    "logical_clock": 2
  },
  "payload": {
    "question": "<specific question>",
    "required_fields": [],
    "uncertainty": 0.5,
    "directed_to": "<target-agent-id>"
  }
}
```

### `knowledge` — Share a finding or answer a query
```json
{
  "header": {
    "kind": "knowledge",
    "actor_id": "<your-agent-id>",
    "schema_id": "ioc.knowledge.v0",
    "provenance": "<tool or source used>",
    "logical_clock": 3
  },
  "payload": {
    "content": "<your finding>",
    "confidence": 0.9,
    "evidence_refs": []
  }
}
```

### `delegation` — Assign a task to another agent
```json
{
  "header": {
    "kind": "delegation",
    "actor_id": "<your-agent-id>",
    "schema_id": "ioc.delegation.v0",
    "session_id": "<session>",
    "logical_clock": 4
  },
  "payload": {
    "task": "<what to do>",
    "assigned_to": "<target-agent-id>",
    "required_capabilities": [],
    "output_schema_id": "ioc.result.v0",
    "evaluation_criteria": "<how to judge success>"
  }
}
```

### `commit` — Record a decision
```json
{
  "header": {
    "kind": "commit",
    "actor_id": "<your-agent-id>",
    "schema_id": "ioc.commit.v0",
    "session_id": "<session>",
    "logical_clock": 5,
    "risk_score": 0.3
  },
  "payload": {
    "decision": "<what was decided>",
    "scope": "<what it affects>",
    "commit_mode": "unilateral",
    "supersedes": null
  }
}
```

### `evidence_bundle` — Provide verifiable proof for a claim
```json
{
  "header": {
    "kind": "evidence_bundle",
    "actor_id": "<your-agent-id>",
    "schema_id": "ioc.evidence.v0",
    "logical_clock": 6
  },
  "payload": {
    "claim": "<what you are proving>",
    "artifacts": [
      { "type": "fact", "name": "<name>", "value": "<value>" }
    ],
    "verdict": "pass",
    "checks_run": []
  }
}
```

### `memory_delta` — Emit a learning for long-term retention
```json
{
  "header": {
    "kind": "memory_delta",
    "actor_id": "<your-agent-id>",
    "schema_id": "ioc.memory_delta.v0",
    "policy_labels": ["retention:90d"],
    "logical_clock": 7
  },
  "payload": {
    "memory_type": "episodic",
    "summary": "<what happened>",
    "derived_rule": "<rule to remember>",
    "propagation": "domain-wide"
  }
}
```

## Rules

- Set `actor_id` to your agent name.
- Increment `logical_clock` by 1 on each message you send within a session.
- Use `session_id` consistently across all messages in the same task.
- Output raw JSON only. Never wrap in code fences.
