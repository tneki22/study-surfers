import os
import sys
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def resource_root() -> Path:
    """Ресурсы внутри PyInstaller и в рабочем каталоге имеют одинаковую структуру."""
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))


ROOT = resource_root()


def default_data_dir() -> Path:
    if getattr(sys, "frozen", False):
        local = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
        return local / "StudySurfers" / "data"
    return ROOT / "data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SS_")
    data_dir: Path = Field(default_factory=default_data_dir)
    port: int = 8765
    public_host: str | None = None
    tentex_root: Path = Path.home() / "Desktop" / "Tentex"
    secret_key: str | None = None
    tentex_secret_key: str | None = None
    seed_demo: bool = True
    ai_timeout_seconds: float = 180
    min_playable_items: int = 8
    concurrency: int = 4
    confirm_cost_usd: float = 1.0
    confirm_input_tokens: int = 1_500_000
    operation_limit_usd: float | None = None

    @property
    def installation_secret_path(self) -> Path:
        return self.data_dir / "installation.secret"


@lru_cache
def get_settings() -> Settings:
    return Settings()
