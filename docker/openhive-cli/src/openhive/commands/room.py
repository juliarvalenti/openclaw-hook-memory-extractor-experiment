"""
Room management commands for OpenHive CLI.

Commands:
- (default): Show current active room
- ls: List rooms
- create: Create a new room
- set: Set active room context
- delete: Delete a room
- join: Join coordination backchannel (blocks until first coordination tick)
- watch: Stream messages from a room via SSE
- respond: Post a message to a room
- delegate: Delegate a task to an agent in a room
"""

import json as json_module
import os
import sys
from pathlib import Path

import typer

from openhive.config import OpenHiveConfig
from openhive.error_handler import print_error
from openhive.exceptions import ConfigNotFoundError, OpenHiveError
from openhive.http_client import OpenHiveHTTPClient

app = typer.Typer(help="Room management commands", invoke_without_command=True)


@app.callback(invoke_without_command=True)
def room_main(ctx: typer.Context) -> None:
    """Show current active room or manage rooms."""
    if ctx.invoked_subcommand is not None:
        return

    try:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        json_output = ctx.obj.get("json", False) if ctx.obj else False

        config = OpenHiveConfig.load()
        active_room = config.get_active_room()

        if not active_room:
            if json_output:
                typer.echo(json_module.dumps({"active_room": None}))
            else:
                typer.secho("No active room set.", fg=typer.colors.YELLOW)
                typer.echo("Set a room with: openhive room set <name>")
            raise typer.Exit(1)

        with OpenHiveHTTPClient(config=config) as client:
            response = client.get("/rooms", params={"name": active_room, "limit": 1})
            rooms_data = response.json()

        if not rooms_data:
            typer.secho(f"Active room '{active_room}' not found on server.", fg=typer.colors.RED)
            raise typer.Exit(1)

        room = rooms_data[0]
        if json_output:
            typer.echo(json_module.dumps(room, indent=2, default=str))
        else:
            typer.secho(f"Current Room: {room['name']}", fg=typer.colors.GREEN, bold=True)
            typer.echo(f"  ID:      {room.get('id')}")
            typer.echo(f"  Created: {str(room.get('created_at', ''))[:10]}")

    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)


@app.command("ls")
def list_rooms(
    ctx: typer.Context,
    limit: int = typer.Option(20, "--limit", "-l"),
    name: str | None = typer.Option(None, "--name", "-n"),
) -> None:
    """List available rooms."""
    try:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        json_output = ctx.obj.get("json", False) if ctx.obj else False

        config_path = OpenHiveConfig.get_config_path()
        if not config_path.exists():
            raise ConfigNotFoundError(str(config_path))

        config = OpenHiveConfig.load()

        params: dict[str, str | int] = {"limit": limit}
        if name:
            params["name"] = name

        with OpenHiveHTTPClient(config=config) as client:
            response = client.get("/rooms", params=params)
            rooms_data = response.json()

        if json_output:
            typer.echo(json_module.dumps(rooms_data, indent=2, default=str))
        else:
            if not rooms_data:
                typer.echo("No rooms found.")
                typer.echo("Create a room with: openhive room create <name>")
                return

            active_room = config.get_active_room()
            typer.secho(f"Rooms ({len(rooms_data)})", bold=True)
            typer.echo("")

            for room in rooms_data:
                is_active = room["name"] == active_room
                created_at = str(room.get("created_at", ""))[:10]
                if is_active:
                    typer.secho(f"  * {room['name']}", fg=typer.colors.GREEN, bold=True, nl=False)
                    typer.echo(f"  (created {created_at})")
                else:
                    typer.echo(f"    {room['name']}  (created {created_at})")

            typer.echo("")
            typer.echo("Use 'openhive room set <name>' to set the active room")

    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)


@app.command()
def create(
    ctx: typer.Context,
    name: str | None = typer.Argument(None, help="Room name"),
    public: bool = typer.Option(True, "--public/--private"),
) -> None:
    """Create a new room."""
    try:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        json_output = ctx.obj.get("json", False) if ctx.obj else False

        config_path = OpenHiveConfig.get_config_path()
        if not config_path.exists():
            raise ConfigNotFoundError(str(config_path))

        config = OpenHiveConfig.load()

        if name is None:
            name = typer.prompt("Room name")

        with OpenHiveHTTPClient(config=config) as client:
            response = client.post(
                "/rooms",
                json={"name": name, "is_public": public},
            )
            room_data = response.json()

        if json_output:
            typer.echo(json_module.dumps(room_data, indent=2, default=str))
        else:
            typer.secho(f"Created room: {room_data['name']}", fg=typer.colors.GREEN)
            typer.echo(f"  ID:      {room_data.get('id')}")
            typer.echo(f"  Created: {str(room_data.get('created_at', ''))[:10]}")
            typer.echo("")
            typer.echo(f"  Run 'openhive room set {name}' to make it your active room")

    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)


@app.command()
def set(
    ctx: typer.Context,
    room_name: str = typer.Argument(..., help="Room name to set as active"),
) -> None:
    """Set active room for this project."""
    try:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        json_output = ctx.obj.get("json", False) if ctx.obj else False

        config = OpenHiveConfig.load()

        with OpenHiveHTTPClient(config=config, timeout=10.0, max_retries=1) as client:
            response = client.get("/rooms", params={"name": room_name, "limit": 1})
            rooms_data = response.json()

            if not rooms_data:
                raise OpenHiveError(
                    f"Room '{room_name}' not found",
                    suggestion=f"Create it first with: openhive room create {room_name}",
                )

        config.init_project(room_name=room_name)
        config.save()

        if json_output:
            typer.echo(json_module.dumps({"room": room_name}))
        else:
            typer.secho(f"Room set: {room_name}", fg=typer.colors.GREEN)
            typer.echo("Next: Run 'openhive onboard' to start a session")

    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)


@app.command()
def delete(
    ctx: typer.Context,
    room_name: str = typer.Argument(..., help="Room name to delete"),
    force: bool = typer.Option(False, "--force", "-f"),
) -> None:
    """Delete a room."""
    try:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        config_path = OpenHiveConfig.get_config_path()
        if not config_path.exists():
            raise ConfigNotFoundError(str(config_path))

        config = OpenHiveConfig.load()

        if not force:
            confirm = typer.confirm(f"Delete room '{room_name}'? This cannot be undone.")
            if not confirm:
                typer.echo("Cancelled.")
                raise typer.Exit(0)

        with OpenHiveHTTPClient(config=config) as client:
            client.delete(f"/rooms/{room_name}")

        typer.secho(f"Room '{room_name}' deleted.", fg=typer.colors.GREEN)

    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)


def _resolve_room(config: OpenHiveConfig) -> str:
    """
    Resolve the coordination room name.

    Priority:
      1. OPENHIVE_CHANNEL_ID env var → room name 'oh-{channelId}'
      2. config.rooms.active (set via 'openhive room set')
      3. Error
    """
    channel_id = os.getenv("OPENHIVE_CHANNEL_ID")
    if channel_id:
        return f"oh-{channel_id}"
    if config.rooms.active:
        return config.rooms.active
    raise OpenHiveError(
        "No channel context found",
        suggestion=(
            "Set OPENHIVE_CHANNEL_ID in your environment, or run: openhive room set <name>"
        ),
    )


def _render_coordination_event(msg: dict, current_identity: str) -> tuple[str | None, bool]:
    """
    Render a coordination SSE event for display.

    Returns (rendered_string | None, should_exit).
    should_exit=True means the CLI should print the message and exit.
    """
    mtype = msg.get("message_type", "")

    if mtype == "coordination_join":
        try:
            data = json_module.loads(msg.get("content", "{}"))
        except json_module.JSONDecodeError:
            data = {}
        handle = data.get("handle", "?")
        intent = data.get("intent")
        suffix = f" — {intent}" if intent else ""
        return f"  ⟫  {handle} joined{suffix}", False

    if mtype == "coordination_start":
        try:
            data = json_module.loads(msg.get("content", "{}"))
        except json_module.JSONDecodeError:
            data = {}
        n = data.get("agent_count", "?")
        return f"  ⟫  Session started — {n} agents joined. Beginning coordination…", False

    if mtype == "coordination_tick":
        try:
            data = json_module.loads(msg.get("content", "{}"))
        except json_module.JSONDecodeError:
            data = {}
        round_num = data.get("round", "?")
        ambiguities = data.get("ambiguities", [])
        lines = [f"  ⟫  CognitiveEngine [tick {round_num}]:"]
        for i, q in enumerate(ambiguities, 1):
            lines.append(f"        {i}. {q}")
        return "\n".join(lines), True  # exit after printing

    if mtype == "coordination_consensus":
        try:
            data = json_module.loads(msg.get("content", "{}"))
        except json_module.JSONDecodeError:
            data = {}
        lines = ["  ⟫  CognitiveEngine [consensus]:"]
        assignments = data.get("assignments", {})
        assignment = assignments.get(current_identity, data.get("plan", ""))
        if assignment:
            lines.append(f"        Your assignment: {assignment}")
        return "\n".join(lines), True  # exit after printing

    # Regular message
    if mtype not in ("coordination_join", "coordination_start"):
        sender = msg.get("sender_handle", "?")
        content = msg.get("content", "")
        return f"  {sender}: {content}", False

    return None, False


@app.command()
def join(
    ctx: typer.Context,
    message: str | None = typer.Option(
        None, "--message", "-m", help="Your requirements/intent for this coordination session"
    ),
    file: Path | None = typer.Option(
        None, "--file", "-f", help="Read requirements from a file"
    ),
) -> None:
    """
    Join the coordination backchannel for the current channel.

    Room is resolved from OPENHIVE_CHANNEL_ID env var, or from 'openhive room set'.
    Blocks until the first coordination tick or consensus, then exits.

    Examples:
        openhive room join -m "My human wants to visit Hawaii"
        openhive room join -f requirements.txt
        openhive room join  # join without intent
    """
    try:
        import httpx

        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        json_output = ctx.obj.get("json", False) if ctx.obj else False

        config = OpenHiveConfig.load()
        room_name = _resolve_room(config)
        handle = config.get_current_identity()

        # Resolve intent from -m or -f
        intent: str | None = None
        if message:
            intent = message
        elif file:
            intent = file.read_text().strip()

        with OpenHiveHTTPClient(config=config) as client:
            response = client.post(
                f"/rooms/{room_name}/sessions",
                json={"agent_handle": handle, "intent": intent},
            )
            data = response.json()

        if json_output:
            typer.echo(json_module.dumps(data, indent=2, default=str))
            return

        typer.echo(f"  Joined room {room_name}")
        typer.echo(
            f"  Waiting for other agents… ({config.server.api_url})"
        )
        typer.echo("")

        # Open SSE stream and block until coordination_tick or _consensus
        url = f"{config.server.api_url}/rooms/{room_name}/messages/stream"
        headers = {}
        if config.server.token:
            headers["Authorization"] = f"Bearer {config.server.token}"

        with httpx.Client(timeout=None) as http:
            with http.stream("GET", url, headers=headers) as resp:
                for line in resp.iter_lines():
                    line = line.strip()
                    if not line or line.startswith(":"):
                        continue
                    if line.startswith("data:"):
                        payload = line[5:].strip()
                        try:
                            msg_data = json_module.loads(payload)
                        except json_module.JSONDecodeError:
                            continue
                        rendered, should_exit = _render_coordination_event(msg_data, handle)
                        if rendered:
                            typer.echo(rendered)
                        if should_exit:
                            return

    except KeyboardInterrupt:
        typer.echo("\n[Stopped]")
    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)


def _watch_room(config: OpenHiveConfig, room_name: str, timeout: int) -> None:
    """Core SSE watch loop — pretty-renders all message types."""
    import time

    import httpx

    C = {
        "cyan":   "\x1b[36m",
        "green":  "\x1b[32m",
        "yellow": "\x1b[33m",
        "blue":   "\x1b[34m",
        "magenta":"\x1b[35m",
        "dim":    "\x1b[2m",
        "bold":   "\x1b[1m",
        "reset":  "\x1b[0m",
    }

    def ts() -> str:
        return C["dim"] + time.strftime("%H:%M:%S") + C["reset"]

    def rule() -> str:
        return C["dim"] + "  " + "─" * 54 + C["reset"]

    def render(msg: dict) -> str | None:
        mtype = msg.get("message_type", "")
        sender = msg.get("sender_handle", "?")

        try:
            data = json_module.loads(msg.get("content", "{}"))
        except (json_module.JSONDecodeError, TypeError):
            data = {}

        if mtype == "coordination_join":
            intent = data.get("intent")
            handle = data.get("handle", sender)
            suffix = f"  {C['dim']}— {intent}{C['reset']}" if intent else ""
            return f"  {ts()}  {C['cyan']}{handle}{C['reset']} joined{suffix}"

        if mtype == "coordination_start":
            n = data.get("agent_count", "?")
            return (
                f"\n{rule()}\n"
                f"  {ts()}  {C['bold']}{C['cyan']}⟫ Session started{C['reset']} — "
                f"{n} agents joined. Beginning coordination…\n"
            )

        if mtype == "coordination_tick":
            round_num = data.get("round", "?")
            questions = data.get("ambiguities", [])
            lines = [
                f"\n  {ts()}  {C['bold']}{C['cyan']}⟫ CognitiveEngine [tick {round_num}]{C['reset']}"
            ]
            for i, q in enumerate(questions, 1):
                lines.append(f"              {C['dim']}{i}.{C['reset']} {q}")
            return "\n".join(lines)

        if mtype == "coordination_consensus":
            plan = data.get("plan", "")
            assignments = data.get("assignments", {})
            lines = [
                f"\n{rule()}",
                f"  {ts()}  {C['bold']}{C['green']}⟫ CognitiveEngine [consensus]{C['reset']}",
            ]
            if plan:
                lines.append(f"              {C['dim']}Plan:{C['reset']} {plan}")
            if assignments:
                lines.append(f"              {C['dim']}Assignments:{C['reset']}")
                for handle, task in assignments.items():
                    lines.append(f"                {C['cyan']}{handle}{C['reset']}: {task}")
            lines.append(f"\n{rule()}")
            return "\n".join(lines)

        if mtype == "delegate":
            recipient = msg.get("recipient_handle", "?")
            content = msg.get("content", "")
            return (
                f"  {ts()}  {C['magenta']}{sender}{C['reset']} "
                f"{C['dim']}→{C['reset']} {C['cyan']}{recipient}{C['reset']}: {content}"
            )

        if mtype in ("direct", "broadcast", "announce"):
            content = msg.get("content", "")
            color = C["yellow"] if mtype == "broadcast" else C["blue"]
            return f"  {ts()}  {color}{sender}{C['reset']}: {content}"

        return None

    url = f"{config.server.api_url}/rooms/{room_name}/messages/stream"
    headers = {}
    if config.server.token:
        headers["Authorization"] = f"Bearer {config.server.token}"

    typer.echo(f"\n  {C['bold']}Watching{C['reset']} {C['cyan']}{room_name}{C['reset']}  "
               f"{C['dim']}(Ctrl+C to stop){C['reset']}\n")
    typer.echo(rule())

    start = time.time()

    with httpx.Client(timeout=None) as http:
        with http.stream("GET", url, headers=headers) as response:
            for line in response.iter_lines():
                if timeout > 0 and (time.time() - start) >= timeout:
                    typer.echo(f"\n  {C['dim']}[Timeout after {timeout}s]{C['reset']}")
                    return
                line = line.strip()
                if not line or line.startswith(":"):
                    continue
                if line.startswith("data:"):
                    payload = line[5:].strip()
                    try:
                        msg = json_module.loads(payload)
                    except json_module.JSONDecodeError:
                        continue
                    rendered = render(msg)
                    if rendered:
                        typer.echo(rendered)


@app.command()
def watch(
    ctx: typer.Context,
    room_name: str | None = typer.Argument(None, help="Room to watch (default: active room)"),
    timeout: int = typer.Option(0, "--timeout", "-t", help="Timeout in seconds (0=no timeout)"),
) -> None:
    """
    Stream live messages from a room.

    Auto-resolves the active room — no argument needed.
    Renders coordination events, agent joins, ticks, and consensus.

    Examples:
        openhive room watch
        openhive room watch my-room
        openhive room watch --timeout 120
    """
    try:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        config = OpenHiveConfig.load()
        name = room_name or _resolve_room(config)
        _watch_room(config, name, timeout)
    except KeyboardInterrupt:
        typer.echo("\n  [Stopped]")
    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)


@app.command()
def respond(
    ctx: typer.Context,
    session_id: str = typer.Argument(..., help="Room session/name"),
    agent: str = typer.Option(..., "--agent", "-a", help="Agent handle sending the response"),
    response_text: str = typer.Option(..., "--response", "-r", help="Response message text"),
) -> None:
    """
    Post a message to a room (triggers NOTIFY).

    Examples:
        openhive room respond my-room --agent alpha#a1b2 --response "Task complete"
    """
    try:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        json_output = ctx.obj.get("json", False) if ctx.obj else False

        config = OpenHiveConfig.load()

        with OpenHiveHTTPClient(config=config) as client:
            resp = client.post(
                f"/rooms/{session_id}/messages",
                params={"sender_handle": agent},
                json={
                    "message_type": "direct",
                    "content": response_text,
                },
            )
            data = resp.json()

        if json_output:
            typer.echo(json_module.dumps(data, indent=2, default=str))
        else:
            typer.secho("Message sent", fg=typer.colors.GREEN)
            typer.echo(f"  {agent}: {response_text[:80]}")

    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)


@app.command()
def delegate(
    ctx: typer.Context,
    session_id: str = typer.Argument(..., help="Room session/name"),
    to: str = typer.Option(..., "--to", help="Target agent handle"),
    task: str = typer.Option(..., "--task", "-t", help="Task description to delegate"),
) -> None:
    """
    Delegate a task to an agent in a room.

    Posts a 'delegate' type message to the room.

    Examples:
        openhive room delegate my-room --to cfn-agent --task "Scan CVE-2024-1234"
    """
    try:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        json_output = ctx.obj.get("json", False) if ctx.obj else False

        config = OpenHiveConfig.load()
        sender = config.get_current_identity()

        with OpenHiveHTTPClient(config=config) as client:
            resp = client.post(
                f"/rooms/{session_id}/messages",
                params={"sender_handle": sender},
                json={
                    "message_type": "delegate",
                    "content": task,
                    "recipient_handle": to,
                },
            )
            data = resp.json()

        if json_output:
            typer.echo(json_module.dumps(data, indent=2, default=str))
        else:
            typer.secho("Task delegated", fg=typer.colors.GREEN)
            typer.echo(f"  {sender} -> {to}: {task[:80]}")

    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)
