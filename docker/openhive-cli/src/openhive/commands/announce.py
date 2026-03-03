"""
Announce command for OpenHive CLI.

Broadcast status to room.
"""

import json as json_module
from datetime import UTC, datetime

import typer

from openhive.config import OpenHiveConfig
from openhive.error_handler import print_error
from openhive.exceptions import ConfigNotFoundError, OpenHiveError
from openhive.http_client import OpenHiveHTTPClient
from openhive.identity import get_current_handle


def announce(
    ctx: typer.Context,
    message: str = typer.Argument(..., help="Status message to broadcast"),
) -> None:
    """
    Broadcast status to room.

    Examples:
        openhive announce "Starting work on CVE-2024-1234"
        openhive announce "CFN scan complete, results in room"
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

        with OpenHiveHTTPClient(config=config) as client:
            response = client.post(
                f"/rooms/{room_name}/messages",
                params={"sender_handle": handle},
                json={
                    "message_type": "announce",
                    "content": message,
                    "extra": {
                        "event": "status",
                        "timestamp": datetime.now(UTC).isoformat(),
                    },
                },
            )
            msg_data = response.json()

        if json_output:
            typer.echo(json_module.dumps(msg_data, indent=2, default=str))
        else:
            typer.secho("Announced:", fg=typer.colors.GREEN)
            typer.echo(f"  {handle}: {message}")

    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)
        raise typer.Exit(1) from None
