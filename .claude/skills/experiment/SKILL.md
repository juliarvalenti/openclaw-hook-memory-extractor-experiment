---
name: experiment
description: Manage multi-agent OpenClaw experiments — create, run, stop, inspect logs, and review outcomes.
user-invocable: true
---

You are helping manage multi-agent experiments in this repo. The CLI lives at `cli/experiment` (relative to the repo root).

## What you can do

- **Create** a new experiment from the template
- **Run** an experiment (spins up Docker containers + Matrix, posts seed message)
- **Stop** a running experiment
- **List** all experiments and their run history
- **Check status** of a running experiment
- **Tail or inspect logs** from a run, by agent or full compose output
- **Review outcomes** — read log files against acceptance criteria and summarize what happened

## How to handle the user's request

Parse their intent and run the right command. Be direct — don't ask for confirmation on read operations. For destructive operations (stop, delete) confirm first if it's not obvious.

### Command reference

```bash
# From repo root:

# Shared Matrix server (start once, leave running)
./cli/experiment matrix start
./cli/experiment matrix stop
./cli/experiment matrix status

# Experiments
./cli/experiment create <name> [agent1] [agent2] ...
./cli/experiment run    <name>                  # default timeout: 5m
./cli/experiment run    <name> --timeout 10m    # custom timeout (5m/30m/1h/etc)
./cli/experiment stop   <name>
./cli/experiment list
./cli/experiment status <name>
./cli/experiment logs   <name>                  # docker compose logs, last 50 lines
./cli/experiment logs   <name> <agent>          # structured .jsonl logs for one agent
./cli/experiment logs   <name> --follow         # live tail
./cli/experiment logs   <name> <agent> --follow # live tail for one agent
./cli/experiment messages <name> [limit]        # snapshot recent room messages
./cli/experiment watch  <name>                  # live tail Matrix room
./cli/experiment server                         # start REST API on port 7777
./cli/experiment server --port 8080             # custom port
```

### REST API

Start with `./cli/experiment server`. Mirrors all CLI commands over HTTP. No auth required (VPN-gated).

```
GET  /health
POST /matrix/start|stop          GET /matrix/status
GET  /experiments                POST /experiments  { name, agents?: [] }
GET  /experiments/:name/status
POST /experiments/:name/run      body: { timeout?: "5m" }
POST /experiments/:name/stop
GET  /experiments/:name/logs     ?agent=<name>  &follow=true → SSE
GET  /experiments/:name/messages ?limit=20
GET  /experiments/:name/watch    → SSE stream of room messages
```

SSE events from `/watch`: `data: {"sender":"@agent:local","body":"...","timestamp":1234567890}`

Each run gets its own Matrix room: `#<experiment-slug>-<timestamp>:local`

Experiments auto-stop after 5 minutes by default. Pass `--timeout` to override (e.g. `--timeout 10m`, `--timeout 1h`). `experiment status` shows remaining time.

### Experiment structure

```
experiments/
  <name>/
    experiment.json          # name, description, seed, acceptance_criteria
    agents/
      <agent-name>/
        openclaw.json        # model, channels, gateway settings
        workspace/
          IDENTITY.md        # optional — who is this agent
          SOUL.md            # optional — behavioral constraints
          CONSTRAINTS.md     # optional — artificial limitations for failure-mode experiments
          skills/            # optional — agent-specific skills
          hooks/             # optional — agent-specific hooks
    runs/
      <timestamp>/           # generated per run — do not edit
        docker-compose.yml
        .env
        logs/
          <agent-name>/
            <session-id>.jsonl
```

### Reading experiment outcomes

When the user asks to review or analyze a run:
1. Read `experiment.json` to get the acceptance criteria
2. Read log files from `runs/<latest>/logs/<agent>/*.jsonl`
3. Each `.jsonl` entry is an `openclaw-conversation-v1` payload — look at the `turns` array for what each agent said and did
4. Evaluate against the acceptance criteria and summarize: what worked, what failed, where did coordination break down

### Creating a new experiment

When creating an experiment, after running `create`:
1. Show the user the generated structure
2. Ask what agents they need and what each one should know/be able to do
3. Help them populate the workspace files — especially `IDENTITY.md` (who is this agent), `SOUL.md` (how should it behave), and `CONSTRAINTS.md` (any artificial limitations)
4. Help them write the `seed` in `experiment.json` — the initial message that kicks off the scenario
5. Help them define `acceptance_criteria` — what does a successful outcome look like

Keep responses concise. Show command output directly. When in doubt, just run the command and show the result.

### Always show Matrix connect info after run/restart

After any `run` or `restart`, always end your response with the Matrix connection block — read it from the active run's `.env`:

```
Homeserver: http://localhost:8008
Username:   @observer:local
Password:   <OBSERVER_MATRIX_PASSWORD from runs/<latest>/.env>
Room:       #agents:local
```

To get the password:
```bash
grep OBSERVER_MATRIX_PASSWORD experiments/<name>/runs/$(ls -1 experiments/<name>/runs/ | sort | tail -1)/.env | cut -d= -f2
```
