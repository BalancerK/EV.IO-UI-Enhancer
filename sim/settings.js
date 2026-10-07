/**
 * settings.js — live-tunable server settings registry.
 *
 * Every knob that used to be a `const X = Number(process.env.EVIO_… )` in local_ws_server.js is
 * declared here instead, so it can be read, validated, and CHANGED AT RUNTIME from the admin UI
 * (admin_server.js) without restarting the game server and losing connected players.
 *
 * HOW IT'S USED
 * ─────────────
 * The call sites keep their plain identifiers — the module-level binding just becomes `let` and a
 * change callback re-assigns it, so the hundreds of existing usages need no edits:
 *
 *     let WALK_SPEED = S.define({ key: 'walkSpeed', … }, (v) => { WALK_SPEED = v; });
 *
 * ENV STILL WINS AT STARTUP. `define()` reads the declared env var first, so every documented
 * `EVIO_*` variable behaves exactly as before; the registry only adds a second way to set it.
 *
 * DERIVED SETTINGS. A few knobs default to a formula over others (crouch speed = walk × 0.5).
 * Those declare `derive`. A derived setting recomputes whenever its inputs change — until someone
 * sets it explicitly (via env or the UI), after which the explicit value sticks. `reset()` returns
 * it to derived.
 *
 * PERSISTENCE. Anything changed through the dashboard is written to settings.local.json and read
 * back at the next start, so tuning a live server is not undone by a restart (and `deploy/sync.sh`
 * restarts on every deploy). Precedence at startup is:
 *
 *     env var  >  settings.local.json  >  derive()/def
 *
 * env stays on top so a documented EVIO_* variable always means what it says, and so a bad saved
 * value can be overridden without editing the file.
 *
 * Only keys someone set explicitly are saved — defaults are not frozen into the file, so improving
 * a default still reaches an existing deployment. `reset()` drops the key from the file.
 *
 * WRITING IS OFF UNLESS THE SERVER IS THE ENTRY POINT. The 40-odd test scripts call set() freely;
 * if that wrote to disk they would rewrite the operator's live configuration as a side effect, and
 * reading it back would make them depend on whatever the operator last tuned. So the store is only
 * loaded and written when local_ws_server.js is the main module — tests, one-off scripts and
 * diagnostics stay hermetic with no per-file opt-out to remember.
 */
'use strict';

// Ported for the browser-extension host (see sim/README.md). No filesystem exists in a service
// worker, so persistence is simply off — persistenceWanted() below is hardcoded rather than the
// Node version's env/require.main sniffing, and every fs.* call below it is already unreachable
// dead code (each one is already gated behind `if (!PERSIST) return;`, same as upstream).

const specs = new Map();    // key -> spec
const values = new Map();   // key -> current value
const explicit = new Set(); // keys whose value was set explicitly (env or user), not derived
const listeners = new Map();// key -> [callback]
const log = [];             // recent changes, newest last (capped)
const LOG_MAX = 200;

// ── Persistent store ────────────────────────────────────────────────────────────────────────
const STORE_PATH = 'settings.local.json'; // never actually opened — see persistenceWanted() above

function persistenceWanted() {
  return false;
}

const PERSIST = persistenceWanted();
const stored = new Map();   // key -> raw value read from disk (still uncoerced)
const userSet = new Set(); // keys a human set (dashboard/API or restored from the file) — what we save
let storeLoadError = null;

if (PERSIST) {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && obj.settings && typeof obj.settings === 'object') {
      for (const [k, v] of Object.entries(obj.settings)) stored.set(k, v);
    }
    console.log(`[settings] loaded ${stored.size} saved setting(s) from ${STORE_PATH}`);
  } catch (err) {
    // A missing file is the normal first run. Anything else (corrupt JSON, bad permissions) must be
    // loud but must NOT stop the server booting on defaults.
    if (err.code !== 'ENOENT') {
      storeLoadError = err.message;
      console.error(`[settings] could not read ${STORE_PATH}: ${err.message}`);
      console.error('[settings] continuing with env/defaults; the file will be rewritten on the '
        + 'next change');
    }
  }
}

let saveTimer = null;
let lastSaveError = null;

function saveNow() {
  if (!PERSIST) return;
  saveTimer = null;
  const settings = {};
  // `userSet`, not `explicit`: `explicit` also holds keys that came from an env var, and copying
  // those into the file would silently freeze a deployment-time override into permanent state.
  // Only keys still in the registry are written — a stale key from an older build would otherwise
  // live in the file for ever.
  for (const key of userSet) {
    if (specs.has(key)) settings[key] = values.get(key);
  }
  const body = JSON.stringify({
    _comment: 'Written by the ev.io custom server. Env vars override anything here.',
    savedAt: new Date().toISOString(),
    settings,
  }, null, 2) + '\n';
  const tmp = `${STORE_PATH}.tmp`;
  try {
    // Write-then-rename: a crash mid-write leaves the previous file intact rather than a truncated
    // one that fails to parse on the next boot.
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, STORE_PATH);
    lastSaveError = null;
  } catch (err) {
    lastSaveError = err.message;
    console.error(`[settings] could not write ${STORE_PATH}: ${err.message}`);
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// Dragging a dashboard slider fires a change per pixel; coalesce them into one write.
function scheduleSave() {
  if (!PERSIST || saveTimer) return;
  saveTimer = setTimeout(saveNow, 400);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

/** Flush any pending write immediately (used on shutdown). */
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveNow(); }
}

function persistenceStatus() {
  return {
    enabled: PERSIST,
    path: PERSIST ? STORE_PATH : null,
    loaded: stored.size,
    loadError: storeLoadError,
    saveError: lastSaveError,
    pending: !!saveTimer,
  };
}

function coerce(spec, raw) {
  if (raw === null || raw === undefined) return { ok: false, err: 'value is required' };
  switch (spec.type) {
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const s = String(raw).trim().toLowerCase();
      if (['1', 'true', 'on', 'yes'].includes(s)) return { ok: true, value: true };
      if (['0', 'false', 'off', 'no'].includes(s)) return { ok: true, value: false };
      return { ok: false, err: `not a boolean: ${raw}` };
    }
    case 'int':
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, err: `not a number: ${raw}` };
      const v = spec.type === 'int' ? Math.round(n) : n;
      if (Number.isFinite(spec.min) && v < spec.min) return { ok: false, err: `below min ${spec.min}` };
      if (Number.isFinite(spec.max) && v > spec.max) return { ok: false, err: `above max ${spec.max}` };
      return { ok: true, value: v };
    }
    case 'enum': {
      // Case-insensitive, so an env var written EVIO_TICK_MODEL=Buffer still resolves (the
      // pre-registry code lower-cased these).
      const s = String(raw).trim().toLowerCase();
      const hit = spec.choices.find((c) => c.toLowerCase() === s);
      if (!hit) return { ok: false, err: `must be one of ${spec.choices.join(', ')}` };
      return { ok: true, value: hit };
    }
    case 'string':
      return { ok: true, value: String(raw) };
    default:
      return { ok: false, err: `unknown type ${spec.type}` };
  }
}

/**
 * Declare a setting and return its startup value.
 *   spec.key      camelCase id used by the API/UI
 *   spec.env      environment variable consulted at startup (optional)
 *   spec.type     'number' | 'int' | 'bool' | 'enum' | 'string'
 *   spec.def      default when neither env nor derive supplies one
 *   spec.derive   () => value — recomputed while the setting is not explicitly set
 *   spec.live     false = takes effect only on restart (UI marks it)
 *   spec.category grouping in the UI
 *   spec.desc     one-line explanation shown in the UI
 * onChange is invoked on every subsequent change (not at startup).
 */
function define(spec, onChange) {
  if (specs.has(spec.key)) throw new Error(`duplicate setting key: ${spec.key}`);
  const full = { live: true, category: 'Other', ...spec };
  specs.set(spec.key, full);
  if (typeof onChange === 'function') listeners.set(spec.key, [onChange]);

  let value;
  const envRaw = full.env ? process.env[full.env] : undefined;
  if (envRaw !== undefined && envRaw !== '') {
    const c = coerce(full, envRaw);
    if (c.ok) { value = c.value; explicit.add(full.key); }
    else console.warn(`[settings] ignoring ${full.env}=${envRaw}: ${c.err}`);
  }
  // Saved value, one rung below env. Coerced through the same validator as any other input: the
  // file is editable by hand and the registry's bounds may have tightened since it was written.
  if (value === undefined && stored.has(full.key)) {
    const c = coerce(full, stored.get(full.key));
    if (c.ok) { value = c.value; explicit.add(full.key); userSet.add(full.key); }
    else {
      console.warn(`[settings] ignoring saved ${full.key}=`
        + `${JSON.stringify(stored.get(full.key))}: ${c.err}`);
      stored.delete(full.key);
    }
  } else if (value !== undefined && stored.has(full.key) && stored.get(full.key) !== value) {
    console.warn(`[settings] ${full.env}=${envRaw} overrides saved ${full.key}=`
      + `${JSON.stringify(stored.get(full.key))} — unset the env var to use the saved value`);
  }
  if (value === undefined) {
    value = typeof full.derive === 'function' ? full.derive() : full.def;
  }
  values.set(full.key, value);
  return value;
}

/** Register an extra change callback (e.g. to recompute a derived value elsewhere). */
function onChange(key, fn) {
  if (!listeners.has(key)) listeners.set(key, []);
  listeners.get(key).push(fn);
}

function get(key) { return values.get(key); }

function notify(key, value) {
  for (const fn of listeners.get(key) || []) {
    try { fn(value); } catch (err) { console.error(`[settings] listener for ${key} threw:`, err); }
  }
  // Anything deriving from this key recomputes, unless it has been set explicitly.
  for (const [k, s] of specs) {
    if (k === key || explicit.has(k) || typeof s.derive !== 'function') continue;
    if (!Array.isArray(s.derivesFrom) || !s.derivesFrom.includes(key)) continue;
    const next = s.derive();
    if (next !== values.get(k)) {
      values.set(k, next);
      for (const fn of listeners.get(k) || []) {
        try { fn(next); } catch (err) { console.error(`[settings] listener for ${k} threw:`, err); }
      }
    }
  }
}

/** Set a setting. Returns {ok, value} or {ok:false, err}. */
function set(key, raw, source = 'api') {
  const spec = specs.get(key);
  if (!spec) return { ok: false, err: `unknown setting: ${key}` };
  const c = coerce(spec, raw);
  if (!c.ok) return { ok: false, err: c.err };
  const prev = values.get(key);
  values.set(key, c.value);
  explicit.add(key);
  userSet.add(key);
  if (prev !== c.value) {
    log.push({ at: Date.now(), key, from: prev, to: c.value, source });
    if (log.length > LOG_MAX) log.shift();
    notify(key, c.value);
    console.log(`[settings] ${key}: ${JSON.stringify(prev)} -> ${JSON.stringify(c.value)} (${source})`
      + (spec.live === false ? ' [restart required to take effect]' : ''));
  }
  scheduleSave();   // also when the value is unchanged: the key may be newly explicit
  return { ok: true, value: c.value, restartRequired: spec.live === false };
}

/** Restore a setting to its env/default/derived startup value. */
function reset(key, source = 'api') {
  const spec = specs.get(key);
  if (!spec) return { ok: false, err: `unknown setting: ${key}` };
  explicit.delete(key);
  userSet.delete(key);
  const envRaw = spec.env ? process.env[spec.env] : undefined;
  let value;
  if (envRaw !== undefined && envRaw !== '') {
    const c = coerce(spec, envRaw);
    if (c.ok) { value = c.value; explicit.add(key); }
  }
  if (value === undefined) value = typeof spec.derive === 'function' ? spec.derive() : spec.def;
  const prev = values.get(key);
  values.set(key, value);
  if (prev !== value) {
    log.push({ at: Date.now(), key, from: prev, to: value, source: `${source}:reset` });
    if (log.length > LOG_MAX) log.shift();
    notify(key, value);
    console.log(`[settings] ${key}: reset to ${JSON.stringify(value)}`);
  }
  stored.delete(key);
  scheduleSave();
  return { ok: true, value };
}

/** Full registry + current values, for the admin UI. */
function list() {
  const out = [];
  for (const [key, s] of specs) {
    out.push({
      key,
      value: values.get(key),
      env: s.env || null,
      type: s.type,
      min: s.min ?? null,
      max: s.max ?? null,
      step: s.step ?? null,
      choices: s.choices || null,
      category: s.category,
      label: s.label || key,
      desc: s.desc || '',
      live: s.live !== false,
      // INERT: declared, accepted, persisted — and consumed by nothing that runs. Kept rather than
      // deleted so documented EVIO_* env vars keep parsing, but surfaced so the dashboard can say so.
      // An unmarked knob that silently does nothing is worse than a missing one: the operator
      // concludes the GAME is broken. `npm run audit:settings` fails if a dead setting is unmarked.
      inert: s.inert || null,
      explicit: explicit.has(key),
      default: typeof s.derive === 'function' ? s.derive() : s.def,
    });
  }
  return out;
}

function changeLog() { return log.slice(); }

// ── Presets ────────────────────────────────────────────────────────────────────────────────
// Named bundles of settings, applied in one click from the dashboard. Everything here goes through
// the ordinary set() path, so validation, the change log and persistence all behave exactly as if
// each value had been typed by hand — a preset is a shortcut, not a back door.
//
// Keys that do not exist are skipped rather than failing the whole preset, so a preset stays usable
// after a setting is renamed or removed.
const PRESETS = {
  // NOTE ON WHICH KEYS ACTUALLY DO ANYTHING.
  // walkSpeed / runSpeed / jumpSpeed / speedScale are read ONLY by the legacy hand-rolled sim, which
  // never runs in production (_integratePlayerSimInner returns early whenever the extracted physics
  // is loaded). Presets built on them were inert. `gravity` is now real — it writes
  // gameSettings.Qn0kxxb and streams opcode 26 so client and server agree — but the rest of the
  // movement tuning lives in the per-player weaponStats block, which a preset cannot reach.
  // So the presets below stick to settings that are verified live.
  normal: {
    label: 'Normal', emoji: '🎯',
    desc: 'The default match: standard gravity, damage and respawn.',
    values: { gravity: 28, dmgGlobalMult: 0.01, respawnTicks: 60, healthRegen: true,
              swordOnly: false, throwableCooldownScale: 1, teleportCooldownScale: 1 },
  },
  moon: {
    label: 'Moon gravity', emoji: '🌙',
    desc: 'Low gravity — everyone floats, and falls take forever.',
    values: { gravity: 8 },
  },
  heavy: {
    label: 'Heavy gravity', emoji: '🪨',
    desc: 'Falls like a brick. Jumps barely leave the ground.',
    values: { gravity: 60 },
  },
  nadefest: {
    label: 'Grenade party', emoji: '🎆',
    desc: 'No cooldown on throwables or teleport — spam everything.',
    values: { throwableCooldownScale: 0, teleportCooldownScale: 0, grenadeThrowCooldown: 2 },
  },
  instagib: {
    label: 'Instagib', emoji: '💀',
    desc: 'One hit, one kill. Instant respawns.',
    values: { dmgGlobalMult: 1, respawnTicks: 10, healthRegen: false },
  },
  swords: {
    label: 'Sword duel', emoji: '⚔️',
    desc: 'Melee only — no guns for anyone.',
    values: { swordOnly: true, speedScale: 1.25, healthRegen: true },
  },
  floaty: {
    label: 'Floaty', emoji: '🐢',
    desc: 'Weak gravity and slow respawns — a drifting, unhurried match.',
    values: { gravity: 12, respawnTicks: 100 },
  },
  tank: {
    label: 'Bullet sponge', emoji: '🛡️',
    desc: 'Very low damage and fast regen — long, grindy fights.',
    values: { dmgGlobalMult: 0.003, healthRegen: true, regenRate: 0.03, regenDelayTicks: 40 },
  },
};

function listPresets() {
  return Object.entries(PRESETS).map(([id, p]) => ({
    id, label: p.label, emoji: p.emoji, desc: p.desc, keys: Object.keys(p.values).length,
  }));
}

function applyPreset(id, who = 'preset') {
  const p = PRESETS[id];
  if (!p) return { ok: false, err: `unknown preset: ${id}` };
  const applied = [], skipped = [];
  for (const [k, v] of Object.entries(p.values)) {
    const r = set(k, v, `${who}:${id}`);
    if (r && r.ok) applied.push(k); else skipped.push({ key: k, err: r && r.err });
  }
  return { ok: applied.length > 0, preset: id, label: p.label, applied, skipped };
}

export {
  define, onChange, get, set, reset, list, changeLog,
  flush, persistenceStatus, STORE_PATH,
  listPresets, applyPreset, PRESETS,
};
