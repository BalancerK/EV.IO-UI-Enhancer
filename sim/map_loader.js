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

function listMaps() {
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

/** Which maps are already cached (so the dashboard can show what is instant). */
async function cachedMaps() {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const cachedUrls = new Set(keys.map((req) => req.url));
  return listMaps().filter((m) => cachedUrls.has(m.evmapUrl));
}

export { listMaps, findMap, loadMap, fetchEvmap, cachedMaps };
