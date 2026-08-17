import sys
import msvcrt
import time

print("Waiting for data...")
while True:
    try:
        print("kbhit:", msvcrt.kbhit())
    except Exception as e:
        print("error:", e)
    
    line = sys.stdin.readline()
    if not line: break
    print("got:", line.strip())
