"""
Configuration management for OpenHive CLI.

Supports two config locations (like git):
1. Global: ~/.openhive/config.toml - identity, server settings
2. Project-local: ./.openhive/config.toml - room settings

Load priority (highest to lowest):
1. Command-line flags
2. Environment variables
3. Project-local config (./.openhive/)
4. Global config (~/.openhive/)
5. Defaults
"""

import os
from pathlib import Path
from typing import Any

import toml
from pydantic import BaseModel, Field, field_validator


class IdentityConfig(BaseModel):
    """Agent identity configuration."""

    name: str | None = Field(
        default=None,
        description="Display name chosen by user",
    )
    machine_id: str | None = Field(
        default=None,
        description="Stable UUID for machine affinity (generated on first use)",
    )
    autonomous: bool = Field(
        default=False,
        description="True when running as an autonomous agent",
    )


class ServerConfig(BaseModel):
    """Server connection configuration."""

    api_url: str = Field(
        default="http://localhost:8000",
        description="OpenHive backend API URL",
    )
    cfn_url: str = Field(
        default="http://localhost:9000",
        description="CFN management backend URL",
    )
    token: str | None = Field(
        default=None,
        description="JWT authentication token",
    )

    @field_validator("api_url", "cfn_url")
    @classmethod
    def validate_url(cls, v: str) -> str:
        """Ensure URLs don't have trailing slashes."""
        return v.rstrip("/")


class RoomConfig(BaseModel):
    """Room management configuration."""

    active: str | None = Field(
        default=None,
        description="Currently active room name",
    )


class OpenHiveConfig(BaseModel):
    """Complete OpenHive CLI configuration."""

    identity: IdentityConfig = Field(default_factory=IdentityConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)
    rooms: RoomConfig = Field(default_factory=RoomConfig)
    adapters: dict[str, Any] = Field(
        default_factory=dict,
        description="Registered agent framework adapters (openclaw, cursor, claude-code, …)",
    )

    model_config = {"arbitrary_types_allowed": True}
    _global_config_path: Path | None = None
    _project_config_path: Path | None = None

    @classmethod
    def get_global_config_dir(cls) -> Path:
        """Get the global configuration directory (~/.openhive/)."""
        return Path.home() / ".openhive"

    @classmethod
    def get_global_config_path(cls) -> Path:
        """Get the global configuration file path."""
        return cls.get_global_config_dir() / "config.toml"

    @classmethod
    def get_logs_dir(cls) -> Path:
        """Get the logs directory (~/.openhive/logs/)."""
        logs_dir = cls.get_global_config_dir() / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        return logs_dir

    @classmethod
    def get_project_config_dir(cls) -> Path:
        """Get the project-local configuration directory (./.openhive/)."""
        return Path.cwd() / ".openhive"

    @classmethod
    def get_project_config_path(cls) -> Path:
        """Get the project-local configuration file path."""
        return cls.get_project_config_dir() / "config.toml"

    @classmethod
    def find_project_config(cls) -> Path | None:
        """Find project-local .openhive/ by walking up directory tree."""
        global_dir = cls.get_global_config_dir()
        current = Path.cwd()
        while current != current.parent:
            config_path = current / ".openhive" / "config.toml"
            if config_path.exists() and config_path.parent != global_dir:
                return config_path
            current = current.parent
        return None

    @classmethod
    def has_project_config(cls) -> bool:
        """Check if project-local .openhive/ exists."""
        return cls.find_project_config() is not None

    @classmethod
    def get_config_path(cls) -> Path:
        """Get the configuration file path (prefers project-local)."""
        project_config = cls.find_project_config()
        return project_config if project_config else cls.get_global_config_path()

    @classmethod
    def get_config_dir(cls) -> Path:
        """Get the configuration directory path (prefers project-local)."""
        project_config = cls.find_project_config()
        if project_config:
            return project_config.parent
        return cls.get_global_config_dir()

    @classmethod
    def load(cls, config_path: Path | None = None) -> "OpenHiveConfig":
        """Load configuration from global and project-local files."""
        config_dict: dict[str, Any] = {}

        if config_path is not None:
            if config_path.exists():
                with open(config_path) as f:
                    config_dict = toml.load(f)
            global_path = config_path
            project_path = None
        else:
            global_path = cls.get_global_config_path()
            if global_path.exists():
                with open(global_path) as f:
                    config_dict = toml.load(f)

            project_path = cls.find_project_config()
            if project_path and project_path.exists():
                with open(project_path) as f:
                    project_dict = toml.load(f)
                config_dict = cls._deep_merge(config_dict, project_dict)

        env_overrides = cls._load_from_env()
        config_dict = cls._deep_merge(config_dict, env_overrides)

        instance = cls(**config_dict)
        instance._global_config_path = global_path
        instance._project_config_path = project_path
        return instance

    @classmethod
    def _load_from_env(cls) -> dict[str, Any]:
        """Load configuration overrides from environment variables."""
        env_config: dict[str, Any] = {"server": {}, "rooms": {}}

        if api_url := os.getenv("OPENHIVE_API_URL"):
            env_config["server"]["api_url"] = api_url
        if cfn_url := os.getenv("OPENHIVE_CFN_URL"):
            env_config["server"]["cfn_url"] = cfn_url
        if token := os.getenv("OPENHIVE_API_TOKEN"):
            env_config["server"]["token"] = token
        if active_room := os.getenv("OPENHIVE_ACTIVE_ROOM"):
            env_config["rooms"]["active"] = active_room

        return env_config

    @classmethod
    def _deep_merge(cls, base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
        """Deep merge two dictionaries."""
        result = base.copy()
        for key, value in override.items():
            if key in result and isinstance(result[key], dict) and isinstance(value, dict):
                result[key] = cls._deep_merge(result[key], value)
            elif value is not None:
                result[key] = value
        return result

    def save(self, config_path: Path | None = None) -> None:
        """Save configuration to appropriate files."""
        config_dict = self.model_dump(mode="json", exclude_none=True)

        if config_path is not None:
            config_path.parent.mkdir(parents=True, exist_ok=True)
            with open(config_path, "w") as f:
                toml.dump(config_dict, f)
            return

        global_path = self._global_config_path or self.get_global_config_path()
        global_path.parent.mkdir(parents=True, exist_ok=True)

        if self._project_config_path:
            global_dict = {
                k: v for k, v in config_dict.items() if k in ("identity", "server", "adapters")
            }
            project_dict = {
                k: v for k, v in config_dict.items() if k in ("identity", "rooms")
            }
            with open(self._project_config_path, "w") as f:
                toml.dump(project_dict, f)
        else:
            global_dict = config_dict

        with open(global_path, "w") as f:
            toml.dump(global_dict, f)

    def save_to_project(self, project_dir: Path | None = None) -> None:
        """Save room settings to project-local .openhive/."""
        if project_dir is None:
            project_dir = Path.cwd()

        config_dir = project_dir / ".openhive"
        config_path = config_dir / "config.toml"
        config_dir.mkdir(parents=True, exist_ok=True)

        config_dict = self.model_dump(mode="json", exclude_none=True)
        project_dict = {k: v for k, v in config_dict.items() if k in ("identity", "rooms")}

        with open(config_path, "w") as f:
            toml.dump(project_dict, f)

        self._project_config_path = config_path

    def init_project(self, project_dir: Path | None = None, room_name: str | None = None) -> Path:
        """Initialize a project-local .openhive/ directory."""
        if project_dir is None:
            existing = self.find_project_config()
            if existing:
                project_dir = existing.parent.parent
            else:
                project_dir = Path.cwd()

        config_dir = project_dir / ".openhive"
        config_dir.mkdir(parents=True, exist_ok=True)

        if room_name:
            self.rooms.active = room_name

        self.save_to_project(project_dir)
        return config_dir

    def get_active_room(self) -> str | None:
        """Get the currently active room."""
        return self.rooms.active

    def set_active_room(self, room_name: str) -> None:
        """Set the active room and save configuration."""
        self.rooms.active = room_name
        self.save()

    def clear_active_room(self) -> None:
        """Clear the active room setting."""
        self.rooms.active = None
        self.save()

    def get_current_identity(self) -> str:
        """Get the current identity handle for attribution."""
        from openhive.identity import get_current_handle

        try:
            handle = get_current_handle(self)
            if handle:
                return handle
        except Exception:
            pass

        if self.identity.name:
            return self.identity.name
        return "unknown"
