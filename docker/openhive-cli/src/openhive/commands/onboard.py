"""
Onboard command for OpenHive CLI.

Join room and register presence.
"""

import json as json_module
from datetime import UTC, datetime

import typer

from openhive.config import OpenHiveConfig
from openhive.error_handler import print_error
from openhive.exceptions import ConfigNotFoundError, OpenHiveError
from openhive.http_client import OpenHiveHTTPClient
from openhive.identity import (
    generate_handle,
    generate_session_id,
    get_or_create_machine_id,
    save_session,
)
from openhive.utils.room import list_cli_agents, register_cli_agent


def onboard(
    ctx: typer.Context,
    name: str | None = typer.Option(
        None,
        "--name",
        "-n",
        help="Set display name (first time only)",
    ),
    no_daemon: bool = typer.Option(
        False,
        "--no-daemon",
        help="Skip starting the watch daemon",
    ),
) -> None:
    """
    Join room and register presence.

    Reads room from .openhive/config.toml, generates/loads signed handle,
    registers presence with server, and shows who's online.

    Examples:
        openhive onboard
        openhive onboard --name "Alpha"
    """
    try:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        json_output = ctx.obj.get("json", False) if ctx.obj else False

        config_path = OpenHiveConfig.get_config_path()
        if not config_path.exists():
            raise ConfigNotFoundError(str(config_path))

        config = OpenHiveConfig.load()

        get_or_create_machine_id(config)

        identity_name = config.identity.name
        if name:
            config.identity.name = name
            config.save()
            identity_name = name
        elif not identity_name:
            raise OpenHiveError(
                "No identity configured",
                suggestion="Run 'openhive onboard --name <your-name>' to set your display name",
            )

        session_id = generate_session_id()
        save_session(session_id)
        handle = generate_handle(identity_name, session_id)

        from openhive.utils import ensure_room_set
        room_name = ensure_room_set(config)

        register_cli_agent(config, handle, room_name)

        agents_list = list_cli_agents(config, room_name)
        agents = {a["handle"]: a for a in agents_list}

        with OpenHiveHTTPClient(config=config) as client:
            client.post(
                f"/rooms/{room_name}/messages",
                params={"sender_handle": handle},
                json={
                    "message_type": "announce",
                    "content": "joined the room",
                    "extra": {
                        "event": "onboard",
                        "timestamp": datetime.now(UTC).isoformat(),
                    },
                },
            )

            messages_response = client.get(
                f"/rooms/{room_name}/messages/recent",
                params={"minutes": 60, "message_type": "announce", "limit": 10},
            )
            recent_messages = messages_response.json().get("messages", [])

        if json_output:
            output = {
                "handle": handle,
                "room": room_name,
                "agents": agents,
                "recent_announcements": recent_messages,
            }
            typer.echo(json_module.dumps(output, indent=2, default=str))
        else:
            _print_onboard_output(
                handle=handle,
                room_name=room_name,
                agents=agents,
                recent_messages=recent_messages,
            )

            if not no_daemon:
                from openhive.commands.daemon import is_daemon_running, start as start_daemon
                if not is_daemon_running():
                    typer.echo("")
                    typer.secho("--- DAEMON ---", fg=typer.colors.CYAN)
                    typer.echo("Starting daemon...")
                    start_daemon(ctx, restart=False)
                else:
                    typer.echo("")
                    typer.secho("--- DAEMON ---", fg=typer.colors.CYAN)
                    typer.echo("Daemon already running")

    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)
        raise typer.Exit(1) from None


def _print_onboard_output(
    handle: str,
    room_name: str,
    agents: dict,
    recent_messages: list,
) -> None:
    """Print formatted onboard output."""
    typer.echo("")
    typer.secho("OpenHive Onboarding", bold=True)
    typer.echo(f"Your handle: {handle}")
    typer.echo("")

    typer.secho("--- ROOM STATUS ---", fg=typer.colors.CYAN)
    typer.echo(f"Room: {room_name}")

    if agents:
        typer.echo("Agents online:")
        for agent_handle, info in agents.items():
            status = info.get("status", "online")
            status_icon = {"online": "+", "away": "~", "busy": "!"}.get(status, "+")
            is_you = agent_handle == handle
            line = f"  {status_icon} {agent_handle}"
            if is_you:
                line += " (you)"
            typer.echo(line)
    else:
        typer.echo("No other agents online")

    typer.echo("")

    if recent_messages:
        typer.secho("--- RECENT ACTIVITY ---", fg=typer.colors.CYAN)
        for msg in recent_messages[:5]:
            sender = msg.get("sender_handle", "?")
            content = msg.get("content", "")
            typer.echo(f"  {sender}: {content}")
        typer.echo("")

    typer.secho("--- HOW TO COMMUNICATE ---", fg=typer.colors.CYAN)
    typer.echo("  openhive send @handle msg   # Send message")
    typer.echo("  openhive announce status    # Broadcast status")
    typer.echo("  openhive checkin            # Update presence/heartbeat")
    typer.echo("  openhive room watch <room>  # Stream messages")
    typer.echo("")
