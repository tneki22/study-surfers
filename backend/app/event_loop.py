"""Цикл Uvicorn с поддержкой локальных CLI, в том числе при --reload на Windows."""

import asyncio
import sys


def loop_factory() -> asyncio.AbstractEventLoop:
    # Uvicorn выбирает SelectorEventLoop для reload; на Windows он не умеет
    # subprocess_exec, необходимый подпискам и установке MCP.
    return asyncio.ProactorEventLoop() if sys.platform == "win32" else asyncio.new_event_loop()
