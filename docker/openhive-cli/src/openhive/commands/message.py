"""
Message coordination commands for OpenHive CLI.

Commands:
- query: Post a response to the current coordination tick and block until next tick/consensus
"""

import json as json_module

import httpx
import typer

from openhive.config import OpenHiveConfig
from openhive.error_handler import print_error
from openhive.http_client import OpenHiveHTTPClient

app = typer.Typer(help="Coordination message commands", invoke_without_command=True)


@app.callback(invoke_without_command=True)
def message_main(ctx: typer.Context) -> None:
    """Coordination message commands."""
    if ctx.invoked_subcommand is None:
        typer.echo(ctx.get_help())


@app.command("query")
def query(
    ctx: typer.Context,
    text: str = typer.Argument(..., help="Your response to the current coordination question"),
) -> None:
    """
    Post a response to the coordination room and block until the next tick or consensus.

    Room is resolved from OPENHIVE_CHANNEL_ID env var, or from 'openhive room set'.
    Blocks until CognitiveEngine processes all responses and posts the next event.

    Examples:
        openhive message query "Hawaii works, budget $1500, wheelchair access required"
        openhive message query "No date constraints, flexible on location"
    """
    try:
        from openhive.commands.room import _render_coordination_event, _resolve_room

        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        json_output = ctx.obj.get("json", False) if ctx.obj else False

        config = OpenHiveConfig.load()
        room_name = _resolve_room(config)
        handle = config.get_current_identity()

        # Post response to room as direct message
        with OpenHiveHTTPClient(config=config) as client:
            response = client.post(
                f"/rooms/{room_name}/messages",
                json={
                    "sender_handle": handle,
                    "message_type": "direct",
                    "content": text,
                },
            )
            msg_data = response.json()

        if json_output:
            typer.echo(json_module.dumps(msg_data, indent=2, default=str))
            return

        typer.echo(f"  ↑  {handle}: {text[:80]}")
        typer.echo("  Waiting for other agents to respond…")
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
                            event = json_module.loads(payload)
                        except json_module.JSONDecodeError:
                            continue
                        rendered, should_exit = _render_coordination_event(event, handle)
                        if rendered:
                            typer.echo(rendered)
                        if should_exit:
                            return

    except KeyboardInterrupt:
        typer.echo("\n[Stopped]")
    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)
