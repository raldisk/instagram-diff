"""
Download Profile Pictures
=========================
Run this BEFORE run_tracker.py to fetch all profile pictures.

Usage:
    python download_pics.py

Saves images to: pics/<username>.jpg
Skips already-downloaded ones, so safe to re-run.
"""

import csv
import os
import time
import urllib.request
from pathlib import Path

FOLLOWERS_CSV = "followers.csv"
FOLLOWING_CSV = "following.csv"
PICS_DIR      = "cache-pfp"

def load_pics_map(*csv_paths):
    """Collect {username: picture_url} from one or more export CSVs."""
    data = {}
    for path in csv_paths:
        with open(path, encoding='utf-8') as f:
            for row in csv.DictReader(f):
                u   = row['Username']
                url = row.get('Picture Url', '').strip()
                if u and url:
                    data[u] = url
    return data

def download_all(pics_map):
    total   = len(pics_map)
    done    = 0
    skipped = 0
    failed  = []

    for i, (username, url) in enumerate(pics_map.items(), 1):
        dest = Path(PICS_DIR) / f"{username}.jpg"

        if dest.exists():
            skipped += 1
            continue

        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=10) as resp:
                dest.write_bytes(resp.read())
            done += 1
            print(f"  [{i}/{total}] ✅ @{username}")
            time.sleep(0.3)   # be polite to CDN
        except Exception as e:
            failed.append(username)
            print(f"  [{i}/{total}] ❌ @{username} — {e}")

    print(f"\nDone!  Downloaded: {done}  |  Skipped: {skipped}  |  Failed: {len(failed)}")
    if failed:
        print("Failed accounts:", ", ".join(failed))


if __name__ == "__main__":
    os.makedirs(PICS_DIR, exist_ok=True)
    print("Loading CSVs...")
    pics_map = load_pics_map(FOLLOWERS_CSV, FOLLOWING_CSV)
    print(f"Found {len(pics_map)} unique accounts. Downloading to '{PICS_DIR}/'...\n")
    download_all(pics_map)
