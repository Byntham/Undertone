# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for Undertone — one-file windowed Undertone.exe.

Build:  .venv\\Scripts\\python.exe -m PyInstaller undertone.spec --noconfirm
Output: dist\\Undertone.exe

Only main.py's import graph and the runtime image/sound assets are bundled.
Never add repo-root globs to datas — the repo root contains a gitignored
personal API key file that must not end up inside the exe.
"""

from PyInstaller.utils.win32.versioninfo import (
    FixedFileInfo,
    StringFileInfo,
    StringStruct,
    StringTable,
    VarFileInfo,
    VarStruct,
    VSVersionInfo,
)

APP_VERSION = "1.4.0"  # keep in sync with config.APP_VERSION
_ver_tuple = tuple(int(p) for p in APP_VERSION.split(".")) + (0,)

version_info = VSVersionInfo(
    ffi=FixedFileInfo(filevers=_ver_tuple, prodvers=_ver_tuple),
    kids=[
        StringFileInfo(
            [
                StringTable(
                    "040904B0",
                    [
                        StringStruct("ProductName", "Undertone"),
                        StringStruct("FileDescription", "Undertone — push-to-talk dictation"),
                        StringStruct("FileVersion", APP_VERSION),
                        StringStruct("ProductVersion", APP_VERSION),
                        StringStruct("OriginalFilename", "Undertone.exe"),
                        StringStruct("InternalName", "Undertone"),
                    ],
                )
            ]
        ),
        VarFileInfo([VarStruct("Translation", [0x0409, 1200])]),
    ],
)

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=[],
    # Bundle only runtime assets. Keep source artwork and other design files
    # in the repo without carrying them into the one-file executable.
    datas=[
        ("assets/icon.png", "assets"),
        ("assets/icon.ico", "assets"),
        ("assets/sound_start.wav", "assets"),
        ("assets/sound_stop.wav", "assets"),
        ("assets/sound_lock.wav", "assets"),
        ("assets/sound_cancel.wav", "assets"),
    ],
    hiddenimports=[
        # comtypes.client.GetModule() imports generated modules from
        # comtypes.gen at runtime; the package must exist in the bundle.
        "comtypes.gen",
        "comtypes.stream",
    ],
    hookspath=[],
    runtime_hooks=[],
    # Only QtCore/QtGui/QtWidgets are used; PyInstaller's PySide6 hooks
    # would otherwise drag in the whole Qt module zoo. tkinter is gone
    # since the Qt port.
    excludes=[
        "tkinter",
        "PySide6.QtNetwork", "PySide6.QtQml", "PySide6.QtQuick",
        "PySide6.QtQuickWidgets", "PySide6.QtWebEngineCore",
        "PySide6.QtWebEngineWidgets", "PySide6.QtWebChannel",
        "PySide6.QtPdf", "PySide6.QtPdfWidgets", "PySide6.QtSql",
        "PySide6.QtTest", "PySide6.QtXml", "PySide6.QtSvg",
        "PySide6.QtSvgWidgets", "PySide6.QtMultimedia",
        "PySide6.QtMultimediaWidgets", "PySide6.QtOpenGL",
        "PySide6.QtOpenGLWidgets", "PySide6.QtPositioning",
        "PySide6.QtLocation", "PySide6.QtBluetooth",
        "PySide6.QtDesigner", "PySide6.QtHelp", "PySide6.QtUiTools",
        "PySide6.Qt3DCore", "PySide6.Qt3DRender",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="Undertone",
    icon="assets/icon.ico",
    version=version_info,
    console=False,
    debug=False,
    strip=False,
    upx=False,
    bootloader_ignore_signals=False,
    disable_windowed_traceback=False,
)
