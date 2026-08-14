import sys
import json
import pyautogui

# Disable fail-safe (which stops the script if mouse moves to a corner)
pyautogui.FAILSAFE = False

# Mapping web KeyboardEvent.key to pyautogui keys where they differ
KEY_MAP = {
    "ArrowUp": "up",
    "ArrowDown": "down",
    "ArrowLeft": "left",
    "ArrowRight": "right",
    "Escape": "esc",
    "Control": "ctrl",
    "Alt": "alt",
    "Shift": "shift",
    "Meta": "win",
    "Enter": "enter",
    "Backspace": "backspace",
    "Tab": "tab",
    " ": "space",
    "Delete": "delete",
    "Home": "home",
    "End": "end",
    "PageUp": "pageup",
    "PageDown": "pagedown",
    "Insert": "insert",
    "CapsLock": "capslock",
    "NumLock": "numlock",
    "ScrollLock": "scrolllock",
    "Pause": "pause",
    "PrintScreen": "printscreen",
    "F1": "f1",
    "F2": "f2",
    "F3": "f3",
    "F4": "f4",
    "F5": "f5",
    "F6": "f6",
    "F7": "f7",
    "F8": "f8",
    "F9": "f9",
    "F10": "f10",
    "F11": "f11",
    "F12": "f12",
}

def process_command(cmd_str):
    try:
        cmd = json.loads(cmd_str)
        action = cmd.get("type")
        
        if action == "mousemove":
            x, y = cmd.get("x"), cmd.get("y")
            if x is not None and y is not None:
                # Move instantly
                pyautogui.moveTo(x, y, _pause=False)
            
        elif action == "mousedown":
            btn = cmd.get("button", "left")
            pyautogui.mouseDown(button=btn, _pause=False)
            
        elif action == "mouseup":
            btn = cmd.get("button", "left")
            pyautogui.mouseUp(button=btn, _pause=False)
            
        elif action == "keydown":
            key = cmd.get("key", "")
            mapped_key = KEY_MAP.get(key, key.lower())
            if mapped_key in pyautogui.KEY_NAMES or len(mapped_key) == 1:
                pyautogui.keyDown(mapped_key, _pause=False)
                
        elif action == "keyup":
            key = cmd.get("key", "")
            mapped_key = KEY_MAP.get(key, key.lower())
            if mapped_key in pyautogui.KEY_NAMES or len(mapped_key) == 1:
                pyautogui.keyUp(mapped_key, _pause=False)
        
        elif action == "scroll":
            deltaX = cmd.get("deltaX", 0)
            deltaY = cmd.get("deltaY", 0)
            # Convert web wheel delta to scroll clicks
            # Web deltaY is typically ~100 per notch, pyautogui scroll uses clicks
            scrollClicks = -int(deltaY / 100) if deltaY != 0 else 0
            hScrollClicks = -int(deltaX / 100) if deltaX != 0 else 0
            
            if scrollClicks != 0:
                pyautogui.scroll(scrollClicks, _pause=False)
            if hScrollClicks != 0:
                try:
                    pyautogui.hscroll(hScrollClicks, _pause=False)
                except AttributeError:
                    pass  # hscroll not available on all platforms
                
    except json.JSONDecodeError:
        print(f"Invalid JSON: {cmd_str}", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"Error processing command: {e}", file=sys.stderr, flush=True)

if __name__ == "__main__":
    # Disable artificial pause after each pyautogui command for lowest latency
    pyautogui.PAUSE = 0
    
    print("Input server started.", file=sys.stderr, flush=True)
    
    # Read commands from standard input continuously
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if line == "QUIT":
            print("Input server shutting down.", file=sys.stderr, flush=True)
            break
        process_command(line)
