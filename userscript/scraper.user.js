// ==UserScript==
// @name         Instagram Followers/Following Scraper
// @version      4.0.0
// @description  Auto-scrape Instagram followers/following to CSV with auto-scroll. Zero memory leaks.
// @author       raldisk (engine rewrite); original concept SH3LL; original interceptor floriandiud
// @match        https://www.instagram.com/*
// @grant        GM_notification
// @namespace    https://github.com/raldisk/instagram-diff
// @homepageURL  https://github.com/raldisk/instagram-diff
// @supportURL   https://github.com/raldisk/instagram-diff/issues
// ==/UserScript==

// =============================================================================
// ENGINE START — main.js (inlined)
// To update: replace everything between ENGINE START / ENGINE END.
// Source: github.com/raldisk/instagram-diff/blob/main/main.js
// =============================================================================

'use strict';

// -- IDB minimal wrapper ------------------------------------------------------

function idbOpen(name, version, onUpgrade) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = (e) => onUpgrade(req.result, e.oldVersion, req.transaction);
        req.onsuccess  = () => resolve(req.result);
        req.onerror    = () => reject(req.error);
        req.onblocked  = () => reject(new Error(`IDB blocked: ${name}`));
    });
}
function idbReq(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}
function idbTx(db, stores, mode, fn) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
        tx.onabort    = () => reject(new DOMException('AbortError', 'AbortError'));
        fn(tx);
    });
}

// -- AccountStore -------------------------------------------------------------

const DB_VERSION  = 6;
const STORE_NAME  = 'data';
const INDEX_PK    = '_pk';
const INDEX_GROUP = '_groupId';
const INDEX_DATE  = '_createdAt';

class AccountStore {
    constructor(dbName) {
        this._dbName   = 'storage-' + dbName;
        this._db       = null;
        this._fallback = new Map();
        this._degraded = false;
    }
    async init() {
        try {
            this._db = await idbOpen(this._dbName, DB_VERSION, (db, oldVersion, tx) => {
                if (oldVersion < 5) { try { db.deleteObjectStore(STORE_NAME); } catch (_) {} }
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
        } catch (err) {
            console.warn('[ig-scraper] IDB unavailable:', err);
            this._degraded = true;
        }
        return { degraded: this._degraded };
    }
    async count() {
        if (this._db) return idbReq(this._db.transaction(STORE_NAME).objectStore(STORE_NAME).count());
        return this._fallback.size;
    }
    async getByPk(pk) {
        if (this._db) return idbReq(this._db.transaction(STORE_NAME).objectStore(STORE_NAME).index(INDEX_PK).get(pk));
        return this._fallback.get(pk);
    }
    async addBatch(entries, groupId) {
        if (!entries.length) return 0;
        const seen    = new Set();
        const deduped = entries.filter(([pk]) => { if (seen.has(pk)) return false; seen.add(pk); return true; });
        if (this._db) {
            let inserted = 0;
            await idbTx(this._db, STORE_NAME, 'readwrite', (tx) => {
                const store = tx.objectStore(STORE_NAME);
                const pkIdx = store.index(INDEX_PK);
                for (const [pk, data] of deduped) {
                    const getReq = pkIdx.get(pk);
                    getReq.onsuccess = () => {
                        if (getReq.result) return;
                        const putReq = store.put({ _pk: pk, _createdAt: new Date(), _groupId: groupId, ...data });
                        putReq.onsuccess = () => { inserted++; };
                    };
                }
            });
            return inserted;
        }
        let inserted = 0;
        for (const [pk, data] of deduped) {
            if (!this._fallback.has(pk)) { this._fallback.set(pk, data); inserted++; }
        }
        return inserted;
    }
    async deleteGroup(groupId) {
        if (!this._db) return;
        await idbTx(this._db, STORE_NAME, 'readwrite', (tx) => {
            const cursor = tx.objectStore(STORE_NAME).index(INDEX_GROUP).openCursor(IDBKeyRange.only(groupId));
            cursor.onsuccess = function () { const c = cursor.result; if (!c) return; c.delete(); c.continue(); };
        });
    }
    async clear() {
        if (this._db) { await idbTx(this._db, STORE_NAME, 'readwrite', (tx) => { tx.objectStore(STORE_NAME).clear(); }); }
        else { this._fallback.clear(); }
    }
    async getAll() {
        if (this._db) {
            const raw = await idbReq(this._db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll());
            return raw.map(({ _id, _pk, _createdAt, _groupId, ...data }) => data);
        }
        return [...this._fallback.values()];
    }
}

// -- CSV ----------------------------------------------------------------------

const CSV_HEADERS = ['Profile Id', 'Username', 'Link', 'Full Name', 'Is Private', 'Location', 'Picture Url', 'Source'];
function csvCell(v) {
    if (v == null) return '';
    const s = v instanceof Date ? v.toLocaleString() : String(v);
    const e = s.replace(/"/g, '""');
    return /[",\n]/.test(e) ? `"${e}"` : e;
}
function downloadCsv(filename, rows) {
    const csv  = rows.map(r => r.map(csvCell).join(',')).join('\n');
    const url  = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
function accountToRow(acc) {
    return [
        acc.profileId, acc.username, `https://www.instagram.com/${acc.username}`,
        acc.fullName, typeof acc.isPrivate === 'boolean' ? String(acc.isPrivate) : '',
        acc.location || '', acc.pictureUrl || '', acc.source || '',
    ];
}

// -- BoundedCache -------------------------------------------------------------

class BoundedCache {
    constructor(max = 500) { this._max = max; this._map = new Map(); }
    get(k)     { return this._map.get(k); }
    has(k)     { return this._map.has(k); }
    set(k, v)  {
        if (this._map.has(k)) this._map.delete(k);
        else if (this._map.size >= this._max) this._map.delete(this._map.keys().next().value);
        this._map.set(k, v);
    }
}

// -- HistoryLog ---------------------------------------------------------------

const _DEL_SVG = `<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24"
    stroke-linecap="round" stroke-linejoin="round" height="16px" width="16px"
    xmlns="http://www.w3.org/2000/svg">
  <polyline points="3 6 5 6 21 6"/>
  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
</svg>`;

class HistoryLog {
    constructor({ container, maxLogs = 4, onDelete }) {
        this._container = container; this._maxLogs = maxLogs; this._onDelete = onDelete;
        this._panel = null; this._ul = null; this._counter = 0; this._logs = [];
    }
    _ensurePanel() {
        if (this._panel) return;
        this._panel = document.createElement('div');
        this._panel.style.cssText = `text-align:right;background:#f5f5fa;padding:8px;margin-bottom:8px;
            border-radius:8px;font-family:monospace;font-size:14px;color:#2f2f2f;
            box-shadow:rgba(42,35,66,.2) 0 2px 2px,rgba(45,35,66,.2) 0 7px 13px -4px;`;
        this._ul = document.createElement('ul');
        this._ul.style.cssText = 'list-style:none;margin:0;padding:0;';
        this._panel.appendChild(this._ul);
        this._container.appendChild(this._panel);
    }
    add({ label, groupId, count, cancellable }) {
        this._counter++; this._ensurePanel();
        while (this._logs.length >= this._maxLogs) { const o = this._logs.pop(); o.el.remove(); }
        const index = this._counter;
        const li = document.createElement('li');
        li.style.cssText = 'line-height:28px;display:flex;align-items:center;justify-content:flex-end;gap:6px;';
        const lbl = document.createElement('div'); lbl.textContent = `#${index} ${label} (${count})`;
        li.appendChild(lbl);
        if (cancellable) {
            const del = document.createElement('div');
            del.style.cssText = 'display:flex;align-items:center;padding:4px 8px;cursor:pointer;';
            del.innerHTML = _DEL_SVG;
            del.addEventListener('click', async () => {
                del.style.opacity = '0.4'; del.style.pointerEvents = 'none';
                await this._onDelete(groupId);
                li.remove(); this._logs = this._logs.filter(e => e.index !== index);
                if (!this._logs.length) this._clearPanel();
            });
            li.appendChild(del);
        }
        this._ul.prepend(li);
        this._logs.unshift({ index, label, groupId, count, cancellable, el: li });
    }
    clear() { this._logs = []; this._counter = 0; this._clearPanel(); }
    _clearPanel() { if (this._panel) { this._panel.remove(); this._panel = null; this._ul = null; } }
}

// -- Widget -------------------------------------------------------------------

class Widget {
    constructor() { this._root = null; this._counterEl = null; this._histDiv = null; }
    mount({ onDownload, onReset }) {
        const canvas = document.createElement('div');
        canvas.style.cssText = 'position:fixed;top:0;left:0;z-index:10000;width:100%;height:100%;pointer-events:none;';
        const inner = document.createElement('div');
        inner.style.cssText = 'position:absolute;bottom:30px;right:30px;width:auto;pointer-events:auto;';
        this._histDiv = document.createElement('div');
        inner.appendChild(this._histDiv);
        const bar = document.createElement('div');
        bar.style.cssText = `align-items:center;background-color:#EEE;border-radius:4px;
            box-shadow:rgba(45,35,66,.4) 0 2px 4px,rgba(45,35,66,.3) 0 7px 13px -3px,#D6D6E7 0 -3px 0 inset;
            box-sizing:border-box;color:#36395A;display:flex;font-family:monospace;font-size:18px;
            height:38px;overflow:hidden;padding:0 16px;user-select:none;white-space:nowrap;gap:8px;`;
        const dlBtn = document.createElement('div');
        dlBtn.style.cssText = 'cursor:pointer;display:flex;align-items:center;gap:4px;';
        const dlLbl = document.createElement('span'); dlLbl.textContent = 'Download ';
        this._counterEl = document.createElement('strong'); this._counterEl.textContent = '0';
        const dlSfx = document.createElement('span'); dlSfx.textContent = ' users';
        dlBtn.append(dlLbl, this._counterEl, dlSfx);
        dlBtn.addEventListener('click', onDownload);
        const sep = document.createElement('div');
        sep.style.cssText = 'margin:0 4px;border-left:1px solid #2e2e2e;height:20px;';
        const resetBtn = document.createElement('div');
        resetBtn.style.cssText = 'cursor:pointer;'; resetBtn.textContent = 'Reset';
        resetBtn.addEventListener('click', onReset);
        bar.append(dlBtn, sep, resetBtn);
        inner.appendChild(bar); canvas.appendChild(inner); document.body.appendChild(canvas);
        this._root = canvas;
        return { historyContainer: this._histDiv };
    }
    setCount(n) { if (this._counterEl) this._counterEl.textContent = String(n); }
}

// -- Parsers ------------------------------------------------------------------

function parseUsers(json, source) {
    if (!json?.users) return [];
    return json.users.flatMap(u => {
        if (!u) return [];
        const { pk, username, full_name, is_private, profile_pic_url } = u;
        return [{ profileId: pk, username, fullName: full_name, isPrivate: is_private, pictureUrl: profile_pic_url, source }];
    });
}
function parseSections(sections, source) {
    const medias = [];
    for (const s of sections) {
        const lc = s?.layout_content;
        if (lc?.medias?.length)     medias.push(...lc.medias);
        if (lc?.fill_items?.length) medias.push(...lc.fill_items);
        if (s?.node)                medias.push(s.node);
    }
    return medias.flatMap(item => {
        let media = item?.media;
        if (!media && item?.__typename === 'XDTMediaDict') media = item;
        if (!media?.owner) return [];
        const { pk, username, full_name, is_private, profile_pic_url } = media.owner;
        const acc = { profileId: pk, username, fullName: full_name, isPrivate: is_private, pictureUrl: profile_pic_url, source };
        if (media.location?.name) acc.location = media.location.name;
        if (acc.isPrivate == null && media.user?.is_private !== undefined) acc.isPrivate = media.user.is_private;
        return [acc];
    });
}
function parseSectionResponse(json, source, locationCache) {
    let sections = []; let resolvedSource = source;
    if (json?.data) {
        resolvedSource = json.data.name || source;
        if (json.data.recent?.sections)                     sections.push(...json.data.recent.sections);
        if (json.data.top?.sections)                        sections.push(...json.data.top.sections);
        if (json.data.xdt_location_get_web_info_tab?.edges) sections.push(...json.data.xdt_location_get_web_info_tab.edges);
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
function parseExplore(json) {
    return (json?.sectional_items ?? [])
        .flatMap(i => i?.layout_content?.fill_items ?? [])
        .flatMap(item => {
            const media = item?.media;
            if (!media?.owner) return [];
            const { pk, username, full_name, is_private, profile_pic_url } = media.owner;
            return [{ profileId: pk, username, fullName: full_name, isPrivate: is_private, pictureUrl: profile_pic_url, source: 'Explore' }];
        });
}
function buildSource(type, id, locationCache) {
    const dec = t => (typeof t === 'string' && t.startsWith('%23')) ? t.replace('%23', '') : t;
    switch (type) {
        case 'followers': return `followers of ${id}`;
        case 'following': return `following of ${id}`;
        case 'tag':       return id ? `post authors #${dec(id)}` : 'post authors';
        case 'location': {
            if (!id) return 'post authors';
            const name = locationCache?.get(id);
            return name ? `post authors (loc: ${name})` : `post authors (loc: ${dec(id)})`;
        }
        default: return 'post authors';
    }
}

// -- App ----------------------------------------------------------------------

class App {
    constructor() {
        this._store         = new AccountStore('insta-scrape');
        this._widget        = new Widget();
        this._history       = null;
        this._locationCache = new BoundedCache(200);
        this._profileCache  = new BoundedCache(1000);
        this._origXhrSend   = null;
        this._origFetch     = null;
        this._patchActive   = false;
    }
    async init() {
        const { degraded } = await this._store.init();
        const { historyContainer } = this._widget.mount({
            onDownload: () => this._onDownload(),
            onReset:    () => this._onReset(),
        });
        this._history = new HistoryLog({
            container: historyContainer, maxLogs: 4,
            onDelete: async (g) => { await this._store.deleteGroup(g); await this._refreshCount(); },
        });
        if (degraded) {
            console.warn('[ig-scraper] IndexedDB unavailable — data in memory only');
            const warn = Object.assign(document.createElement('div'), {
                textContent: 'ig-scraper: IndexedDB unavailable — data in memory only',
            });
            warn.style.cssText = `position:fixed;top:12px;left:50%;transform:translateX(-50%);
                background:#b45309;color:#fff;padding:6px 14px;border-radius:6px;
                font-family:monospace;font-size:13px;z-index:99999;pointer-events:none;`;
            document.body.appendChild(warn);
            setTimeout(() => warn.remove(), 6000);
        }
        await this._refreshCount();
        this._installPatches();
    }
    async _onDownload() {
        const records = await this._store.getAll();
        downloadCsv(`instaExport-${new Date().toISOString()}.csv`, [CSV_HEADERS, ...records.map(accountToRow)]);
    }
    async _onReset() { await this._store.clear(); this._history.clear(); await this._refreshCount(); }
    async _refreshCount() { this._widget.setCount(await this._store.count()); }
    async _persist(accounts, source) {
        if (!accounts.length) return;
        const groupId  = crypto.randomUUID();
        const inserted = await this._store.addBatch(accounts.filter(Boolean).map(a => [a.profileId, a]), groupId);
        await this._refreshCount();
        this._history.add({ label: source ? `Added ${source}` : 'Added items', groupId, count: inserted, cancellable: false });
    }
    async _resolveUsername(profileId) {
        const pid = String(profileId);
        if (this._profileCache.has(pid)) return this._profileCache.get(pid);
        const r = await this._store.getByPk(profileId);
        if (r?.username) { this._profileCache.set(pid, r.username); return r.username; }
        return null;
    }
    async _routeResponse(text, url) {
        let payloads = [];
        try { payloads = [JSON.parse(text)]; }
        catch (_) { payloads = text.split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch (_) { return []; } }); }
        for (const json of payloads) await this._dispatchPayload(json, url);
    }
    async _dispatchPayload(json, url) {
        const fwM = /\/api\/v1\/friendships\/(?<id>\d+)\/followers\//.exec(url);
        if (fwM) {
            const un = await this._resolveUsername(fwM.groups.id);
            const lbl = un ? `${fwM.groups.id} (${un})` : fwM.groups.id;
            await this._persist(parseUsers(json, buildSource('followers', lbl)), buildSource('followers', lbl)); return;
        }
        const foM = /\/api\/v1\/friendships\/(?<id>\d+)\/following\//.exec(url);
        if (foM) {
            const un = await this._resolveUsername(foM.groups.id);
            const lbl = un ? `${foM.groups.id} (${un})` : foM.groups.id;
            await this._persist(parseUsers(json, buildSource('following', lbl)), buildSource('following', lbl)); return;
        }
        if (url.includes('/api/v1/discover/web/explore_grid')) { await this._persist(parseExplore(json), 'Explore'); return; }
        const routes = [
            ['/api/v1/tags/web_info',         () => { const m = /tag_name=(?<t>[\w_-]+)/i.exec(url);    return buildSource('tag',      m?.groups?.t,  this._locationCache); }],
            ['/api/v1/locations/web_info',     () => { const m = /location_id=(?<id>[\w_-]+)/i.exec(url); return buildSource('location', m?.groups?.id, this._locationCache); }],
            ['/api/v1/fbsearch/web/top_serp',  () => { const m = /query=(?<t>[\w_%-]+)/i.exec(url);      return buildSource('tag',      m?.groups?.t,  this._locationCache); }],
        ];
        for (const [pattern, srcFn] of routes) {
            if (url.includes(pattern)) {
                const src = srcFn();
                const { accounts } = parseSectionResponse(json, src, this._locationCache);
                await this._persist(accounts, src); return;
            }
        }
        if (/\/api\/v1\/locations\/[\w\d]+\/sections\//.test(url)) {
            const m = /\/locations\/(?<id>[\w\d]+)\/sections\//.exec(url);
            const src = buildSource('location', m?.groups?.id, this._locationCache);
            const { accounts } = parseSectionResponse(json, src, this._locationCache);
            await this._persist(accounts, src); return;
        }
        if (url.includes('/graphql/query')) {
            const m = /explore\/locations\/\d+\/(?<slug>[\w-]+)\/?/.exec(window.location.href);
            const src = buildSource('tag', m?.groups?.slug);
            const { accounts } = parseSectionResponse(json, src, this._locationCache);
            await this._persist(accounts, src); return;
        }
        if (/\/api\/v1\/[\w\d/]+\/sections\//.test(url)) {
            const { accounts } = parseSectionResponse(json, 'post authors', this._locationCache);
            await this._persist(accounts, 'post authors');
        }
    }
    _installPatches() {
        if (this._patchActive) return;
        this._patchActive = true;
        this._origXhrSend = XMLHttpRequest.prototype.send;
        const app = this;
        XMLHttpRequest.prototype.send = function (...args) {
            const xhr = this;
            function onStateChange() {
                if (xhr.readyState !== 4) return;
                xhr.removeEventListener('readystatechange', onStateChange);
                const url = xhr.responseURL || '';
                if (url) app._routeResponse(xhr.responseText, url).catch(console.error);
            }
            xhr.addEventListener('readystatechange', onStateChange);
            app._origXhrSend.apply(xhr, args);
        };
        this._origFetch = window.fetch;
        const origFetch = this._origFetch;
        window.fetch = async function (...args) {
            const response = await origFetch.apply(window, args);
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
            response.clone().text().then(t => app._routeResponse(t, url)).catch(console.error);
            return response;
        };
    }
    removePatches() {
        if (!this._patchActive) return;
        if (this._origXhrSend) XMLHttpRequest.prototype.send = this._origXhrSend;
        if (this._origFetch)   window.fetch                  = this._origFetch;
        this._origXhrSend = null; this._origFetch = null; this._patchActive = false;
    }
}

// Boot guard
const _BOOT_FLAG = '__igScraperLoaded';
if (!window[_BOOT_FLAG]) {
    window[_BOOT_FLAG] = true;
    new App().init().catch(err => { console.error('[ig-scraper] Init failed:', err); delete window[_BOOT_FLAG]; });
}

// =============================================================================
// ENGINE END
// =============================================================================


// =============================================================================
// SCROLL PANEL START — Auto-scroll controller (top-right panel)
// This section is the only part needed when using @require for main.js.
// =============================================================================

(function () {
    'use strict';

    const PANEL_ID         = 'ig-scraper-scroll-panel';
    // Matches profile root AND /followers/ /following/ modal URLs
    // so the panel stays alive when Instagram routes to /username/followers/ on click.
    const PROFILE_REGEX = /^https:\/\/www\.instagram\.com\/([a-zA-Z0-9_.]+)(?:\/(followers|following)\/?)?$/;
    const NAV_DEBOUNCE_MS  = 800;
    const SCROLL_STEP_PX   = 900;
    const SCROLL_PAUSE_MS  = 600;
    const STABLE_THRESHOLD = 3;
    // Scroll target is found at runtime via probe — no hardcoded class names.
    // Instagram rotates obfuscated atomic CSS on every deploy so static selectors break.
    const C = Object.freeze({ green: '#16A34A', orange: '#EA580C', ok: '#86EFAC', warn: '#FCD34D', info: '#93C5FD' });

    // Registry
    function createRegistry() {
        const fns = [];
        return {
            add(fn) { fns.push(fn); },
            flush() { for (let i = fns.length - 1; i >= 0; i--) { try { fns[i](); } catch (_) {} } fns.length = 0; },
        };
    }
    function onEvent(reg, target, type, handler, opts) {
        target.addEventListener(type, handler, opts);
        reg.add(() => target.removeEventListener(type, handler, opts));
    }
    function trackedTimeout(reg, fn, delay) {
        const id = setTimeout(fn, delay);
        const cancel = () => clearTimeout(id);
        reg.add(cancel);
        return cancel;
    }

    // Scroller — rAF driven, zero ghost callbacks
    function createScroller(target, { onProgress, onComplete }) {
        let cancelled = false, rafId = null, timerId = null, stableCount = 0, lastHeight = target.scrollHeight;
        const countItems = () => target.querySelectorAll('li, [role="listitem"]').length;
        function step() {
            if (cancelled) return;
            target.scrollBy(0, SCROLL_STEP_PX);
            timerId = setTimeout(() => {
                timerId = null;
                if (cancelled) return;
                const h = target.scrollHeight;
                if (h === lastHeight) {
                    stableCount++;
                    onProgress({ count: countItems(), stable: stableCount });
                    if (stableCount >= STABLE_THRESHOLD) { cancel(); onComplete({ count: countItems() }); return; }
                } else { stableCount = 0; lastHeight = h; onProgress({ count: countItems(), stable: 0 }); }
                rafId = requestAnimationFrame(step);
            }, SCROLL_PAUSE_MS);
        }
        function start()  { if (!cancelled) rafId = requestAnimationFrame(step); }
        function cancel() {
            cancelled = true;
            if (rafId   !== null) { cancelAnimationFrame(rafId); rafId   = null; }
            if (timerId !== null) { clearTimeout(timerId);        timerId = null; }
        }
        return { start, cancel };
    }

    // Panel — top-right, scroll button + status only
    function buildPanel(reg, { onScrollToggle }) {
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.cssText = `
            position:fixed;top:12px;right:14px;z-index:99999;
            display:flex;align-items:center;gap:7px;
            background:rgba(18,18,18,0.9);border:1px solid rgba(255,255,255,0.1);
            border-radius:8px;padding:7px 10px;box-shadow:0 4px 16px rgba(0,0,0,0.5);
            backdrop-filter:blur(8px);
            font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        `;
        function makeBtn(label, bg) {
            const btn = document.createElement('button');
            btn.textContent   = label;
            btn.style.cssText = `background:${bg};border:1px solid rgba(255,255,255,0.14);
                border-radius:6px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;
                padding:5px 11px;transition:opacity 0.15s;user-select:none;`;
            onEvent(reg, btn, 'mouseenter', () => { btn.style.opacity = '0.78'; });
            onEvent(reg, btn, 'mouseleave', () => { btn.style.opacity = '1'; });
            return btn;
        }
        const scrollBtn = makeBtn('Auto-Scroll', C.green);
        const statusEl  = document.createElement('span');
        statusEl.style.cssText = `color:#fff;font-size:11px;font-weight:500;padding:4px 7px;
            background:rgba(0,0,0,0.38);border-radius:5px;white-space:nowrap;min-width:96px;text-align:center;`;
        statusEl.textContent = 'Ready';
        onEvent(reg, scrollBtn, 'click', onScrollToggle);
        panel.append(scrollBtn, statusEl);
        document.body.appendChild(panel);
        reg.add(() => panel.remove());
        return {
            setStatus(t, c = '#fff') { statusEl.textContent = t; statusEl.style.color = c; },
            setScrollBtn(t, bg)      { scrollBtn.textContent = t; scrollBtn.style.background = bg; },
        };
    }

    // Session
    function findScrollTarget() {
        const dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) return null;

        // Walk every div inside the dialog — find the one that is actually scrollable.
        // "Scrollable" = computed overflowY is scroll/auto AND has hidden overflow content.
        // This survives Instagram's obfuscated atomic CSS class rotations on deploy.
        const candidates = dialog.querySelectorAll('div');
        let best = null;
        let bestHidden = 0;

        for (const el of candidates) {
            const oy = window.getComputedStyle(el).overflowY;
            if (oy !== 'scroll' && oy !== 'auto') continue;
            const hidden = el.scrollHeight - el.clientHeight;
            if (hidden > bestHidden) { bestHidden = hidden; best = el; }
        }

        // Fallback: list not rendered yet — return dialog so scrollBy still fires
        // API requests that load the first batch.
        return best || dialog;
    }
    function isProfilePage() { return PROFILE_REGEX.test(window.location.href); }

    function createSession() {
        const reg = createRegistry();
        let scroller = null, ui = null;

        function handleScrollToggle() {
            if (scroller) {
                scroller.cancel(); scroller = null;
                if (ui) { ui.setScrollBtn('Auto-Scroll', C.green); ui.setStatus('Stopped', '#D1D5DB'); }
                return;
            }
            const target = findScrollTarget();
            if (!target) { if (ui) ui.setStatus('Open followers list first', C.warn); return; }
            if (ui) { ui.setScrollBtn('Stop', C.orange); ui.setStatus('Scrolling...', C.info); }
            scroller = createScroller(target, {
                onProgress({ count, stable }) {
                    if (!ui) return;
                    ui.setStatus(stable > 0 ? `End check ${stable}/${STABLE_THRESHOLD}` : `Loaded: ${count}`, stable > 0 ? C.warn : C.info);
                },
                onComplete({ count }) {
                    scroller = null;
                    if (ui) { ui.setScrollBtn('Auto-Scroll', C.green); ui.setStatus(`Done: ${count} accounts`, C.ok); }
                    GM_notification({ title: 'Instagram Scraper', text: `Complete. ${count} accounts loaded.`, timeout: 4000 });
                },
            });
            scroller.start();
        }

        ui = buildPanel(reg, { onScrollToggle: handleScrollToggle });
        return {
            teardown() { if (scroller) { scroller.cancel(); scroller = null; } reg.flush(); ui = null; },
        };
    }

    // Navigation controller
    const topReg = createRegistry();
    let currentSession = null, navDebounceTimer = null;

    function handleNavigation() {
        if (navDebounceTimer !== null) { clearTimeout(navDebounceTimer); navDebounceTimer = null; }
        if (currentSession) { currentSession.teardown(); currentSession = null; }
        if (!isProfilePage()) return;
        navDebounceTimer = setTimeout(() => {
            navDebounceTimer = null;
            if (isProfilePage() && !document.getElementById(PANEL_ID)) currentSession = createSession();
        }, NAV_DEBOUNCE_MS);
    }

    function patchScrollHistory(reg, onNavigate) {
        const oP = history.pushState.bind(history), oR = history.replaceState.bind(history);
        history.pushState    = (...a) => { oP(...a); onNavigate(); };
        history.replaceState = (...a) => { oR(...a); onNavigate(); };
        reg.add(() => { history.pushState = oP; history.replaceState = oR; });
    }

    patchScrollHistory(topReg, handleNavigation);
    onEvent(topReg, window, 'popstate', handleNavigation);
    onEvent(topReg, window, 'pagehide', () => {
        if (navDebounceTimer !== null) { clearTimeout(navDebounceTimer); navDebounceTimer = null; }
        if (currentSession)  { currentSession.teardown(); currentSession = null; }
        topReg.flush();
    });

    // Boot 100ms after engine (engine boots at 1000ms)
    trackedTimeout(topReg, () => {
        if (isProfilePage() && !document.getElementById(PANEL_ID)) currentSession = createSession();
    }, 1100);

})();

// =============================================================================
// SCROLL PANEL END
// =============================================================================
