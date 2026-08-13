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
}

def process_command(cmd_str):
    try:
        cmd = json.loads(cmd_str)
        action = cmd.get("type")
        
        if action == "mousemove":
            x, y = cmd.get("x"), cmd.get("y")
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
                
    except Exception as e:
        # Silently ignore errors to keep the loop alive
        pass

if __name__ == "__main__":
    # Disable artificial pause after each pyautogui command for lowest latency
    pyautogui.PAUSE = 0
    
    # Read commands from standard input continuously
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if line == "QUIT":
            break
        process_command(line)
