"""
Adapter commands — connect agent frameworks to IoC/CFN.

Supported adapters:
  openclaw    — hook-based (installs JS hook + openhive skill into OpenClaw)

Planned:
  cursor      — SDK harness (next sprint)
  claude-code — SDK harness (next sprint)
"""

import importlib.resources
import json as json_module
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import typer

from openhive.config import OpenHiveConfig
from openhive.error_handler import print_error

app = typer.Typer(help="Manage agent framework adapters")

ADAPTER_TYPES = {
    "openclaw": "hook-based — installs JS hook + OpenHive skill into OpenClaw",
    "cursor": "sdk-based — generates CFN harness for Cursor agents (planned)",
    "claude-code": "sdk-based — generates CFN harness for Claude Code (planned)",
}

ADAPTER_DEFAULTS: dict[str, dict] = {
    "openclaw": {
        "hooks_dir": "~/.openclaw/hooks",
        "skills_dir": "~/.openclaw/skills",
    },
}

# Names of the installed hook/skill directories
_OPENCLAW_HOOK_NAME = "openhive-inject"
_OPENCLAW_SKILL_NAME = "openhive"


@app.callback()
def adapter_main(ctx: typer.Context) -> None:
    """Manage agent framework adapters (openclaw, cursor, claude-code, …)."""


@app.command("add")
def add(
    ctx: typer.Context,
    adapter_type: str = typer.Argument(..., help="Adapter type: openclaw, cursor, claude-code"),
    hooks_dir: Optional[str] = typer.Option(None, "--hooks-dir", help="Override default hooks directory"),
    skills_dir: Optional[str] = typer.Option(None, "--skills-dir", help="Override default skills directory"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Show what would be installed without doing it"),
) -> None:
    """
    Register and install an agent framework adapter.

    Examples:
        openhive adapter add openclaw
        openhive adapter add openclaw --hooks-dir ~/.openclaw/hooks
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

        defaults = ADAPTER_DEFAULTS.get(adapter_type, {})
        resolved_hooks_dir = (
            Path(hooks_dir or defaults["hooks_dir"]).expanduser()
            if (hooks_dir or defaults.get("hooks_dir"))
            else None
        )
        resolved_skills_dir = (
            Path(skills_dir or defaults["skills_dir"]).expanduser()
            if (skills_dir or defaults.get("skills_dir"))
            else None
        )

        if dry_run:
            typer.secho(f"[dry-run] Would install adapter: {adapter_type}", fg=typer.colors.CYAN)
            if resolved_hooks_dir:
                typer.echo(f"  hook:       {resolved_hooks_dir / _OPENCLAW_HOOK_NAME}/")
            if resolved_skills_dir:
                typer.echo(f"  skill:      {resolved_skills_dir / _OPENCLAW_SKILL_NAME}/")
            typer.echo(f"  cfn_url:    {config.server.cfn_url}")
            return

        if adapter_type == "openclaw":
            _install_openclaw(resolved_hooks_dir, resolved_skills_dir, verbose=verbose)
        else:
            typer.secho(f"Adapter '{adapter_type}' is planned but not yet implemented.", fg=typer.colors.YELLOW)
            raise typer.Exit(1)

        adapter_record: dict = {
            "type": adapter_type,
            "installed_at": datetime.now(timezone.utc).isoformat(),
            "cfn_url": config.server.cfn_url,
        }
        if resolved_hooks_dir:
            adapter_record["hooks_dir"] = str(resolved_hooks_dir)
        if resolved_skills_dir:
            adapter_record["skills_dir"] = str(resolved_skills_dir)

        config.adapters[adapter_type] = adapter_record
        config.save()

        if json_output:
            typer.echo(json_module.dumps(adapter_record, indent=2))
        else:
            typer.secho(f"Adapter '{adapter_type}' installed.", fg=typer.colors.GREEN)
            if resolved_hooks_dir:
                typer.echo(f"  hook:   {resolved_hooks_dir / _OPENCLAW_HOOK_NAME}/")
            if resolved_skills_dir:
                typer.echo(f"  skill:  {resolved_skills_dir / _OPENCLAW_SKILL_NAME}/")
            typer.echo(f"  cfn:    {config.server.cfn_url}")

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

def _openclaw_data_dir() -> Path:
    """Return the path to the bundled openclaw adapter package data."""
    pkg = importlib.resources.files("openhive.adapters.openclaw")
    # importlib.resources returns a Traversable; resolve to a real Path
    return Path(str(pkg))


def _install_openclaw(
    hooks_dir: Optional[Path],
    skills_dir: Optional[Path],
    verbose: bool = False,
) -> None:
    """
    Copy the bundled openhive-inject hook directory and openhive skill directory
    into the target OpenClaw installation.

    Hook:  openhive-inject/ (handler.js ES module, fires on agent:bootstrap,
           injects OPENHIVE_INSTRUCTIONS.md into every agent turn)

    Skill: openhive/ (SKILL.md — CLI command reference; agents never see SSTP)
    """
    data_dir = _openclaw_data_dir()

    if hooks_dir:
        hooks_dir.mkdir(parents=True, exist_ok=True)
        src_hook = data_dir / "hooks" / _OPENCLAW_HOOK_NAME
        dst_hook = hooks_dir / _OPENCLAW_HOOK_NAME
        if dst_hook.exists():
            shutil.rmtree(dst_hook)
        shutil.copytree(src_hook, dst_hook)
        if verbose:
            typer.echo(f"  wrote hook: {dst_hook}/")

    if skills_dir:
        skills_dir.mkdir(parents=True, exist_ok=True)
        src_skill = data_dir / "skills" / _OPENCLAW_SKILL_NAME
        dst_skill = skills_dir / _OPENCLAW_SKILL_NAME
        if dst_skill.exists():
            shutil.rmtree(dst_skill)
        shutil.copytree(src_skill, dst_skill)
        if verbose:
            typer.echo(f"  wrote skill: {dst_skill}/")


def _uninstall_openclaw(adapter_record: dict) -> None:
    """Remove OpenHive hook and skill directories from an OpenClaw installation."""
    hooks_dir = adapter_record.get("hooks_dir")
    if hooks_dir:
        p = Path(hooks_dir) / _OPENCLAW_HOOK_NAME
        if p.exists():
            shutil.rmtree(p)

    skills_dir = adapter_record.get("skills_dir")
    if skills_dir:
        p = Path(skills_dir) / _OPENCLAW_SKILL_NAME
        if p.exists():
            shutil.rmtree(p)


def _check_adapter_status(name: str, info: dict) -> dict:
    """Run health checks for a registered adapter."""
    details: list[str] = []
    ok = True

    if name == "openclaw":
        hooks_dir = info.get("hooks_dir")
        if hooks_dir:
            hook = Path(hooks_dir) / _OPENCLAW_HOOK_NAME / "handler.js"
            if hook.exists():
                details.append(f"hook installed: {hook.parent}/")
            else:
                details.append(f"hook missing: {hook.parent}/")
                ok = False

        skills_dir = info.get("skills_dir")
        if skills_dir:
            skill = Path(skills_dir) / _OPENCLAW_SKILL_NAME / "SKILL.md"
            if skill.exists():
                details.append(f"skill installed: {skill.parent}/")
            else:
                details.append(f"skill missing: {skill.parent}/")
                ok = False

    cfn_url = info.get("cfn_url", "")
    details.append(f"cfn_url: {cfn_url}")

    return {"ok": ok, "details": details}
