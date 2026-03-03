"""
Instance management commands for OpenHive CLI.

Commands for managing local OpenHive instances:
- init: Initialize configuration
- install: Pull and start all services via docker compose
- start: Start core OpenHive services (db + backend)
- stop: Stop services
- status: Show service health
- logs: View service logs
"""

import subprocess
from pathlib import Path

import typer

from openhive.config import OpenHiveConfig, ServerConfig
from openhive.error_handler import print_error
from openhive.exceptions import ConfigNotFoundError
from openhive.http_client import OpenHiveHTTPClient

app = typer.Typer(help="Instance management commands")


def _get_compose_path() -> Path:
    """
    Resolve docker-compose file path.

    Priority:
      1. OPENHIVE_COMPOSE_FILE env var
      2. Walk up from package location to find repo's services/docker-compose.yml
         (editable installs — keeps relative build contexts correct)
      3. ~/.openhive/docker/compose.yml  (extracted by openhive install)
      4. Bundled in CLI package          (extracted on demand; build contexts broken)
    """
    import importlib.resources
    import os

    if env_path := os.getenv("OPENHIVE_COMPOSE_FILE"):
        return Path(env_path)

    # Walk up from package source to find repo's services/docker-compose.yml
    try:
        pkg_path = Path(str(importlib.resources.files("openhive")))
        for depth in range(2, 7):
            candidate = pkg_path.parents[depth] / "services" / "docker-compose.yml"
            if candidate.exists():
                return candidate
    except Exception:
        pass

    installed = Path.home() / ".openhive" / "docker" / "compose.yml"
    if installed.exists():
        return installed

    # Extract bundled compose to stable location (fallback; build contexts will be wrong)
    try:
        compose_ref = importlib.resources.files("openhive.docker") / "compose.yml"
        installed.parent.mkdir(parents=True, exist_ok=True)
        installed.write_bytes(compose_ref.read_bytes())
        return installed
    except Exception:
        pass

    return Path.cwd() / "services" / "docker-compose.yml"


def _get_env_path() -> Path | None:
    env_path = Path.home() / ".openhive" / ".env"
    return env_path if env_path.exists() else None


def init(
    ctx: typer.Context,
    api_url: str | None = typer.Option(
        None,
        "--api-url",
        help="Backend API URL (default: http://localhost:8000)",
    ),
    cfn_url: str | None = typer.Option(
        None,
        "--cfn-url",
        help="CFN management backend URL (default: http://localhost:9000)",
    ),
    force: bool = typer.Option(
        False,
        "--force",
        "-f",
        help="Overwrite existing configuration",
    ),
) -> None:
    """
    Initialize OpenHive configuration.

    Creates ~/.openhive/config.toml with default settings.
    """
    try:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        config_path = OpenHiveConfig.get_config_path()

        if config_path.exists() and not force:
            typer.secho(
                f"Configuration already exists at {config_path}",
                fg=typer.colors.GREEN,
            )
            typer.echo("")
            typer.echo("Use --force to overwrite existing configuration")
            return

        if api_url is None:
            api_url = typer.prompt(
                "Backend API URL",
                default="http://localhost:8000",
                show_default=True,
            )
        if cfn_url is None:
            cfn_url = typer.prompt(
                "CFN management backend URL",
                default="http://localhost:9000",
                show_default=True,
            )

        assert api_url is not None
        assert cfn_url is not None

        config = OpenHiveConfig(
            server=ServerConfig(
                api_url=api_url,
                cfn_url=cfn_url,
            )
        )
        config.save(config_path)

        typer.secho(f"Created configuration at {config_path}", fg=typer.colors.GREEN)
        typer.echo("")
        typer.echo("Configuration:")
        typer.echo(f"  API URL: {api_url}")
        typer.echo(f"  CFN URL: {cfn_url}")
        typer.echo("")
        typer.echo("Next steps:")
        typer.echo("  - Run 'openhive install' to pull and start all services")
        typer.echo("  - Run 'openhive status' to check service health")

    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)




def start(
    ctx: typer.Context,
    cfn: bool = typer.Option(False, "--cfn", help="Also start CFN services"),
    build: bool = typer.Option(False, "--build", help="Rebuild images before starting"),
) -> None:
    """
    Start OpenHive services.

    Runs docker compose up -d using the bundled compose file and
    ~/.openhive/.env for configuration.

    Examples:
        openhive up           # core only (openhive-db + openhive-backend)
        openhive up --cfn     # core + full CFN stack
        openhive up --build   # rebuild images first
    """
    try:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        compose_path = _get_compose_path()
        env_path = _get_env_path()

        if not compose_path.exists():
            typer.secho(f"Compose file not found at {compose_path}", fg=typer.colors.RED)
            typer.echo("Run 'openhive install' first.")
            raise typer.Exit(1)

        cmd = ["docker", "compose", "-f", str(compose_path)]
        if env_path:
            cmd += ["--env-file", str(env_path)]
        if cfn:
            cmd += ["--profile", "cfn"]
        cmd += ["up", "-d"]
        if build:
            cmd.append("--build")

        label = "core + CFN" if cfn else "core"
        typer.echo(f"Starting OpenHive ({label})...")
        result = subprocess.run(cmd, check=False)
        if result.returncode != 0:
            raise typer.Exit(result.returncode)

        typer.secho("Services started.", fg=typer.colors.GREEN)
        typer.echo("  openhive-backend  → http://localhost:8000")
        if cfn:
            typer.echo("  ioc-cfn-mgmt      → http://localhost:9000")
            typer.echo("  ioc-cfn-mgmt-ui   → http://localhost:9001")

    except typer.Exit:
        raise
    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)


def stop(
    ctx: typer.Context,
    volumes: bool = typer.Option(False, "--volumes", "-v", help="Also remove volumes (destructive)"),
) -> None:
    """
    Stop OpenHive services.

    Examples:
        openhive down             # stop containers, keep volumes
        openhive down --volumes   # stop and delete all data
    """
    try:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        compose_path = _get_compose_path()
        env_path = _get_env_path()

        if not compose_path.exists():
            typer.secho(f"Compose file not found at {compose_path}", fg=typer.colors.RED)
            raise typer.Exit(1)

        cmd = ["docker", "compose", "-f", str(compose_path)]
        if env_path:
            cmd += ["--env-file", str(env_path)]
        cmd += ["--profile", "cfn", "down"]
        if volumes:
            cmd.append("-v")

        typer.echo("Stopping OpenHive services...")
        result = subprocess.run(cmd, check=False)
        if result.returncode != 0:
            raise typer.Exit(result.returncode)

        typer.secho("Services stopped.", fg=typer.colors.GREEN)

    except typer.Exit:
        raise
    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)


def status(ctx: typer.Context) -> None:
    """
    Show service health.

    Checks if OpenHive backend is running and accessible.
    """
    try:
        import httpx

        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        json_output = ctx.obj.get("json", False) if ctx.obj else False

        config_path = OpenHiveConfig.get_config_path()
        if not config_path.exists():
            raise ConfigNotFoundError(str(config_path))

        config = OpenHiveConfig.load()

        # Check backend health
        backend_running = False
        backend_room_count = 0
        with OpenHiveHTTPClient(config=config) as client:
            try:
                response = client.get("/rooms")
                rooms = response.json()
                backend_running = True
                backend_room_count = len(rooms) if isinstance(rooms, list) else 0
            except Exception:
                backend_running = False

        # Check CFN mgmt backend
        cfn_running = False
        try:
            with httpx.Client(timeout=5.0) as http:
                response = http.get(f"{config.server.cfn_url}/health")
                cfn_running = response.status_code < 400
        except Exception:
            cfn_running = False

        def status_str(running: bool) -> tuple[str, str]:
            return ("Running", typer.colors.GREEN) if running else ("Not running", typer.colors.RED)

        backend_status, backend_color = status_str(backend_running)
        cfn_status, cfn_color = status_str(cfn_running)

        if json_output:
            import json
            output = {
                "services": {
                    "backend": {
                        "url": config.server.api_url,
                        "running": backend_running,
                        "room_count": backend_room_count,
                    },
                    "cfn": {
                        "url": config.server.cfn_url,
                        "running": cfn_running,
                    },
                },
                "config": {
                    "path": str(config_path),
                    "api_url": config.server.api_url,
                    "active_room": config.get_active_room(),
                },
            }
            typer.echo(json.dumps(output, indent=2))
        else:
            typer.secho("OpenHive Status", bold=True)
            typer.echo("")
            typer.echo("Services:")
            typer.secho(f"  Backend:   {backend_status}", fg=backend_color)
            typer.echo(f"             {config.server.api_url}")
            if backend_running and backend_room_count > 0:
                typer.echo(f"             {backend_room_count} rooms")
            typer.secho(f"  CFN:       {cfn_status}", fg=cfn_color)
            typer.echo(f"             {config.server.cfn_url}")
            typer.echo("")
            typer.echo("Configuration:")
            typer.echo(f"  Path:        {config_path}")
            if config.get_active_room():
                typer.echo(f"  Active Room: {config.get_active_room()}")
            typer.echo("")
            all_running = backend_running
            if all_running:
                typer.secho("Backend healthy", fg=typer.colors.GREEN)
            else:
                typer.secho("Backend is down", fg=typer.colors.YELLOW)
                typer.echo("\nTo start services:")
                typer.echo("  openhive start")

    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)


def logs(
    ctx: typer.Context,
    service: str | None = typer.Argument(None, help="Service name (e.g. openhive-backend, ioc-cfn-mgmt-plane-svc)"),
    follow: bool = typer.Option(False, "--follow", "-f", help="Follow log output"),
    tail: int | None = typer.Option(None, "--tail", help="Number of lines to show from the end"),
) -> None:
    """View service logs via docker compose."""
    try:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False  # noqa: F841
        compose_path = _get_compose_path()
        env_path = _get_env_path()

        cmd = ["docker", "compose", "-f", str(compose_path)]
        if env_path:
            cmd += ["--env-file", str(env_path)]
        cmd += ["--profile", "cfn", "logs"]
        if follow:
            cmd.append("-f")
        if tail is not None:
            cmd.extend(["--tail", str(tail)])
        if service:
            cmd.append(service)

        subprocess.run(cmd, check=False)

    except typer.Exit:
        raise
    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)
