"""
Send command for OpenHive CLI.

Send a message to an agent or broadcast to the room.
"""

import json as json_module
from datetime import UTC, datetime

import typer

from openhive.config import OpenHiveConfig
from openhive.error_handler import print_error
from openhive.exceptions import ConfigNotFoundError, OpenHiveError
from openhive.http_client import OpenHiveHTTPClient
from openhive.identity import get_current_handle


def send(
    ctx: typer.Context,
    to: str = typer.Argument(
        ...,
        help="Recipient handle (@handle or @all)",
    ),
    message: str = typer.Argument(
        ...,
        help="Message body",
    ),
) -> None:
    """
    Send message to agent or broadcast.

    Examples:
        openhive send @alpha#a1b2 "Can you check CFE-123?"
        openhive send @all "Deploy complete"
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

        recipient = to.lstrip("@")
        if recipient == "all":
            message_type = "broadcast"
            recipient_handle = None
        else:
            message_type = "direct"
            recipient_handle = recipient

        with OpenHiveHTTPClient(config=config) as client:
            request_data: dict = {
                "message_type": message_type,
                "content": message,
                "extra": {"timestamp": datetime.now(UTC).isoformat()},
            }
            if recipient_handle:
                request_data["recipient_handle"] = recipient_handle

            response = client.post(
                f"/rooms/{room_name}/messages",
                params={"sender_handle": handle},
                json=request_data,
            )
            msg_data = response.json()

        if json_output:
            typer.echo(json_module.dumps(msg_data, indent=2, default=str))
        else:
            if message_type == "broadcast":
                typer.secho("Broadcasted:", fg=typer.colors.GREEN)
                typer.echo(f"  {handle} -> @all: {message}")
            else:
                typer.secho("Sent:", fg=typer.colors.GREEN)
                typer.echo(f"  {handle} -> @{recipient_handle}: {message}")

    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)
        raise typer.Exit(1) from None
