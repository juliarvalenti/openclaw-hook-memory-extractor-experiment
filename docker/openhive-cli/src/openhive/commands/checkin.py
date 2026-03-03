"""
Checkin command for OpenHive CLI.

Check room status and update node heartbeat.
"""

import json as json_module

import typer

from openhive.config import OpenHiveConfig
from openhive.error_handler import print_error
from openhive.exceptions import ConfigNotFoundError, OpenHiveError
from openhive.http_client import OpenHiveHTTPClient
from openhive.identity import get_current_handle
from openhive.utils.room import list_cli_agents, update_cli_agent


def checkin(
    ctx: typer.Context,
    status: str | None = typer.Option(
        None,
        "--status",
        "-s",
        help="Update status (online, away, busy)",
    ),
) -> None:
    """
    Check room status and update presence.

    Quick status check for agents to see room state. Also acts as
    a heartbeat to keep presence alive.

    Examples:
        openhive checkin
        openhive checkin --status busy
    """
    try:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        json_output = ctx.obj.get("json", False) if ctx.obj else False

        config_path = OpenHiveConfig.get_config_path()
        if not config_path.exists():
            raise ConfigNotFoundError(str(config_path))

        config = OpenHiveConfig.load()

        handle = get_current_handle(config)
        if not handle:
            raise OpenHiveError(
                "No identity configured",
                suggestion="Run 'openhive onboard --name <your-name>' first",
            )

        from openhive.utils import ensure_room_set
        room_name = ensure_room_set(config)

        update_cli_agent(config, handle, room_name, status=status or "online")
        agents_list = list_cli_agents(config, room_name)
        agents = {a["handle"]: a for a in agents_list}

        with OpenHiveHTTPClient(config=config) as client:
            recent_response = client.get(
                f"/rooms/{room_name}/messages/recent",
                params={"minutes": 30, "limit": 5},
            )
            recent_messages = recent_response.json().get("messages", [])

        if json_output:
            output = {
                "handle": handle,
                "room": room_name,
                "status": status or "online",
                "agents": agents,
                "recent_activity": recent_messages,
            }
            typer.echo(json_module.dumps(output, indent=2, default=str))
        else:
            _print_checkin_output(
                handle=handle,
                room_name=room_name,
                agents=agents,
                recent_messages=recent_messages,
            )

    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)
        raise typer.Exit(1) from None


def _print_checkin_output(
    handle: str,
    room_name: str,
    agents: dict,
    recent_messages: list,
) -> None:
    """Print formatted checkin output."""
    typer.secho(f"Room: {room_name}", bold=True)
    typer.echo("")

    online_count = len(agents)
    typer.echo(f"Agents online: {online_count}")

    for agent_handle, info in sorted(agents.items()):
        is_you = agent_handle == handle
        status = info.get("status", "online")
        status_icon = {"online": "+", "away": "~", "busy": "!"}.get(status, "+")
        line = f"  {status_icon} {agent_handle}"
        if is_you:
            line += " (you)"
        if status != "online":
            line += f" [{status}]"
        typer.echo(line)

    if recent_messages:
        typer.echo("")
        typer.secho("Recent activity:", bold=True)
        typer.echo("")
        for msg in reversed(recent_messages[:3]):
            sender = msg.get("sender_handle", "?")
            content = msg.get("content", "")
            typer.echo(f"  {sender}: {content}")
