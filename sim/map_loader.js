/**
 * map_loader.js — ported for the extension host (see sim/README.md).
 *
 * Same job as the Node server's own map_loader.js: resolve the catalogue, download+parse a map
 * on first use, cache it, and build its collision world via physics_world.js's (already shared,
 * unchanged) buildWorldFromEvmapBuffer/resolveSpawnsToFloor. Three real differences from the
 * Node version, all forced by having no filesystem in a browser extension:
 *   - The catalogue (maps.json) is bundled directly (esbuild's JSON loader) instead of read from
 *     disk at runtime — same trick already used for weapons.json in game_server.js.
 *   - Downloads go through fetch()+arrayBuffer(), not Node's https module.
 *   - The on-disk map_cache/ directory becomes the Cache Storage API (`caches`) — available in a
 *     service worker, persists across restarts the same way a file on disk would, and needs no
 *     manual eviction policy of its own (Chrome manages total cache storage quota).
 */
'use strict';

import bpw from './physics_world.js';
import mapsJsonData from './maps.json';

const CMS_BASE = 'https://ev.io';
const CACHE_NAME = 'evio-ext-map-cache-v1';

// Built worlds, keyed by evmap URL — same bounded in-memory cache as the Node version (worlds
// are multi-MB typed arrays; keeping every map ever loaded would be a real memory leak over a
// long-running session).
const _worldCache = new Map();
const WORLD_CACHE_MAX = 3;

let _catalogue = null;

// ── Hosted extra-maps list ─────────────────────────────────────────────────────────────────────
// Same list, same rules as the Node server's extra_maps.js: community maps uploaded to ev.io after
// the maps.json snapshot are listed in one hosted file (maintained in the EV.IO-MAP-EDITOR repo),
// fetched when the game server boots and merged into the catalogue — so a new map needs no bundle
// rebuild and no Web Store release. The last good copy is kept in Cache Storage so it still works
// offline. Only .evmap files on ev.io's own file store are accepted, because the list decides what
// players' browsers download.
const EXTRA_MAPS_URL = 'https://balancerk.github.io/EV.IO-MAP-EDITOR/maps/extra-maps.json';
const EXTRA_CACHE_KEY = 'https://evio-ext.invalid/extra-maps.json';
const EVMAP_URL_RE = /^https:\/\/ev\.io\/sites\/default\/files\/maps\/[A-Za-z0-9._%-]+\.evmap$/;
const IMAGE_URL_RE = /^https:\/\/ev\.io\/sites\/default\/files\/[A-Za-z0-9._%\/-]+\.(png|jpe?g)$/i;
let _extra = [];
let _merged = null;

function parseExtraList(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.maps)) throw new Error('not an extra-maps list');
  const out = [];
  const seen = new Set();
  for (const m of raw.maps.slice(0, 500)) {
    if (!m || typeof m !== 'object') continue;
    const nid = Number(m.nid);
    if (!Number.isInteger(nid) || nid <= 0 || seen.has(nid)) continue;
    if (typeof m.evmapUrl !== 'string' || !EVMAP_URL_RE.test(m.evmapUrl)) continue;
    const img = (u) => (typeof u === 'string' && IMAGE_URL_RE.test(u) ? u : null);
    seen.add(nid);
    out.push({
      nid,
      title: (typeof m.title === 'string' && m.title.trim() ? m.title.trim() : `Map ${nid}`).slice(0, 80),
      evmapUrl: m.evmapUrl,
      thumbUrl: img(m.thumbUrl),
      largeImageUrl: img(m.largeImageUrl),
      inRotation: false,
      extra: true,
    });
  }
  return out;
}

/**
 * Load the extra-maps list: the cached copy first (instant, offline-safe), then the hosted file.
 * Never rejects; resolves to the number of extra maps known afterwards.
 */
async function refreshExtraMaps() {
  let cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch { /* no Cache Storage: fetch only */ }
  if (cache && !_extra.length) {
    try {
      const hit = await cache.match(EXTRA_CACHE_KEY);
      if (hit) { _extra = parseExtraList(await hit.json()); _merged = null; }
    } catch { /* bad cached copy: ignore */ }
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(EXTRA_MAPS_URL, { cache: 'no-cache', signal: ctrl.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    _extra = parseExtraList(raw);
    _merged = null;
    if (cache) {
      await cache.put(EXTRA_CACHE_KEY, new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } }));
    }
    console.log(`[evio-ext] map-loader: ${_extra.length} extra map(s) from the hosted list`);
  } catch (err) {
    console.warn(`[evio-ext] map-loader: extra-maps list unavailable (${err && err.message}); using ${_extra.length} cached`);
  }
  return _extra.length;
}

// Load the list at most once per worker lifetime, and start that as soon as this module loads:
// the MV3 service worker is stopped when idle and restarted on demand, and a restarted worker must
// know the extra maps before anything lists or loads maps — not only after a hosted game boots.
let _extraPromise = null;
function ensureExtraMaps() {
  if (!_extraPromise) _extraPromise = refreshExtraMaps();
  return _extraPromise;
}
if (typeof caches !== 'undefined' && typeof fetch === 'function') ensureExtraMaps();

// The official snapshot plus the extra list; an extra entry replaces a snapshot one with the same nid.
function listMaps() {
  if (_merged) return _merged;
  const extraIds = new Set(_extra.map((m) => String(m.nid)));
  _merged = baseCatalogue().filter((m) => !extraIds.has(String(m.nid))).concat(_extra)
    .sort((x, y) => String(x.title).localeCompare(String(y.title)));
  return _merged;
}

function baseCatalogue() {
  if (_catalogue) return _catalogue;
  const raw = mapsJsonData;
  const byId = new Map();
  for (const inc of raw.included || []) byId.set(inc.id, inc);
  const fileUrl = (rel) => {
    const id = rel && rel.data && rel.data.id;
    const ent = id && byId.get(id);
    const url = ent && ent.attributes && ent.attributes.uri && ent.attributes.uri.url;
    return url ? CMS_BASE + url : null;
  };

  const out = [];
  for (const node of raw.data || []) {
    const a = node.attributes || {};
    const r = node.relationships || {};
    const evmapUrl = fileUrl(r.field_map);
    if (!evmapUrl || !/\.evmap$/i.test(evmapUrl)) continue;
    out.push({
      nid: a.drupal_internal__nid,
      title: a.title || 'Untitled',
      evmapUrl,
      thumbUrl: fileUrl(r.field_map_thumbnail),
      largeImageUrl: fileUrl(r.field_large_image),
      inRotation: a.field_in_public_rotation !== false,
    });
  }
  out.sort((x, y) => String(x.title).localeCompare(String(y.title)));
  _catalogue = out;
  return out;
}

function findMap(idOrTitleOrUrl) {
  const maps = listMaps();
  const key = String(idOrTitleOrUrl);
  return maps.find((m) => String(m.nid) === key)
      || maps.find((m) => m.title.toLowerCase() === key.toLowerCase())
      || maps.find((m) => m.evmapUrl === key)
      || null;
}

/** Fetch the .evmap bytes, using the Cache Storage entry when present. */
async function fetchEvmap(url) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);
  if (cached) {
    const buf = new Uint8Array(await cached.arrayBuffer());
    if (buf.length > 0) return { buf, fromCache: true };
  }
  const t0 = Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  // Cache the raw Response (not just the bytes) — cache.put() wants one, and it conveniently
  // means a later cache.match() gives back a fresh, independently-readable body.
  await cache.put(url, res.clone());
  const buf = new Uint8Array(await res.arrayBuffer());
  console.log(`[evio-ext] map-loader: downloaded ${url.split('/').pop()} `
    + `(${(buf.length / 1048576).toFixed(1)} MB in ${Date.now() - t0} ms)`);
  return { buf, fromCache: false };
}

/**
 * Load a map and build its collision world. Resolves to
 * { map, world, spawns, teleporters, navmesh, pickupPoints, vertices, indices, groupIds, tris, fromCache, buildMs }.
 */
async function loadMap(idOrTitleOrUrl) {
  await ensureExtraMaps();
  const map = findMap(idOrTitleOrUrl);
  if (!map) throw new Error(`unknown map: ${idOrTitleOrUrl}`);

  const hit = _worldCache.get(map.evmapUrl);
  if (hit) return { ...hit, fromCache: true, buildMs: 0 };

  const { buf, fromCache } = await fetchEvmap(map.evmapUrl);
  const t0 = Date.now();
  const built = bpw.buildWorldFromEvmapBuffer(buf, map.title);
  const buildMs = Date.now() - t0;
  if (!built.spawns || !built.spawns.length) {
    throw new Error(`${map.title} has no spawn points — cannot host it`);
  }

  const spawns = bpw.resolveSpawnsToFloor(built.world, built.spawns, map.title);
  const entry = {
    map, world: built.world, spawns, teleporters: built.teleporters || [],
    navmesh: built.navmesh || [], pickupPoints: built.pickupPoints || [],
    vertices: built.vertices, indices: built.indices, groupIds: built.groupIds,
    tris: built.indices.length / 3,
  };
  _worldCache.set(map.evmapUrl, entry);
  while (_worldCache.size > WORLD_CACHE_MAX) {
    _worldCache.delete(_worldCache.keys().next().value);
  }
  return { ...entry, fromCache, buildMs };
}

// ── Test maps ────────────────────────────────────────────────────────────────────────────────
// Same rules as the Node server's map_loader.js: an uploaded .evmap lives ONLY in memory — never in
// Cache Storage, never in the world cache, never in listMaps()/findMap() — and is dropped as soon as
// another map is loaded. Its URL is a placeholder no browser can fetch on its own: the extension's
// page hook (page-socket-hook.js) recognises /maps/test/<key>.evmap and gets the bytes from this
// host — directly for the host's own tab, over the lobby's reliable WebRTC channel for everyone
// else (background.js) — so nothing is ever uploaded anywhere.
const TEST_MAP_MAX_BYTES = 32 * 1024 * 1024;
const TEST_MAP_ORIGIN = 'https://evio-test-map.invalid';
const TEST_KEY_RE = /^[0-9a-f]{32}$/;
let _testMap = null;   // { key, name, buf, size } while a test map is the active map

function testMapUrl(key) { return `${TEST_MAP_ORIGIN}/maps/test/${key}.evmap`; }

function testMapName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/\.evmap$/i, '')
    .replace(/[^\p{L}\p{N} ._'()-]+/gu, ' ').replace(/[\s_]+/g, ' ').trim().slice(0, 48);
  return base || 'Test map';
}

async function testMapKey(buf) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Build a test map from uploaded bytes WITHOUT making it active (see setTestMap). */
async function buildTestMap(bytes, name) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!buf.length) throw new Error('the file is empty');
  if (buf.length > TEST_MAP_MAX_BYTES) {
    throw new Error(`the file is ${(buf.length / 1048576).toFixed(1)} MB; test maps can be at most ${TEST_MAP_MAX_BYTES / 1048576} MB`);
  }
  const key = await testMapKey(buf);
  const title = testMapName(name);
  let built;
  try { built = bpw.buildWorldFromEvmapBuffer(buf, title); } catch (err) {
    throw new Error(`not a readable .evmap file (${(err && err.message) || err})`);
  }
  if (!built || !built.world) throw new Error('not a readable .evmap file');
  if (!built.spawns || !built.spawns.length) throw new Error(`${title} has no spawn points — add at least one player spawn`);
  const spawns = bpw.resolveSpawnsToFloor(built.world, built.spawns, title);
  const map = { nid: `test:${key}`, title, evmapUrl: testMapUrl(key), thumbUrl: null, largeImageUrl: null,
                inRotation: false, test: true, key };
  return { map, world: built.world, spawns, teleporters: built.teleporters || [],
           navmesh: built.navmesh || [], pickupPoints: built.pickupPoints || [],
           vertices: built.vertices, indices: built.indices, groupIds: built.groupIds,
           tris: built.indices.length / 3, fromCache: false, buf };
}
function setTestMap(loaded) {
  _testMap = { key: loaded.map.key, name: loaded.map.title, buf: loaded.buf, size: loaded.buf.length };
}
function clearTestMap() { _testMap = null; }
function testMapBytes(key) {
  return (_testMap && typeof key === 'string' && TEST_KEY_RE.test(key) && key === _testMap.key) ? _testMap.buf : null;
}
function activeTestMap() {
  return _testMap ? { key: _testMap.key, name: _testMap.name, size: _testMap.size, url: testMapUrl(_testMap.key) } : null;
}

/** Which maps are already cached (so the dashboard can show what is instant). */
async function cachedMaps() {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const cachedUrls = new Set(keys.map((req) => req.url));
  return listMaps().filter((m) => cachedUrls.has(m.evmapUrl));
}

export { listMaps, findMap, loadMap, fetchEvmap, cachedMaps, refreshExtraMaps, ensureExtraMaps, parseExtraList,
  buildTestMap, setTestMap, clearTestMap, testMapBytes, activeTestMap, testMapUrl, TEST_MAP_MAX_BYTES };
