# HiveMind Agent Connector Pattern

A connector abstracts the invocation of an autonomous agent so the daemon can
trigger _n_ different agent runtime types through a single interface.
OpenClaw is the first implementation.

---

## The Problem

HiveMind's daemon needs to trigger agents at runtime — on schedule, on
`@mention`, or on coordinator instruction. The agent runtime could be:

- An OpenClaw gateway (current)
- A custom agent (Vercel AI SDK, LangChain, etc.)
- A remote CFN-managed agent
- A future runtime we haven't built yet

Without an abstraction, every new runtime requires changes to the daemon core.
With connectors, the daemon only knows about the interface.

---

## Connector Interface

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional


@dataclass
class AgentResponse:
    text: str
    session_id: str
    run_id: Optional[str] = None
    model: Optional[str] = None
    usage: Optional[dict] = None
    raw: Optional[dict] = None  # full connector-specific payload


class AgentConnector(ABC):
    """
    One connector instance per agent registration.
    Connectors are stateless — session continuity is managed via session_id.
    """

    @abstractmethod
    def trigger(
        self,
        message: str,
        session_id: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> AgentResponse:
        """
        Send a message to the agent and return its response.

        Args:
            message:    The prompt or task body.
            session_id: If provided, continue an existing session.
                        If None, the connector starts a new session.
            agent_id:   Connector-specific agent identifier override.
                        Falls back to the connector's configured default.

        Returns:
            AgentResponse with at minimum `text` and `session_id`.
            `session_id` MUST be returned even for new sessions — the daemon
            stores it on the AutonomousAgent record for future calls.
        """
        ...

    @abstractmethod
    def health_check(self) -> bool:
        """Return True if the underlying runtime is reachable."""
        ...
```

---

## OpenClaw Connector

Invokes the OpenClaw gateway via the CLI. No HTTP client, no SDK dependency —
just a subprocess call to `openclaw agent`.

```python
import json
import subprocess
from typing import Optional


class OpenClawConnector(AgentConnector):
    """
    Triggers an OpenClaw agent via: openclaw agent --agent <id> --message <text> --json

    Requires:
    - openclaw CLI installed and on PATH
    - OpenClaw gateway running (openclaw gateway)
    """

    def __init__(
        self,
        agent_name: str = "main",
        openclaw_bin: str = "openclaw",
        timeout_seconds: int = 600,
    ):
        self.agent_name = agent_name
        self.openclaw_bin = openclaw_bin
        self.timeout_seconds = timeout_seconds

    def trigger(
        self,
        message: str,
        session_id: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> AgentResponse:
        cmd = [
            self.openclaw_bin,
            "agent",
            "--agent", agent_id or self.agent_name,
            "--message", message,
            "--json",
            "--timeout", str(self.timeout_seconds),
        ]

        if session_id:
            cmd += ["--session-id", session_id]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=self.timeout_seconds + 10,  # outer timeout > inner
        )

        if result.returncode != 0:
            raise RuntimeError(
                f"OpenClaw agent failed (exit {result.returncode}): {result.stderr}"
            )

        data = json.loads(result.stdout)

        payloads = data.get("result", {}).get("payloads", [])
        text = payloads[0].get("text", "") if payloads else ""

        agent_meta = data.get("result", {}).get("meta", {}).get("agentMeta", {})

        return AgentResponse(
            text=text,
            session_id=agent_meta.get("sessionId", ""),
            run_id=data.get("runId"),
            model=agent_meta.get("model"),
            usage=agent_meta.get("usage"),
            raw=data,
        )

    def health_check(self) -> bool:
        try:
            result = subprocess.run(
                [self.openclaw_bin, "health"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            return result.returncode == 0
        except Exception:
            return False
```

---

## Daemon Integration

The daemon stores connector config on each `AutonomousAgent` record and
instantiates the right connector at runtime.

### DB schema (addition to AutonomousAgent)

```python
class AutonomousAgent(Base):
    # ... existing fields ...
    cfn_agent_id:       Optional[str]   # CFN MAS agent ID (existing)

    connector_type:     str             # "openclaw" | "vercel_ai" | "cfn" | ...
    connector_config:   dict            # connector-specific config (JSON column)
    session_id:         Optional[str]   # persisted after first turn
```

### Connector registry

```python
CONNECTOR_REGISTRY = {
    "openclaw": OpenClawConnector,
    # "vercel_ai": VercelAIConnector,   # future
    # "cfn":       CFNConnector,        # future
}

def build_connector(agent: AutonomousAgent) -> AgentConnector:
    cls = CONNECTOR_REGISTRY.get(agent.connector_type)
    if not cls:
        raise ValueError(f"Unknown connector type: {agent.connector_type}")
    return cls(**agent.connector_config)
```

### Daemon trigger loop

```python
async def run_agent(agent: AutonomousAgent, message: str, db: Session):
    connector = build_connector(agent)

    response = connector.trigger(
        message=message,
        session_id=agent.session_id,  # None on first run → new session
    )

    # Persist session_id so future turns continue the same conversation
    if not agent.session_id:
        agent.session_id = response.session_id
        db.commit()

    return response
```

---

## Agent Registration (OpenClaw)

When `hm agent create` is called with `--connector openclaw`:

```bash
hm agent create jodee-agent \
  --room vacation-planning \
  --connector openclaw \
  --connector-config '{"agent_name": "jodee", "timeout_seconds": 300}' \
  --system-prompt "You are Jodee's travel agent..."
```

This creates:
```python
AutonomousAgent(
    name="jodee-agent",
    connector_type="openclaw",
    connector_config={"agent_name": "jodee", "timeout_seconds": 300},
    session_id=None,  # populated after first trigger
    cfn_agent_id="agent-001",  # set by CFN Control Plane
)
```

---

## Multi-Agent Trigger Flow

```
hm schedule trigger jodee-agent --label trip-planning
  │
  ├─ Daemon picks up pending run
  ├─ build_connector(jodee-agent)  →  OpenClawConnector(agent_name="jodee")
  ├─ connector.trigger(message, session_id=None)
  │     └─ openclaw agent --agent jodee --message "..." --json
  │
  ├─ Response contains @mention: "@julia-agent ..."
  ├─ @mention detection → create pending run for julia-agent
  │
  ├─ build_connector(julia-agent)  →  OpenClawConnector(agent_name="julia")
  ├─ connector.trigger(message, session_id=None)
  │     └─ openclaw agent --agent julia --message "..." --json
  │
  └─ ... same for bob-agent
```

Each agent maintains its own `session_id`. The coordinator (Guardian) can
inject context into any agent's next turn by prepending to `message` or by
writing to the agent's OpenClaw `bootstrapFiles` directory.

---

## Adding a New Connector

1. Implement `AgentConnector` — only `trigger()` and `health_check()` required
2. Register it in `CONNECTOR_REGISTRY`
3. Add a `--connector <type>` option to `hm agent create`

No changes to daemon core, scheduler, @mention detection, or CFN integration.

---

## Notes on OpenClaw Multi-Agent Setup

For the vacation-planning scenario to work with multiple OpenClaw agents,
each agent needs to be a **named agent** in OpenClaw's config:

```json
{
  "agents": {
    "jodee": { "model": { "primary": "anthropic/claude-sonnet-4-5-20250929" } },
    "julia": { "model": { "primary": "anthropic/claude-sonnet-4-5-20250929" } },
    "bob":   { "model": { "primary": "anthropic/claude-sonnet-4-5-20250929" } }
  }
}
```

**Open question:** Does OpenClaw support multiple named agents in a single
gateway instance, or does each agent require its own gateway? If the latter,
`connector_config` would need a `gateway_url` field and the connector would
need to pass `--url` to the CLI. This needs to be validated.
