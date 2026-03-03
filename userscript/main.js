/**
 * instagram-scraper/main.js
 *
 * Clean rewrite of floriandiud/instagram-users-scraper (main.min.js).
 * Drop-in replacement — same CSV schema, same IndexedDB store name,
 * same URL routing so existing data is preserved.
 *
 * Changes vs original:
 *  - Removed __awaiter / __rest polyfills (native async/await throughout)
 *  - Removed inline idb library — replaced with minimal native IDB wrapper
 *  - XHR patch guarded + restorable (no stacking on reinject)
 *  - fetch() intercept added (IG has migrated endpoints)
 *  - sourceGlobal race condition eliminated (source passed per-call)
 *  - locationNameCache / profileUsernamesCache → bounded Map
 *  - exportToCsv blob URL revoked after click
 *  - HistoryTracker: incremental DOM updates, no full rebuild per log
 *  - History log rendering uses textContent — no XSS via username/label
 *  - crypto.randomUUID() replaces randomString(10)
 *  - Single App object — no module-level mutable globals
 *  - IDB init failure surfaced to UI (no silent degraded mode)
 */

'use strict';

// =============================================================================
// IDB — MINIMAL NATIVE WRAPPER
// Replaces the full bundled idb library with ~80 lines of native IDB.
// Supports only what the storage layer actually needs.
// =============================================================================

/**
 * Open (or upgrade) an IndexedDB database.
 * @param {string} name
 * @param {number} version
 * @param {(db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void} onUpgrade
 * @returns {Promise<IDBDatabase>}
 */
function idbOpen(name, version, onUpgrade) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = (e) => onUpgrade(req.result, e.oldVersion, req.transaction);
        req.onsuccess  = () => resolve(req.result);
        req.onerror    = () => reject(req.error);
        req.onblocked  = () => reject(new Error(`IDB blocked: ${name}`));
    });
}

/** Wrap a single IDBRequest in a Promise. */
function idbReq(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

/** Run a transaction and return a Promise that resolves when it completes. */
function idbTx(db, stores, mode, fn) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
        tx.onabort    = () => reject(new DOMException('AbortError', 'AbortError'));
        fn(tx);
    });
}

// =============================================================================
// STORAGE
// IndexedDB-backed store. Schema identical to original so existing data
// is readable. Falls back to in-memory Map if IDB is unavailable
// (private browsing), and surfaces that state to the caller.
// =============================================================================

const DB_VERSION   = 6;
const STORE_NAME   = 'data';
const INDEX_PK     = '_pk';
const INDEX_GROUP  = '_groupId';
const INDEX_DATE   = '_createdAt';

class AccountStore {
    /**
     * @param {string} dbName - IndexedDB database name
     */
    constructor(dbName) {
        this._dbName    = 'storage-' + dbName;
        this._db        = null;
        this._fallback  = new Map();   // used only if IDB unavailable
        this._ready     = false;
        this._degraded  = false;       // true = running on in-memory Map
    }

    /** Must be called before any other method. Resolves with degraded=true if IDB failed. */
    async init() {
        try {
            this._db = await idbOpen(this._dbName, DB_VERSION, (db, oldVersion, tx) => {
                // Wipe pre-v5 object store (schema change in original)
                if (oldVersion < 5) {
                    try { db.deleteObjectStore(STORE_NAME); } catch (_) {}
                }

                let store;
                if (db.objectStoreNames.contains(STORE_NAME)) {
                    store = tx.objectStore(STORE_NAME);
                } else {
                    store = db.createObjectStore(STORE_NAME, { keyPath: '_id', autoIncrement: true });
                }

                if (!store.indexNames.contains(INDEX_DATE))  store.createIndex(INDEX_DATE,  INDEX_DATE);
                if (!store.indexNames.contains(INDEX_GROUP)) store.createIndex(INDEX_GROUP, INDEX_GROUP);
                if (!store.indexNames.contains(INDEX_PK))    store.createIndex(INDEX_PK,    INDEX_PK, { unique: true });
            });
            this._ready = true;
        } catch (err) {
            console.warn('[ig-scraper] IDB unavailable, using in-memory fallback:', err);
            this._degraded = true;
            this._ready    = true;
        }
        return { degraded: this._degraded };
    }

    /** @returns {Promise<number>} */
    async count() {
        if (this._db) return idbReq(this._db.transaction(STORE_NAME).objectStore(STORE_NAME).count());
        return this._fallback.size;
    }

    /**
     * Get a single record by its _pk (profileId).
     * @param {string|number} pk
     * @returns {Promise<object|undefined>}
     */
    async getByPk(pk) {
        if (this._db) {
            return idbReq(
                this._db.transaction(STORE_NAME)
                    .objectStore(STORE_NAME)
                    .index(INDEX_PK)
                    .get(pk)
            );
        }
        return this._fallback.get(pk);
    }

    /**
     * Add multiple records in a single transaction. Skips duplicates by _pk.
     * @param {Array<[string|number, object]>} entries  - [pk, data] pairs
     * @param {string} groupId
     * @returns {Promise<number>} count of records actually inserted
     */
    async addBatch(entries, groupId) {
        if (!entries.length) return 0;

        // Deduplicate within this batch by pk
        const seen = new Set();
        const deduped = entries.filter(([pk]) => {
            if (seen.has(pk)) return false;
            seen.add(pk);
            return true;
        });

        if (this._db) {
            let inserted = 0;

            await idbTx(this._db, STORE_NAME, 'readwrite', (tx) => {
                const store = tx.objectStore(STORE_NAME);
                const pkIdx = store.index(INDEX_PK);

                for (const [pk, data] of deduped) {
                    const getReq = pkIdx.get(pk);
                    getReq.onsuccess = () => {
                        if (getReq.result) return; // already exists — skip
                        const record = { _pk: pk, _createdAt: new Date(), _groupId: groupId, ...data };
                        const putReq = store.put(record);
                        putReq.onsuccess = () => { inserted++; };
                    };
                }
            });

            return inserted;
        }

        // Fallback path
        let inserted = 0;
        for (const [pk, data] of deduped) {
            if (!this._fallback.has(pk)) {
                this._fallback.set(pk, data);
                inserted++;
            }
        }
        return inserted;
    }

    /**
     * Delete all records belonging to a groupId.
     * @param {string} groupId
     */
    async deleteGroup(groupId) {
        if (!this._db) return;
        await idbTx(this._db, STORE_NAME, 'readwrite', (tx) => {
            const range  = IDBKeyRange.only(groupId);
            const cursor = tx.objectStore(STORE_NAME).index(INDEX_GROUP).openCursor(range);
            cursor.onsuccess = function () {
                const c = cursor.result;
                if (!c) return;
                c.delete();
                c.continue();
            };
        });
    }

    /** Clear all records. */
    async clear() {
        if (this._db) {
            await idbTx(this._db, STORE_NAME, 'readwrite', (tx) => {
                tx.objectStore(STORE_NAME).clear();
            });
        } else {
            this._fallback.clear();
        }
    }

    /**
     * Return all records as an array of plain objects (internal fields stripped).
     * @returns {Promise<object[]>}
     */
    async getAll() {
        if (this._db) {
            const raw = await idbReq(
                this._db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll()
            );
            // Strip internal fields
            return raw.map(({ _id, _pk, _createdAt, _groupId, ...data }) => data);
        }
        return [...this._fallback.values()];
    }
}

// =============================================================================
// CSV EXPORT
// Fixes blob URL leak: URL.revokeObjectURL called after synthetic click.
// =============================================================================

/**
 * Escape a single CSV cell value.
 * @param {unknown} value
 * @returns {string}
 */
function csvCell(value) {
    if (value === null || value === undefined) return '';
    const s = value instanceof Date ? value.toLocaleString() : String(value);
    const escaped = s.replace(/"/g, '""');
    return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

/**
 * Trigger a CSV file download.
 * @param {string} filename
 * @param {unknown[][]} rows  - first row is treated as headers
 */
function downloadCsv(filename, rows) {
    const csv  = rows.map(row => row.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Fix: revoke immediately after click — original never called this
    URL.revokeObjectURL(url);
}

// =============================================================================
// INSTAGRAM ACCOUNT SCHEMA
// CSV headers kept identical to original for run_tracker.py compatibility.
// =============================================================================

const CSV_HEADERS = ['Profile Id', 'Username', 'Link', 'Full Name', 'Is Private', 'Location', 'Picture Url', 'Source'];

/**
 * @typedef {{ profileId: string, username: string, fullName: string,
 *             isPrivate?: boolean, pictureUrl?: string,
 *             location?: string, source?: string }} Account
 */

/**
 * Convert an Account to a CSV row in the same order as CSV_HEADERS.
 * @param {Account} acc
 * @returns {unknown[]}
 */
function accountToRow(acc) {
    const link      = `https://www.instagram.com/${acc.username}`;
    const isPrivate = typeof acc.isPrivate === 'boolean' ? String(acc.isPrivate) : '';
    return [
        acc.profileId,
        acc.username,
        link,
        acc.fullName,
        isPrivate,
        acc.location  || '',
        acc.pictureUrl || '',
        acc.source    || '',
    ];
}

// =============================================================================
// BOUNDED CACHE
// Replaces the original plain-object caches that grew without bound.
// Simple FIFO eviction — Map preserves insertion order.
// =============================================================================

class BoundedCache {
    /** @param {number} maxSize */
    constructor(maxSize = 500) {
        this._max  = maxSize;
        this._map  = new Map();
    }

    get(key)        { return this._map.get(key); }
    has(key)        { return this._map.has(key); }

    set(key, value) {
        if (this._map.has(key)) this._map.delete(key); // refresh position
        else if (this._map.size >= this._max) {
            // evict oldest entry
            this._map.delete(this._map.keys().next().value);
        }
        this._map.set(key, value);
    }
}

// =============================================================================
// HISTORY LOG UI
// Incremental DOM updates — no full teardown/rebuild per entry.
// Uses textContent for all user-supplied strings — no XSS.
// =============================================================================

const DELETE_SVG = `<svg stroke="currentColor" fill="none" stroke-width="2"
    viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"
    height="16px" width="16px" xmlns="http://www.w3.org/2000/svg">
  <polyline points="3 6 5 6 21 6"/>
  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
</svg>`;

class HistoryLog {
    /**
     * @param {{ container: HTMLElement, maxLogs?: number, onDelete: (groupId: string) => Promise<void> }} opts
     */
    constructor({ container, maxLogs = 4, onDelete }) {
        this._container = container;
        this._maxLogs   = maxLogs;
        this._onDelete  = onDelete;
        this._panel     = null;
        this._ul        = null;
        this._counter   = 0;

        /** @type {Array<{ index: number, label: string, groupId: string, count: number, cancellable: boolean, el: HTMLLIElement }>} */
        this._logs = [];
    }

    _ensurePanel() {
        if (this._panel) return;

        this._panel = Object.assign(document.createElement('div'), {});
        this._panel.style.cssText = `
            text-align: right;
            background: #f5f5fa;
            padding: 8px;
            margin-bottom: 8px;
            border-radius: 8px;
            font-family: monospace;
            font-size: 14px;
            box-shadow: rgba(42,35,66,.2) 0 2px 2px, rgba(45,35,66,.2) 0 7px 13px -4px;
            color: #2f2f2f;
        `;

        this._ul = document.createElement('ul');
        this._ul.style.cssText = 'list-style: none; margin: 0; padding: 0;';
        this._panel.appendChild(this._ul);
        this._container.appendChild(this._panel);
    }

    /**
     * @param {{ label: string, groupId: string, count: number, cancellable: boolean }} entry
     */
    add({ label, groupId, count, cancellable }) {
        this._counter++;
        this._ensurePanel();

        // Trim oldest if over limit — remove from DOM and logs array
        while (this._logs.length >= this._maxLogs) {
            const oldest = this._logs.pop();
            oldest.el.remove();
        }

        const index = this._counter;

        // Build <li> using textContent — no innerHTML with user data
        const li = document.createElement('li');
        li.style.cssText = 'line-height: 28px; display: flex; align-items: center; justify-content: flex-end; gap: 6px;';

        const labelEl = document.createElement('div');
        labelEl.textContent = `#${index} ${label} (${count})`;
        li.appendChild(labelEl);

        if (cancellable) {
            const del = document.createElement('div');
            del.style.cssText = 'display: flex; align-items: center; padding: 4px 8px; cursor: pointer;';
            del.innerHTML = DELETE_SVG; // constant SVG — not user data, safe
            del.addEventListener('click', async () => {
                del.style.opacity = '0.4';
                del.style.pointerEvents = 'none';
                await this._onDelete(groupId);
                li.remove();
                this._logs = this._logs.filter(e => e.index !== index);
                if (this._logs.length === 0) this._clearPanel();
            });
            li.appendChild(del);
        }

        // Prepend — newest at top (matches original order)
        this._ul.prepend(li);

        this._logs.unshift({ index, label, groupId, count, cancellable, el: li });
    }

    clear() {
        this._logs = [];
        this._counter = 0;
        this._clearPanel();
    }

    _clearPanel() {
        if (this._panel) {
            this._panel.remove();
            this._panel = null;
            this._ul    = null;
        }
    }
}

// =============================================================================
// WIDGET UI
// Fixed bottom-right panel. Counter updated in-place (no innerHTML rebuild).
// =============================================================================

class Widget {
    constructor() {
        this._root       = null;
        this._counterEl  = null;
        this._historyDiv = null;
    }

    /**
     * Build and mount the widget.
     * @param {{ onDownload: () => void, onReset: () => void }} handlers
     * @returns {{ historyContainer: HTMLElement }}
     */
    mount({ onDownload, onReset }) {
        // Outer canvas — full-viewport transparent overlay, pointer-events none
        const canvas = document.createElement('div');
        canvas.style.cssText = `
            position: fixed; top: 0; left: 0; z-index: 10000;
            width: 100%; height: 100%; pointer-events: none;
        `;

        // Inner panel — anchored bottom-right
        const inner = document.createElement('div');
        inner.style.cssText = `
            position: absolute; bottom: 30px; right: 30px;
            width: auto; pointer-events: auto;
        `;

        // History log container (above the button bar)
        this._historyDiv = document.createElement('div');
        inner.appendChild(this._historyDiv);

        // Button bar
        const bar = document.createElement('div');
        bar.style.cssText = `
            align-items: center;
            background-color: #EEE;
            border-radius: 4px;
            box-shadow: rgba(45,35,66,.4) 0 2px 4px, rgba(45,35,66,.3) 0 7px 13px -3px, #D6D6E7 0 -3px 0 inset;
            box-sizing: border-box;
            color: #36395A;
            display: flex;
            font-family: monospace;
            font-size: 18px;
            height: 38px;
            justify-content: space-between;
            overflow: hidden;
            padding: 0 16px;
            user-select: none;
            white-space: nowrap;
            gap: 8px;
        `;

        // Download button
        const dlBtn = document.createElement('div');
        dlBtn.style.cssText = 'cursor: pointer; display: flex; align-items: center; gap: 4px;';
        const dlLabel  = document.createElement('span');
        dlLabel.textContent = 'Download ';
        this._counterEl = document.createElement('strong');
        this._counterEl.textContent = '0';
        const dlSuffix = document.createElement('span');
        dlSuffix.textContent = ' users';
        dlBtn.append(dlLabel, this._counterEl, dlSuffix);
        dlBtn.addEventListener('click', onDownload);

        // Separator
        const sep = document.createElement('div');
        sep.style.cssText = 'margin: 0 4px; border-left: 1px solid #2e2e2e; height: 20px;';

        // Reset button
        const resetBtn = document.createElement('div');
        resetBtn.style.cssText = 'cursor: pointer;';
        resetBtn.textContent = 'Reset';
        resetBtn.addEventListener('click', onReset);

        bar.append(dlBtn, sep, resetBtn);
        inner.appendChild(bar);
        canvas.appendChild(inner);
        document.body.appendChild(canvas);
        this._root = canvas;

        return { historyContainer: this._historyDiv };
    }

    /** @param {number} n */
    setCount(n) {
        if (this._counterEl) this._counterEl.textContent = String(n);
    }

    destroy() {
        this._root?.remove();
        this._root = null;
    }
}

// =============================================================================
// RESPONSE PARSERS
// Each parser extracts Account objects from a specific Instagram API shape.
// Returns Account[] — no side effects.
// =============================================================================

/**
 * Followers / following API: { users: [{ pk, username, full_name, ... }] }
 * @param {object} json
 * @param {string} source
 * @returns {Account[]}
 */
function parseUsers(json, source) {
    if (!json?.users) return [];
    return json.users.flatMap(u => {
        if (!u) return [];
        const { pk, username, full_name, is_private, profile_pic_url } = u;
        return [{ profileId: pk, username, fullName: full_name, isPrivate: is_private, pictureUrl: profile_pic_url, source }];
    });
}

/**
 * Extract Account objects from an array of IG media section objects.
 * Shared between tag, location, hashtag, and GraphQL responses.
 * @param {object[]} sections
 * @param {string} source
 * @returns {Account[]}
 */
function parseSections(sections, source) {
    const medias = [];
    for (const section of sections) {
        const lc = section?.layout_content;
        if (lc?.medias?.length)     medias.push(...lc.medias);
        if (lc?.fill_items?.length) medias.push(...lc.fill_items);
        if (section?.node)          medias.push(section.node);
    }

    const accounts = [];
    for (const item of medias) {
        let media = item?.media;
        if (!media && item?.__typename === 'XDTMediaDict') media = item;
        if (!media) continue;

        const owner = media.owner;
        if (!owner) continue;

        const { pk, username, full_name, is_private, profile_pic_url } = owner;
        const acc = {
            profileId:  pk,
            username,
            fullName:   full_name,
            isPrivate:  is_private,
            pictureUrl: profile_pic_url,
            source,
        };

        // Location from post
        if (media.location?.name) acc.location = media.location.name;

        // is_private fallback
        if (acc.isPrivate == null && media.user?.is_private !== undefined) {
            acc.isPrivate = media.user.is_private;
        }

        accounts.push(acc);
    }
    return accounts;
}

/**
 * Tag/location/GraphQL "sections" shaped response.
 * @param {object} json
 * @param {string} source
 * @param {BoundedCache} locationCache
 * @returns {{ accounts: Account[], source: string }}
 */
function parseSectionResponse(json, source, locationCache) {
    let sections = [];
    let resolvedSource = source;

    if (json?.data) {
        // Tag / search result shape
        resolvedSource = json.data.name || source;
        if (json.data.recent?.sections)                        sections.push(...json.data.recent.sections);
        if (json.data.top?.sections)                           sections.push(...json.data.top.sections);
        if (json.data.xdt_location_get_web_info_tab?.edges)    sections.push(...json.data.xdt_location_get_web_info_tab.edges);
    } else if (json?.media_grid?.sections) {
        sections = json.media_grid.sections;
    } else if (json?.native_location_data) {
        const loc = json.native_location_data;
        if (loc.location_info?.name) {
            locationCache.set(loc.location_info.location_id, loc.location_info.name);
            resolvedSource = buildSource('location', loc.location_info.location_id, locationCache);
        }
        if (loc.ranked?.sections) sections.push(...loc.ranked.sections);
        if (loc.recent?.sections) sections.push(...loc.recent.sections);
    } else if (json?.sections) {
        sections = json.sections;
    }

    return { accounts: parseSections(sections, resolvedSource), source: resolvedSource };
}

/**
 * Explore grid shape: { sectional_items: [{ layout_content: { fill_items: [...] } }] }
 * @param {object} json
 * @returns {Account[]}
 */
function parseExplore(json) {
    const items = json?.sectional_items;
    if (!items?.length) return [];

    const fillItems = items.flatMap(i => i?.layout_content?.fill_items ?? []);
    return fillItems.flatMap(item => {
        const media = item?.media;
        if (!media?.owner) return [];
        const { pk, username, full_name, is_private, profile_pic_url } = media.owner;
        return [{ profileId: pk, username, fullName: full_name, isPrivate: is_private, pictureUrl: profile_pic_url, source: 'Explore' }];
    });
}

// =============================================================================
// SOURCE STRING HELPERS
// =============================================================================

/**
 * @param {'followers'|'following'|'tag'|'location'} type
 * @param {string} [id]
 * @param {BoundedCache} [locationCache]
 * @returns {string}
 */
function buildSource(type, id, locationCache) {
    const decodeTag = (t) => (typeof t === 'string' && t.startsWith('%23')) ? t.replace('%23', '') : t;

    switch (type) {
        case 'followers': return `followers of ${id}`;
        case 'following': return `following of ${id}`;
        case 'tag': {
            if (!id) return 'post authors';
            return `post authors #${decodeTag(id)}`;
        }
        case 'location': {
            if (!id) return 'post authors';
            const name = locationCache?.get(id);
            if (name)  return `post authors (loc: ${name})`;
            if (typeof id === 'string' && id.startsWith('%23')) return `post authors (loc: ${id.replace('%23', '')})`;
            return `post authors (loc: ${id})`;
        }
        default: return 'post authors';
    }
}

// =============================================================================
// APP
// Single object — owns all mutable state.
// No module-level globals outside this object.
// =============================================================================

class App {
    constructor() {
        this._store          = new AccountStore('insta-scrape');
        this._widget         = new Widget();
        this._history        = null;
        this._locationCache  = new BoundedCache(200);
        this._profileCache   = new BoundedCache(1000);
        this._origXhrSend    = null;
        this._origFetch      = null;
        this._patchActive    = false;
    }

    async init() {
        const { degraded } = await this._store.init();

        const { historyContainer } = this._widget.mount({
            onDownload: () => this._onDownload(),
            onReset:    () => this._onReset(),
        });

        this._history = new HistoryLog({
            container: historyContainer,
            maxLogs:   4,
            onDelete:  async (groupId) => {
                await this._store.deleteGroup(groupId);
                await this._refreshCount();
            },
        });

        // Warn user if IDB is unavailable (private browsing, etc.)
        if (degraded) {
            console.warn('[ig-scraper] IndexedDB unavailable. Data will not persist across navigation.');
            const warn = document.createElement('div');
            warn.style.cssText = `
                position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
                background: #b45309; color: #fff; padding: 6px 14px;
                border-radius: 6px; font-family: monospace; font-size: 13px;
                z-index: 99999; pointer-events: none;
            `;
            warn.textContent = 'ig-scraper: IndexedDB unavailable — data stored in memory only';
            document.body.appendChild(warn);
            setTimeout(() => warn.remove(), 6000);
        }

        await this._refreshCount();
        this._installPatches();
    }

    // -------------------------------------------------------------------------
    // DOWNLOAD + RESET
    // -------------------------------------------------------------------------

    async _onDownload() {
        const records = await this._store.getAll();
        const rows    = [CSV_HEADERS, ...records.map(accountToRow)];
        const ts      = new Date().toISOString();
        downloadCsv(`instaExport-${ts}.csv`, rows);
    }

    async _onReset() {
        await this._store.clear();
        this._history.clear();
        await this._refreshCount();
    }

    async _refreshCount() {
        const n = await this._store.count();
        this._widget.setCount(n);
    }

    // -------------------------------------------------------------------------
    // PERSIST ACCOUNTS
    // Shared path for all parsers — eliminates the duplicate
    // addElems + updateCounter + addHistoryLog pattern in the original.
    // -------------------------------------------------------------------------

    async _persist(accounts, source) {
        if (!accounts.length) return;

        const groupId = crypto.randomUUID();
        const entries = accounts
            .filter(Boolean)
            .map(acc => [acc.profileId, acc]);

        const inserted = await this._store.addBatch(entries, groupId);
        await this._refreshCount();

        this._history.add({
            label:       source ? `Added ${source}` : 'Added items',
            groupId,
            count:       inserted,
            cancellable: false,
        });
    }

    // -------------------------------------------------------------------------
    // PROFILE ID → USERNAME LOOKUP
    // Used to enrich follower/following log labels.
    // -------------------------------------------------------------------------

    async _resolveUsername(profileId) {
        const pid = String(profileId);
        if (this._profileCache.has(pid)) return this._profileCache.get(pid);

        const record = await this._store.getByPk(profileId);
        if (record?.username) {
            this._profileCache.set(pid, record.username);
            return record.username;
        }
        return null;
    }

    // -------------------------------------------------------------------------
    // RESPONSE ROUTING
    // Routes a parsed JSON payload to the correct parser based on URL context.
    // Eliminates the mutable sourceGlobal race condition — source is
    // derived per-call and passed explicitly.
    // -------------------------------------------------------------------------

    async _routeResponse(text, url) {
        // Parse JSON — Instagram sometimes sends newline-delimited JSON
        let payloads = [];
        try {
            payloads = [JSON.parse(text)];
        } catch (_) {
            payloads = text.split('\n').flatMap(line => {
                try { return [JSON.parse(line)]; } catch (_) { return []; }
            });
        }
        if (!payloads.length) return;

        for (const json of payloads) {
            await this._dispatchPayload(json, url);
        }
    }

    async _dispatchPayload(json, url) {
        // --- Followers
        const followersMatch = /\/api\/v1\/friendships\/(?<id>\d+)\/followers\//.exec(url);
        if (followersMatch) {
            const pid      = followersMatch.groups.id;
            const username = await this._resolveUsername(pid);
            const label    = username ? `${pid} (${username})` : pid;
            await this._persist(parseUsers(json, buildSource('followers', label)), buildSource('followers', label));
            return;
        }

        // --- Following
        const followingMatch = /\/api\/v1\/friendships\/(?<id>\d+)\/following\//.exec(url);
        if (followingMatch) {
            const pid      = followingMatch.groups.id;
            const username = await this._resolveUsername(pid);
            const label    = username ? `${pid} (${username})` : pid;
            await this._persist(parseUsers(json, buildSource('following', label)), buildSource('following', label));
            return;
        }

        // --- Explore
        if (url.includes('/api/v1/discover/web/explore_grid')) {
            await this._persist(parseExplore(json), 'Explore');
            return;
        }

        // --- Tag info
        if (url.includes('/api/v1/tags/web_info')) {
            const m   = /tag_name=(?<tag>[\w_-]+)/i.exec(url);
            const src = buildSource('tag', m?.groups?.tag);
            const { accounts } = parseSectionResponse(json, src, this._locationCache);
            await this._persist(accounts, src);
            return;
        }

        // --- Location web info
        if (url.includes('/api/v1/locations/web_info')) {
            const m   = /location_id=(?<id>[\w_-]+)/i.exec(url);
            const src = buildSource('location', m?.groups?.id, this._locationCache);
            const { accounts } = parseSectionResponse(json, src, this._locationCache);
            await this._persist(accounts, src);
            return;
        }

        // --- Search top SERP
        if (url.includes('/api/v1/fbsearch/web/top_serp')) {
            const m   = /query=(?<tag>[\w_%-]+)/i.exec(url);
            const src = buildSource('tag', m?.groups?.tag);
            const { accounts } = parseSectionResponse(json, src, this._locationCache);
            await this._persist(accounts, src);
            return;
        }

        // --- Location sections
        if (/\/api\/v1\/locations\/[\w\d]+\/sections\//.test(url)) {
            const m   = /\/locations\/(?<id>[\w\d]+)\/sections\//.exec(url);
            const src = buildSource('location', m?.groups?.id, this._locationCache);
            const { accounts } = parseSectionResponse(json, src, this._locationCache);
            await this._persist(accounts, src);
            return;
        }

        // --- GraphQL query (location from page URL)
        if (url.includes('/graphql/query')) {
            const m   = /explore\/locations\/\d+\/(?<slug>[\w-]+)\/?/.exec(window.location.href);
            const src = buildSource('tag', m?.groups?.slug);
            const { accounts } = parseSectionResponse(json, src, this._locationCache);
            await this._persist(accounts, src);
            return;
        }

        // --- Generic sections endpoint
        if (/\/api\/v1\/[\w\d/]+\/sections\//.test(url)) {
            const { accounts } = parseSectionResponse(json, 'post authors', this._locationCache);
            await this._persist(accounts, 'post authors');
            return;
        }
    }

    // -------------------------------------------------------------------------
    // NETWORK PATCHES
    // XHR + fetch, guarded against stacking, restorable.
    // -------------------------------------------------------------------------

    _installPatches() {
        if (this._patchActive) return; // guard: never stack
        this._patchActive = true;

        // -- XHR patch
        this._origXhrSend = XMLHttpRequest.prototype.send;
        const app = this;

        XMLHttpRequest.prototype.send = function (...args) {
            // Capture URL before the request fires
            const xhr = this;
            // readystatechange is used (not load) to match original behaviour
            // The listener is a named function so it can be removed per-instance.
            function onStateChange() {
                if (xhr.readyState !== 4) return;
                xhr.removeEventListener('readystatechange', onStateChange);
                const url = xhr.responseURL || '';
                if (url) app._routeResponse(xhr.responseText, url).catch(console.error);
            }
            xhr.addEventListener('readystatechange', onStateChange);
            app._origXhrSend.apply(xhr, args);
        };

        // -- fetch patch
        this._origFetch = window.fetch;
        const origFetch = this._origFetch;

        window.fetch = async function (...args) {
            const response = await origFetch.apply(window, args);
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';

            // Clone response so the caller's .json()/.text() still works
            const clone = response.clone();
            clone.text()
                .then(text => app._routeResponse(text, url))
                .catch(console.error);

            return response;
        };
    }

    /** Restore original XHR.send and window.fetch. */
    removePatches() {
        if (!this._patchActive) return;
        if (this._origXhrSend) XMLHttpRequest.prototype.send = this._origXhrSend;
        if (this._origFetch)   window.fetch                  = this._origFetch;
        this._origXhrSend = null;
        this._origFetch   = null;
        this._patchActive = false;
    }
}

// =============================================================================
// BOOT
// Single entry point. Guard prevents double-init on reinject.
// =============================================================================

const BOOT_FLAG = '__igScraperLoaded';

if (!window[BOOT_FLAG]) {
    window[BOOT_FLAG] = true;
    const app = new App();
    app.init().catch(err => {
        console.error('[ig-scraper] Init failed:', err);
        delete window[BOOT_FLAG]; // allow retry
    });
}
