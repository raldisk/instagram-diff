<p align="center">
  <h1 align="center">instagram-diff</h1>
  <p align="center">Deterministic, idempotent Instagram followers/following diff engine with historical state tracking and structured PDF reporting.</p>
</p>

<p align="center">
  <img src="https://img.shields.io/static/v1?style=for-the-badge&message=Python+3.9%2B&color=3776AB&logo=Python&logoColor=FFFFFF&label=" alt="Python" />
  <img src="https://img.shields.io/static/v1?style=for-the-badge&message=Instagram&color=E4405F&logo=Instagram&logoColor=FFFFFF&label=" alt="Instagram" />
  <img src="https://img.shields.io/static/v1?style=for-the-badge&message=GitHub&color=181717&logo=GitHub&logoColor=FFFFFF&label=" alt="GitHub" />
  <img src="https://img.shields.io/static/v1?style=for-the-badge&message=Linux&color=222222&logo=Linux&logoColor=FCC624&label=" alt="Linux" />
  <img src="https://img.shields.io/static/v1?style=for-the-badge&message=macOS&color=000000&logo=macOS&logoColor=FFFFFF&label=" alt="macOS" />
  <img src="https://img.shields.io/static/v1?style=for-the-badge&message=Violentmonkey&color=00485B&logo=Tampermonkey&logoColor=FFFFFF&label=" alt="Violentmonkey" />
  <img src="https://img.shields.io/static/v1?style=for-the-badge&message=MIT&color=1A6321&logo=GitHub&logoColor=FFFFFF&label=License" alt="License MIT" />
</p>

---

## Overview

Instagram Tracker is a state-aware CLI tool that:

- Compares `followers.csv` and `following.csv`
- Detects **New**, **Returned**, and **Removed** accounts
- Preserves historical state across runs
- Generates a structured, Unicode-safe PDF report
- Maintains a permanent append-only change log

This is not a simple report generator. It is a **deterministic state-diff system with idempotent re-run guarantees**.

---

## Problem It Solves

Instagram does not provide:

- Historical follower change tracking
- Return detection (deactivated then reactivated)
- Reliable state diffs across time
- Persistent baselines for comparison

This tool introduces:

- Snapshot baselining
- Deterministic diff classification
- Append-only event history
- Idempotent re-run architecture

---

## Project Structure

```
instagram-diff/
|
+-- tracker/
|   +-- run_tracker.py        <- diff engine + PDF generator
|   +-- download_pics.py      <- profile picture downloader
|   +-- __init__.py
|
+-- userscript/
|   +-- scraper.user.js       <- Violentmonkey install (single file, bundled)
|   +-- main.js               <- engine only (for @require after GitHub publish)
|   +-- README.md             <- userscript docs
|
+-- tests/
|   +-- test_detect_changes.py
|
+-- cache-pfp/                <- profile picture cache (auto-created, gitignored)
+-- snapshot.csv              <- comparison baseline (optional commit)
+-- history.csv               <- permanent change log (optional commit)
+-- last_changes.csv          <- re-run memory (gitignored, auto-created)
+-- followers.csv             <- Instagram export (gitignored, personal data)
+-- following.csv             <- Instagram export (gitignored, personal data)
+-- report_YYYY-MM-DD.pdf     <- generated report (gitignored)
|
+-- pyproject.toml
+-- LICENSE
+-- README.md
+-- .gitignore
```

---

## Quick Start

### 1. Install Requirements

```bash
# Install uv if needed
pip install uv

# Install project dependencies
uv sync

# Include dev dependencies (pytest)
uv sync --dev
```

Python 3.9+ required. [uv](https://github.com/astral-sh/uv) is recommended over pip.

---

### 2. Export Instagram Data

This tool relies on CSV exports generated via the bundled userscript in [`userscript/scraper.user.js`](./userscript/scraper.user.js).

**Steps:**
1. Install [Violentmonkey](https://violentmonkey.github.io/get-it/) browser extension
2. Open Violentmonkey → Dashboard → **+** → paste `userscript/scraper.user.js` → Save
3. Go to your Instagram profile and open the followers or following list
4. Click **Auto-Scroll** — the script loads the full list automatically
5. Click **Download N users** to export `instaExport-[timestamp].csv`
6. Rename to `followers.csv` / `following.csv` and place in project root

See [`userscript/README.md`](./userscript/README.md) for full documentation.

> Note: Instagram CDN profile picture URLs expire. Run `download_pics.py` soon after exporting.

---

### 3. Set Your Baseline

If you have a previous export to compare against, rename it:

```
instagram-clean.csv  ->  snapshot.csv
```

If no `snapshot.csv` exists, one is created automatically on first run (showing 0 changes).

---

### 4. Download Profile Pictures (Optional)

```bash
uv run python tracker/download_pics.py
```

- Saves to `cache-pfp/<username>.jpg`
- Safe to re-run — skips already-downloaded files
- Falls back to initials avatar if image unavailable

---

### 5. Generate the Report

```bash
uv run python tracker/run_tracker.py

# With options:
uv run python tracker/run_tracker.py --debug
uv run python tracker/run_tracker.py --no-pdf
```

Outputs `report_YYYY-MM-DD.pdf`.

---

## Architecture

### State Model

Three persistence layers enforce deterministic behavior:

| File | Role | Lifecycle |
|---|---|---|
| `snapshot.csv` | Baseline state | Updated only when changes are detected |
| `history.csv` | Append-only event log | Never overwritten |
| `last_changes.csv` | Last meaningful diff | Used only when no new changes detected |

---

### Idempotent Re-Run Guarantee

Re-running with identical exports:

- Does not erase previous diffs
- Does not overwrite meaningful change sets
- Reuses `last_changes.csv` to preserve display consistency

Prevents the classic failure mode:

> "Run once, changes detected, run again, everything shows 0."

This separation of **detection state** and **display state** is deliberate.

---

### Deterministic Diff Engine

The core diff logic is pure — no file I/O, no timestamps, no side effects.

Input: previous snapshot set, current export set.

Output:

| Category | Definition |
|---|---|
| New | Not previously seen in any snapshot |
| Returned | Previously removed or deactivated, now back |
| Removed | Present in snapshot, missing from current export |

This makes the engine independently testable.

---

### Status Classification

| Condition | Status |
|---|---|
| In followers AND following | Mutual |
| In followers only | Follower Only |
| In following only | Following Only |

Statuses are precomputed once via `build_status_map()` and reused across detection, sorting, and rendering — no repeated set lookups.

---

### Unicode-Safe PDF Rendering

- Attempts DejaVuSans (full Unicode: emoji, CJK, non-Latin names)
- Falls back to Helvetica if unavailable
- Active font shown in PDF footer
- Tested on Linux, Windows, macOS

---

## PDF Report Structure

| Section | Description |
|---|---|
| Summary Strip | Mutual, Followers, Following, New, Returned, Removed |
| New Accounts | First-time appearances |
| Returned Accounts | Previously removed, now back |
| Removed Accounts | Missing since last snapshot |
| Current List | Full status-tiered list with avatars |
| Page Numbers | On every page |

---

## Defensive Design

**UTF-8 enforced everywhere** — prevents Windows `cp1252` decode crashes on emoji in display names.

**CSV header validation** — fails fast with a clear error if Instagram changes export column names.

**Graceful image degradation** — missing profile pictures fall back to colored initials avatars.

**CDN expiry awareness** — images cached locally, never fetched at report time.

---

## File Policy

| File | Commit to Git | Reason |
|---|---|---|
| `snapshot.csv` | Optional | Baseline example only |
| `history.csv` | Optional | Example history |
| `last_changes.csv` | No | Runtime state |
| `followers.csv` | No | Personal data |
| `following.csv` | No | Personal data |
| `cache-pfp/` | No | Generated cache |
| `report_*.pdf` | No | Generated output |

---

## Run Behavior Reference

**First run (no snapshot.csv):**
```
Loading data...
  No snapshot.csv found - creating baseline...
  snapshot.csv created with 67 accounts.
  Current: 67  |  New: 0  |  Returned: 0  |  Removed: 0
  Generating PDF...
  Report saved: report_2026-03-02.pdf
  Done!
```

**Run with changes detected:**
```
Loading data...
  Logging changes to history.csv...
  Updating snapshot...
  Current: 67  |  New: 4  |  Returned: 1  |  Removed: 20
  Profile pics found: 67 (will be embedded)
  Generating PDF...
  Report saved: report_2026-03-02.pdf
  Done!
```

**Re-run with same exports:**
```
Loading data...
  No new changes - retaining last recorded diff.
  Current: 67  |  New: 4  |  Returned: 1  |  Removed: 20
  Profile pics found: 67 (will be embedded)
  Generating PDF...
  Report saved: report_2026-03-02.pdf
  Done!
```

---

## Testing Philosophy

Core invariant:

> Given identical input CSVs and unchanged snapshot, repeated runs must produce identical diffs.

Manual validation scenarios:
- First run (no snapshot)
- New accounts added
- Accounts removed
- Removed account returns
- Re-run with unchanged exports
- Baseline created from previous CSV

---

## Future Roadmap

- Extract diff engine into `diff_engine.py`
- Add unit tests for state transitions
- Add CLI arguments for custom file paths
- JSON export format
- FastAPI wrapper for web UI
- Docker container

---

## Engineering Notes

**Idempotent re-run** — The core challenge: re-running with the same exports always produced `New: 0, Removed: 0` after the first run because `snapshot.csv` gets overwritten. The fix: `last_changes.csv` stores the last meaningful diff and is only re-read when no new changes are detected. This separates detection state from display state.

**Pure diff engine** — `detect_changes()` takes sets, returns sets. No file I/O, no timestamps inside the function. Makes the core logic independently testable.

**Precomputed status map** — `build_status_map()` runs once upfront. Eliminates repeated membership checks during detection, sorting, and PDF rendering.

**Windows encoding** — All file I/O explicitly uses `encoding="utf-8"`. Without this, Windows defaults to `cp1252` and crashes on emoji in display names.

**CDN expiry** — Instagram profile picture URLs are signed and expire. `download_pics.py` must run soon after exporting. The report generator only reads from local cache.

---

## Credits

- [passthesh3ll](https://greasyfork.org/en/users/762057-passthesh3ll) — [Instagram Auto Followers/Following Scraper (OSINT)](https://greasyfork.org/en/scripts/527647-instagram-auto-followers-following-scraper-osint)
- [floriandiud](https://github.com/floriandiud/instagram-users-scraper) — original scraper code
- [Violentmonkey](https://violentmonkey.github.io/) — open-source userscript manager

---

## Contributing

Pull requests welcome.

Before submitting:
- Preserve idempotent re-run behavior
- Do not break snapshot update logic
- Maintain `encoding="utf-8"` on all file I/O
- Ensure deterministic diff output

---

## License

MIT — see [LICENSE](LICENSE)
