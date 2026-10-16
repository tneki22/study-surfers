# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

root = Path(SPECPATH).parent

# Добавленные модули app и файлы frontend/dist подхватываются при каждой сборке.
analysis = Analysis(
    [str(root / "backend/desktop_server.py")],
    pathex=[str(root / "backend")],
    datas=[
        (str(root / "build/workspace/frontend/dist"), "frontend/dist"),
        (str(root / "fixtures/demo-deck.ssdeck.json"), "fixtures"),
        (str(root / "contract/deck.schema.json"), "contract"),
        (str(root / "backend/mcp_server.py"), "backend"),
        *collect_data_files("app"),
        *collect_data_files("pymorphy3_dicts_ru"),
        *collect_data_files("docx"),
        *copy_metadata("pymorphy3"),
        *copy_metadata("pymorphy3-dicts-ru"),
    ],
    hiddenimports=[
        *collect_submodules("app"),
        "pymorphy3_dicts_ru",
        "mcp.server.fastmcp",
        "uvicorn.logging",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.lifespan.on",
    ],
    excludes=["pytest", "tkinter", "IPython", "notebook"],
)
pyz = PYZ(analysis.pure)
exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="study-surfers-backend",
    console=True,
    upx=False,
)
coll = COLLECT(exe, analysis.binaries, analysis.datas, name="study-surfers-backend", upx=False)
