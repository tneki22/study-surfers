"""Точка входа EXE: сервер с жизненным циклом окна или отдельный STDIO MCP."""

import argparse
import multiprocessing
import runpy
import sys
import threading


def main():
    multiprocessing.freeze_support()
    # Режим MCP не импортирует приложение, не открывает SQLite и не пишет в stdout.
    if "--mcp" in sys.argv[1:]:
        sys.argv.remove("--mcp")
        from app.config import ROOT

        runpy.run_path(str(ROOT / "backend/mcp_server.py"), run_name="__main__")
        return

    parser = argparse.ArgumentParser(description="Локальный сервер Study Surfers")
    from app.config import get_settings

    parser.add_argument("--port", type=int, default=get_settings().port)
    args = parser.parse_args()

    import json

    import uvicorn

    from app.event_loop import loop_factory
    from app.main import app

    class DesktopServer(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets)
            if self.started:
                port = self.servers[0].sockets[0].getsockname()[1]
                # STDIO MCP должен обращаться к фактическому порту, включая --port 0.
                get_settings().port = port
                print("SS_DESKTOP_READY " + json.dumps({"port": port}), flush=True)

    server = DesktopServer(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=args.port,
            loop=loop_factory,
            http="h11",
            ws="none",
            proxy_headers=False,
            timeout_graceful_shutdown=8,
        )
    )

    def watch_parent():
        # Закрытие окна и аварийное завершение Electron закрывают pipe.
        # EOF запускает обычный lifespan shutdown, включая задачи и дочерние CLI.
        for _ in sys.stdin:
            pass
        server.should_exit = True

    threading.Thread(target=watch_parent, daemon=True, name="desktop-parent").start()
    server.run()


if __name__ == "__main__":
    main()
