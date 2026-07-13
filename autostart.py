"""Manage "start with Windows" for Undertone via the HKCU Run registry key.

Uses only the stdlib ``winreg`` module. Enabling adds a value under the
current user's Run key so the app launches at login; disabling removes it.
"""

import sys
import winreg
from pathlib import Path

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
VALUE_NAME = "Undertone"
LEGACY_VALUE_NAME = "PushToTalkSTT"


def _command() -> str:
    """Build the login launch command: the frozen exe, or pythonw + main.py."""
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}"'
    pyw = Path(sys.executable).with_name("pythonw.exe")
    if not pyw.exists():
        pyw = Path(sys.executable)
    main_py = Path(__file__).resolve().parent / "main.py"
    return f'"{pyw}" "{main_py}"'


def migrate_legacy() -> None:
    """Move an old PushToTalkSTT Run entry to the Undertone name.

    Rewrites the command too, so the entry also heals if the project
    folder moved along with the rename.
    """
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, RUN_KEY, 0,
            winreg.KEY_QUERY_VALUE | winreg.KEY_SET_VALUE,
        ) as key:
            winreg.QueryValueEx(key, LEGACY_VALUE_NAME)
            winreg.DeleteValue(key, LEGACY_VALUE_NAME)
            winreg.SetValueEx(key, VALUE_NAME, 0, winreg.REG_SZ, _command())
    except (FileNotFoundError, OSError):
        pass


def is_enabled() -> bool:
    """Return True if the Run value exists (i.e. the user enabled autostart).

    Existence alone is the signal; a stale path still means the user opted in,
    and comparing against the current command would flap across relocations.
    """
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            winreg.QueryValueEx(key, VALUE_NAME)
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return False


def set_enabled(enabled: bool) -> None:
    """Enable or disable autostart by writing/removing the Run value."""
    if enabled:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            winreg.SetValueEx(key, VALUE_NAME, 0, winreg.REG_SZ, _command())
    else:
        try:
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE
            ) as key:
                winreg.DeleteValue(key, VALUE_NAME)
        except (FileNotFoundError, OSError):
            # Nothing to remove; disabling a missing value is a no-op.
            pass
