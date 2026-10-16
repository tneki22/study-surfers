#!/usr/bin/env bash
# Запуск Study Surfers на macOS и Linux.
#   ./start.sh         — собрать интерфейс и запустить игру (http://127.0.0.1:8765)
#   ./start.sh --dev   — режим разработки: Vite с горячей перезагрузкой (http://127.0.0.1:5180)
#   ./start.sh --no-browser — не открывать браузер
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV=0
OPEN_BROWSER=1
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=1 ;;
    --no-browser) OPEN_BROWSER=0 ;;
    *) echo "Неизвестный параметр: $arg" >&2; exit 2 ;;
  esac
done
export PYTHONUTF8=1

fail() { echo "Не удалось запустить Study Surfers: $*" >&2; exit 1; }

VENV="$ROOT/backend/.venv"
PY="$VENV/bin/python"
if [ ! -x "$PY" ]; then
  BASE=""
  for candidate in python3.12 python3.13 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      version="$("$candidate" -c 'import sys; print(*sys.version_info[:2], sep=".")' 2>/dev/null || true)"
      if [ "$version" = "3.12" ] || [ "$version" = "3.13" ]; then BASE="$candidate"; break; fi
    fi
  done
  [ -n "$BASE" ] || fail "нужен Python 3.12 или 3.13 (https://www.python.org/downloads/)"
  "$BASE" -m venv "$VENV" || fail "не получилось создать окружение (в Debian/Ubuntu: sudo apt install python3-venv)"
fi
command -v npm >/dev/null 2>&1 || fail "нужен Node.js 22 или новее (https://nodejs.org/)"

# Хэш файлов: зависимости и сборка обновляются только при изменениях.
hash_files() {
  "$PY" - "$@" <<'EOF'
import hashlib, pathlib, sys
digest = hashlib.sha256()
paths = []
for arg in sys.argv[1:]:
    p = pathlib.Path(arg)
    paths += [f for f in p.rglob("*") if f.is_file()] if p.is_dir() else [p] if p.is_file() else []
for f in sorted(paths):
    digest.update(f"{f.as_posix()} {hashlib.sha256(f.read_bytes()).hexdigest()}\n".encode())
print(digest.hexdigest())
EOF
}

REQ="$ROOT/backend/requirements.txt"
REQ_STAMP="$VENV/requirements.sha256"
REQ_HASH="$(hash_files "$REQ")"
if [ ! -f "$REQ_STAMP" ] || [ "$(cat "$REQ_STAMP")" != "$REQ_HASH" ]; then
  "$PY" -m pip install -r "$REQ"
  echo "$REQ_HASH" > "$REQ_STAMP"
fi

cd "$ROOT/frontend"
PIDS=()
cleanup() { for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

if [ "$DEV" = 0 ]; then
  BUILD_HASH="$(hash_files src public package.json package-lock.json index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json)"
  BUILD_STAMP="$ROOT/frontend/dist/.build.sha256"
  if [ ! -f "$BUILD_STAMP" ] || [ "$(cat "$BUILD_STAMP")" != "$BUILD_HASH" ]; then
    npm ci
    npm run build
    echo "$BUILD_HASH" > "$BUILD_STAMP"
  fi
  URL="http://127.0.0.1:8765"
else
  [ -d node_modules ] || npm ci
  npm run dev -- --host 127.0.0.1 --port 5180 --strictPort &
  PIDS+=($!)
  URL="http://127.0.0.1:5180"
fi

if [ "$OPEN_BROWSER" = 1 ]; then
  (
    for _ in $(seq 120); do
      if "$PY" -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8765/api/health", timeout=1)' 2>/dev/null; then
        if command -v open >/dev/null 2>&1 && [ "$(uname)" = "Darwin" ]; then open "$URL"
        elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
        else echo "Откройте в браузере: $URL"; fi
        exit 0
      fi
      sleep 0.5
    done
  ) &
  PIDS+=($!)
fi

echo "Study Surfers запускается: $URL (остановить — Ctrl+C)"
cd "$ROOT/backend"
ARGS=(-m uvicorn app.main:app --host 127.0.0.1 --port 8765 --loop app.event_loop:loop_factory)
[ "$DEV" = 1 ] && ARGS+=(--reload)
"$PY" "${ARGS[@]}"
