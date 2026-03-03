"""
Adapter commands — connect agent frameworks to OpenHive.

Supported adapters:
  openclaw    — runs `openclaw plugins install` with the bundled openhive-cfn plugin

Planned:
  cursor      — SDK harness (next sprint)
  claude-code — SDK harness (next sprint)
"""

import importlib.resources
import json as json_module
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import typer

from openhive.config import OpenHiveConfig
from openhive.error_handler import print_error

app = typer.Typer(help="Manage agent framework adapters")

ADAPTER_TYPES = {
    "openclaw": "plugin-based — installs openhive-cfn via `openclaw plugins install`",
    "cursor": "sdk-based — generates CFN harness for Cursor agents (planned)",
    "claude-code": "sdk-based — generates CFN harness for Claude Code (planned)",
}

_OPENCLAW_PLUGIN_NAME = "openhive-cfn"


@app.callback()
def adapter_main(ctx: typer.Context) -> None:
    """Manage agent framework adapters (openclaw, cursor, claude-code, …)."""


@app.command("add")
def add(
    ctx: typer.Context,
    adapter_type: str = typer.Argument(..., help="Adapter type: openclaw, cursor, claude-code"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Show what would be installed without doing it"),
) -> None:
    """
    Register and install an agent framework adapter.

    Examples:
        openhive adapter add openclaw
    """
    try:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        json_output = ctx.obj.get("json", False) if ctx.obj else False

        if adapter_type not in ADAPTER_TYPES:
            known = ", ".join(ADAPTER_TYPES.keys())
            typer.secho(f"Unknown adapter type '{adapter_type}'. Known types: {known}", fg=typer.colors.RED)
            raise typer.Exit(1)

        config = OpenHiveConfig.load()

        if adapter_type in config.adapters:
            typer.secho(
                f"Adapter '{adapter_type}' already registered. Use 'openhive adapter status {adapter_type}' to check it.",
                fg=typer.colors.YELLOW,
            )
            raise typer.Exit(0)

        if dry_run:
            plugin_src = _resolve_plugin_src()
            typer.secho(f"[dry-run] Would install adapter: {adapter_type}", fg=typer.colors.CYAN)
            typer.echo(f"  plugin src: {plugin_src}/")
            typer.echo(f"  command:    openclaw plugins install {plugin_src}")
            typer.echo(f"  api_url:    {config.server.api_url}")
            return

        if adapter_type == "openclaw":
            _install_openclaw(verbose=verbose)
        else:
            typer.secho(f"Adapter '{adapter_type}' is planned but not yet implemented.", fg=typer.colors.YELLOW)
            raise typer.Exit(1)

        adapter_record: dict = {
            "type": adapter_type,
            "installed_at": datetime.now(timezone.utc).isoformat(),
            "api_url": config.server.api_url,
        }

        config.adapters[adapter_type] = adapter_record
        config.save()

        if json_output:
            typer.echo(json_module.dumps(adapter_record, indent=2))
        else:
            typer.secho(f"Adapter '{adapter_type}' installed.", fg=typer.colors.GREEN)
            typer.echo(f"  plugin:   {_OPENCLAW_PLUGIN_NAME}")
            typer.echo(f"  api_url:  {config.server.api_url}")
            typer.echo("")
            typer.echo("  Set OPENHIVE_API_URL and OPENHIVE_CHANNEL_ID in your agent environment.")

    except typer.Exit:
        raise
    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)
        raise typer.Exit(1) from None


@app.command("remove")
def remove(
    ctx: typer.Context,
    adapter_type: str = typer.Argument(..., help="Adapter type to remove"),
    force: bool = typer.Option(False, "--force", "-f", help="Skip confirmation"),
) -> None:
    """Unregister and uninstall an adapter."""
    try:
        config = OpenHiveConfig.load()

        if adapter_type not in config.adapters:
            typer.secho(f"Adapter '{adapter_type}' is not registered.", fg=typer.colors.YELLOW)
            raise typer.Exit(0)

        if not force:
            confirm = typer.confirm(f"Remove adapter '{adapter_type}'?")
            if not confirm:
                typer.echo("Cancelled.")
                raise typer.Exit(0)

        if adapter_type == "openclaw":
            _uninstall_openclaw(config.adapters[adapter_type])

        del config.adapters[adapter_type]
        config.save()

        typer.secho(f"Adapter '{adapter_type}' removed.", fg=typer.colors.GREEN)

    except typer.Exit:
        raise
    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)
        raise typer.Exit(1) from None


@app.command("ls")
def list_adapters(ctx: typer.Context) -> None:
    """List registered adapters."""
    try:
        json_output = ctx.obj.get("json", False) if ctx.obj else False
        config = OpenHiveConfig.load()

        if json_output:
            typer.echo(json_module.dumps(config.adapters, indent=2, default=str))
            return

        if not config.adapters:
            typer.echo("No adapters registered.")
            typer.echo("  Add one with: openhive adapter add <type>")
            typer.echo(f"  Known types: {', '.join(ADAPTER_TYPES.keys())}")
            return

        typer.secho(f"Adapters ({len(config.adapters)})", bold=True)
        typer.echo("")
        for name, info in config.adapters.items():
            installed_at = info.get("installed_at", "unknown")[:10]
            typer.echo(f"  {name:<16} installed {installed_at}")

    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)


@app.command("status")
def status(
    ctx: typer.Context,
    adapter_type: Optional[str] = typer.Argument(None, help="Adapter type to check (all if omitted)"),
) -> None:
    """Check adapter health."""
    try:
        json_output = ctx.obj.get("json", False) if ctx.obj else False
        config = OpenHiveConfig.load()

        if adapter_type and adapter_type not in config.adapters:
            typer.secho(f"Adapter '{adapter_type}' is not registered.", fg=typer.colors.YELLOW)
            raise typer.Exit(1)

        targets = (
            {adapter_type: config.adapters[adapter_type]}
            if adapter_type
            else config.adapters
        )

        if not targets:
            typer.echo("No adapters registered.")
            return

        results = {name: _check_adapter_status(name, info) for name, info in targets.items()}

        if json_output:
            typer.echo(json_module.dumps(results, indent=2, default=str))
            return

        for name, check in results.items():
            ok = check.get("ok", False)
            color = typer.colors.GREEN if ok else typer.colors.RED
            symbol = "✓" if ok else "✗"
            typer.secho(f"  {symbol} {name}", fg=color)
            for detail in check.get("details", []):
                typer.echo(f"      {detail}")

    except typer.Exit:
        raise
    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)


# ── Adapter-specific install / uninstall ──────────────────────────────────────

def _resolve_plugin_src() -> Path:
    """
    Return a real filesystem path to the bundled openhive-cfn plugin directory.

    importlib.resources may return a path inside a zip for non-editable installs,
    so we extract to a temp dir in that case. The caller is responsible for
    cleanup if a temp dir was created (check path.parts for tmp).
    """
    pkg = importlib.resources.files("openhive.adapters.openclaw")
    src = Path(str(pkg)) / "extensions" / _OPENCLAW_PLUGIN_NAME

    if src.exists():
        return src

    # Non-editable install: extract from the package zip to a temp dir
    tmp = Path(tempfile.mkdtemp(prefix="openhive-plugin-"))
    dst = tmp / _OPENCLAW_PLUGIN_NAME
    dst.mkdir()
    for entry in (pkg / "extensions" / _OPENCLAW_PLUGIN_NAME).iterdir():
        (dst / entry.name).write_bytes(entry.read_bytes())
    return dst


def _install_openclaw(verbose: bool = False) -> None:
    """
    Install the bundled openhive-cfn plugin via `openclaw plugins install <path>`.

    Covers the full CFN adapter lifecycle:
      gateway_start, gateway_stop, session_start, session_end,
      before_agent_start, message_sent
    """
    plugin_src = _resolve_plugin_src()
    cmd = ["openclaw", "plugins", "install", str(plugin_src)]
    if verbose:
        typer.echo(f"  running: {' '.join(cmd)}")

    result = subprocess.run(cmd, text=True, capture_output=not verbose)
    if result.returncode != 0:
        stderr = result.stderr.strip() if result.stderr else ""
        raise RuntimeError(
            f"`openclaw plugins install` failed (exit {result.returncode})"
            + (f": {stderr}" if stderr else "")
        )


def _uninstall_openclaw(adapter_record: dict) -> None:
    """Uninstall the openhive-cfn plugin via `openclaw plugins uninstall`."""
    result = subprocess.run(
        ["openclaw", "plugins", "uninstall", _OPENCLAW_PLUGIN_NAME],
        text=True, capture_output=True,
    )
    # Non-zero exit is acceptable if the plugin was already removed manually
    if result.returncode != 0 and "not found" not in (result.stderr or "").lower():
        typer.secho(
            f"  warning: openclaw plugins uninstall exited {result.returncode}",
            fg=typer.colors.YELLOW,
        )


def _check_adapter_status(name: str, info: dict) -> dict:
    """Run health checks for a registered adapter."""
    details: list[str] = []
    ok = True

    if name == "openclaw":
        result = subprocess.run(
            ["openclaw", "plugins", "info", _OPENCLAW_PLUGIN_NAME],
            text=True, capture_output=True,
        )
        if result.returncode == 0:
            details.append(f"plugin installed: {_OPENCLAW_PLUGIN_NAME}")
        else:
            details.append(f"plugin not found: {_OPENCLAW_PLUGIN_NAME} (run: openhive adapter add openclaw)")
            ok = False

    api_url = info.get("api_url", "")
    details.append(f"api_url: {api_url}")

    return {"ok": ok, "details": details}
