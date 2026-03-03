"""
Install command for OpenHive CLI.

Phases:
  1. Hex animation + real system checks
  2. Interactive prompts (profile, LLM config)
  3. Real docker compose up (streaming output)
  4. Health polling
  5. Config write to ~/.openhive/config.toml
"""

import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import typer

from openhive.error_handler import print_error

LOG_WINDOW = 4

# Public images that are always pulled regardless of profile.
# Pulling these during the animation means compose-up is faster.
_PUBLIC_IMAGES = [
    ("postgres:17-alpine",                        "postgres"),
    ("skaiworldwide/agensgraph:v2.16.0-alpine3.22", "graph DB (AgensGraph)"),
    ("skaiworldwide/agviewer:latest",             "graph DB viewer"),
]


def _check_docker() -> tuple[bool, str]:
    try:
        r = subprocess.run(
            ["docker", "version", "--format", "{{.Server.Version}}"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0:
            return True, r.stdout.strip()
        return False, "docker daemon not running"
    except FileNotFoundError:
        return False, "docker not found — install Docker Desktop"
    except Exception as e:
        return False, str(e)


def _check_compose() -> tuple[bool, str]:
    try:
        r = subprocess.run(
            ["docker", "compose", "version", "--short"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0:
            return True, r.stdout.strip()
        return False, "docker compose v2 not available"
    except Exception as e:
        return False, str(e)


def _check_ports(ports: list[int]) -> list[int]:
    """Return list of ports that are already in use."""
    busy = []
    for port in ports:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.3)
            if s.connect_ex(("localhost", port)) == 0:
                busy.append(port)
    return busy


def _check_disk(min_mb: int = 500) -> tuple[bool, str]:
    usage = shutil.disk_usage(Path.home())
    free_mb = usage.free // (1024 * 1024)
    return free_mb >= min_mb, f"{free_mb:,} MB free"


# ── Interactive prompts ──────────────────────────────────────────────────────

def _ask(prompt: str, default: str = "") -> str:
    """Read a line; raise KeyboardInterrupt on Ctrl+C/Ctrl+D/q/Q/Escape."""
    try:
        raw = input(prompt)
    except (EOFError, KeyboardInterrupt):
        raise KeyboardInterrupt
    stripped = raw.strip()
    if stripped.lower() in ("q", "quit", "exit") or stripped.startswith("\x1b"):
        raise KeyboardInterrupt
    return stripped or default


def _prompt_profile() -> str:
    print()
    print("  \x1b[1;36m? Deployment profile\x1b[0m")
    print()
    options = [
        ("1", "full",  "OpenHive + CFN control plane + knowledge graph"),
        ("2", "core",  "OpenHive only (no CFN)"),
    ]
    for key, name, desc in options:
        marker = "\x1b[36m▸\x1b[0m" if key == "1" else " "
        default_tag = " \x1b[2m(default)\x1b[0m" if key == "1" else ""
        print(f"    {marker} \x1b[1m{key})\x1b[0m {name}  — {desc}{default_tag}")
    print()
    choice = _ask("  \x1b[2mChoice [1]:\x1b[0m ", default="1")
    profile = "cfn" if choice == "1" else "core"
    label = options[0][2] if choice == "1" else options[1][2]
    print(f"  \x1b[32m✓\x1b[0m {label}")
    print()
    return profile


def _prompt_llm() -> dict[str, str]:
    print()
    print("  \x1b[1;36m? LLM configuration (for CognitiveEngine)\x1b[0m")
    print()
    print("    \x1b[36m▸\x1b[0m \x1b[1m1)\x1b[0m Bedrock proxy  — uses Claude Code local proxy at :8099  \x1b[2m(default)\x1b[0m")
    print("      \x1b[1m2)\x1b[0m Anthropic API key")
    print("      \x1b[1m3)\x1b[0m Skip — stub mode (no real LLM)")
    print()
    choice = _ask("  \x1b[2mChoice [1]:\x1b[0m ", default="1")

    if choice == "2":
        key = _ask("  \x1b[2mAnthropic API key (sk-ant-...):\x1b[0m ")
        print("  \x1b[32m✓\x1b[0m Anthropic API key configured")
        return {"ANTHROPIC_API_KEY": key, "COORDINATION_LLM_MODEL": "claude-sonnet-4-6"}
    elif choice == "3":
        print("  \x1b[33m~\x1b[0m Skipped — coordination will use stub responses")
        return {}
    else:
        print("  \x1b[32m✓\x1b[0m Bedrock proxy at http://host.docker.internal:8099/")
        return {
            "ANTHROPIC_BASE_URL": "http://host.docker.internal:8099/",
            "ANTHROPIC_AUTH_TOKEN": "",
            "COORDINATION_LLM_MODEL": "bedrock/global.anthropic.claude-sonnet-4-6",
        }


# ── Env file ─────────────────────────────────────────────────────────────────

def _write_env_file(env_path: Path, llm_config: dict[str, str]) -> None:
    import importlib.resources
    defaults_ref = importlib.resources.files("openhive.docker") / ".env.defaults"
    defaults_text = defaults_ref.read_text(encoding="utf-8")

    lines = []
    for line in defaults_text.splitlines():
        key = line.split("=")[0].strip() if "=" in line else None
        if key and key in llm_config:
            lines.append(f"{key}={llm_config[key]}")
        else:
            lines.append(line)

    # Append any new keys from llm_config not already in defaults
    existing_keys = {l.split("=")[0].strip() for l in lines if "=" in l}
    for key, value in llm_config.items():
        if key not in existing_keys:
            lines.append(f"{key}={value}")

    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ── Docker compose ────────────────────────────────────────────────────────────

def _get_compose_path() -> Path:
    """
    Resolve the canonical compose file path.

    For editable installs (dev), walk up from the package source to find the
    repo's services/docker-compose.yml — this keeps build context relative
    paths (../cfn/..., ../fastapi-backend) correct.

    For non-editable installs, extract the bundled compose to ~/.openhive/docker/.
    Build contexts won't work in that case, but pull-only services will.
    """
    import importlib.resources
    import os

    if env_path := os.getenv("OPENHIVE_COMPOSE_FILE"):
        return Path(env_path)

    # Walk up from package location to find services/docker-compose.yml
    try:
        pkg_path = Path(str(importlib.resources.files("openhive")))
        for depth in range(2, 7):
            candidate = pkg_path.parents[depth] / "services" / "docker-compose.yml"
            if candidate.exists():
                return candidate
    except Exception:
        pass

    # Fallback: extract bundled compose (relative build paths will be wrong)
    compose_ref = importlib.resources.files("openhive.docker") / "compose.yml"
    dest = Path.home() / ".openhive" / "docker" / "compose.yml"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(compose_ref.read_bytes())
    return dest


def _compose_up(compose_path: Path, env_path: Path, profile: str) -> bool:
    args = [
        "docker", "compose",
        "-f", str(compose_path),
        "--env-file", str(env_path),
    ]
    if profile == "cfn":
        args += ["--profile", "cfn"]

    args += ["up", "--pull", "missing", "--build", "-d"]

    print()
    typer.secho("  Running: " + " ".join(args[2:]), dim=True)
    print()

    result = subprocess.run(args, text=True)
    return result.returncode == 0


def _wait_for_health(urls: list[str], timeout: int = 120) -> bool:
    try:
        import httpx
    except ImportError:
        return True  # skip if httpx not available

    deadline = time.time() + timeout
    pending = list(urls)

    sys.stdout.write(f"  Waiting for services to become healthy")
    sys.stdout.flush()

    while pending and time.time() < deadline:
        time.sleep(3)
        sys.stdout.write(".")
        sys.stdout.flush()
        still_pending = []
        for url in pending:
            try:
                r = httpx.get(url, timeout=3)
                if r.status_code < 500:
                    continue
            except Exception:
                pass
            still_pending.append(url)
        pending = still_pending

    print()
    if pending:
        typer.secho(f"  ⚠  Timed out waiting for: {', '.join(pending)}", fg=typer.colors.YELLOW)
        return False
    return True


# ── Config write ─────────────────────────────────────────────────────────────

def _write_openhive_config(profile: str) -> None:
    from openhive.config import OpenHiveConfig, ServerConfig

    config_path = OpenHiveConfig.get_global_config_path()
    try:
        config = OpenHiveConfig.load(config_path) if config_path.exists() else OpenHiveConfig()
    except Exception:
        config = OpenHiveConfig()

    config.server = ServerConfig(
        api_url="http://localhost:8000",
        cfn_url="http://localhost:9000" if profile == "cfn" else config.server.cfn_url,
    )
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config.save(config_path)


# ── Animation helper ──────────────────────────────────────────────────────────


# ── Main ─────────────────────────────────────────────────────────────────────

def install(
    ctx: typer.Context,
    ascii_: bool = typer.Option(False, "--ascii", help="Use ASCII rendering"),
    blocks: bool = typer.Option(False, "--blocks", help="Use unicode block rendering"),
    theme: str = typer.Option("cyan", "--color", help="Color theme (cyan|amber|magenta|green|white)"),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmations"),
) -> None:
    """
    Install an OpenHive instance.

    Checks system requirements, prompts for configuration, then brings up
    all services via docker compose.
    """
    try:
        from openhive.animations import run_animation_live

        mode = "ascii" if ascii_ else "blocks" if blocks else "braille"

        # ── Phase 1: System checks + public image pulls (animation runs live) ─
        docker_ok, docker_ver = _check_docker()
        compose_ok, compose_ver = _check_compose()
        disk_ok, disk_info = _check_disk()

        ok   = "\x1b[32m✓\x1b[0m"
        err  = "\x1b[31m✗\x1b[0m"
        spin = "\x1b[2m⟳\x1b[0m"

        header_lines = [
            "",
            "  \x1b[1mInstalling OpenHive...\x1b[0m",
            "",
            f"    {ok if docker_ok  else err} docker {docker_ver}",
            f"    {ok if compose_ok else err} docker compose {compose_ver}",
            f"    {ok if disk_ok    else err} disk {disk_info}",
            "",
            "  \x1b[1mPulling base images\x1b[0m",
            "",
        ]
        # One slot per image — updated in-place by the pull thread.
        image_lines: list[str] = [f"    {spin} {label}" for _, label in _PUBLIC_IMAGES]
        # Sliding window of recent pull output lines.
        log_window: list[str] = []

        done = threading.Event()

        # Honor DOCKER_DEFAULT_PLATFORM from the env defaults so pre-pulled
        # images match the platform compose will use.
        import importlib.resources as _ir
        import os as _os
        _pull_platform = _os.getenv("DOCKER_DEFAULT_PLATFORM", "")
        if not _pull_platform:
            try:
                _defaults = (_ir.files("openhive.docker") / ".env.defaults").read_text()
                for _ln in _defaults.splitlines():
                    if _ln.startswith("DOCKER_DEFAULT_PLATFORM="):
                        _pull_platform = _ln.split("=", 1)[1].strip()
                        break
            except Exception:
                pass

        def _do_pulls() -> None:
            nonlocal log_window
            for i, (image, label) in enumerate(_PUBLIC_IMAGES):
                image_lines[i] = f"    {spin} {label}  \x1b[2mpulling…\x1b[0m"
                log_window = []
                cmd = ["docker", "pull"]
                if _pull_platform:
                    cmd += ["--platform", _pull_platform]
                cmd.append(image)
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True,
                )
                assert proc.stdout
                for raw in proc.stdout:
                    text = raw.strip()
                    if text:
                        log_window = (log_window + [f"      \x1b[2m> {text}\x1b[0m"])[-LOG_WINDOW:]
                proc.wait()
                if proc.returncode == 0:
                    image_lines[i] = f"    {ok} {label}"
                else:
                    image_lines[i] = f"    {err} {label}  \x1b[2m(will retry during compose up)\x1b[0m"
                log_window = []
            done.set()

        pull_thread = threading.Thread(target=_do_pulls, daemon=True)
        pull_thread.start()

        def _get_lines() -> list[str]:
            return header_lines + image_lines + ([""] + log_window if log_window else [])

        run_animation_live(
            get_lines=_get_lines,
            done=done,
            height=18, theme=theme, fill=0.15, mode=mode,
            rain=True, wipe=True, linger=0.4,
        )
        pull_thread.join()

        if not docker_ok:
            typer.secho(f"\n  ✗ Docker: {docker_ver}", fg=typer.colors.RED)
            typer.echo("  Install Docker Desktop: https://docs.docker.com/get-docker/")
            raise typer.Exit(1) from None

        if not compose_ok:
            typer.secho(f"\n  ✗ Docker Compose: {compose_ver}", fg=typer.colors.RED)
            raise typer.Exit(1) from None

        # ── Phase 2: Interactive prompts ──────────────────────────────────
        profile = _prompt_profile()
        llm_config = _prompt_llm()

        # Port check after profile selection
        core_ports = [5432, 8000]
        cfn_ports = [5433, 5456, 5457, 9000, 9001, 9002, 9003]
        ports_to_check = core_ports + (cfn_ports if profile == "cfn" else [])
        busy_ports = _check_ports(ports_to_check)
        if busy_ports:
            typer.secho(f"\n  ⚠  Ports already in use: {busy_ports}", fg=typer.colors.YELLOW)
            typer.echo("  Stop conflicting services before installing.")
            if not yes:
                ans = _ask("  Continue anyway? [y/N]: ", default="n")
                if ans.lower() not in ("y", "yes"):
                    raise KeyboardInterrupt

        # ── Phase 3: Write env, bring up services ─────────────────────────
        print()
        typer.secho("  ── Starting services ──────────────────────────────────", bold=True)

        env_dir = Path.home() / ".openhive"
        env_dir.mkdir(parents=True, exist_ok=True)
        env_path = env_dir / ".env"

        # Don't clobber existing .env — merge LLM config in
        if not env_path.exists():
            _write_env_file(env_path, llm_config)
            typer.echo(f"  ✓ Wrote {env_path}")
        else:
            typer.echo(f"  ~ Using existing {env_path}")

        compose_path = _get_compose_path()
        typer.echo(f"  ✓ Compose file → {compose_path}")

        ok = _compose_up(compose_path, env_path, profile)
        if not ok:
            typer.secho("\n  ✗ docker compose up failed", fg=typer.colors.RED)
            raise typer.Exit(1) from None

        # ── Phase 4: Health checks ─────────────────────────────────────────
        health_urls = ["http://localhost:8000/health"]
        if profile == "cfn":
            health_urls.append("http://localhost:9000/health")

        print()
        _wait_for_health(health_urls)

        # ── Phase 5: Write config ──────────────────────────────────────────
        _write_openhive_config(profile)
        typer.secho("  ✓ Config written to ~/.openhive/config.toml", fg=typer.colors.GREEN)

        # ── Done ───────────────────────────────────────────────────────────
        print()
        typer.secho("  OpenHive is ready.", fg=typer.colors.GREEN, bold=True)
        print()
        typer.echo("  Services:")
        typer.echo("    openhive-backend  → http://localhost:8000")
        if profile == "cfn":
            typer.echo("    ioc-cfn-mgmt      → http://localhost:9000")
            typer.echo("    ioc-cfn-mgmt-ui   → http://localhost:9001")
            typer.echo("    ioc-cfn-svc       → http://localhost:9002")
            typer.echo("    knowledge-memory  → http://localhost:9003")
            typer.echo("    graph-db-viewer   → http://localhost:5457")
        print()
        typer.echo("  Next steps:")
        typer.echo("    openhive room create <name>   # create your first room")
        typer.echo("    openhive onboard              # register your identity")
        print()

    except KeyboardInterrupt:
        sys.stdout.write("\x1b[0m\x1b[?25h\n")
        sys.stdout.flush()
        typer.secho("  Cancelled.", fg=typer.colors.YELLOW)
        raise typer.Exit(0) from None
    except typer.Exit:
        raise
    except Exception as e:
        verbose = ctx.obj.get("verbose", False) if ctx.obj else False
        print_error(e, verbose=verbose)
        raise typer.Exit(1) from None
