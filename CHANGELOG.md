# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [4.0.1] — 2026-03-08

### Python Tracker (`tracker/run_tracker.py`, `tracker/download_pics.py`)

#### Fixed

- **P0 — Missing `main()` entry point.** The `if __name__ == "__main__":` block in
  `run_tracker.py` has been wrapped in `def main(argv=None):` and called via
  `raise SystemExit(main())`. The `pyproject.toml` entry point
  `tracker.run_tracker:main` now resolves correctly. Running
  `uv run instagram-diff` or any installed script invocation no longer raises
  `AttributeError`.

- **P0 — Version mismatch.** `pyproject.toml` version corrected from `1.0.0` to
  `4.0.1` to match the CHANGELOG, userscript `@version`, and all other version
  references.

- **P1 — `append_history` is now atomic.** The previous implementation used
  `open(..., "a")` with `flush()` + `fsync()`, which could produce a torn/partial
  row if the process crashed mid-write between multiple events. The rewrite reads
  existing rows, merges new events in memory, then writes the full file via
  `_atomic_csv_write` (`NamedTemporaryFile` + `Path.replace()`). A crash at any
  point leaves the original `history.csv` intact. Additionally, `load_history` now
  calls `validate_csv()` and skips malformed rows with a warning, consistent with
  the defensive pattern already present in `load_export` and `load_snapshot`.

- **P1 — `download_pics.py` module-level side effect removed.** `os.makedirs(PICS_DIR)`
  was executing unconditionally at import time, creating a `cache-pfp/` directory
  in the working directory whenever the module was imported. It has been moved
  inside `if __name__ == "__main__":`. Importing the module no longer produces
  filesystem side effects.

- **P1 — Module-level globals no longer mutated at runtime.** `run_tracker.py`
  previously overwrote six module-level constants (`FOLLOWERS_CSV`,
  `FOLLOWING_CSV`, `SNAPSHOT_CSV`, `HISTORY_CSV`, `OUTPUT_PDF`) with CLI argument
  values at runtime. These are now local variables inside `main()`. The
  module-level constants remain as documented defaults only. `generate_report()`
  accepts an explicit `output_pdf` parameter instead of reading from module scope.

### Project

#### Added

- `.gitattributes` — normalizes all text file line endings to LF across platforms,
  resolving the CRLF/LF inconsistency between `scraper.user.js` and `main.js`.

---

## [4.0.0] — 2026-03-03

### Userscript (`scraper.user.js` + `main.js`)

**Engine rewrite** — complete ground-up rewrite of floriandiud's `main.min.js` backbone.

#### Added
- `fetch()` intercept — Instagram has migrated some endpoints; original only patched XHR
- `BoundedCache` class — FIFO eviction for `locationNameCache` (200) and `profileUsernamesCache` (1000)
- `removePatches()` — restores original `XHR.prototype.send` and `window.fetch` cleanly
- `_patchActive` guard — prevents patch stacking on reinject or double-init
- `window.__igScraperLoaded` boot flag — single-init guarantee
- IDB failure surfaced to UI — on-screen warning banner if IndexedDB unavailable (private browsing)
- `{ degraded }` return from `AccountStore.init()` — caller knows persistence state
- Incremental DOM updates in `HistoryLog` — one `<li>` created per entry, deleted individually
- `crypto.randomUUID()` — replaces custom `randomString(10)`
- `URL.revokeObjectURL` after CSV export click — fixes blob URL memory leak

#### Changed
- `sourceGlobal` mutable global eliminated — source derived per-call, passed explicitly (fixes race condition)
- Duplicate `addElems + updateCounter + addHistoryLog` pattern × 3 collapsed into single `_persist(accounts, source)`
- `readystatechange` listener: named function, removed via `removeEventListener` at `readyState === 4`
- All user-supplied strings rendered via `textContent` — eliminates XSS risk in history log
- Minimal native IDB wrapper (~80 lines) replaces bundled `idb` library (~200 lines)
- Single `App` class owns all mutable state — eliminates module-level globals

#### Removed
- `__awaiter` × 2 polyfills — native `async/await` used throughout
- `__rest` polyfill — native destructuring used throughout
- Bundled `idb` library — replaced with minimal native wrapper
- `randomString(10)` — replaced with `crypto.randomUUID()`
- `.lastIndex = 0` on non-`/g` regexes — cargo-cult, removed

---

**Scroll panel rewrite** — complete ground-up rewrite of SH3LL v2.3 `scraper.user.js`.

#### Added
- `createRegistry()` — cleanup registry pattern; all listeners/timers/DOM nodes self-register, `flush()` removes everything LIFO
- `createMachine()` — explicit state machine: `IDLE → SCROLLING → DONE`
- `createScroller()` — rAF-driven scroll loop with cancellation token (`rafId`, `timerId`, `cancelled` flag)
- Scroll-end detection — `scrollHeight` stabilization over `STABLE_THRESHOLD = 3` consecutive checks
- Live progress counter — `Loaded: N`, `End check N/3`, `Done: N accounts`
- `GM_notification` on scroll complete
- SPA navigation handling — `pushState` / `replaceState` patched, session tears down and re-injects on profile navigation
- Panel re-injection guard — ID check prevents duplicate panels
- `pagehide` teardown — full cleanup on page unload
- `trackedTimeout` — boot timer tracked in registry, cancelled if `pagehide` fires first

#### Changed
- `position: absolute` → `position: fixed` — panel no longer scrolls off screen
- `paddingX` (invalid CSS) → `padding: 5px 11px`
- All event listeners wrapped in `onEvent(reg, ...)` — removed on session teardown
- `@namespace` updated to `https://github.com/raldisk/instagram-diff`
- `@homepageURL` and `@supportURL` fields added

#### Removed
- `setInterval` + nested `setTimeout` — replaced by single rAF loop
- `MutationObserver` — never disconnected in original; removed entirely
- `loadScraper` / `GM_xmlhttpRequest` remote fetch — engine now bundled inline
- Scrape button — engine boots independently, no manual inject step needed
- Global scope pollution — everything inside IIFE

---

### Python Tracker (`tracker/run_tracker.py`)

#### Added
- `_atomic_csv_write()` — `NamedTemporaryFile` + `Path.replace()` for crash-safe writes
- `append_history()` — `flush()` + `os.fsync()` for durable appends
- `_setup_font()` — cross-platform DejaVuSans discovery (bundled → Linux → Windows → macOS → Helvetica fallback)
- `argparse` CLI — `--followers`, `--following`, `--snapshot`, `--history`, `--output`, `--debug`, `--no-pdf`
- `PermissionError` + `FileNotFoundError` handling on file loads
- `@lru_cache(maxsize=2048)` + `deepcopy()` on `_cached_initials_drawing()` — avatar caching without Flowable mutation
- `logging.basicConfig()` moved inside `__main__` — `--debug` flag works correctly

#### Changed
- `build_status_map()` rewritten with set operations (`&`, `-`) — single pass, no repeated membership checks
- Explicit `snapshot.keys()` instead of implicit `set(snapshot)` dict iteration
- Hardcoded Python 3.12 font path removed — `_setup_font()` handles all platforms

---

### Project structure

#### Added
- `tracker/` — Python scripts moved here
- `userscript/` — JS files and userscript README
- `tests/` — pytest suite (5 test cases covering core `detect_changes()` invariants)
- `pyproject.toml` — replaces `requirements.txt` (PEP 517/518, `uv` compatible)
- `CHANGELOG.md` — this file

#### Removed
- `requirements.txt` — superseded by `pyproject.toml`
- Flat file layout

---

## [1.0.0] — baseline

- Initial `run_tracker.py` by raldisk
- Based on SH3LL v2.3 userscript concept
- Based on floriandiud instagram-users-scraper engine
