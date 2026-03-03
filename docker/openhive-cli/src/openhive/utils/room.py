"""Room utilities for OpenHive CLI."""

import platform

from openhive.config import OpenHiveConfig
from openhive.exceptions import OpenHiveError
from openhive.http_client import OpenHiveHTTPClient


def ensure_room_set(
    config: OpenHiveConfig,
    room_override: str | None = None,
) -> str:
    """
    Ensure a room is set.

    Returns the active room name or raises if none is set.
    """
    active_room = config.get_active_room()

    if room_override is not None:
        if room_override.strip() == "":
            raise OpenHiveError(
                "Empty room name not allowed",
                suggestion="Run 'openhive room set <room-name>' to set your active room",
            )
        target_room = room_override
    elif active_room:
        target_room = active_room
    else:
        raise OpenHiveError(
            "No room set",
            suggestion="Run 'openhive room set <room-name>' first",
        )

    if target_room != active_room:
        import typer
        if active_room:
            typer.secho(f"Switching room: {active_room} → {target_room}", dim=True)
        else:
            typer.secho(f"Setting room: {target_room}", dim=True)
        config.init_project(room_name=target_room)
        config.save()

    return target_room


def register_cli_agent(
    config: OpenHiveConfig,
    handle: str,
    room_name: str,
) -> None:
    """Register CLI agent with the API on onboard."""
    machine_name = platform.node() or "unknown"

    payload: dict = {
        "handle": handle,
        "machine": machine_name,
    }
    if config.identity.machine_id:
        payload["machine_id"] = config.identity.machine_id

    with OpenHiveHTTPClient(config=config) as client:
        client.post(
            f"/agents/cli/{room_name}/register",
            json=payload,
        )


def update_cli_agent(
    config: OpenHiveConfig,
    handle: str,
    room_name: str,
    **data: str | None,
) -> None:
    """Update CLI agent presence via API."""
    payload: dict = {}
    if "status" in data and data["status"] is not None:
        payload["status"] = data["status"]
    if "machine" not in payload:
        payload["machine"] = platform.node() or "unknown"
    if config.identity.machine_id:
        payload["machine_id"] = config.identity.machine_id

    from urllib.parse import quote

    with OpenHiveHTTPClient(config=config) as client:
        client.patch(
            f"/agents/cli/{room_name}/{quote(handle, safe='')}",
            json=payload,
        )


def list_cli_agents(
    config: OpenHiveConfig,
    room_name: str,
) -> list[dict]:
    """List CLI agents in a room via API."""
    with OpenHiveHTTPClient(config=config) as client:
        response = client.get(f"/agents/cli/{room_name}")
        agents: list[dict] = response.json().get("agents", [])
        return agents
