import sys
import json
import platform

IS_WINDOWS = platform.system() == 'Windows'

# ──── Windows: Direct Win32 API via ctypes (ultra-low latency) ────
if IS_WINDOWS:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32

    # ─── SendInput structures (modern API, replaces deprecated mouse_event/keybd_event) ───
    INPUT_MOUSE = 0
    INPUT_KEYBOARD = 1

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", wintypes.LONG),
            ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", wintypes.WORD),
            ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [
            ("uMsg", wintypes.DWORD),
            ("wParamL", wintypes.WORD),
            ("wParamH", wintypes.WORD),
        ]

    class _INPUT_UNION(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    class INPUT(ctypes.Structure):
        _anonymous_ = ("_input",)
        _fields_ = [("type", wintypes.DWORD), ("_input", _INPUT_UNION)]

    # Configure SendInput function signature
    _SendInput = user32.SendInput
    _SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
    _SendInput.restype = wintypes.UINT

    # Helper: create and send a single INPUT event
    def _send_input(*inputs):
        """Send one or more INPUT events atomically via SendInput."""
        n = len(inputs)
        arr = (INPUT * n)(*inputs)
        _SendInput(n, arr, ctypes.sizeof(INPUT))

    # Mouse event flags
    MOUSEEVENTF_LEFTDOWN   = 0x0002
    MOUSEEVENTF_LEFTUP     = 0x0004
    MOUSEEVENTF_RIGHTDOWN  = 0x0008
    MOUSEEVENTF_RIGHTUP    = 0x0010
    MOUSEEVENTF_MIDDLEDOWN = 0x0020
    MOUSEEVENTF_MIDDLEUP   = 0x0040
    MOUSEEVENTF_WHEEL      = 0x0800
    MOUSEEVENTF_HWHEEL     = 0x1000

    # Keyboard event flags
    KEYEVENTF_KEYUP   = 0x0002
    KEYEVENTF_UNICODE = 0x0004

    # Virtual key code mapping from web KeyboardEvent.key
    VK_MAP = {
        "Backspace": 0x08, "Tab": 0x09, "Enter": 0x0D, "Shift": 0x10,
        "Control": 0x11, "Alt": 0x12, "Pause": 0x13, "CapsLock": 0x14,
        "Escape": 0x1B, " ": 0x20, "PageUp": 0x21, "PageDown": 0x22,
        "End": 0x23, "Home": 0x24, "ArrowLeft": 0x25, "ArrowUp": 0x26,
        "ArrowRight": 0x27, "ArrowDown": 0x28, "PrintScreen": 0x2C,
        "Insert": 0x2D, "Delete": 0x2E, "Meta": 0x5B,
        "F1": 0x70, "F2": 0x71, "F3": 0x72, "F4": 0x73,
        "F5": 0x74, "F6": 0x75, "F7": 0x76, "F8": 0x77,
        "F9": 0x78, "F10": 0x79, "F11": 0x7A, "F12": 0x7B,
        "NumLock": 0x90, "ScrollLock": 0x91,
    }

    # For single character keys, use VkKeyScanW to get virtual key code
    def get_vk_code(key):
        """Get Windows virtual key code for a web KeyboardEvent.key value."""
        if key in VK_MAP:
            return VK_MAP[key], False
        if len(key) == 1:
            # Use VkKeyScanW for printable characters
            result = user32.VkKeyScanW(ord(key))
            vk = result & 0xFF
            if vk != 0xFF:
                return vk, False
            # Fallback: send as unicode
            return ord(key), True
        return None, False

    def mouse_move(x, y):
        # SetCursorPos is already the fastest method for absolute mouse positioning
        user32.SetCursorPos(int(x), int(y))

    def mouse_down(button):
        flags = {"left": MOUSEEVENTF_LEFTDOWN, "right": MOUSEEVENTF_RIGHTDOWN, "middle": MOUSEEVENTF_MIDDLEDOWN}
        inp = INPUT()
        inp.type = INPUT_MOUSE
        inp.mi.dwFlags = flags.get(button, MOUSEEVENTF_LEFTDOWN)
        _send_input(inp)

    def mouse_up(button):
        flags = {"left": MOUSEEVENTF_LEFTUP, "right": MOUSEEVENTF_RIGHTUP, "middle": MOUSEEVENTF_MIDDLEUP}
        inp = INPUT()
        inp.type = INPUT_MOUSE
        inp.mi.dwFlags = flags.get(button, MOUSEEVENTF_LEFTUP)
        _send_input(inp)

    def key_down(key):
        vk, is_unicode = get_vk_code(key)
        if vk is not None:
            inp = INPUT()
            inp.type = INPUT_KEYBOARD
            if is_unicode:
                inp.ki.wScan = vk
                inp.ki.dwFlags = KEYEVENTF_UNICODE
            else:
                inp.ki.wVk = vk
                inp.ki.dwFlags = 0
            _send_input(inp)

    def key_up(key):
        vk, is_unicode = get_vk_code(key)
        if vk is not None:
            inp = INPUT()
            inp.type = INPUT_KEYBOARD
            if is_unicode:
                inp.ki.wScan = vk
                inp.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
            else:
                inp.ki.wVk = vk
                inp.ki.dwFlags = KEYEVENTF_KEYUP
            _send_input(inp)

    WHEEL_DELTA = 120  # Standard Windows wheel delta

    def scroll_wheel(delta_x, delta_y):
        # Convert web wheel delta to Windows WHEEL_DELTA units
        # Web sends ~100 per notch, Windows uses 120 per notch
        if delta_y != 0:
            clicks = -int(round(delta_y / 100))
            if clicks != 0:
                inp = INPUT()
                inp.type = INPUT_MOUSE
                inp.mi.mouseData = ctypes.c_long(clicks * WHEEL_DELTA).value & 0xFFFFFFFF
                inp.mi.dwFlags = MOUSEEVENTF_WHEEL
                _send_input(inp)
        if delta_x != 0:
            clicks = -int(round(delta_x / 100))
            if clicks != 0:
                inp = INPUT()
                inp.type = INPUT_MOUSE
                inp.mi.mouseData = ctypes.c_long(clicks * WHEEL_DELTA).value & 0xFFFFFFFF
                inp.mi.dwFlags = MOUSEEVENTF_HWHEEL
                _send_input(inp)

# ──── Fallback: pyautogui for non-Windows platforms ────
else:
    import pyautogui
    pyautogui.FAILSAFE = False
    pyautogui.PAUSE = 0

    KEY_MAP = {
        "ArrowUp": "up", "ArrowDown": "down", "ArrowLeft": "left", "ArrowRight": "right",
        "Escape": "esc", "Control": "ctrl", "Alt": "alt", "Shift": "shift",
        "Meta": "win", "Enter": "enter", "Backspace": "backspace", "Tab": "tab",
        " ": "space", "Delete": "delete", "Home": "home", "End": "end",
        "PageUp": "pageup", "PageDown": "pagedown", "Insert": "insert",
        "CapsLock": "capslock", "NumLock": "numlock", "ScrollLock": "scrolllock",
        "Pause": "pause", "PrintScreen": "printscreen",
        "F1": "f1", "F2": "f2", "F3": "f3", "F4": "f4", "F5": "f5", "F6": "f6",
        "F7": "f7", "F8": "f8", "F9": "f9", "F10": "f10", "F11": "f11", "F12": "f12",
    }

    def mouse_move(x, y):
        pyautogui.moveTo(x, y, _pause=False)

    def mouse_down(button):
        pyautogui.mouseDown(button=button, _pause=False)

    def mouse_up(button):
        pyautogui.mouseUp(button=button, _pause=False)

    def key_down(key):
        mapped = KEY_MAP.get(key, key.lower())
        if mapped in pyautogui.KEY_NAMES or len(mapped) == 1:
            pyautogui.keyDown(mapped, _pause=False)

    def key_up(key):
        mapped = KEY_MAP.get(key, key.lower())
        if mapped in pyautogui.KEY_NAMES or len(mapped) == 1:
            pyautogui.keyUp(mapped, _pause=False)

    def scroll_wheel(delta_x, delta_y):
        if delta_y != 0:
            clicks = -int(delta_y / 100) if abs(delta_y) >= 100 else (-1 if delta_y > 0 else 1)
            pyautogui.scroll(clicks, _pause=False)
        if delta_x != 0:
            clicks = -int(delta_x / 100) if abs(delta_x) >= 100 else (-1 if delta_x > 0 else 1)
            try:
                pyautogui.hscroll(clicks, _pause=False)
            except AttributeError:
                pass


# ──── Command processor ────

# Accumulate fractional scroll deltas so small scrolls aren't lost
scroll_accum_x = 0.0
scroll_accum_y = 0.0

def process_command(cmd_str):
    global scroll_accum_x, scroll_accum_y
    try:
        cmd = json.loads(cmd_str)
        action = cmd.get("type")

        if action == "mousemove":
            x, y = cmd.get("x"), cmd.get("y")
            if x is not None and y is not None:
                mouse_move(x, y)

        elif action == "mousedown":
            mouse_down(cmd.get("button", "left"))

        elif action == "mouseup":
            mouse_up(cmd.get("button", "left"))

        elif action == "keydown":
            key_down(cmd.get("key", ""))

        elif action == "keyup":
            key_up(cmd.get("key", ""))

        elif action == "scroll":
            scroll_wheel(cmd.get("deltaX", 0), cmd.get("deltaY", 0))

    except json.JSONDecodeError:
        print(f"Invalid JSON: {cmd_str}", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"Error processing command: {e}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    mode = "ctypes/Win32 API" if IS_WINDOWS else "pyautogui"
    print(f"Input server started. Mode: {mode}", file=sys.stderr, flush=True)

    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        if line == "QUIT":
            print("Input server shutting down.", file=sys.stderr, flush=True)
            break
        process_command(line)
