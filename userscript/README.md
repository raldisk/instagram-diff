<p align="center">
  <h1 align="center">Instagram Followers/Following Scraper</h1>
  <p align="center">A browser userscript that intercepts Instagram's private API responses and exports your followers and following list to CSV — with zero memory leaks, auto-scroll, and IndexedDB persistence across page navigations.</p>
</p>

<p align="center">
  <a href="https://github.com/raldisk/instagram-diff"><img src="https://img.shields.io/badge/version-4.0.0-blueviolet" alt="Version" /></a>
  <a href="https://violentmonkey.github.io/"><img src="https://img.shields.io/badge/platform-Violentmonkey-orange" alt="Platform" /></a>
  <a href="https://www.instagram.com"><img src="https://img.shields.io/badge/site-Instagram-E1306C" alt="Instagram" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License" /></a>
</p>

---

## Credits

| Role | Author |
|---|---|
| Original scraper UI & concept | [SH3LL](https://greasyfork.org/users/762057) — v2.3 |
| Original network interceptor & storage engine | [floriandiud](https://github.com/floriandiud/instagram-users-scraper) |
| Architecture rewrite, memory leak fixes, fetch() intercept, bounded caches, atomic IDB, scroll engine, SPA navigation handling | [raldisk](https://github.com/raldisk/instagram-diff) |

This project would not exist without the foundational work of SH3LL and floriandiud. The rewrite preserves full compatibility with their original IndexedDB schema and CSV format.

---

## What It Does

Opens a small panel on any Instagram profile page. When you open a followers or following list and click **Auto-Scroll**, the script scrolls the modal to the bottom automatically. The engine (`main.js`) silently intercepts Instagram's API responses as the list loads and stores every account to IndexedDB. When you're done, click **Download** to export the full list as a CSV file compatible with [run_tracker.py](./run_tracker.py).

```
You open Instagram profile → click followers/following
    → click Auto-Scroll
        → engine intercepts API responses silently
            → list loads fully, scroll stops automatically
                → click Download → instaExport-[timestamp].csv
```

---

## Files

| File | Purpose |
|---|---|
| `scraper.user.js` | Single-file install — engine + scroll panel bundled |
| `main.js` | Engine only — for `@require` use after GitHub publish |

---

## Installation

### Option A — Single file (recommended, works offline)

1. Install [Violentmonkey](https://violentmonkey.github.io/)
2. Open Violentmonkey → Dashboard → click **+** → New Script
3. Delete all default content
4. Paste the entire contents of [`scraper.user.js`](./scraper.user.js)
5. Save (`Ctrl+S`)
6. Navigate to any Instagram profile — the panel appears top-right

### Option B — Split files via `@require` (auto-updates from GitHub)

Once `main.js` is live in this repo, create a new VM script with only this content:

```js
// ==UserScript==
// @name         Instagram Followers/Following Scraper
// @version      4.0.0
// @match        https://www.instagram.com/*
// @grant        GM_notification
// @require      https://raw.githubusercontent.com/raldisk/instagram-diff/main/userscript/main.js
// ==/UserScript==

// paste only the SCROLL PANEL START → SCROLL PANEL END section from scraper.user.js
```

With this setup, pushing updates to `main.js` on GitHub propagates to all installs automatically. The scroll panel section stays local and only updates when you edit it manually.

---

## Usage

### Step 1 — Open a profile

Navigate to any Instagram profile page (e.g. `instagram.com/username/`). The scroll panel appears in the top-right corner.

### Step 2 — Open the list

Click the **Followers** or **Following** count on the profile to open the modal list.

### Step 3 — Auto-Scroll

Click **Auto-Scroll** in the panel. The script scrolls the modal automatically and shows a live count:

| Status | Meaning |
|---|---|
| `Scrolling...` | Actively scrolling |
| `Loaded: 45` | 45 accounts loaded so far |
| `End check 2/3` | Scroll height stable, verifying end of list |
| `Done: 312 accounts` | Full list loaded, scroll stopped |

A browser notification fires when the list is complete.

Click **Stop** at any time to halt scrolling.

### Step 4 — Download

Click **Download N users** in the bottom-right widget to export a CSV file. The file is named `instaExport-[ISO timestamp].csv`.

### Step 5 — Reset

Click **Reset** to clear the IndexedDB store and start fresh.

---

## CSV Format

The exported CSV is directly compatible with `run_tracker.py` for diff analysis.

| Column | Example |
|---|---|
| Profile Id | `123456789` |
| Username | `example_user` |
| Link | `https://www.instagram.com/example_user` |
| Full Name | `Example User` |
| Is Private | `false` |
| Location | `Manila, Philippines` |
| Picture Url | `https://cdninstagram.com/...` |
| Source | `followers of 123456789 (example_user)` |

---

## Two-Panel Layout

| Panel | Position | Controls |
|---|---|---|
| Scroll panel | Top-right | Auto-Scroll / Stop + status |
| Engine widget | Bottom-right | Download N users + Reset + history log |

The panels are independent — the engine widget persists across profile navigations while the scroll panel resets per-profile.

---

## Supported Instagram API Endpoints

The engine intercepts both XHR and `fetch()` — Instagram has progressively migrated endpoints between the two.

| Endpoint | Data captured |
|---|---|
| `/api/v1/friendships/*/followers/` | Followers list |
| `/api/v1/friendships/*/following/` | Following list |
| `/api/v1/tags/web_info` | Tag post authors |
| `/api/v1/locations/web_info` | Location post authors |
| `/api/v1/locations/*/sections/` | Location sections |
| `/api/v1/fbsearch/web/top_serp` | Search results |
| `/api/v1/discover/web/explore_grid` | Explore page |
| `/graphql/query` | GraphQL location responses |

---

## Architecture

### scraper.user.js — Scroll Panel

```
createRegistry()          cleanup registry — all listeners/timers self-register
  └── createSession()     one session per profile page visit
        └── createScroller()  rAF-driven scroll loop with cancellation token
              └── buildPanel()  top-right UI, scroll button + status label
```

**SPA navigation** — `history.pushState` and `replaceState` are patched to detect React route changes. On navigation, the current session tears down fully before a new one is created.

**Memory management** — every `addEventListener`, `setTimeout`, and DOM node is registered with a `createRegistry()` instance. `teardown()` flushes the registry LIFO, leaving zero references.

### main.js — Engine

```
App
  ├── AccountStore      IndexedDB persistence (DB version 6, deduplication by profileId)
  ├── Widget            Download/Reset UI, bottom-right
  ├── HistoryLog        Per-session log with incremental DOM updates
  ├── BoundedCache      locationNameCache (200) + profileUsernamesCache (1000)
  └── _installPatches() XHR + fetch interceptors, guarded + restorable
        └── _dispatchPayload()  routes each API response to the correct parser
```

---

## What Changed from the Originals

### vs SH3LL v2.3 (`scraper.user.js`)

| Issue | Fix |
|---|---|
| `position: absolute` — panel scrolls off screen | `position: fixed` |
| `paddingX` — invalid CSS property | `padding: 5px 11px` |
| `setInterval` + `setTimeout` inside MutationObserver — N competing intervals | Single `requestAnimationFrame` loop |
| MutationObserver never disconnected | Removed entirely |
| No scroll-end detection | `scrollHeight` stabilization over 3 checks |
| No progress feedback | Live counter + end detection status |
| No error handling on scrape inject | HTTP status check, `onerror`, red button feedback |
| Global scope pollution | Everything inside IIFE |
| No SPA navigation handling | `pushState` / `replaceState` patched, session teardown on nav |
| No duplicate guard | Panel ID check before inject |

### vs floriandiud `main.min.js`

| Issue | Fix |
|---|---|
| `__awaiter` × 2 + `__rest` polyfills | Deleted — native `async/await` |
| Full bundled `idb` library (~200 lines) | 80-line minimal native IDB wrapper |
| XHR patch unstackable, never restored | `_patchActive` guard + `removePatches()` |
| No `fetch()` intercept | `window.fetch` patched with response clone |
| `readystatechange` listeners accumulate | Named handler, removed after `readyState === 4` |
| `sourceGlobal` mutable global — race condition | Eliminated, source passed per-call |
| `locationNameCache` plain object, unbounded | `BoundedCache(200)` with FIFO eviction |
| `profileUsernamesCache` plain object, unbounded | `BoundedCache(1000)` |
| `randomString(10)` | `crypto.randomUUID()` |
| Blob URL never revoked on export | `URL.revokeObjectURL` after `a.click()` |
| `renderLogs()` full DOM teardown per entry | Incremental DOM — one `<li>` per `add()` |
| `innerHTML` with user label data | `textContent` everywhere — XSS eliminated |
| Duplicate persist + log pattern × 3 | Single `_persist(accounts, source)` |
| IDB failure swallowed silently | `init()` returns `{ degraded }`, on-screen warning |
| Module-level mutable globals | Single `App` instance owns all state |
| No boot guard | `window.__igScraperLoaded` flag |

---

## Integration with run_tracker.py

The CSV output from this userscript feeds directly into `run_tracker.py` for diff analysis between scrape sessions.

```bash
# After downloading followers.csv and following.csv:
uv run python run_tracker.py

# With options:
uv run python run_tracker.py --followers followers.csv --following following.csv --debug
uv run python run_tracker.py --no-pdf   # skip PDF, dry run
```

See the main [README](./README.md) for the full pipeline documentation.

---

## Known Limitations

- Instagram must be open in a real logged-in browser session — headless scraping is not supported and risks account action
- CDN profile picture URLs in the CSV expire after a period — run `download_pics.py` shortly after export
- IndexedDB is unavailable in some private browsing modes — the engine falls back to an in-memory Map with an on-screen warning (data lost on navigation)
- Instagram's obfuscated atomic CSS class names (e.g. `x1rife3k`) may rotate on deploys — the scroll selector chain tries semantic selectors first and falls back gracefully

---

## Changelog

See [CHANGELOG.md](../CHANGELOG.md) for full version history.

---

## License

MIT — see [LICENSE](../LICENSE)

Original works by [SH3LL](https://greasyfork.org/users/762057) and [floriandiud](https://github.com/floriandiud/instagram-users-scraper) are credited above and remain under their respective licenses.
