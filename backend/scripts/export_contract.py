import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.main import app  # noqa: E402


def export_contract():
    folder = ROOT / "contract"
    folder.mkdir(exist_ok=True)
    (folder / "openapi.json").write_text(
        json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    try:
        from app.decks.schemas import DeckFile
    except ImportError:
        return
    (folder / "deck.schema.json").write_text(
        json.dumps(DeckFile.model_json_schema(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    export_contract()
