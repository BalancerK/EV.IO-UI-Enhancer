"use strict";

// Ported for the browser-extension host (see sim/README.md). Same logic as the Node custom
// server's local_ws_server.js — require/module.exports swapped for ES import/export, plus the
// handful of real Node dependencies (fs/path/the `ws` library) stubbed out below, since a browser
// extension's service worker has no filesystem and no real TCP listening socket. Nearly every
// fs/path call site in this file was ALREADY optional/best-effort (debug logging, settings
// persistence, map-rotation catalogues) wrapped in its own try/catch upstream — these shims make
// that dead code harmless instead of deleting dozens of scattered call sites individually.
const __dirname = ".";
const fs = {
  readFileSync() { throw new Error("fs unavailable in extension host"); },
  writeFileSync() {}, appendFileSync() {}, renameSync() {}, unlinkSync() {},
};
const path = {
  join: (...parts) => parts.join("/"),
  resolve: (...parts) => parts.join("/"),
  basename: (p) => String(p).split(/[\\/]/).pop(),
};
import { encode, decode } from "./msgpack/index.mjs";
import { buildStatePacket, buildFirstSpawnBody, buildLoadoutDelta } from "./state_builder.js";
import { computeWeaponStats, ABILITY_COST, ABILITY_TIMER, ABILITY_TABLES } from "./ability_stats.js";
import cachedWeaponsData from "./weapons.json";

// The ability array (Q3i8qs3, opcode 93) is INDEXED BY ABILITY ID and the ids run 0..16 — so it needs
// 17 entries. Derived from the table rather than written as a literal: a hand-picked 16 silently cut
// off id 16, the impulse grenade, which is exactly the kind of off-by-one a magic number invites.
const MAX_ABILITY_SEED_LEN = Math.max(...Object.keys(ABILITY_TABLES).map(Number)) + 1;

// One sanitiser for all three places a loadout arrives (the join, RPC 7, and the userscript's live
// push). They had drifted: only the join was length-capped, so a truncated join array was what the
// HUD got built from while the live push restored the full one — which is how the impulse grenade came
// to be missing from the loadout display yet still throwable.
//
// Integer point-counts only (the stat computation is fed from this), and length-capped because the
// array is retained per session and copied onto the physics state. Out-of-range VALUES are already
// harmless: the stat table misses and falls back to the base value.
function _sanitizeAbilitySeed(arr) {
  if (!Array.isArray(arr)) return [];
  const src = arr.length > MAX_ABILITY_SEED_LEN ? arr.slice(0, MAX_ABILITY_SEED_LEN) : arr;
  return src.map((v) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0));
}
// terrain_height/bishop_heightmap.json removed: spawns come from the collision world
// (resolveSpawnsToFloor) and movement from the extracted physics. See activeSpawnPoints().
import phys from "./physics_extracted.js";
import bpw from "./physics_world.js";
import * as teleport from "./map_teleporters.js";
import * as navPath from "./navmesh_pathfinder.js";
import * as botDifficulty from "./bot_difficulty.js";

// ── Physics world player registry ─────────────────────────────────────────────
// Maps physId (= sessionId) → extracted physics player state (_ps object).
// MUST contain ALL registered players when Qcw4fab is called.
//
// Root cause of "Player B sees Player A stuck at spawn":
//   Qcw4fab iterates its internal Qvq3qq capsule map and calls
//   `delete this.Qvq3qq[l]` for any player NOT in the incoming game state.
//   Calling registerPlayer(world, ps_B) with only Player B in the fake state
//   deleted Player A's capsule → g() for Player A couldn't resolve collisions
//   → position stopped updating → server sent spawn position every tick.
// Fix: always call Qcw4fab with ALL currently-registered player states so
//   existing capsules are never deleted unexpectedly.
const _physWorldPlayers = new Map();  // physId → _ps

/**
 * Rebuild capsule data in the physics world for ALL registered players.
 * Must be called:
 *   - After registering a new player (so others' capsules are preserved)
 *   - Before each physics tick (so other players' capsule positions are current)
 *   - After a player disconnects (so their capsule is removed cleanly)
 *
 * @param {string|null} localPlayerId  ID of the "local" player (affects dead-player
 *   handling in Qcw4fab); pass the just-registered/ticking player's ID, or null.
 */
function _syncPhysWorldCapsules(localPlayerId) {
  if (!bpw.world) return;
  // Build a Qa7phk3 map from all registered physics states.
  // _ps objects are mutated in-place by tickMovement, so this map always
  // reflects the most recently computed positions.
  const allStates = {};
  for (const [, ps] of _physWorldPlayers) {
    allStates[ps.Q7q6byi] = ps;
  }
  const gs = { Qa7phk3: allStates, Qbu40n9: 1 };
  bpw.world.Qcw4fab([gs, gs], 0, localPlayerId || null);
}

// ── Settings registry ────────────────────────────────────────────────────────────────────
// Every tunable below is declared through `S.define` so the admin UI (admin_server.js, port
// 8081) can change it while the server runs. Env vars still win at startup and keep their exact
// previous meaning — the registry only adds a second way in. The bindings stay plain `let`s
// re-assigned by the change callback, so all existing usage sites are untouched.
import * as S from "./settings.js";
import * as mapLoader from "./map_loader.js";

let HOST = S.define({
  key: "host", env: "EVIO_LOCAL_HOST", type: "string", def: "127.0.0.1", live: false,
  category: "Server", label: "Bind host", desc: "Interface the game WebSocket listens on.",
}, (v) => { HOST = v; });
let PORT = S.define({
  key: "port", env: "EVIO_LOCAL_PORT", type: "int", def: 8080, min: 1, max: 65535, live: false,
  category: "Server", label: "Bind port", desc: "Game WebSocket port the client connects to.",
}, (v) => { PORT = v; });
let TICK_MS = S.define({
  key: "tickMs", env: "EVIO_TICK_MS", type: "int", def: 50, min: 10, max: 200, live: false,
  category: "Server", label: "Tick interval (ms)",
  desc: "Server tick period. 50ms = 20Hz, matching the client's simulation rate.",
}, (v) => { TICK_MS = v; });
// ── netlib/WebRTC transport (see server/netlib_adapter.js + the netlib migration plan) ───────
// Additive: when on, a second listener runs ALONGSIDE the WS one above, feeding every peer it
// accepts into the exact same handleConnection() path. Off by default — the WS transport is
// unaffected either way, this is a strict addition, not a replacement, for Phase 1.
let NETLIB_ENABLED = S.define({
  key: "netlibEnabled", env: "EVIO_NETLIB_ENABLED", type: "bool", def: false, live: false,
  category: "Server", label: "Enable netlib/WebRTC transport (experimental)",
  desc: "Runs a second, WebRTC-based listener alongside the WS one, to work around TCP "
    + "head-of-line blocking on lossy connections. Off by default; the WS transport keeps "
    + "working unmodified either way.",
}, (v) => { NETLIB_ENABLED = v; });
let NETLIB_GAME_ID = S.define({
  key: "netlibGameId", env: "EVIO_NETLIB_GAME_ID", type: "string",
  def: "0d6a3b8e-6b8b-4f0a-9a2b-3a6e7b7a2b39", live: false,
  category: "Server", label: "netlib game id (UUID)",
  desc: "Passed to the signaling server as the game namespace (util.IsUUID() enforced "
    + "server-side). Fixed per deployment; changing it does not affect any already-running "
    + "lobby.",
}, (v) => { NETLIB_GAME_ID = v; });
let NETLIB_SIGNALING_URL = S.define({
  key: "netlibSignalingUrl", env: "EVIO_NETLIB_SIGNALING_URL", type: "string",
  def: "ws://127.0.0.1:8090/v0/signaling", live: false,
  category: "Server", label: "netlib signaling server URL",
  desc: "Our self-hosted signaling server (see netlib-vendor/setup-signaling-service.sh). "
    + "Loopback by default since production reaches it through Caddy at "
    + "wss://<domain>/netlib/v0/signaling — set this to that public URL for a real deploy.",
}, (v) => { NETLIB_SIGNALING_URL = v; });
// ── Envelope `sync` — the server→client CLOCK-SYNC channel ───────────────────────────────
// The packet is [sync, clientTick, body]. `sync` is NOT a server tick counter: the client
// assigns it straight to `lagAccumulator` (bundle :27351) and derives its own tick period from
// it every animation frame (:27277):
//
//     period = TICK_MS + lagAccumulator * n + tickErrorCount        // n = 2 (SyncHandler :27244)
//
// So `sync` is how the server tells the client to speed up or slow down. Semantics come from the
// client's own pre-game path, which computes it locally as `stateBuffer.length - 1` (:27331):
// the number of SURPLUS server states the client has buffered. 0 = perfectly paced.
//   sync = 0  → period 50ms → exactly 20Hz, matching the client's sim rate.
//   sync > 0  → client slows down (it has a backlog of states to burn through).
//   sync < 0  → DISABLES reconciliation entirely (`lagAccumulator < 0` → Qak2r7y returns -1,
//               :27372), so never send a negative value unless that is what you want.
//
// We used to send `globalTick` here — an unbounded counter. At tick 1000 that asks the client for
// a 2050ms tick period; a stock client would simply stop sending input. It only ever worked
// because userscript patch 6d3 clamps the incoming sync to ±3 — which pinned the client at the
// ceiling, +3, i.e. a 56ms period = 17.86Hz against our 20Hz server. That permanent ~2Hz
// mismatch is a real desync: the client also never resets `lagCounter` (it only resets while
// lagAccumulator < 0), so it periodically hits "Skipping a server state to keep up" (:27348) and
// DROPS a server state whenever its buffer exceeds 2.
//
// All three official captures show `sync = 0` on every server→client packet. Default "zero"
// reproduces that. "adaptive" additionally nudges the client when OUR input queue tells us it is
// running fast or slow relative to us — useful on a real network, unnecessary on localhost.
let SYNC_MODE = S.define({
  key: "syncMode", env: "EVIO_SYNC_MODE", type: "enum", def: "zero",
  choices: ["zero", "adaptive", "tick"],
  category: "Netcode", label: "Clock-sync (envelope sync)",
  desc: "zero = always 0, matching the official server → the client ticks at exactly 20Hz "
      + "(default). adaptive = derive a small correction from the input-queue depth, clamped to "
      + "0..3, to pull a drifting client back. tick = legacy (send the server tick counter); "
      + "this is BROKEN — it stalls a stock client and pins a patched one at ~17.9Hz.",
}, (v) => { SYNC_MODE = v; });
let SYNC_ADAPTIVE_MAX = S.define({
  key: "syncAdaptiveMax", type: "int", def: 3, min: 0, max: 30,
  category: "Netcode", label: "Adaptive sync max",
  desc: "Upper clamp for adaptive mode (both the queue-surplus and burst-level contributions — see "
      + "syncAdaptiveBurst). Each unit adds 2ms to the client's tick period, so 3 means at most 56ms "
      + "(17.9Hz). Kept small (3) by default — a genuinely CPU-starved client (see syncAdaptiveBurst) "
      + "may need much more than that to actually break the catch-up spiral; raise this per-lobby if "
      + "you have players on weak hardware.",
}, (v) => { SYNC_ADAPTIVE_MAX = v; });
// Separate on/off switch for the burst-level contribution below, so an operator can keep the
// existing queue-surplus behaviour (drift correction) without opting into this newer, less-proven
// mechanism, or vice versa.
let SYNC_ADAPTIVE_BURST = S.define({
  key: "syncAdaptiveBurst", env: "EVIO_SYNC_ADAPTIVE_BURST", type: "bool", def: true,
  category: "Netcode", label: "Adaptive sync reacts to burst level (weak-CPU relief)",
  desc: "When syncMode=adaptive, also widen a struggling client's OWN tick period based on their "
      + "burstLevel (session._burstLevel — the same peak-hold signal that drives adaptive peer "
      + "smoothing). MECHANISM: the client's render/tick-processing loop is requestAnimationFrame-"
      + "driven with no fallback timer (confirmed in the real client bundle) — a slow frame (weak "
      + "CPU, background tab contention) directly stalls it, and the NEXT frame then has to "
      + "synchronously drain every tick that piled up in the meantime, which makes THAT frame slow "
      + "too — a compounding spiral that inflates the player's own ping reading 5-40x beyond the "
      + "underlying network latency (measured: 80ms baseline -> 400-3000ms under 4x CPU throttling). "
      + "Widening sync gives the client a longer real-time budget per required tick, so less backlog "
      + "accumulates between frames — this cannot fix a slow CPU, but it can reduce how much work "
      + "piles up per frame, damping the spiral. Same mechanism helps a burst caused by network "
      + "jitter, not just a weak CPU — the server cannot tell the two apart, and does not need to: "
      + "the mitigation is identical either way.",
}, (v) => { SYNC_ADAPTIVE_BURST = v; });

// Value to put in the envelope's sync slot for one recipient.
function computeSyncValue(session) {
  if (SYNC_MODE === "tick") return session._legacySyncTick || 0;
  if (SYNC_MODE !== "adaptive") return 0;
  // Adaptive: our input queue is the mirror of the client's state buffer. A queue persistently
  // deeper than the target means the client is producing ticks faster than we consume them, so
  // ask it to ease off by exactly the surplus. Never negative — that would kill reconciliation.
  const depth = Array.isArray(session.inputQueue) ? session.inputQueue.length : 0;
  const surplus = depth - INPUT_BUFFER_DEPTH;
  const queueDriven = surplus > 0 ? surplus : 0;
  // Burst-level driven — see syncAdaptiveBurst's description for the full mechanism. burstLevel=1
  // (perfectly steady arrival) contributes nothing; each unit above that widens the period by the
  // same 2ms/unit as the queue-surplus path, using the SAME clamp so the two compose sensibly
  // rather than one silently overriding the other.
  const burstDriven = (SYNC_ADAPTIVE_BURST && session._burstLevel > 1)
    ? Math.round(session._burstLevel - 1) : 0;
  const value = Math.max(queueDriven, burstDriven);
  return value > 0 ? Math.min(value, SYNC_ADAPTIVE_MAX) : 0;
}

// Send one authoritative state per CLIENT tick rather than per SERVER tick. See the gate in the
// broadcast loop: the client consumes exactly one buffered state per tick, so any surplus
// accumulates in its queue until it starts silently discarding corrections.
let RATE_MATCH_SENDS = S.define({
  key: "rateMatchSends", env: "EVIO_RATE_MATCH_SENDS", type: "bool", def: true,
  category: "Netcode", label: "Match send rate to client ticks",
  desc: "Skip the broadcast to a player on a server tick that drained none of their input. "
      + "Prevents their client-side state queue from growing until it discards corrections "
      + "(\"Skipping a server state to keep up\"). Disable to restore one send per server tick.",
}, (v) => { RATE_MATCH_SENDS = v; });

// How long a client may go silent before the send-rate gate stops applying to it. Short enough that
// a normally-ticking client (which sends every tick) always stays gated, long enough that a client
// which has stopped sending — loading a map, paused, backgrounded — starts receiving ticks again.
// Ceiling on banked send credit. Without one, a client that stalls and then floods its backlog would
// earn a large balance and be sent a burst it cannot consume — the queue growth rate matching exists
// to prevent.
//
// MEASURED LIVE (real VPN-tunnelled session, ~700ms RTT): queued-input depth cleanly oscillating
// 0 -> 4 -> 0 every few seconds, jitter itself a boring 2-4ms. The tick scheduler is fine; the
// player's own uplink is delivering input in BATCHES of ~4 ticks at once (consistent with a VPN
// client coalescing packets before flushing), not smoothly. At the old default of 3, a burst of 4
// only banked 3 credits — one tick's worth of movement got no corresponding broadcast every single
// burst, a real, live, currently-reproducing gap, not a theoretical one. Raised to 8 so it covers
// what real long-haul connections are actually doing, with margin, while still being far short of
// inputBufferMaxCatchup's ceiling (64) so a genuinely stalled-then-flooding client still gets capped.
let SEND_CREDIT_MAX = S.define({
  key: "sendCreditMax", env: "EVIO_SEND_CREDIT_MAX", type: "int", def: 8, min: 1, max: 32,
  category: "Netcode", label: "Send-credit ceiling (rate-match burst cover)",
  desc: "Max banked credit for the send-rate-match gate (see rateMatchMode=credit). A server tick "
      + "that drains N client ticks at once (arrival burst) earns min(this, N) credit, each spent on "
      + "one broadcast. Too low and a burst larger than this silently forfeits sends — a real gap "
      + "measured live on a high-latency VPN connection (bursts of 4, default was 3). Too high risks "
      + "flooding a client that stalls then catches up. Keep comfortably above the largest burst size "
      + "your real players' connections produce; well below inputBufferMaxCatchup.",
}, (v) => { SEND_CREDIT_MAX = v; });

// How the rate-match gate decides. Both cap total sends at the client ticks consumed; they differ only
// when a tick drains MORE than one client tick, which happens whenever a packet lands just after a tick
// boundary — real network jitter, routinely.
//   drain  — the original: one send per server tick that drained anything. A tick draining two client
//            ticks still sends once, so the second is forfeited and the client sees a doubled gap.
//   credit — earn one per client tick consumed, spend one per send. The owed send goes out next tick,
//            so nothing is forfeited and the cadence stays even.
// Kept switchable because "credit" is the change and a rollback should not need a code edit.
let RATE_MATCH_MODE = S.define({
  key: "rateMatchMode", env: "EVIO_RATE_MATCH_MODE", type: "enum", def: "credit",
  choices: ["credit", "drain"],
  category: "Netcode", label: "Rate-match accounting",
  desc: "credit = a tick that drains two client ticks funds two sends (no forfeited packets, even "
      + "cadence). drain = the original one-send-per-draining-tick behaviour.",
}, (v) => { RATE_MATCH_MODE = v; });

let SEND_GATE_GRACE_TICKS = S.define({
  key: "sendGateGraceTicks", env: "EVIO_SEND_GATE_GRACE", type: "number", def: 20, min: 1, max: 400, step: 1,
  category: "Netcode", label: "Send-gate grace (ticks)",
  desc: "A client silent for longer than this is treated as loading/paused and keeps receiving "
      + "state, so map loads cannot deadlock waiting for input the client cannot yet send.",
}, (v) => { SEND_GATE_GRACE_TICKS = v; });

let TICK_SCHEDULER = S.define({
  key: "tickScheduler", env: "EVIO_TICK_SCHEDULER", type: "enum", def: "drift",
  choices: ["drift", "precise", "interval"], live: false,
  category: "Server", label: "Tick scheduler",
  desc: "drift = absolute deadlines, exactly 20Hz on average at ~0% CPU (default). "
      + "precise = additionally busy-waits the last 16ms for ±0.03ms jitter, but costs ~2 CPU "
      + "cores — for parity captures only. interval = legacy setInterval, which on Windows "
      + "actually runs at 16Hz because the OS timer granularity is 15.625ms.",
}, (v) => { TICK_SCHEDULER = v; });
// A dedicated VPS deployment should stay "warm" (match timer/bots/map state ticking) even between
// players, the same way the official servers do. The browser extension host is the opposite case
// — it deliberately stops the tick loop with zero accepted sessions to save CPU/battery on
// whatever machine happens to be hosting it (see maybeStopGameLoop below and background.js's own
// teardownHosting() comment). Defaults from NODE_ENV=production — true on the VPS (its systemd
// unit sets that), false here (nothing ever sets NODE_ENV in the extension's shimmed
// process.env) — so the two deployments get the right behavior with no separate flag to remember.
let ALWAYS_RUN_TICK = S.define({
  key: "alwaysRunTick", env: "EVIO_ALWAYS_RUN_TICK", type: "bool",
  def: process.env.NODE_ENV === "production", live: false,
  category: "Server", label: "Always run the tick loop",
  desc: "Keep the global tick loop running even with zero connected players, instead of "
      + "stopping it when the lobby empties. Defaults on when NODE_ENV=production.",
}, (v) => { ALWAYS_RUN_TICK = v; });
let LOG_ALL_INPUT = S.define({
  key: "logAllInput", env: "EVIO_INPUT_LOG_ALL", type: "bool", def: false,
  category: "Debug", label: "Log every input frame",
  desc: "Very verbose: prints every client input frame instead of only interesting ones.",
}, (v) => { LOG_ALL_INPUT = v; });
// Per-tick state lines while the player is moving (position/velocity/grounded/sliding/...). At 20Hz
// per moving player this is the single loudest thing the server prints, so it is opt-in. The
// TICK_LOG_EVERY heartbeat is unaffected and still shows the loop is alive.
let TICK_DEBUG = S.define({
  key: "tickDebug", env: "EVIO_TICK_DEBUG", type: "bool", def: false,
  category: "Debug", label: "Log per-tick player state",
  desc: "Print the full per-tick state line whenever a player is in motion (20/s each). Use for "
      + "movement/parity work; the periodic heartbeat prints regardless.",
}, (v) => { TICK_DEBUG = v; });
// "Interesting" input frames — anything carrying a look delta, a key edge or an event. That is
// almost every frame once you move the mouse, so this defaulted to a wall of text whenever the
// camera turned. The first few frames still print unconditionally (they confirm input is arriving
// and parsing correctly at all); the rest need this flag.
let INPUT_DEBUG = S.define({
  key: "inputDebug", env: "EVIO_INPUT_DEBUG", type: "bool", def: false,
  category: "Debug", label: "Log interesting input frames",
  desc: "Print input frames that carry look/keys/events, plus a heartbeat every 100. Chatty while "
      + "moving the camera. The first 5 frames print regardless of this setting.",
}, (v) => { INPUT_DEBUG = v; });
// clientTick echo — reproduce the OFFICIAL ev.io server's behaviour.  Official
// captures show the server echoes the client's input tick incrementing one-per-
// frame, lagging the client's latest sent tick by a near-constant ~4 ticks (the
// real network + processing delay).  That lag is what keeps the echoed tick
// comfortably INSIDE the client's prediction ring (Qxo2o14, ~20 entries), so the
// reconciler matches EVERY tick and applies tiny continuous corrections.
//
// On localhost RTT≈0, so echoing the freshly-received tick (lag 0) lands at/ahead
// of the client's newest ring entry → trips `e.clientTick > ring[0].Qoiudi1` →
// reconciler skips for seconds → prediction free-runs → giant snap on the rare
// match.  We therefore inject the lag deliberately.
//   EVIO_ECHO_LAG_TICKS =  0 (default) server-authoritative reconcile, echo the
//                                       last PROCESSED client tick (buffer model).
//                       = >0          add extra echo lag (jitter margin for real nets)
//                       = -1          echo -1 → client-authoritative, no reconcile
//
// DEFAULT IS 0 (server-authoritative).  With the tick-index buffer model the server
// processes one client tick per server tick through the client's own g() and echoes
// the PROCESSED tick (always inside the client ring), so the reconciler matches every
// tick.  Validated smooth: reconcile rate ~16/s, median correction 0.000u, p99 0.607u,
// max ~1.05u over 2 min of wall-jumping ("stutter almost invisible").  Peers are also
// accurate because the client is reconciled to the server's authoritative position.
// -1 (client-authoritative) is kept for A/B testing; it's smooth locally but lets the
// server sim free-run from the client → ~46u peer drift.
// Default 3, NOT 0. The client refuses to reconcile an echo that is newer than its own newest
// prediction (Qak2r7y's first gate: `e.clientTick > Qxo2o14[0].Qt03jhz.Qoiudi1` -> return -1). Its
// ring head at reconcile time is the tick BEFORE the one it just sent, so echoing the newest
// processed tick lands exactly one ahead and is refused — every tick.
//
// On a real network the round trip supplies that lag for free, which is why official captures show
// the echo trailing by ~4 ticks. On localhost there is no such delay, so it has to be explicit.
// Measured with def:0 — echo=1330 against ring=[1310..1329]: 1306 of 1328 reconcile attempts
// declined (98%), i.e. reconciliation was effectively OFF while looking perfectly healthy.
// 3 sits well inside the observed ring depth of 20 (cap 100) and costs no simulation latency.
let ECHO_LAG_TICKS = S.define({
  key: "echoLagTicks", env: "EVIO_ECHO_LAG_TICKS", type: "int", def: 0, min: -1, max: 20,
  category: "Netcode", label: "Echo lag (ticks)",
  desc: "How far behind the newest processed client tick to echo. MUST be >= 1: the client refuses "
      + "an echo newer than its own newest prediction, so 0 declines every reconcile on localhost "
      + "(no network RTT to supply the lag). Adds no simulation latency, unlike inputBufferDepth. "
      + "-1 = echo -1, which makes the client SKIP reconciliation entirely: it will then ignore "
      + "every server-applied force it cannot predict (impulse knockback, damage push, teleport).",
}, (v) => { ECHO_LAG_TICKS = v; });

// ── Tick model ──────────────────────────────────────────────────────────────
// "buffer" (default): tick-index input-buffer model — each client input message
//   is enqueued keyed by its client tick index (Qoiudi1); the fixed-rate server
//   tick drains the queue FIFO, advancing the authoritative sim ONE client-tick
//   at a time through the same g() the client runs, and echoes the actually-
//   processed client tick.  Server-tick-N == client-predictState-N by construction
//   → reconcile corrections shrink to ~0.  The small buffer depth absorbs jitter
//   and IS the (official-style) ack lag, so the echoed tick stays inside the
//   client's prediction ring.
// "hybrid": the legacy global-loop + input-paced + computeEchoTick model.
let TICK_MODEL = S.define({
  key: "tickModel", env: "EVIO_TICK_MODEL", type: "enum", def: "buffer",
  choices: ["buffer", "hybrid"], live: false,
  category: "Netcode", label: "Tick model",
  desc: "buffer = tick-index input buffer (server tick N == client predictState N). "
      + "hybrid = legacy global-loop + input-paced model.",
}, (v) => { TICK_MODEL = v; });
// Jitter-buffer target depth (client ticks held before processing).  On localhost
// RTT≈0 this also provides the lag that keeps the echoed tick inside the ring.
// DEFAULT 1 (was 3): each unit of depth is a tick (~50ms) the server holds an input before
// acting on it — pure latency you feel as input/fire lag.  Depth absorbs network JITTER, of
// which localhost has none, so 1 is the right local default (the server still echoes the
// PROCESSED tick, which now lags newest by only 1 → comfortably inside the client's ~20-entry
// ring, so the reconciler still matches every tick).  Real-network deploys should raise this
// (e.g. 3) via EVIO_INPUT_BUFFER_DEPTH to trade latency for jitter tolerance.
// ── The netcode pairing that actually works (validated in play) ──────────────────────────────
// inputBufferDepth = 3, echoLagTicks = 0.
//
// These two are not independent. The client refuses an echo newer than its own newest prediction
// (Qak2r7y's first gate), so the echo MUST trail. There are two ways to make that happen and only
// one of them is correct:
//
//   echoLagTicks > 0  — move the LABEL back while the body still carries the newest simulated
//                       state. The client then compares its prediction for tick T-lag against a
//                       state that is really tick T; while rotating those differ by `lag` ticks of
//                       rotation and it corrects every tick. Measured 11.4 deg mean same-tick yaw
//                       error at lag 3 — this was the rotation stutter, and it scaled with the lag.
//   inputBufferDepth  — hold the tick back and simulate later, so lastProcessedClientTick is
//                       genuinely older AND the body really is that tick's state. Label and body
//                       agree, the comparison is apples to apples, and no correction is provoked.
//
// Depth costs ~1 tick of input latency per unit and buys jitter tolerance. 3 was confirmed smooth
// in play with echoLagTicks = 0; the minimum that still clears the ring-head gate is 1.
let INPUT_BUFFER_DEPTH = S.define({
  key: "inputBufferDepth", env: "EVIO_INPUT_BUFFER_DEPTH", type: "int", def: 0, min: 0, max: 20,
  category: "Netcode", label: "Input buffer depth",
  desc: "Client ticks held before simulating. 0 is only safe with carryLateInput ON (otherwise "
      + "sub-frames that arrive after the tick was simulated are DISCARDED, losing rotation) and is "
      + "best paired with echoLagTicks=-1, so the one-tick offset carried input introduces never "
      + "shows up as a correction. EVERY UNIT COSTS 50ms OF PEER LATENCY FOR EVERYONE: the server "
      + "simulates that far behind, and the client interpolates peers a further 1-2 ticks, so a "
      + "peer you see is roughly (depth+1)*50 to (depth+2)*50 ms old regardless of ping. 1 is right "
      + "for LAN/low ping; raise it only if jitter is actually causing problems. Prefer this over "
      + "echoLagTicks — depth keeps the echo label and the state body in agreement, echo lag does "
      + "not.",
}, (v) => { INPUT_BUFFER_DEPTH = v; });

// ── Why there is no per-session adaptive depth here ─────────────────────────────────────────────
// An earlier version of this widened inputBufferDepth PER SESSION based on burstLevel (extra target
// depth for a session whose own input kept arriving in bursts). Replaced by a simpler mechanism:
// inputBufferMaxCatchup below is now a small FIXED cap for every session, always — a burst just
// drains gradually over a few extra real ticks instead of being caught up in one, the same "reveal
// at a bounded rate, let the queue absorb the rest" shape already used for peer-broadcast smoothing
// (pushReplaySnapshot/popReplayTarget) and now for input consumption too. That intrinsically buys
// the same jitter tolerance the reactive widening did, without needing to detect "who is struggling"
// and reach into a per-session knob to fix it — every session gets smooth draining uniformly, and
// inputQueueMaxTicks (unchanged) remains the overflow backstop for a backlog too large to smooth
// through, exactly mirroring peerReplayQueueMax's role on the broadcast side.

// Max client-ticks processed in one server tick when catching up a backed-up queue.
//
// DEFAULT 16. Briefly dropped to 2 in an attempt to smooth server-side CPU cost during a burst, but
// that smoothing goal turned out to be REDUNDANT once the peer-replay-queue existed: peer-visible
// smoothness during a burst is already fully handled by pacing the REVEAL to peers (peerReplayQueueMax/
// popReplayTarget), independent of how fast we actually drain the backlog server-side. With that
// concern already covered elsewhere, a low catchup value bought nothing but extra delay — every tick
// a bursty/high-ping session's backlog sits undrained is a tick their actions are NOT yet
// authoritative, on top of whatever raw network latency they already have. Restored to 16, which
// this project already measured safe under real load (a 300-tick backlog across 38 firing players
// cleared in under 500ms with zero tick overruns) — the actual overrun problem historically only
// showed up at the setting's own MAX (64), not at 16.
let INPUT_BUFFER_MAX_CATCHUP = S.define({
  key: "inputBufferMaxCatchup", env: "EVIO_INPUT_BUFFER_MAX_CATCHUP", type: "int", def: 16, min: 1, max: 64,
  category: "Netcode", label: "Max catch-up ticks",
  desc: "Client ticks drained in one server tick when the queue backs up. Higher = a bursty/high-ping "
      + "session's backlog becomes server-authoritative faster (less added delay on top of their "
      + "network latency); peer-visible smoothness during the same burst is handled separately and "
      + "independently by the peer-replay-queue (peerReplayQueueMax), so this no longer needs to be "
      + "kept artificially low for that reason. Too low and the echo can fall out of the client's "
      + "100-tick reconciliation ring before a GENUINELY large backlog (multi-second stall, "
      + "backgrounded tab) finishes draining — worst case is roughly inputQueueMaxTicks / this value "
      + "real ticks. RAISING THIS HAS A SHARED COST: every extra drained tick re-runs the full "
      + "per-tick pipeline (physics, and an O(N) lag-comp rewind per shot if firing) for ONE session, "
      + "in ONE server tick — found live at 64 (the setting's own max) blowing the tick budget for "
      + "EVERYONE over one bad connection's catch-up burst. 16 is already measured safe; raise "
      + "further only with a fresh live measurement in hand.",
}, (v) => { INPUT_BUFFER_MAX_CATCHUP = v; });
// REPORTED SYMPTOM this exists to fix: "under intense combat with not-so-good internet, tick
// desync sometimes happened — the player still at tick 1 but the server already at tick 100 — and
// it takes a very long time to reconcile back."
//
// enqueueClientInput's own overflow guard used to trim the queue at a HARDCODED 120 entries — a
// number picked purely to bound memory, with no relationship to the client's reconciliation ring.
// The ring's own comments (above, at ECHO_LAG_TICKS) already documented its hard cap as 100 — so
// the queue was allowed to hold MORE backlog than the client can EVER reconcile against, even in
// principle. Once a stall (or a burst of sustained packet loss under "intense combat" — WebSocket
// runs over TCP, so a lost packet stalls delivery of everything behind it until retransmission,
// then it all arrives in one burst) pushes the backlog past what the client's ring can still hold,
// draining faster does not help: the ECHOED tick is already too stale for the client's lookup to
// find a matching prediction, the reconciler's comparison fails, and correction stops until
// something else intervenes — which is why it "takes a very long time," not a proportionally
// longer one. Measured server-side catch-up itself is fast (a 300-tick simulated backlog across 38
// firing players cleared in under 500ms with zero tick overruns) — the bottleneck is not OUR speed,
// it is that the client cannot use an echo this stale no matter how quickly we produce it.
//
// So this is capped HARD at 100 in the setting itself (not just documented) — raising it above the
// ring's own hard cap would silently reintroduce exactly this bug. The default (80) leaves margin
// under that ceiling for the time an echo takes to reach the client after being sent.
let INPUT_QUEUE_MAX_TICKS = S.define({
  key: "inputQueueMaxTicks", env: "EVIO_INPUT_QUEUE_MAX_TICKS", type: "int", def: 80, min: 8, max: 100,
  category: "Netcode", label: "Input queue hard cap (ticks)",
  desc: "Oldest buffered input is dropped once a session's queue exceeds this many ticks. MUST stay "
      + "under the client's reconciliation ring (hard cap 100): letting the queue hold more than the "
      + "ring can ever match against is what causes a desync that drains fine but never actually "
      + "reconciles — the exact 'stuck for a long time' failure. 80 leaves margin for transmission "
      + "delay after the echo is sent.",
}, (v) => { INPUT_QUEUE_MAX_TICKS = v; });
// ── Lag compensation (INTERPOLATED rewind) ──────────────────────────────────────
// The client raycasts shots against peer capsules INTERPOLATED to its render time — it lerps each
// peer BETWEEN two server snapshots (bundle Qcw4fab `lerpVectors`), and the input packet reports
// exactly which two: prevServerTick (A) and currServerTick (B). So the server must rewind each
// target to lerp(posAt(A), posAt(B), alpha) — NOT to a single floored tick. The old single-tick
// rewind sat the target at A (behind where the client rendered it ≈ midpoint A→B), so moving
// targets were consistently missed BEHIND. We keep per-player position history keyed by SERVER tick.
//   EVIO_LAGCOMP_ALPHA — interp fraction A→B (default 0.5 = the unbiased render midpoint; raise
//                        toward 1 to favour the newer snapshot — tune live with the dmg comparator).
//   EVIO_LAGCOMP_INTERP — optional extra whole-tick shift applied to BOTH A and B (default 0; the
//                        prev/curr window already encodes the client's render+buffer delay).
let LAGCOMP = S.define({
  key: "lagComp", env: "EVIO_LAGCOMP", type: "bool", def: true,
  category: "Combat", label: "Lag compensation",
  desc: "Rewind peer capsules to where the shooter's client rendered them. Off = shots are "
      + "checked against live server positions (moving targets get missed behind).",
}, (v) => { LAGCOMP = v; });
let LAGCOMP_ALPHA = S.define({
  key: "lagCompAlpha", env: "EVIO_LAGCOMP_ALPHA", type: "number", def: 0.3, min: 0, max: 1, step: 0.05,
  category: "Combat", label: "Lag-comp interp alpha",
  desc: "Fraction between the shooter's prev and curr server snapshots. 0.5 = the unbiased "
      + "render midpoint; raise toward 1 to favour the newer snapshot.",
}, (v) => { LAGCOMP_ALPHA = v; });
let LAGCOMP_INTERP = S.define({
  key: "lagCompInterp", env: "EVIO_LAGCOMP_INTERP", type: "number", def: 0, min: 0, max: 10, step: 0.5,
  category: "Combat", label: "Lag-comp extra shift (ticks)",
  desc: "Extra whole-tick rewind applied to both snapshots. Normally 0 — the prev/curr window "
      + "already encodes the client's render delay.",
}, (v) => { LAGCOMP_INTERP = v; });
let LAGCOMP_HISTORY = S.define({
  key: "lagCompHistory", type: "int", def: 64, min: 8, max: 256,
  category: "Combat", label: "Position history length",
  desc: "Per-player position-snapshot ring length. 64 ≈ 3s at 20Hz — the rewind window.",
}, (v) => { LAGCOMP_HISTORY = v; });
// ── Sub-frame shot parity (the "official way") ──────────────────────────────────
// The client fires from its RENDER position, not the end-of-tick position: m = lerp(prevTick.pos,
// currTick.pos, c) where c = frameDeltaTime = tickDeltaMs/tickDuration ∈ [0,1) (bundle 27282/67084),
// and it rewinds peer capsules at the SAME c (Qcw4fab, 67086). The end-of-tick origin we used before
// sat the shooter a partial tick AHEAD of where it rendered — worse the faster you move (the high-
// speed miss). With this on, the shot origin AND the target rewind both use the firing sub-frame's
// real c, reproducing the client's view exactly. EVIO_SUBFRAME_SHOT=0 reverts to end-of-tick.
// DEFAULT ON. (A high-speed-only session read 42.9% with it on, but that's the worst-case scenario,
// not an A/B vs off — high-speed shooting is exactly where the end-of-tick origin diverges most.)
let SUBFRAME_SHOT = S.define({
  key: "subframeShot", env: "EVIO_SUBFRAME_SHOT", type: "bool", def: true,
  category: "Combat", label: "Sub-frame shot origin",
  desc: "Fire from the client's interpolated RENDER position rather than the end-of-tick "
      + "position. Off = the shooter sits a partial tick ahead of where it drew (high-speed misses).",
}, (v) => { SUBFRAME_SHOT = v; });
// ── Client-supplied shot ray (exact origin/aim from the client we control) ──────
// The server can't reconstruct the client's exact firing position (merged-step residual + render
// interpolation), so the userscript sends the shot's EXACT rayOrigin+rayDirection (`#SHOT#`). The
// server raycasts THAT ray against its own lag-comp targets — identical to the client's raycast,
// zero shooter-side divergence — while staying authoritative (walls still block; we sanity-check
// the origin is near the server's reconstructed position so a tampered client can't teleport shots).
// EVIO_CLIENT_RAY=0 ignores client rays (force reconstruction) for A/B.
let CLIENT_RAY = S.define({
  key: "clientRay", env: "EVIO_CLIENT_RAY", type: "bool", def: true,
  category: "Combat", label: "Use client-supplied ray",
  desc: "Raycast the exact origin/direction the client sends (#SHOT#) instead of reconstructing "
      + "it. Removes shooter-side divergence; the server still validates walls and the origin.",
}, (v) => { CLIENT_RAY = v; });
// Slide entry/boost tracing. These fired on every slide entry — i.e. constantly while moving — and
// drowned everything else in the console. Diagnostics for tuning the slide boost, not something
// normal play needs, so they are off unless asked for.
let SLIDE_DEBUG = S.define({
  key: "slideDebug", inert: "legacy sim only - _integratePlayerSimInner never runs while the extracted physics is loaded, so this changes nothing", env: "EVIO_SLIDE_DEBUG", type: "bool", def: false,
  category: "Debug", label: "Log slide entry + boost",
  desc: "Log each slide entry transition and speed boost. Very chatty while moving.",
}, (v) => { SLIDE_DEBUG = v; });
// Per-shot ray/sid tracing. Off by default (one line per shot is far too noisy for normal play);
// turn on with EVIO_RAY_DEBUG=1 when chasing double-counted damage on the victim's health bar.
let RAY_DEBUG = S.define({
  key: "rayDebug", env: "EVIO_RAY_DEBUG", type: "bool", def: false,
  category: "Debug", label: "Log per-shot client ray + sid",
  desc: "One line per shot: weapon, whether the client's exact ray arrived, its shot sid, and the "
      + "queue depth. A shot with no sid double-counts on the victim's bar for ~3 ticks.",
}, (v) => { RAY_DEBUG = v; });
let CLIENT_RAY_MAX_ORIGIN_DRIFT = S.define({
  key: "clientRayMaxOriginDrift", env: "EVIO_CLIENT_RAY_MAX_DRIFT", type: "number", def: 4, min: 0, max: 50, step: 0.5,
  category: "Combat", label: "Client ray max origin drift (u)",
  desc: "Reject a client ray whose origin is further than this from the server's reconstructed "
      + "position — stops a tampered client teleporting its shots.",
}, (v) => { CLIENT_RAY_MAX_ORIGIN_DRIFT = v; });
let CLIENT_RAY_MAX_AGE_MS = S.define({
  key: "clientRayMaxAgeMs", type: "int", def: 500, min: 50, max: 5000, step: 50,
  category: "Combat", label: "Client ray max age (ms)",
  desc: "Drop unused client rays older than this.",
}, (v) => { CLIENT_RAY_MAX_AGE_MS = v; });
// How many ticks to keep echoing a real client tick after the server applies an unpredictable
// force. One tick would be enough on a perfect link; a few makes it robust to a dropped packet.
// MUST BE 0. THE ECHO IS A LABEL FOR THE BODY, AND A NON-ZERO VALUE MAKES IT LIE.
//
// The body we send during a burst is the server's state as of lastProcessedClientTick (T). Backing
// the echo off by N labels that body as tick T-N. The client then adopts a NEWER state as its
// prediction for an OLDER tick and replays its own inputs for the intervening ticks on top — so it
// ends up exactly N ticks AHEAD of the server, permanently.
//
// MEASURED at the old default of 2: the client sat exactly 2 ticks ahead after every knockback
// (SRV(t) == CLI(t-2), never 1 or 3), the gap compounded to 80-120u as the two sims began hitting
// different geometry, and 91-95% of ticks diverged. Setting this to 0 collapsed that to 10.4%
// diverging with a phase offset of ZERO (27/27 ticks matching at k=0), and the gap stopped growing.
// A knockback now shows a single tick of discrepancy, is corrected, and re-converges exactly.
//
// This is the same "label disagrees with body" mistake documented at the buffer-mode echo in
// processBufferedTick; the burst path reintroduced it. The stated reason for the backoff — landing
// inside the client's prediction ring — does not require it: lastProcessedClientTick is by
// definition a tick the client already sent, and with real RTT the client is 1-2 ticks past it, so
// it is comfortably inside the ring. Raise this ONLY if bursts are observed being dropped entirely,
// and if they are, the correct fix is to send the body FROM that older tick, not to mislabel this one.
let RECONCILE_ECHO_BACKOFF = S.define({
  key: "reconcileEchoBackoff", env: "EVIO_RECONCILE_BACKOFF", type: "int", def: 0, min: 0, max: 10,
  category: "Netcode", label: "Reconcile burst echo backoff",
  desc: "Ticks BEHIND the newest processed tick that the echo points during a reconcile burst. "
      + "MUST be 0: the body sent is that newest tick's state, so any backoff mislabels it and the "
      + "client ends up exactly this many ticks AHEAD of the server, permanently. Measured: 2 here "
      + "caused a permanent 2-tick offset after every knockback that compounded to 80-120u.",
}, (v) => { RECONCILE_ECHO_BACKOFF = v; });
let RECONCILE_BURST_TICKS = S.define({
  key: "reconcileBurstTicks", env: "EVIO_RECONCILE_BURST", type: "int", def: 4, min: 1, max: 20,
  category: "Netcode", label: "Reconcile burst (ticks)",
  desc: "With echoLagTicks=-1 the client runs free. After the server applies a force it cannot "
      + "predict (impulse grenade, explosion knockback) the echo carries a real tick for this "
      + "many ticks so the client adopts the push, then goes back to running free.",
}, (v) => { RECONCILE_BURST_TICKS = v; });
// ── Socket limits ────────────────────────────────────────────────────────────
// The game port faces the internet, so a client is untrusted input. None of these existed: the
// server accepted unlimited connections, 100 MiB frames (the `ws` default), unlimited message
// rate, and had no way to notice a connection that died without closing — a laptop lid or a lost
// phone signal left a session holding a player slot for ever, because `close` never fires for a
// silently dropped TCP connection.
let MAX_PAYLOAD_BYTES = S.define({
  key: "maxPayloadBytes", env: "EVIO_MAX_PAYLOAD", type: "int", def: 65536, min: 1024, max: 1048576,
  live: false, category: "Server", label: "Max inbound frame (bytes)",
  desc: "Largest single WebSocket frame accepted. Real input is a few hundred bytes; the library "
      + "default is 100 MiB. Applied at socket construction, so it needs a restart.",
}, (v) => { MAX_PAYLOAD_BYTES = v; });
let MAX_PLAYERS = S.define({
  key: "maxPlayers", env: "EVIO_MAX_PLAYERS", type: "int", def: 24, min: 1, max: 200,
  category: "Server", label: "Max connections",
  desc: "Connections beyond this are refused. Protects the tick loop, which does work per player.",
}, (v) => { MAX_PLAYERS = v; });
let MAX_CONN_PER_IP = S.define({
  key: "maxConnectionsPerIp", env: "EVIO_MAX_CONN_PER_IP", type: "int", def: 6, min: 1, max: 100,
  category: "Server", label: "Max connections per IP",
  desc: "Stops one host consuming every slot. Several is normal — two players behind one NAT, or "
      + "a reconnect racing a stale session.",
}, (v) => { MAX_CONN_PER_IP = v; });
// SIGTERM (what `systemctl restart`/`stop` sends) used to just flush settings and process.exit(0)
// immediately — every connected player was dropped mid-match with zero warning, on every single
// deploy. This is the one lever a single-process server actually has toward "production ready"
// without a full blue/green rearchitecture: refuse new joins, warn who's already in, and give the
// match a real chance to end naturally before forcing the issue. See beginGracefulShutdown().
let DRAIN_GRACE_SEC = S.define({
  key: "drainGraceSeconds", env: "EVIO_DRAIN_GRACE_SEC", type: "int", def: 20, min: 0, max: 120,
  category: "Server", label: "Graceful shutdown grace period (seconds)",
  desc: "On SIGTERM: stop accepting new joins, announce the restart to connected players, then wait "
      + "up to this long for them to leave naturally before exiting anyway. 0 skips the wait and "
      + "exits as soon as the announcement is sent. SIGINT (Ctrl+C) is unaffected — it still exits "
      + "immediately, for fast local dev iteration. Coupled to TimeoutStopSec in the systemd unit "
      + "(deploy/provision.sh) — that must stay comfortably above this setting's max (120s) or "
      + "systemd will SIGKILL the process mid-drain before it gets to exit on its own.",
}, (v) => { DRAIN_GRACE_SEC = v; });
// maxConnectionsPerIp bounds CONCURRENT connections from one address, but nothing bounded the RATE
// of new attempts — an address could open and close a connection thousands of times a second without
// ever exceeding that concurrent cap, and every attempt still pays for a TCP/WS handshake, a full
// O(N) scan of `sessions` (the per-IP concurrent-count check itself), session-object allocation, and
// a join-deadline timer. That is real, avoidable CPU spent on the same shared single-threaded tick
// loop this project has already found (see inputBufferMaxCatchup) blows the tick budget for everyone
// when a session pays real cost. A token bucket, same shape as the inbound-message limiter below,
// closes that gap independently of the concurrent-connection check.
let MAX_CONN_ATTEMPTS_PER_MIN = S.define({
  key: "maxConnAttemptsPerMin", env: "EVIO_MAX_CONN_ATTEMPTS_PER_MIN", type: "int", def: 30,
  min: 1, max: 1000,
  category: "Server", label: "Max connection attempts per IP per minute",
  desc: "Token bucket on NEW connection attempts from one address, independent of "
      + "maxConnectionsPerIp (which only bounds how many are open AT ONCE, not how fast new ones "
      + "arrive). Refused instantly, before any session/physics-state allocation. 30/min is "
      + "generous for real reconnect churn (a flaky connection retrying) while still bounding a "
      + "connect/disconnect flood from one address.",
}, (v) => { MAX_CONN_ATTEMPTS_PER_MIN = v; });
// ip -> { tokens, lastRefillMs }. Pruned in the heartbeat sweep (see startServer) rather than its
// own timer — piggybacking on an interval that already exists rather than adding another.
const _connAttempts = new Map();
function _connectionAttemptAllowed(ip) {
  const now = Date.now();
  let e = _connAttempts.get(ip);
  if (!e) {
    e = { tokens: MAX_CONN_ATTEMPTS_PER_MIN, lastRefillMs: now };
    _connAttempts.set(ip, e);
  } else {
    const elapsedMin = (now - e.lastRefillMs) / 60000;
    if (elapsedMin > 0) {
      e.tokens = Math.min(MAX_CONN_ATTEMPTS_PER_MIN, e.tokens + elapsedMin * MAX_CONN_ATTEMPTS_PER_MIN);
      e.lastRefillMs = now;
    }
  }
  if (e.tokens < 1) return false;
  e.tokens -= 1;
  return true;
}
let MAX_MSG_PER_SEC = S.define({
  key: "maxMessagesPerSec", env: "EVIO_MAX_MSG_PER_SEC", type: "int", def: 300, min: 20, max: 5000,
  category: "Server", label: "Max inbound messages/sec",
  desc: "Sustained per-connection ceiling. A client at 240fps sends well under 100/s, so this only "
      + "trips on a flood. Offenders are disconnected, not silently throttled.",
}, (v) => { MAX_MSG_PER_SEC = v; });
let MSG_BURST_SECONDS = S.define({
  key: "msgBurstSeconds", env: "EVIO_MSG_BURST_SEC", type: "number", def: 4, min: 0, max: 60,
  step: 0.5,
  category: "Server", label: "Message burst allowance (s)",
  desc: "Seconds' worth of messages a client may send in one burst above the sustained rate. This is "
      + "what stops a tab returning from the background — which flushes everything it buffered while "
      + "hidden — from being mistaken for a flood and disconnected.",
}, (v) => { MSG_BURST_SECONDS = v; });
// A socket that connects but never joins still holds a player slot, because maxPlayers counts
// SESSIONS and a session exists from the moment the socket opens. The heartbeat cannot reap these —
// the connection is genuinely alive and answers pings, it just never says who it is. Without a
// deadline, maxConnectionsPerIp from four addresses fills a 24-slot server with zero players and
// nothing in the logs looks wrong.
// Backpressure thresholds. A tick body is a few hundred bytes to a few KB.
//
// REPORTED SYMPTOM this default (256 KiB) directly caused: a player on a real degraded connection
// (250-400ms, packet loss) showed a ~6000ms "ping" and could not even send chat. Root cause: their
// displayed ping and their chat ack both travel as a backtick-RPC reply (handleBacktickRpc), sent via
// a plain, unconditional safeSend with NO backpressure check — it always sends, which it must (the
// client's sendEvent queue is SERIAL; an unanswered RPC blocks every later one, including their next
// chat and their next ping measurement). WebSocket delivers bytes over ONE ordered TCP stream, so
// that tiny reply queues BEHIND whatever state data is already sitting in the socket's send buffer.
// At 256 KiB (dozens of full tick bodies), a connection whose real throughput is degraded could take
// several SECONDS just to drain what was already queued before that reply could even begin to leave
// the server — which is exactly what "6000ms ping" and "can't chat" measure, not real network RTT.
//
// Lowered to 16 KiB (was 256 KiB) so the skip engages roughly 16x sooner — bounding worst-case
// already-queued backlog (and therefore worst-case RPC-reply delay) to a few ticks' worth instead of
// dozens. This does not fix a connection whose SUSTAINED real throughput is below what steady-state
// play requires (nothing server-side can), but it stops OUR OWN behaviour from making a temporary
// stall worse by piling minutes... — seconds — of backlog onto it before reacting.
//
// LOWERED AGAIN, 16 KiB -> 8 KiB. Reported live: a real long-haul connection (Australia, genuine
// geographic RTT ~300-400ms) saw its own displayed ping spike as high as 1300ms — roughly matching
// real RTT PLUS this exact already-queued-backlog delay (16 KiB at typical tick-body sizes ≈
// several hundred ms on its own), the same mechanism the first cut here was for, just not cut far
// enough for a connection this far away. Halving it again roughly halves that worst-case addition.
let SEND_BUFFER_SKIP_BYTES = S.define({
  key: "sendBufferSkipBytes", env: "EVIO_SEND_BUFFER_SKIP", type: "int", def: 8192,
  min: 0, max: 16777216,
  category: "Server", label: "Skip sending above N buffered bytes",
  desc: "Skip a player's state packet while their socket has more than this queued. Each tick is a "
      + "full snapshot, so a skip behaves like a dropped packet. 0 disables the check. LOWER IS "
      + "SAFER for struggling connections: backtick-RPC replies (chat ack, ping) are sent "
      + "UNCONDITIONALLY and queue behind whatever is already buffered here — a high threshold "
      + "directly becomes their worst-case delay (measured live: 256 KiB caused a ~6s stall on a "
      + "degraded connection, then 16 KiB was still enough to meaningfully worsen a genuinely "
      + "long-haul international connection's own displayed ping).",
}, (v) => { SEND_BUFFER_SKIP_BYTES = v; });
let SEND_BUFFER_MAX_TICKS = S.define({
  key: "sendBufferMaxTicks", env: "EVIO_SEND_BUFFER_MAX_TICKS", type: "int", def: 100,
  min: 20, max: 4000,
  category: "Server", label: "Ticks over the buffer limit before dropping",
  desc: "Close a connection that has been over the buffer limit for this many consecutive ticks. "
      + "100 = 5s at 20Hz — long enough to ride out a stall, short enough that a connection stuck "
      + "here (queued state neither draining nor shrinking) frees the slot before it eats minutes.",
}, (v) => { SEND_BUFFER_MAX_TICKS = v; });

let JOIN_DEADLINE_SEC = S.define({
  key: "joinDeadlineSeconds", env: "EVIO_JOIN_DEADLINE", type: "int", def: 20, min: 0, max: 300,
  category: "Server", label: "Join deadline (s)",
  desc: "Seconds a connection may stay open without sending its join before it is closed. Must be "
      + "generous — a real client downloads and parses the map first. 0 disables it.",
}, (v) => { JOIN_DEADLINE_SEC = v; });

let HEARTBEAT_SEC = S.define({
  key: "heartbeatSeconds", env: "EVIO_HEARTBEAT_SEC", type: "int", def: 15, min: 0, max: 300,
  category: "Server", label: "Heartbeat interval (s)",
  desc: "Ping every connection this often. 0 disables. Without it a connection that dies without "
      + "closing holds its player slot for ever.",
}, (v) => { HEARTBEAT_SEC = v; });
let HEARTBEAT_MISSES = S.define({
  key: "heartbeatMisses", env: "EVIO_HEARTBEAT_MISSES", type: "int", def: 2, min: 1, max: 10,
  category: "Server", label: "Heartbeat misses before drop",
  desc: "Consecutive unanswered pings before a connection is terminated. 1 is a hair-trigger: an "
      + "aggressively frozen browser tab can stall a single pong, and dropping a real player is "
      + "worse than reaping a dead socket one interval later.",
}, (v) => { HEARTBEAT_MISSES = v; });

// Map the latest-received client input tick to the value we echo this frame.
// Lagging by ECHO_LAG_TICKS keeps it inside the client ring; monotonic by
// construction since lastClientTick only increases during play.
// Mark a player as needing a reconcile: the server has just applied a force the client cannot
// predict, so its prediction is now wrong and only an echoed tick will correct it.
//
// The client has NO code path for an explosion pushing itself — the only writes to its own velocity
// are its own movement and the wall-jump. A server-spawned grenade has no client-side collider, so
// the blast is invisible to it. Reconciliation is the sole channel.
// Periodic re-anchor while the client is authoritative (echoLagTicks = -1).
//
// With echo -1 the client is NEVER corrected, so any per-tick difference accumulates without bound.
// Ordinarily that is fine, because our sim is the client's own extracted g() and tracks it closely.
// SLIDE BOOSTING breaks that assumption: slide entry is a velocity THRESHOLD (speed >= walk × 1.1)
// and entry multiplies velocity, so it is self-amplifying and chaotically sensitive. A difference far
// below the comparator's tolerance decides whether the boost fires on this tick or the next, and one
// missed or extra boost is a large, permanent position difference. Chain those and the two sims end
// up somewhere completely different — which only becomes visible when something (an impulse) finally
// forces a reconcile and the client snaps across the gap.
//
// A periodic burst bounds that: the client re-anchors every N ticks, so drift can never exceed one
// interval's worth. 0 disables it (pure client authority).
// Never withhold a tick from a recipient while other players exist — the packet is how they receive
// every peer's position, and the rate-match gate is keyed on the recipient's OWN input. See the note
// at the `idle` computation in the broadcast loop.
let RATE_MATCH_KEEP_PEERS = S.define({
  key: "rateMatchKeepPeers", env: "EVIO_RATE_MATCH_KEEP_PEERS", type: "bool", def: true,
  category: "Netcode", label: "Never skip a send while peers exist",
  desc: "Rate matching skips a player's packet on a tick that drained none of THEIR input — but that "
      + "packet also carries every peer's position, so the skip freezes everyone else on their screen "
      + "for a tick and then jumps a double step. With this on, the gate only applies when a player is "
      + "alone, where there is nothing to starve. Turn off to restore strict rate matching.",
}, (v) => { RATE_MATCH_KEEP_PEERS = v; });

let RECONCILE_ANCHOR_TICKS = S.define({
  key: "reconcileAnchorTicks", env: "EVIO_RECONCILE_ANCHOR", type: "int", def: 0, min: 0, max: 600,
  category: "Netcode", label: "Re-anchor interval while client-authoritative (ticks)",
  desc: "With echoLagTicks = -1 the client is never corrected, so server and client drift apart — "
      + "badly during slide boosting, which is threshold-driven and self-amplifying. This forces a "
      + "short reconcile burst every N ticks so drift is bounded by one interval. 0 = off. 100 = 5s. "
      + "Lower values correct more often but each correction is a visible nudge.",
}, (v) => { RECONCILE_ANCHOR_TICKS = v; });

// ── Live parity ring ────────────────────────────────────────────────────────────────────────────
// Records what the SERVER computed for each CLIENT tick, so it can be diffed against the client's own
// recording of the same tick. This is the one thing offline replay structurally cannot do: the
// harness always feeds the right input to the right tick, so it can never expose a mis-attribution.
//
// Deliberately cheap and OFF by default — it is a diagnostic, not a feature.
// The IN-FLIGHT component of the grenade catch-up, which tick numbers cannot reveal.
//
// A grenade thrown on client tick N is simulated by the CLIENT from tick N. We spawn ours when we
// PROCESS N, which is later by (a) inputBufferDepth and (b) the packet's flight time. Only (a) is
// visible as `lastClientTick - batch.clientTick`; (b) is invisible, because a packet still in the air
// has not raised lastClientTick yet.
//
// MEASURED: the live diff showed the server exactly 2 ticks behind at inputBufferDepth=1 on a 36ms
// ping — 1 tick of buffer plus 1 in flight. Hence a default of 1. If a capture shows the server still
// late, raise it; if it shows the server EARLY (detonating before the client), lower it.
let GRENADE_CATCHUP_EXTRA = S.define({
  key: "grenadeCatchupExtra", env: "EVIO_GRENADE_CATCHUP_EXTRA", type: "int", def: 1, min: 0, max: 6,
  category: "Grenades", label: "Grenade catch-up: extra ticks for packet flight time",
  desc: "Added to the measurable buffer lag when sizing a thrown grenade's catch-up. Covers the "
      + "in-flight packet time, which tick numbers cannot show. 0 disables the compensation entirely.",
}, (v) => { GRENADE_CATCHUP_EXTRA = v; });

let PARITY_RING_TICKS = S.define({
  key: "parityRingTicks", env: "EVIO_PARITY_RING", type: "int", def: 0, min: 0, max: 20000,
  category: "Debug", label: "Live parity ring (client ticks kept, 0 = off)",
  desc: "Record the server's per-tick state keyed by CLIENT tick, readable from /api/parity, so it "
      + "can be diffed against a client-side parity trace tick-for-tick. 3000 = ~2.5 minutes. Costs "
      + "a small object per player per tick; leave at 0 unless diagnosing divergence.",
}, (v) => { PARITY_RING_TICKS = v; });

function recordParitySample(session, batch, globalTick) {
  if (!(PARITY_RING_TICKS > 0)) return;
  const p = session.playerState, ps = p && p._ps;
  if (!ps || !batch || !Number.isFinite(batch.clientTick)) return;
  const ring = session._parityRing || (session._parityRing = []);
  // Count the sub-frames and held keys we ACTUALLY applied — a mis-attribution shows up here as a
  // different frame count or key set for the same client tick than the client recorded.
  let held = null;
  try { held = [...(p.heldActions || [])].map(Number).sort((a, b) => a - b); } catch (_) {}
  ring.push({
    ct: batch.clientTick, st: globalTick,
    px: +ps.Qdsukt4.x.toFixed(6), py: +ps.Qdsukt4.y.toFixed(6), pz: +ps.Qdsukt4.z.toFixed(6),
    vx: +ps.Qyaswvo.x.toFixed(6), vy: +ps.Qyaswvo.y.toFixed(6), vz: +ps.Qyaswvo.z.toFixed(6),
    yaw: +ps.Qqg4go0.toFixed(6), pitch: +ps.Qcrzrpr.toFixed(6),
    g: ps.Q9t2fit ? 1 : 0, cr: ps.Q2r3ysn ? 1 : 0, sp: ps.Q2xg3ev ? 1 : 0,
    aj: ps.Qac6dfa, js: ps.Qezbnmf, sl: ps.Qkm4yk4, st2: +(ps.Qwhpz0q || 0).toFixed(4),
    nf: Array.isArray(batch.frames) ? batch.frames.length : 0,
    // The catch-up this tick would give a grenade thrown now. Recorded so a capture SHOWS the value
    // rather than us inferring it from the resulting offset — the previous round of this fix failed
    // silently because the value was computed after the throw and nothing surfaced it.
    lag: p._inputLagTicks || 0,
    held,
  });
  if (ring.length > PARITY_RING_TICKS) ring.splice(0, ring.length - PARITY_RING_TICKS);
}

function requestReconcile(playerState, ticks) {
  if (!playerState) return;
  const n = Number.isFinite(ticks) ? ticks : RECONCILE_BURST_TICKS;
  playerState._reconcileFor = Math.max(playerState._reconcileFor || 0, n);
}

// Raise the periodic anchor burst if one is due. MUST be called from BOTH echo paths: the buffer
// tick model — the production default — computes its echo INLINE and never calls computeEchoTick,
// so a feature added only to the latter never runs for real players. That is exactly how this
// anchor silently did nothing on its first outing, and how selective reconciliation failed before
// it. Anything that influences the echo belongs in a shared helper like this one, called from both.
function maybeAnchorReconcile(session) {
  if (!(RECONCILE_ANCHOR_TICKS > 0)) return;
  if (!session || !session.playerState) return;
  const now = _live.globalTick || 0;
  const last = session._lastAnchorTick || 0;
  if (now - last < RECONCILE_ANCHOR_TICKS) return;
  session._lastAnchorTick = now;
  requestReconcile(session.playerState, RECONCILE_BURST_TICKS);
}

// Consume one tick of a pending reconcile burst. Returns true while the client still needs to be
// corrected, false once the burst is spent. Shared by BOTH echo paths — the buffer model computes
// its echo inline and an earlier version of this feature only patched the other one, so with the
// default tick model the burst never fired and an impulse pushed the player on the server (peers
// saw them fly) while their own screen never moved.
function consumeReconcileBurst(session) {
  const ps = session && session.playerState;
  if (!ps || !(ps._reconcileFor > 0)) return false;
  ps._reconcileFor -= 1;
  return true;
}

// The tick to echo DURING a reconcile burst.
//
// It must land INSIDE the client's prediction ring or the reconciler discards it before comparing
// anything (Qak2r7y: `e.clientTick > Qxo2o14[0].Qt03jhz.Qoiudi1` -> return -1). The newest tick is
// the risky one: at inputBufferDepth 0 we simulate a client tick the moment it arrives and would
// echo that same tick, but the client stores its ring entry and sends its input in the same frame,
// so our echo can be one ahead of what it has recorded — and the whole burst is then silently
// dropped. That is why the push showed on peers (server state was right) while the thrower's own
// screen never moved.
//
// Stepping back a couple of ticks costs nothing: this only applies on the handful of ticks after an
// impulse, never in normal play.
function burstEchoTick(session) {
  const t = session && session.lastProcessedClientTick;
  if (!Number.isFinite(t) || t <= 0) return -1;
  const back = t - RECONCILE_ECHO_BACKOFF;
  return back > 0 ? back : (t > 0 ? t : -1);
}

function computeEchoTick(lastClientTick, session) {
  // While we are simulating a player with no input of their own, the state we are sending is NOT the
  // state of any client tick — it is the server's own continuation past the last tick they sent.
  // Labelling it with their stale lastProcessedClientTick would be exactly the label-disagrees-with-
  // body mistake that produced the rotation stutter: the client would compare its prediction for an
  // old tick against a body that has moved on since. -1 says "do not reconcile this one", which is
  // also simply true — a frozen tab has no prediction to reconcile.
  // A player still on the arrival screen must NOT be reconciled. Reconciliation rebuilds the local
  // player from the client's own prediction, and the client never predicts Qyxhj60 = 0 — only the
  // server sends that — so a reconcile silently restores state 1, which is why the arrival view showed
  // a first-person camera with the weapon in hand (the FP weapon is gated on state 1 at :48138).
  // Official echoes -1 on every packet, so it never reconciles at all.
  if (session && session.playerState && session.playerState._holdForPlay) return -1;
  if (session && session._idleTicks > 0) return -1;
  // SELECTIVE RECONCILIATION (echoLagTicks = -1 with correctness preserved).
  //
  // Echoing -1 makes the client authoritative over its own movement — exactly what official ev.io
  // does — so it never corrects itself and never stutters. The catch is that it also never learns
  // about impulse grenades or explosion knockback, because those are server-computed velocity it
  // cannot predict.
  //
  // So echo -1 on ordinary ticks, and a REAL tick for a short burst after the server applies such a
  // force. The client reconciles just then, adopts the push, and goes back to running free. The
  // burst repeats the correction for a few ticks so a single dropped packet cannot swallow it.
  if (ECHO_LAG_TICKS < 0) {
    maybeAnchorReconcile(session);   // periodic re-anchor so drift cannot build up unbounded
    if (consumeReconcileBurst(session)) {
      const t = burstEchoTick(session);
      if (t > 0) return t;                          // correct me, just for these ticks
    }
    return -1;                                      // client-authoritative
  }
  if (!Number.isFinite(lastClientTick) || lastClientTick <= 0) return -1;
  // No implicit floor. The trailing now comes from INPUT_BUFFER_DEPTH holding a tick back, so
  // lastProcessedClientTick is ALREADY older than the newest tick the client sent — and crucially
  // the state we send is genuinely that tick's state. Adding lag on top would re-introduce the
  // mismatch this whole mechanism exists to avoid: the echo is only a label, and shifting it
  // without shifting the body makes the client compare its prediction against the wrong tick.
  const t = lastClientTick - ECHO_LAG_TICKS;
  return t > 0 ? t : -1;
}
// ── Ground height / player coordinate system ─────────────────────────────────
// Bundle analysis (lines 44448-44449 in bundle.pretty.js):
//   lower sphere center = Qdsukt4 + up * Qkjo9hz (radius 0.6)
//   upper sphere center = Qdsukt4 + up * (Qfvid2k − Qkjo9hz) = Qdsukt4 + 1.6
// → Qdsukt4 is the FEET (bottom of capsule), NOT the center.
// Camera: feet.y + Qyohfua (1.8 standing) or + Qymlxst (1.0 crouching).
// Hitbox top: feet.y + Qfvid2k (2.2 standing).
//
// state_builder.js spawn default: { x:0, y:2, z:0 }  → feet at world y=2.0
// Bishop map terrain at spawn origin is at y≈2.0 world units.
// GROUND_Y must match spawn terrain or the player is embedded in the ground.
// Old value 1.93 put the player 0.07 m below terrain → "feels shorter" bug.
let GROUND_Y = S.define({
  key: "groundY", env: "EVIO_SIM_GROUND_Y", type: "number", def: 2.0, min: -100, max: 100, step: 0.1,
  category: "Movement", label: "Fallback ground Y",
  desc: "Flat ground height used only when the heightmap is unavailable. Must match spawn "
      + "terrain or players are embedded in the floor.",
}, (v) => { GROUND_Y = v; });
// Network-origin Y offset applied only to the emitted position opcode 136.
// Kept at 0: Qdsukt4=feet at y=2 is already the correct world coordinate.
let EMIT_POSITION_Y_OFFSET = S.define({
  key: "emitPositionYOffset", env: "EVIO_EMIT_POSITION_Y_OFFSET", type: "number", def: 0, min: -10, max: 10, step: 0.1,
  category: "Movement", label: "Emitted position Y offset",
  desc: "Y offset applied only to the streamed position (opcode 136). 0 is correct — feet are "
      + "already the world coordinate.",
}, (v) => { EMIT_POSITION_Y_OFFSET = v; });
// ── Speed scale ───────────────────────────────────────────────────────────────
// These defaults are bundle-derived official movement speeds. The relevant
// client constants are Q6o3kdb=Q6zowar=0.45 and Q8i9f3s=Qin39fw=0.7, applied
// over the 20Hz simulation/update scale. Earlier 4.8/8.9 values came from a
// noisy public-player capture analysis and feel almost half-speed after the
// clientTick pacing/rubber-band bug was fixed.
//   walk/backward = 0.45 * 20 = 9.0 u/s
//   sprint cap    = 0.70 * 20 = 14.0 u/s
//   jump/gravity remain provisional and should be tuned from jump captures.
let WALK_SPEED_BASE = S.define({
  key: "walkSpeed", inert: "movement is driven by weaponStats Q8i9f3s - this only feeds the 'sliding' flag", env: "EVIO_SIM_WALK_SPEED", type: "number", def: 9.0, min: 0, max: 60, step: 0.5,
  category: "Movement", label: "Walk speed (u/s)",
  desc: "Bundle-derived official walk speed: Q6o3kdb 0.45 × 20Hz = 9.0.",
}, (v) => { WALK_SPEED_BASE = v; });
let RUN_SPEED_BASE = S.define({
  key: "runSpeed", inert: "movement is driven by weaponStats Q8i9f3s - this only feeds the 'sliding' flag", env: "EVIO_SIM_RUN_SPEED", type: "number", def: 14.0, min: 0, max: 80, step: 0.5,
  category: "Movement", label: "Sprint speed cap (u/s)",
  desc: "Bundle-derived official sprint cap: Q8i9f3s 0.70 × 20Hz = 14.0.",
}, (v) => { RUN_SPEED_BASE = v; });
let SPEED_SCALE = S.define({
  key: "speedScale", inert: "movement is driven by weaponStats Q8i9f3s - this only scales the 'sliding' flag", env: "EVIO_SIM_SPEED_SCALE", type: "number", def: 1.0, min: 0.1, max: 5, step: 0.05,
  category: "Movement", label: "Global speed scale",
  desc: "Multiplies walk and sprint together — one knob for overall movement feel.",
}, (v) => { SPEED_SCALE = v; });

// Derived from the three above; recomputed by S when any of them changes.
let WALK_SPEED = WALK_SPEED_BASE * SPEED_SCALE;
let RUN_SPEED = RUN_SPEED_BASE * SPEED_SCALE;
function _recomputeSpeeds() {
  WALK_SPEED = WALK_SPEED_BASE * SPEED_SCALE;
  RUN_SPEED = RUN_SPEED_BASE * SPEED_SCALE;
}
S.onChange("walkSpeed", _recomputeSpeeds);
S.onChange("runSpeed", _recomputeSpeeds);
S.onChange("speedScale", _recomputeSpeeds);

// Bundle Q4jg62a = 0.5: crouch max speed = walkSpeed * 0.5. Derived until set explicitly.
let CROUCH_SPEED = S.define({
  key: "crouchSpeed", inert: "legacy sim only - _integratePlayerSimInner never runs while the extracted physics is loaded, so this changes nothing", env: "EVIO_SIM_CROUCH_SPEED", type: "number", min: 0, max: 60, step: 0.5,
  derive: () => (S.get("walkSpeed") ?? 9.0) * (S.get("speedScale") ?? 1.0) * 0.5,
  derivesFrom: ["walkSpeed", "speedScale"],
  category: "Movement", label: "Crouch speed (u/s)",
  desc: "Bundle Q4jg62a = 0.5 → walk × 0.5. Tracks walk speed until you set it explicitly.",
}, (v) => { CROUCH_SPEED = v; });
// Bundle Qyzir06 = 1.1: slide starts when horizontalSpeed >= walkSpeed * 1.1 (checked every frame)
// This is a continuous velocity-threshold check, NOT a one-time press event. No time limit.
let SLIDE_THRESHOLD = S.define({
  key: "slideThreshold", env: "EVIO_SIM_SLIDE_THRESHOLD", type: "number", def: 1.1, min: 0.1, max: 5, step: 0.05,
  category: "Movement", label: "Slide entry threshold (× walk)",
  desc: "Bundle Qyzir06 = 1.1: sliding starts while horizontal speed ≥ walk × this. Continuous "
      + "velocity check, not a press event.",
}, (v) => { SLIDE_THRESHOLD = v; });
// Bundle slide entry boost (line 34679): velocity *= SLIDE_ENTRY_BOOST on first frame entering slide.
// Condition: prev-grounded (i.Q9t2fit) AND NOT prev-crouching+grounded (!b where b = Q2r3ysn prev-frame).
// Cooldown: 50 bundle ticks = 2.5s real-time. At our 20Hz server (50ms/tick) that's 50 ticks.
let SLIDE_ENTRY_BOOST = S.define({
  key: "slideEntryBoost", env: "EVIO_SIM_SLIDE_ENTRY_BOOST", type: "number", def: 1.5, min: 1, max: 5, step: 0.1,
  category: "Movement", label: "Slide entry boost (×)",
  desc: "Velocity multiplier on the first frame entering a slide (bundle :34679).",
}, (v) => { SLIDE_ENTRY_BOOST = v; });
let SLIDE_ENTRY_COOLDOWN_TICKS = S.define({
  key: "slideEntryCooldownTicks", inert: "legacy sim only - _integratePlayerSimInner never runs while the extracted physics is loaded, so this changes nothing", env: "EVIO_SIM_SLIDE_ENTRY_COOLDOWN_TICKS", type: "int", def: 50, min: 0, max: 400,
  category: "Movement", label: "Slide boost cooldown (ticks)",
  desc: "Ticks before another slide-entry boost can fire. 50 ticks = 2.5s at 20Hz.",
}, (v) => { SLIDE_ENTRY_COOLDOWN_TICKS = v; });
// Bundle slide decay: O -= 0.012 * Qq5sl76 per bundle tick at 20 TPS.
// In server units: 0.012 × 20 (tps) × 20 (u/tick-to-u/s scale) = 4.8 u/s per second.
let SLIDE_DECAY_RATE = S.define({
  key: "slideDecayRate", inert: "legacy sim only - _integratePlayerSimInner never runs while the extracted physics is loaded, so this changes nothing", env: "EVIO_SIM_SLIDE_DECAY_RATE", type: "number", def: 4.8, min: 0, max: 40, step: 0.1,
  category: "Movement", label: "Slide decay (u/s per s)",
  desc: "Speed bled off while sliding. Bundle: 0.012 × 20 tps × 20 = 4.8.",
}, (v) => { SLIDE_DECAY_RATE = v; });
// Slide steering: Qxabwrz * Q26sgxw * 2 * Qq5sl76 = 0.14 × 0.2 × 2 × 1 = 0.056 bundle-units/tick.
// In server units: 0.056 × 20 = 1.12 u/s steering impulse cap per second.
let SLIDE_STEER_ACCEL = S.define({
  key: "slideSteerAccel", inert: "legacy sim only - _integratePlayerSimInner never runs while the extracted physics is loaded, so this changes nothing", env: "EVIO_SIM_SLIDE_STEER_ACCEL", type: "number", def: 1.12, min: 0, max: 20, step: 0.05,
  category: "Movement", label: "Slide steer accel (u/s)",
  desc: "Steering impulse cap while sliding. Bundle: 0.14 × 0.2 × 2 × 20 = 1.12.",
}, (v) => { SLIDE_STEER_ACCEL = v; });
// Bundle-derived sprint ramp constants. Official code uses three per-tick multipliers
// (Qi19vt9/Qi19vta/Qi19vtb) at two speed thresholds (Qo1g7o1/Qqek7vy).
// SPRINT_RAMP_HZ = bundle TPS (20): exponent = dtSeconds × 20 = bundle-ticks per our integration step.
let SPRINT_RAMP_LOW = S.define({
  key: "sprintRampLow", env: "EVIO_SIM_SPRINT_RAMP_LOW", type: "number", def: 1.09, min: 1, max: 2, step: 0.005,
  category: "Movement", label: "Sprint ramp — low (Qi19vt9)",
  desc: "Per-tick acceleration multiplier below the mid speed threshold.",
}, (v) => { SPRINT_RAMP_LOW = v; });
let SPRINT_RAMP_MID = S.define({
  key: "sprintRampMid", env: "EVIO_SIM_SPRINT_RAMP_MID", type: "number", def: 1.033, min: 1, max: 2, step: 0.005,
  category: "Movement", label: "Sprint ramp — mid (Qi19vta)",
  desc: "Per-tick acceleration multiplier between the mid and high thresholds.",
}, (v) => { SPRINT_RAMP_MID = v; });
let SPRINT_RAMP_HIGH = S.define({
  key: "sprintRampHigh", env: "EVIO_SIM_SPRINT_RAMP_HIGH", type: "number", def: 1.0065, min: 1, max: 2, step: 0.001,
  category: "Movement", label: "Sprint ramp — high (Qi19vtb)",
  desc: "Per-tick acceleration multiplier above the high threshold.",
}, (v) => { SPRINT_RAMP_HIGH = v; });
let SPRINT_RAMP_HZ = S.define({
  key: "sprintRampHz", env: "EVIO_SIM_SPRINT_RAMP_HZ", type: "number", def: 20, min: 1, max: 120,
  category: "Movement", label: "Sprint ramp rate (Hz)",
  desc: "Bundle TPS used as the ramp exponent base. Should stay 20 (the client's rate).",
}, (v) => { SPRINT_RAMP_HZ = v; });
let SPRINT_RAMP_THRESHOLD_MID = S.define({
  key: "sprintRampThresholdMid", env: "EVIO_SIM_SPRINT_RAMP_THRESHOLD_MID", type: "number", min: 0, max: 80, step: 0.1,
  derive: () => (S.get("walkSpeed") ?? 9.0) * (S.get("speedScale") ?? 1.0) * (0.52 / 0.45),
  derivesFrom: ["walkSpeed", "speedScale"],
  category: "Movement", label: "Sprint ramp mid threshold (u/s)",
  desc: "Bundle Qo1g7o1. Derived as walk × 0.52/0.45 until set explicitly.",
}, (v) => { SPRINT_RAMP_THRESHOLD_MID = v; });
let SPRINT_RAMP_THRESHOLD_HIGH = S.define({
  key: "sprintRampThresholdHigh", env: "EVIO_SIM_SPRINT_RAMP_THRESHOLD_HIGH", type: "number", min: 0, max: 80, step: 0.1,
  derive: () => (S.get("walkSpeed") ?? 9.0) * (S.get("speedScale") ?? 1.0) * (0.59 / 0.45),
  derivesFrom: ["walkSpeed", "speedScale"],
  category: "Movement", label: "Sprint ramp high threshold (u/s)",
  desc: "Bundle Qqek7vy. Derived as walk × 0.59/0.45 until set explicitly.",
}, (v) => { SPRINT_RAMP_THRESHOLD_HIGH = v; });
let JUMP_SPEED = S.define({
  key: "jumpSpeed", inert: "legacy sim only - _integratePlayerSimInner never runs while the extracted physics is loaded, so this changes nothing", env: "EVIO_SIM_JUMP_SPEED", type: "number", def: 15.4, min: 0, max: 60, step: 0.1,
  category: "Movement", label: "Jump speed (u/s)",
  desc: "Bundle Qfh4lso 0.77 × 20 TPS. Note the real per-player value comes from the loadout.",
}, (v) => { JUMP_SPEED = v; });
// LIVE, AND SYNCED TO THE CLIENT.
//
// This used to be read only by the legacy hand-rolled sim, which never runs in production
// (_integratePlayerSimInner returns early whenever _ps && bpw.world) — so the setting, and the
// "Moon gravity" preset built on it, did nothing at all.
//
// The value the extracted physics actually uses is gameSettings.Qn0kxxb (per FRAME, :3525), and the
// client reads its own copy of the same field — which is opcode 26, one we were not emitting. So
// changing gravity has to do BOTH: update our gameSettings so the server sim uses it, and emit 26 so
// the client's sim matches. Changing only one would desync every player instantly, which matters a
// great deal more now that reconciliation runs every tick.
//
// Stored in u/s² for the dashboard (28 = the real game); converted to the engine's per-frame unit by
// dividing by the tick rate squared: 28 / 20² = 0.07 = the bundle's Qyw1swv.
let GRAVITY = S.define({
  key: "gravity", env: "EVIO_SIM_GRAVITY", type: "number", def: 28.0, min: 0, max: 200, step: 0.5,
  category: "Movement", label: "Gravity (u/s²)",
  desc: "28 = the real game (bundle Qyw1swv 0.07 x 20²). Applied to the server sim AND streamed to "
      + "the client as opcode 26, so both stay in sync. 8 = floaty, 60 = heavy.",
}, (v) => { GRAVITY = v; applyGravityToWorld(); });

// Push the configured gravity into the settings object the extracted physics reads. Called on every
// change and once after the physics world loads (the setting can be applied before it exists).
function applyGravityToWorld() {
  const gs = bpw && bpw.gameSettings;
  if (!gs) return;
  const ticksPerSecond = Math.max(1, Math.round(1000 / TICK_MS));
  gs.Qn0kxxb = GRAVITY / (ticksPerSecond * ticksPerSecond);
}
bpw.ready.then(applyGravityToWorld).catch(() => {});
let LOOK_SCALE = S.define({
  key: "lookScale", env: "EVIO_SIM_LOOK_SCALE", type: "number", def: 1.0, min: 0.05, max: 10, step: 0.05,
  category: "Movement", label: "Look delta scale",
  desc: "Multiplier on the client's look deltas. 1.0 = faithful; changing it desyncs aim.",
}, (v) => { LOOK_SCALE = v; });
// Per-sub-frame movement integration. Merged (default) matches the client's RECONCILER state (right
// for echo>=0). But under echo=-1 the reconciler is off and the client shows its LIVE per-sub-frame
// prediction — which is what peers should see. With merged, the server's authoritative position
// slowly drifts from the live client (collision/slide sub-stepping differs) and, with no reconcile to
// correct it, accumulates until the capsule catches walls the client passed. Set EVIO_SUBFRAME_MOVE=1
// (recommended together with EVIO_ECHO_LAG_TICKS=-1) to step movement per-sub-frame like the live
// client. Look stays at the folded end-of-tick yaw (per-frame lookDelta stripped) so this isolates
// the integration/collision sub-stepping.
let SUBFRAME_MOVE = S.define({
  key: "subframeMove", env: "EVIO_SUBFRAME_MOVE", type: "bool", def: false,
  category: "Netcode", label: "Per-sub-frame movement",
  desc: "Step movement per sub-frame like the live client instead of the merged single step. "
      + "Merged matches the RECONCILER state and is correct for echo ≥ 0; enable this only "
      + "together with echo = -1.",
}, (v) => { SUBFRAME_MOVE = v; });
// Pacing instrumentation: with echo=-1 the offline harness can't see real-time tick-stream drift.
// EVIO_PACING_DEBUG=1 logs, every ~2s per session: client ticks ENQUEUED vs PROCESSED vs DROPPED
// (queue overflow) and the processed-vs-received lag. Drops or processed<enqueued = the accumulation.
let PACING_DEBUG = S.define({
  key: "pacingDebug", env: "EVIO_PACING_DEBUG", type: "bool", def: false,
  category: "Debug", label: "Pacing log",
  desc: "Every ~2s per session, log client ticks enqueued vs processed vs dropped, and the "
      + "processed-vs-received lag. Writes to pacing.log.",
}, (v) => { PACING_DEBUG = v; if (v) _initPacingLog(); });
const PACING_LOG = path.join(__dirname, "pacing.log");
function _initPacingLog() {
  try { fs.writeFileSync(PACING_LOG, `# pacing log started ${new Date().toISOString()}\n`); } catch (e) {}
}
if (PACING_DEBUG) _initPacingLog();
let ALIGN_TICKS_TO_CLIENT = S.define({
  key: "alignTicksToClient", inert: "no consumer - nothing reads this", env: "EVIO_ALIGN_TICKS_TO_CLIENT", type: "bool", def: false,
  category: "Netcode", label: "Align server ticks to client",
  desc: "Legacy (hybrid model): drive the server tick index from the client's tick.",
}, (v) => { ALIGN_TICKS_TO_CLIENT = v; });
let INPUT_PACED_TICKS = S.define({
  key: "inputPacedTicks", inert: "no consumer - nothing reads this", env: "EVIO_INPUT_PACED_TICKS", type: "bool", def: false,
  category: "Netcode", label: "Input-paced ticks",
  desc: "Legacy (hybrid model): advance a tick on input arrival rather than on the timer.",
}, (v) => { INPUT_PACED_TICKS = v; });
let REALTIME_SIM_DT = S.define({
  key: "realtimeSimDt", env: "EVIO_REALTIME_SIM_DT", type: "bool", def: false,
  category: "Netcode", label: "Real-time sim dt",
  desc: "Integrate with the measured wall-clock delta instead of the fixed tick period.",
}, (v) => { REALTIME_SIM_DT = v; });
let MAX_REALTIME_DT = S.define({
  key: "maxRealtimeDt", env: "EVIO_SIM_MAX_REALTIME_DT", type: "number", def: 0.25, min: 0.01, max: 2, step: 0.01,
  category: "Netcode", label: "Max real-time dt (s)",
  desc: "Clamp on the measured delta, so a stalled process can't integrate one giant step.",
}, (v) => { MAX_REALTIME_DT = v; });
let TICK_LOG_EVERY = S.define({
  key: "tickLogEvery", env: "EVIO_TICK_LOG_EVERY", type: "int", def: 100, min: 1, max: 10000,
  category: "Debug", label: "Tick log interval",
  desc: "Print a tick summary every N ticks.",
}, (v) => { TICK_LOG_EVERY = v; });
let OFFICIAL_BOOTSTRAP_FIELDS = S.define({
  key: "officialBootstrapFields", env: "EVIO_OFFICIAL_BOOTSTRAP_FIELDS", type: "bool", def: false,
  category: "Protocol", label: "Official bootstrap fields",
  desc: "Emit the full official-shaped bootstrap field set rather than the minimal one.",
}, (v) => { OFFICIAL_BOOTSTRAP_FIELDS = v; });
// ── Round / match lifecycle (deathmatch) ────────────────────────────────────────────────
// PROTOCOL, from the bundle:
//   opcode 7   Qpm8qez  = match time remaining, in TICKS. Server-authoritative, but the decoder
//                         AUTO-DECREMENTS it when the opcode is absent
//                         (`7===n[a] ? (Qpm8qez=n[++a]) : Qpm8qez--`), so the HUD clock stays
//                         smooth between updates. We send it every tick, which is always correct.
//   opcode 42  Qdh8um3  = lobbyData.matchDuration. NOT the match length — it is TICKS PER SECOND
//                         (20). The HUD does `Qapcs0u(Qpm8qez / matchDuration)` and Qapcs0u
//                         formats SECONDS as m:ss, so without this the clock reads NaN:NaN.
//   opcode 280 Qbu40n9  = gameMode. 0 = playing; 2 = round over (weapons hidden, "Next round in
//                         X"); 1 = whole GAME over ("Next game in X" / lobby shutdown).
//
// The timer counts DOWN THROUGH ZERO into negative during the intermission: the client renders the
// next-round countdown as `(Qywx2mi(...) + Qpm8qez) / matchDuration`, where Qywx2mi = Qxhitt4 = 400
// ticks (20s). So "round over" is Qpm8qez <= 0 and "start the next round" is Qpm8qez <= -400.
//
// NOTE: the comparator early-outs when `Qpm8qez <= 0` (Qjuel41), so reconciliation naturally STOPS
// during the intermission and resumes when the new round sets the timer positive again. That is the
// official behaviour, not a bug — players free-run for those 20s.
let ROUND_TICKS = S.define({
  key: "roundTicks", env: "EVIO_ROUND_TICKS", type: "int", def: 4800, min: 60, max: 120000,
  category: "Gameplay", label: "Round length (ticks)",
  desc: "Bundle default Q5vkher = 4800 ticks = 4 minutes at 20Hz.",
}, (v) => { ROUND_TICKS = v; });
let INTERMISSION_TICKS = S.define({
  key: "intermissionTicks", env: "EVIO_INTERMISSION_TICKS", type: "int", def: 400, min: 0, max: 12000,
  category: "Gameplay", label: "Intermission (ticks)",
  desc: "Between-round scoreboard time. Bundle Qxhitt4 = 400 ticks = 20s. The client derives its "
      + "'Next round in' countdown from this exact constant, so changing it desyncs that text.",
}, (v) => { INTERMISSION_TICKS = v; });
// gameMode value used at round end. 1 = GAME over: the client shows the end-game scoreboard with
// its leaderboard/earn/performance tabs (`1 === l.gameMode ? show tabs : hide tabs`) and the
// "Next game in X" text. 2 = sub-round over, which shows neither. Deathmatch wants 1.
// ── Click-to-play join ───────────────────────────────────────────────────────────────────────────
// Official ev.io does not drop you straight into the match: you arrive watching the map, listed as a
// spectator, and play only once you click. The client already implements the whole overlay — it shows
// an ENABLED "CLICK TO PLAY" when the local player has Qyxhj60 === 4 and Qpjho15 past the respawn
// threshold (bundle :63938, threshold Q4b9iia.Qk49m3k = 60 ticks). Both are opcodes we already send
// (91 and 168), so the server can produce the state; nothing in the client needs changing.
//
// The part the protocol does NOT carry is the click itself. Qxobfsk (the click handler) only tears
// down the menu and locks the pointer — it sends nothing. So the only signal available to a server is
// that the client STARTS SENDING INPUT once it is in the game. Whether the client is genuinely silent
// beforehand was an empirical question about the real browser — confirmed live (no false-start, the
// overlay holds correctly), so this now defaults ON. (If the client ever sends input while the
// overlay is up on some other build, the hold would end instantly and the overlay would flash past —
// worth rechecking if that's ever reported.) Bots are exempt regardless of this setting — see
// spawnBot's own _holdForPlay override — since nothing could ever send the "click" on their behalf.
let CLICK_TO_PLAY = S.define({
  key: "clickToPlayJoin", env: "EVIO_CLICK_TO_PLAY", type: "bool", def: true,
  category: "Gameplay", label: "Hold new players until they click to play",
  desc: "Join as a spectator watching the map, with the client's own CLICK TO PLAY overlay, and spawn "
      + "on the first input. Bots always start in play regardless of this setting.",
}, (v) => { CLICK_TO_PLAY = v; });
// Which state a held player is put in. 3 shows CLICK TO PLAY + [ SPECTATE ]; 2 shows [ JOIN ] instead
// and is what a player who has explicitly chosen to spectate should be moved to. Both give the
// spectator camera, so this only chooses which button the arrival screen offers.
let PLAYER_STATE_HELD = S.define({
  // 0 — the same value the official server sends. State 0 IS the arrival state: it is the one that
  // runs the flyover camera (Q9w7oks/Qh71cmr). That camera is selected at :53201/:53213 whenever the
  // state is outside {1,4} and the spectator branch does not claim it, i.e. unconditionally for 0 and
  // 5, and for 2/3 only when gamePhase === 3. It is also the state that draws CLICK TO PLAY together
  // with [ SPECTATE ] (:61820), which is exactly the official arrival screen.
  //
  // If the arrival view renders at the origin looking down -Z, that is NOT this setting: the flyover
  // returns position (0,0,0) and identity rotation when its path list is empty (:52261), and every
  // map we have ships an empty list. Moving off 0 to hide that symptom only swaps the flyover for the
  // spectator camera and loses the arrival screen.
  key: "heldPlayerState", env: "EVIO_HELD_STATE", type: "int", def: 0, min: 0, max: 5,
  category: "Gameplay", label: "Player state while waiting to play (opcode 91)",
  desc: "3 = eliminated-but-present: spectator camera, still COUNTS as a player and can score. " +
        "2 = true spectator: spectator camera, counts as nobody and earns nothing. " +
        "0 = pre-join: no spectator camera and the client stops stepping its world. " +
        "5 = removed: cannot win, counts as nobody, no camera. 4 = the dead/respawn screen.",
}, (v) => { PLAYER_STATE_HELD = v; });

// Comfortably past the client's 60-tick threshold, so the overlay is enabled the moment it appears.
const CLICK_TO_PLAY_HOLD_TICKS = 90;

// With the bridge on, the click arrives explicitly and the input heuristic is not consulted at all —
// it only ever guessed. Turn it off to fall back to that guess if the userscript is not installed.
// Both paths are live, and whichever arrives first releases the hold. They are not alternatives: the
// bridge is exact but needs the userscript, and the input heuristic covers a player without it. The
// heuristic only fires on real intent (a key, or a look delta above noise), so it no longer trips on
// the client's idle menu traffic the way "any packet" did.
let LOBBY_INTENT_FALLBACK = S.define({
  key: "lobbyIntentFallback", env: "EVIO_LOBBY_INTENT_FALLBACK", type: "bool", def: true,
  category: "Gameplay", label: "Also release on player input",
  desc: "Enter the match on the first real input (a key or a mouse movement) as well as on the "
      + "userscript's explicit click signal. Off = only the explicit signal counts.",
}, (v) => { LOBBY_INTENT_FALLBACK = v; });

// Diagnostic: log EVERYTHING a held player sends, so "what does the client transmit when you click the
// canvas" is answered by observation instead of by reading the bundle. Text frames verbatim, binary
// frames summarised down to the fields that could carry intent. Off by default — it is one line per
// packet per held player.
let LOG_HELD_INPUT = S.define({
  key: "logHeldInput", env: "EVIO_LOG_HELD_INPUT", type: "bool", def: false,
  category: "Debug", label: "Log everything a held player sends",
  desc: "While a player is on the arrival screen, log every inbound frame. Use it to find what the "
      + "client actually sends when the canvas is clicked.",
}, (v) => { LOG_HELD_INPUT = v; });

let INTERMISSION_FREEZE = S.define({
  key: "intermissionFreeze", env: "EVIO_INTERMISSION_FREEZE", type: "bool", def: true,
  category: "Gameplay", label: "Freeze players during the intermission",
  desc: "Between rounds, hold every player exactly where they are — on the ground or mid-air — the "
      + "way the official game does. Implemented through opcode 168, so the client freezes its own "
      + "prediction on the same rule and there is nothing to reconcile when the round restarts.",
}, (v) => { INTERMISSION_FREEZE = v; });

let ROUND_END_GAMEMODE = S.define({
  key: "roundEndGameMode", env: "EVIO_ROUND_END_GAMEMODE", type: "int", def: 1, min: 0, max: 5,
  category: "Gameplay", label: "Round-end gameMode",
  desc: "1 = end-game scoreboard + 'Next game in X' (deathmatch). 2 = sub-round end, no scoreboard "
      + "tabs. 3 = 'Waiting for N players'.",
}, (v) => { ROUND_END_GAMEMODE = v; });

// Map rotation. Changing the map is a two-part signal: bump Qy1p5xf (opcode 8, the map GENERATION
// id — the loader fires when it differs from the last loaded value, and predictState returns null
// meanwhile) and send the new URL in Qsj9eqq (opcode 15).
//
// !! HARD CONSTRAINT: the SERVER's collision world is Bishop-only (physics_world.js parses
// default_map.evmap). Rotating the CLIENT onto another map while the server still simulates Bishop
// geometry would desync every player completely — they would fall through floors and walk through
// walls. So the default rotation is Bishop alone. Add a map here only after building its collision
// data server-side.
let MAP_ROTATION = S.define({
  key: "mapRotation", env: "EVIO_MAP_ROTATION", type: "string",
  def: "https://ev.io/sites/default/files/maps/HUT8Bishop.evmap",
  category: "Gameplay", label: "Map rotation (comma-separated .evmap URLs)",
  desc: "Cycled at each round start. DEFAULT IS BISHOP ONLY because the server's physics world is "
      + "built from default_map.evmap — adding a map the server cannot simulate desyncs everyone.",
}, (v) => { MAP_ROTATION = v; });

// The map chosen from the dashboard, remembered across restarts. switchMap() writes this on every
// successful switch and the boot path loads it before accepting connections, so a restart (which
// deploy/sync.sh does on every deploy) does not drop the server back onto the bootstrap map.
// Empty = whatever physics_world.js parsed at load, i.e. default_map.evmap.
let STARTUP_MAP = S.define({
  key: "startupMap", env: "EVIO_STARTUP_MAP", type: "string", def: "",
  category: "Gameplay", label: "Map to load at startup",
  desc: "Set automatically whenever you switch maps from the dashboard. Empty = the bootstrap map "
      + "(default_map.evmap). A title or id from the map list.",
}, (v) => { STARTUP_MAP = v; });

let ROUNDS_ENABLED = S.define({
  key: "roundsEnabled", env: "EVIO_ROUNDS", type: "bool", def: true,
  category: "Gameplay", label: "Timed rounds",
  desc: "Off = one endless round (the old behaviour: a permanently large match timer).",
}, (v) => { ROUNDS_ENABLED = v; });

let GAME_PHASE = S.define({
  key: "gamePhase", env: "EVIO_GAME_PHASE", type: "int", def: 0, min: 0, max: 10,
  category: "Protocol", label: "Game phase (opcode 280)",
  desc: "Match phase streamed to clients. 0 = in-progress.",
}, (v) => { GAME_PHASE = v; });

const SECRET_KEYS = new Set([
  "token",
  "adminPass",
  "pass",
  "password",
  "cookie",
  "authorization",
  "auth",
  "jwt",
  "session",
]);

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SECRET_KEYS.has(key) ? "<redacted>" : redact(val);
    }
    return out;
  }
  return value;
}

// Cosmetic URLs (skin, avatar thumb, clan badge) come from the client and are REBROADCAST to every
// other player, so an unbounded one is bandwidth amplification: it arrives once and goes out N times.
//
// Scheme is restricted as well. These are handed to the client as image/model sources, and while a
// `javascript:` or `data:` URL is not currently a script sink there, allowing a peer to choose the
// scheme of a URL that other people's browsers will load is not something to leave open by accident.
// An unusable value is dropped rather than truncated — a half URL is not better than none.
const MAX_URL_LEN = 512;
function _boundedUrl(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > MAX_URL_LEN) return null;
  if (!/^(https?:\/\/|\/)/i.test(s)) return null;   // absolute http(s) or a site-relative path
  return s;
}

function parseJoinMessage(text) {
  if (!text.startsWith(";")) return null;
  const payload = text.slice(1);
  try {
    return JSON.parse(payload);
  } catch (err) {
    return { parseError: err.message, rawPrefix: payload.slice(0, 80) };
  }
}

// The readyState check is not sufficient on its own: a socket can fail between the check and the
// write (the peer resets the connection in that window), and ws also throws on a send to a socket that
// is closing. Callers are spread across the tick loop, the RPC handlers and the chat path, most with
// no guard of their own, so a throw here would surface somewhere unrelated. Returns whether it went.
function safeSend(ws, data, opts) {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(data, opts);
    return true;
  } catch (err) {
    console.error(`[evio-local] send failed: ${(err && err.message) || err}`);
    return false;
  }
}

// weapons.json is bundled directly (esbuild's JSON loader; see the top-of-file import) rather
// than read from disk at runtime — no filesystem exists in a service worker. The Node server's
// own loadCachedJson()/fail-soft fallback is irrelevant here: a bundle that failed to include
// weapons.json would be a build-time error, not a runtime one.

// Per-weapon base damage (field_weapon_data.dmg), keyed by nid. The client's combat damage is
// `dmg * Qalrljx(0.01) * hitMult(1 body / 1.5 head) * lobbyDamageMultiplier` (getDmg, bundle 43425;
// final at 64740). Extracting the real per-weapon dmg makes the server match the client exactly so
// the reconciler doesn't revert. Built once from the served catalogue.
const WEAPON_DMG = (() => {
  const map = {};
  try {
    const items = Array.isArray(cachedWeaponsData.data) ? cachedWeaponsData.data : [];
    for (const it of items) {
      const a = it && it.attributes;
      if (!a || a.drupal_internal__nid == null) continue;
      let wd = null;
      try { wd = JSON.parse(a.field_weapon_data); } catch (_) { wd = null; }
      // dmg is sometimes a string ("10"), sometimes a number (30) in the catalogue — parse both.
      const dmg = wd ? parseFloat(wd.dmg) : NaN;
      if (Number.isFinite(dmg)) map[a.drupal_internal__nid] = dmg;
    }
  } catch (_) {}
  return map;
})();

// Per-weapon fire cooldown (field_weapon_data.cooldown), keyed by nid. The client gates firing
// on `actionTickCounter + 1 >= getCooldown()` where getCooldown = ceil(cooldown / tickDuration)
// and tickDuration = 1 (bundle 32804), so `cooldown` is the spacing between shots IN CLIENT TICKS.
// The buffer-mode server advances exactly one client tick per drained input batch, so the same
// value is the server-tick spacing 1:1. The old hardcoded FIRE_COOLDOWN_TICKS=3 throttled fast
// weapons (Auto Rifle/SMG cooldown=2 → felt sluggish) AND let slow ones fire far too fast
// (Sniper cooldown=26 fired at ~6.6/s). EVIO_FIRE_COOLDOWN_SCALE lets us calibrate feel live
// without re-editing per-weapon values.
let FIRE_COOLDOWN_SCALE = S.define({
  key: "fireCooldownScale", env: "EVIO_FIRE_COOLDOWN_SCALE", type: "number", def: 1.0, min: 0.05, max: 10, step: 0.05,
  category: "Combat", label: "Fire cooldown scale",
  desc: "Multiplies every weapon's catalogue cooldown. <1 = faster fire rate. 1.0 is faithful.",
}, (v) => { FIRE_COOLDOWN_SCALE = v; });
const WEAPON_COOLDOWN = (() => {
  const map = {};
  try {
    const items = Array.isArray(cachedWeaponsData.data) ? cachedWeaponsData.data : [];
    for (const it of items) {
      const a = it && it.attributes;
      if (!a || a.drupal_internal__nid == null) continue;
      let wd = null;
      try { wd = JSON.parse(a.field_weapon_data); } catch (_) { wd = null; }
      const cd = wd ? parseFloat(wd.cooldown) : NaN;
      if (Number.isFinite(cd)) map[a.drupal_internal__nid] = cd;
    }
  } catch (_) {}
  return map;
})();
// Resolve a weapon's per-shot cooldown in server ticks (≥1). Falls back to 3 for unknown weapons.
function weaponCooldownTicks(nid) {
  const base = WEAPON_COOLDOWN[nid];
  const raw = Number.isFinite(base) ? base : 3;
  return Math.max(1, Math.round(raw * FIRE_COOLDOWN_SCALE));
}

// Per-weapon magazine size (field_weapon_data.clipSize) + reload duration (cooldown2, in ticks),
// keyed by nid — the ammo/reload system. Each shot drains the mag; at 0 the gun auto-reloads (refills
// to clipSize) over the reload duration. Reserve ammo is "infinite" (the HUD shows ∞ when reserve>999).
function _weaponDataMap(field, fallback) {
  const map = {};
  try {
    for (const it of (Array.isArray(cachedWeaponsData.data) ? cachedWeaponsData.data : [])) {
      const a = it && it.attributes;
      if (!a || a.drupal_internal__nid == null) continue;
      let wd = null; try { wd = JSON.parse(a.field_weapon_data); } catch (_) {}
      const v = wd ? parseFloat(wd[field]) : NaN;
      if (Number.isFinite(v)) map[a.drupal_internal__nid] = v;
    }
  } catch (_) {}
  return map;
}
// ── Weapon DB for the extracted sim (the client's `hb.weaponDb.getSettings()` equivalent) ──────
// g() looks the EQUIPPED weapon up in `weaponData.dataById[player.Qslw9vf]` and reads real fields
// off it. physics_extracted's makeWeaponData() fallback only contains ONE synthetic entry keyed by
// Mh.Q4b9iia.Qhph812 (343), so for a player holding 4 (Auto Rifle) or 262 (sword) every lookup
// missed and the sim silently took its undefined-fallbacks. The consequential one:
//
//   :3318  S = dataById[weapon];  r.Qgk2mcg = !!(hp>0 && held(6) && S !== undefined && S.zoom !== undefined && …)
//
// With S undefined that forces zooming=FALSE every tick — overwriting the correct value preTickFire
// had just computed from this catalogue, so the ADS move-speed cut (Q6o3kdb × Qaezxaf = 0.65) never
// applied server-side while the client did apply it. `zooming` is also a reconciler-COMPARED field,
// so this diverged on every aiming tick. Two other lookups (:3161 startAmmo, :3430 h.id) dereference
// WITHOUT a null check and would throw outright if those paths ran.
//
// Fix: build the real table from the served catalogue, keyed by every nid, carrying field_weapon_data
// verbatim (numeric strings coerced, as the catalogue mixes "10" and 30) plus the `id` the sim reads.
const WEAPON_DB = (() => {
  const dataById = {};
  try {
    for (const it of (Array.isArray(cachedWeaponsData.data) ? cachedWeaponsData.data : [])) {
      const a = it && it.attributes;
      if (!a || a.drupal_internal__nid == null) continue;
      let wd = null; try { wd = JSON.parse(a.field_weapon_data); } catch (_) { wd = null; }
      if (!wd) continue;
      const entry = { id: a.drupal_internal__nid };
      for (const [k, v] of Object.entries(wd)) {
        // The catalogue stores some numbers as strings ("10", "-.007"); the sim type-checks with
        // `typeof x === 'number'`, so coerce anything numeric to a real number.
        if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) entry[k] = Number(v);
        else entry[k] = v;
      }
      dataById[a.drupal_internal__nid] = entry;
    }
  } catch (_) {}
  return { dataById };
})();

const WEAPON_CLIP   = _weaponDataMap("clipSize");
const WEAPON_RELOAD = _weaponDataMap("cooldown2");
// Which weapons can ADS (field_weapon_data.zoom present). The client sets Qgk2mcg (zooming) only for
// weapons whose `zoom` key is defined; while zooming, move speed is cut to Q6o3kdb*Qaezxaf(0.65).
const WEAPON_ZOOM   = _weaponDataMap("zoom");
function weaponHasZoom(nid) { return Number.isFinite(WEAPON_ZOOM[nid]); }
// Magazine size and reload time are PER PLAYER, not per weapon: two of the loadout abilities change
// them and the client applies both to its own prediction.
//
//   Extra Clip Size (ability 6) -> Qe2qk8v : the client's magazine is ceil(clipSize * Qe2qk8v)  :34635
//   Quick Load      (ability 4) -> Qvven1v : the client's reload is floor(cooldown2 - Qvven1v)  :43982
//
// Reading only the weapon catalogue meant a player with either ability had a different magazine or
// reload timer than their own screen showed — they would fire rounds we did not think they had, or be
// held in a reload the client had already finished. `playerState` is optional so a call with no player
// (a fresh state, before any loadout is applied) still gets the base value.
function _abilityStats(playerState) {
  return (playerState && playerState._ps && playerState._ps.Qz8l93a) || null;
}
function weaponClip(nid, playerState) {
  const c = WEAPON_CLIP[nid];
  const base = Number.isFinite(c) && c > 0 ? c : 30;
  const st = _abilityStats(playerState);
  const mult = st && Number.isFinite(st.Qe2qk8v) && st.Qe2qk8v > 0 ? st.Qe2qk8v : 1;
  let clip = Math.ceil(base * mult);      // ceil, matching the client exactly
  // A picked-up special weapon has NO reserve refill (field_weapon_data startAmmo:0 — you carry
  // only what the pad(s) granted, pickUpSize per pickup, stacking on repeats — see
  // _grantPickupWeapon). playerState.pickupAmmo[nid] tracks the TOTAL rounds left for THAT nid —
  // chambered included, not a separate "reserve beyond the clip" figure — and only firing
  // decrements it (preTickFire); reloading just redistributes between chamber and reserve, so
  // capping the reload target at it HERE is exactly right without any reload site needing to also
  // debit it. A reload started with less than a full clip left simply loads a partial magazine, and
  // one started at exactly 0 loads nothing (weaponClip returns 0), which is what lets preTickFire's
  // spent-slot check detect "nothing left at all for this nid" and clear just that slot.
  if (playerState && playerState.pickupAmmo
      && Object.prototype.hasOwnProperty.call(playerState.pickupAmmo, nid)) {
    clip = Math.min(clip, Math.max(0, playerState.pickupAmmo[nid]));
  }
  return clip;
}
// Re-size the magazine after a loadout has been applied. Every loadout path sets gunAmmo BEFORE it
// assigns the computed stats, so the capacity was always derived from a multiplier of 1 — Extra Clip
// Size had no effect on the life you joined with even once the stat existed. Call this after the
// Object.assign onto Qz8l93a, never before.
function refreshMagazineCapacity(playerState) {
  if (!playerState) return;
  const nid = playerState._ammoGunId;
  if (!Number.isFinite(nid) || nid === SWORD_WEAPON_ID) return;   // the sword has no magazine
  playerState.gunAmmo = weaponClip(nid, playerState);
  playerState.reloadTicks = 0;
}

function weaponReloadTicks(nid, playerState) {
  const r = WEAPON_RELOAD[nid];
  const base = Number.isFinite(r) && r > 0 ? Math.round(r) : 60;
  const st = _abilityStats(playerState);
  const bonus = st && Number.isFinite(st.Qvven1v) ? st.Qvven1v : 0;
  return Math.max(1, Math.floor(base - bonus));
}

// ── Fire-mode dispatch (hitscan vs multi-pellet vs projectile) ──────────────────────────────────
// The client's own fire-resolution (bundle Q1hatp1, :43998-44022) decides per-weapon, not per-shot:
// `void 0 !== field_weapon_data.projectileSpeed && projectileSpeed > 0` -> spawn a physical
// projectile entity; otherwise push N hitscan rays, where N = field_weapon_data.countProjectiles
// (default 1). We were treating every non-melee weapon as a single hitscan ray — correct for AR/
// SMG/Sniper/etc, silently wrong for Shotgun (12 pellets) and Rocket/Grenade Launcher (a travelling
// splash projectile, not an instant ray).
const WEAPON_PROJECTILE_SPEED = _weaponDataMap("projectileSpeed");
const WEAPON_PELLET_COUNT     = _weaponDataMap("countProjectiles");
const WEAPON_SPRAY_SPREAD     = _weaponDataMap("sprayPatternSpread");
const WEAPON_SPRAY_SPREAD_ADS = _weaponDataMap("sprayPatternSpreadADS");
function isProjectileWeapon(nid) {
  const s = WEAPON_PROJECTILE_SPEED[nid];
  return Number.isFinite(s) && s > 0;
}
function weaponPelletCount(nid) {
  const c = WEAPON_PELLET_COUNT[nid];
  return Number.isFinite(c) && c > 1 ? Math.round(c) : 1;
}

// ── Weapon pickups — map spawn points that grant a special weapon on proximity ──────────────────
// Official maps carry fixed pickup LOCATIONS (evmap flags&32, see physics_world.js's
// readPickupPointRich/readPickupPointSimple — this was previously mis-parsed and discarded as a
// "lights" array). Which of the special weapons appears at a given point, and when, is decided
// here at runtime: the map only authors WHERE, not WHAT — every catalogue entry has startAmmo:0 and
// a finite pickUpSize, confirming these are pickup-only weapons with no starting reserve. Desert
// Eagle (281, startAmmo:0, pickUpSize:4 — same shape as the rest) was missing from this list
// entirely, so it could never spawn as a ground pickup even though it's a real pickup-only weapon.
const PICKUP_WEAPON_IDS = [6, 7, 8, 281, 282, 283];   // Sniper, Shotgun, Rocket Launcher, Desert Eagle, SMG, Grenade Launcher
const WEAPON_PICKUP_SIZE = _weaponDataMap("pickUpSize");   // total rounds granted per pickup

let PICKUP_ENABLED = S.define({
  key: "weaponPickupsEnabled", env: "EVIO_WEAPON_PICKUPS", type: "bool", def: true,
  category: "Gameplay", label: "Weapon pickups enabled",
  desc: "Special weapon spawn points (Sniper Rifle, Shotgun, Rocket Launcher, SMG, Grenade Launcher) "
      + "on maps that author them. A picked-up weapon is used until its ammo runs out or the player "
      + "dies, then it's cleared — it never becomes a permanent part of their loadout.",
}, (v) => { PICKUP_ENABLED = v; });
let PICKUP_BOT_ENABLED = S.define({
  key: "botWeaponPickupsEnabled", env: "EVIO_BOT_WEAPON_PICKUPS", type: "bool", def: true,
  category: "Bots", label: "Bots can pick up special weapons",
  desc: "OFF stops BOTS from taking Sniper/Shotgun/Rocket/SMG/Grenade Launcher pickups — real "
      + "players are completely unaffected either way. A point a bot walks past while this is off "
      + "stays available for a real player to grab.",
}, (v) => { PICKUP_BOT_ENABLED = v; });
let PICKUP_RESPAWN_TICKS = S.define({
  key: "weaponPickupRespawnTicks", env: "EVIO_WEAPON_PICKUP_RESPAWN", type: "int", def: 400,
  min: 20, max: 6000,
  category: "Gameplay", label: "Pickup respawn cooldown (ticks)",
  desc: "Ticks a pickup point stays empty after being taken before a (re-rolled) weapon appears "
      + "there again. 400 = 20s at 20Hz.",
}, (v) => { PICKUP_RESPAWN_TICKS = v; });
let PICKUP_RADIUS = S.define({
  key: "weaponPickupRadius", env: "EVIO_WEAPON_PICKUP_RADIUS", type: "number", def: 1.8,
  min: 0.5, max: 6, step: 0.1,
  category: "Gameplay", label: "Pickup trigger radius (u)",
  desc: "Distance within which a player standing near an available pickup point picks it up.",
}, (v) => { PICKUP_RADIUS = v; });

function _randomPickupWeapon() {
  return PICKUP_WEAPON_IDS[Math.floor(Math.random() * PICKUP_WEAPON_IDS.length)];
}
// Parallel to bpw.pickupPoints: { weaponTypeId, availableAtTick }. weaponTypeId is ALWAYS a real
// nid, pre-rolled for the NEXT grant — see buildWeaponPickupBlock's header comment for why a point
// can never go through an "no weapon at all" state on the wire. Rebuilt whenever the point count no
// longer matches the active map (first boot, or a map switch changed the list).
let _pickupState = [];
function _resetPickupState() {
  _pickupState = (bpw.pickupPoints || []).map(() => ({ weaponTypeId: _randomPickupWeapon(), availableAtTick: 0 }));
}

// Detect weaponList removals and age the weapon-slot re-announce window (opcode 135's delete,
// 135,-1,nid) — called ONCE PER TICK from the post-broadcast sweep, unconditionally, for every
// session with a playerState.
//
// MUST run there and not inside appendPlayerTickBody (which builds the actual 135 blocks): that
// function runs once per RECIPIENT and is skipped ENTIRELY for a congested client — the
// backpressure check in the broadcast loop `continue`s before ever calling it. A removal detected
// only inside appendPlayerTickBody could have its ONE opening tick be exactly the tick that
// recipient's body never got built, so the re-announce window would never open and the stale icon
// would linger forever — this was the actual, confirmed cause of "special weapon slot doesn't clear
// after dying and respawning": server-side state (pickupAmmo/weaponList) was already provably
// correct at the moment of respawn, but the ONE packet announcing it didn't reliably land and
// nothing was queued to repeat it. Mirrors how activeEntities' removals are detected in the
// (also unconditional) grenade sim step rather than in the broadcast loop, for the identical reason.
function _advanceWeaponSlotTracking(p) {
  const curWeaponIds = Array.isArray(p.weaponList) ? p.weaponList.filter((w) => w !== SWORD_WEAPON_ID) : [];
  const prevWeaponIds = Array.isArray(p._prevEmitWeaponIds) ? p._prevEmitWeaponIds : [];
  if (!p._weaponSlotRemovalRepeat) p._weaponSlotRemovalRepeat = new Map();
  for (const oldId of prevWeaponIds) {
    if (!curWeaponIds.includes(oldId)) p._weaponSlotRemovalRepeat.set(oldId, ENTITY_REMOVAL_REPEAT);
  }
  if (p._weaponSlotRemovalRepeat.size) {
    for (const [id, left] of p._weaponSlotRemovalRepeat) {
      if (left <= 1) p._weaponSlotRemovalRepeat.delete(id);
      else p._weaponSlotRemovalRepeat.set(id, left - 1);
    }
  }
  p._prevEmitWeaponIds = curWeaponIds;
}

// How many ticks equippedWeaponId/backupWeaponId (opcode 127/128) re-announce after a switch —
// they're delta-emitted (absent means "unchanged"), so a client that misses every packet in this
// window keeps rendering the PREVIOUS weapon on that player indefinitely (until their next switch,
// if any) — reported live as "my peer is holding a sword in my view but he says he's holding a
// gun". The countdown advances once per REAL tick regardless of whether any given recipient's own
// connection is having a rough moment right then (the same coarse-grained, per-subject-not-per-
// recipient reliability model activeEntities' removal stream and the weaponSlots fix both use, not
// a true per-recipient ack), so a longer window directly trades a little redundant bandwidth for a
// much lower chance any one recipient's bad half-second causes a permanent desync. 6 ticks (300ms)
// was tight enough that an ordinary short stall could eat the whole window.
let WEAPON_SEND_REPEAT_TICKS = S.define({
  key: "weaponSendRepeatTicks", env: "EVIO_WEAPON_SEND_REPEAT", type: "int", def: 20, min: 1, max: 200,
  category: "Netcode", label: "Weapon-change re-announce (ticks)",
  desc: "Ticks equippedWeaponId (opcode 127, the actual weapon model peers see) keeps re-sending "
      + "after a switch. It's delta-emitted — a client that misses every packet in this window "
      + "keeps rendering the OLD weapon on that player until their next switch. Raise this if peers "
      + "sometimes appear to be holding the wrong weapon; the cost is a few extra bytes per switch, "
      + "not per tick. 20 = 1s at 20Hz.",
}, (v) => { WEAPON_SEND_REPEAT_TICKS = v; });

// Re-equip the primary weapon after a pickup slot that was in hand gets stripped (ammo spent, or
// every slot cleared on death) — shared by both clear paths below.
function _revertToPrimaryWeapon(p) {
  const primary = Array.isArray(p.weaponList) ? p.weaponList[0] : SWORD_WEAPON_ID;
  p.equippedWeaponId = Number.isFinite(primary) ? primary : SWORD_WEAPON_ID;
  p._ammoGunId = p.equippedWeaponId;
  p.gunAmmo = weaponClip(p.equippedWeaponId, p);
  p.reloadTicks = 0;
  p.weaponSendCount = WEAPON_SEND_REPEAT_TICKS;   // opcode 127 is delta-emitted; force the re-send (matches every other switch site)
  startWeaponSwitch(p);
}

// Strip ONE picked-up weapon slot — its ammo pool hit zero. Any OTHER special weapons the player
// is still carrying are untouched; only this one nid leaves weaponList/pickupAmmo.
function _clearPickupSlot(p, nid) {
  if (!p || !p.pickupAmmo || !Object.prototype.hasOwnProperty.call(p.pickupAmmo, nid)) return;
  const wasEquipped = p.equippedWeaponId === nid;
  delete p.pickupAmmo[nid];
  p.weaponList = (Array.isArray(p.weaponList) ? p.weaponList : []).filter((w) => w !== nid);
  if (wasEquipped) _revertToPrimaryWeapon(p);
}

// Strip EVERY picked-up weapon slot at once — used on respawn/death (official: a pickup NEVER
// survives death, and that applies to every slot a player was carrying, not just whichever one
// happened to be equipped at the moment they died).
function _clearAllPickupWeapons(p) {
  if (!p) return;
  const carried = p.pickupAmmo ? Object.keys(p.pickupAmmo).map(Number) : [];
  if (carried.length === 0) { p.pickupAmmo = {}; return; }
  const wasEquipped = carried.includes(p.equippedWeaponId);
  p.weaponList = (Array.isArray(p.weaponList) ? p.weaponList : []).filter((w) => !carried.includes(w));
  p.pickupAmmo = {};
  if (wasEquipped) _revertToPrimaryWeapon(p);
}

// Grant `nid` to a player standing on an available pickup point. Multiple DIFFERENT special
// weapons can be carried at once — each distinct nid is its own weapon-list slot with its own
// ammo pool (playerState.pickupAmmo, nid -> rounds remaining, same "total including whatever's
// chambered" accounting weaponClip already expects). Picking up a type already carried ADDS to
// that pool (stacks) rather than replacing it, and does NOT re-equip — silently topping up a
// reserve you already have shouldn't yank whatever's currently in hand out of it. Picking up a
// genuinely NEW type appends a new slot and DOES auto-equip it (walking onto a weapon and
// immediately holding it is the standard FPS feel), sizing the first magazine via the same
// weaponClip() every other reload path uses, so it's naturally capped at the fresh pool.
// Cycle order = ASCENDING WEAPON NID, full stop — confirmed against the real, official HUD's
// displayed loadout after picking up everything: "1, 3, 2, 4, Z, 7, 6, 8". Two earlier guesses at
// this were both wrong: first, inserting every pickup immediately before the sword (only correct
// for exactly one pickup); then a hand-authored table matching the CLIENT's default keybind-to-
// weapon map (49:12,50:13,...,56:36 — i.e. key 2=Shotgun, key 3=Sniper, ...), which assumed the
// KEY a weapon is bound to also dictates its position in the list. It does not: the displayed
// order 1,3,2,4,Z,7,6,8 has Sniper (nid 6, key 3) BEFORE Shotgun (nid 7, key 2), and Desert Eagle
// (nid 281, key 7) BEFORE SMG (nid 282, key 6) — the key labels come out scrambled precisely
// because the underlying sort is by NID, not by key number. Sorted by nid, 6 < 7 < 8 and
// 281 < 282 < 283 — matching exactly. The sword's own nid (262) sits naturally between the two
// groups this way too (8 < 262 < 281), with no special-casing needed for it at all — it is simply
// another member of the same sort, not a fixed anchor point.

function _grantPickupWeapon(p, nid, isBot) {
  if (!p || !Number.isFinite(nid)) return;
  if (!p.pickupAmmo) p.pickupAmmo = {};
  const size = WEAPON_PICKUP_SIZE[nid];
  const grant = Number.isFinite(size) && size > 0 ? size : 1;
  const alreadyCarried = Object.prototype.hasOwnProperty.call(p.pickupAmmo, nid);
  p.pickupAmmo[nid] = (alreadyCarried ? p.pickupAmmo[nid] : 0) + grant;
  if (!alreadyCarried) {
    if (!Array.isArray(p.weaponList)) p.weaponList = [];
    // Insert in ascending-nid order (see the comment above) — index 0 (the primary) is never
    // touched, so scanning starts at index 1 regardless of the primary's own nid.
    let insertAt = p.weaponList.length;
    for (let i = 1; i < p.weaponList.length; i++) {
      if (p.weaponList[i] > nid) { insertAt = i; break; }
    }
    p.weaponList.splice(insertAt, 0, nid);
    // Deliberately does NOT auto-equip a REAL player — only adds it to weaponList.
    // appendPlayerTickBody's weaponSlots (135) block streams every CARRIED weapon every tick
    // regardless of which one is equipped, so the new weapon's icon/ammo shows up in the HUD
    // immediately either way; this just stops it from yanking the gun out of the player's hands
    // mid-fight. They keep whatever they're currently holding and switch to the pickup manually
    // (cycle or direct-select, processWeaponSwitch) whenever they actually want it. No ammo init
    // is needed here either — the per-tick equippedWeaponId/_ammoGunId sync a little further down
    // (search "Keep the magazine pointed at the equipped gun") lazily sets up gunAmmo from
    // pickupAmmo the moment the player actually switches to it, exactly like switching to any
    // other carried gun.
    //
    // Bots are the one exception: driveBotFrame never presses a weapon-switch action (no cycle,
    // no direct-select — bots just fire whatever's currently equipped), so without SOME equip
    // path they would grab every pickup on the map and never fire a single one, making
    // botWeaponPickupsEnabled a dead setting. Keep the original immediate-equip for them only.
    if (isBot) {
      p.backupWeaponId = p.equippedWeaponId;
      p.equippedWeaponId = nid;
      p._ammoGunId = nid;
      p.gunAmmo = weaponClip(nid, p);
      p.reloadTicks = 0;
      p.weaponSendCount = WEAPON_SEND_REPEAT_TICKS;
      startWeaponSwitch(p);
    }
  }
  console.log(`[evio-local] weapon pickup: ${p.id || p._ownerSid} grabbed nid=${nid} `
    + `(+${grant}, ${alreadyCarried ? "stacked to" : "new slot,"} ${p.pickupAmmo[nid]} rounds total)`);
}

// Per-tick: let empty pickup points respawn once their cooldown elapses, then grant an available
// weapon to any alive player standing within range. Cheap even on the biggest observed map (37
// points) against dozens of players — a handful of distance checks, far below the grenade/vision
// scan cost already paid every tick — so this is unthrottled, unlike BOT_VISION_SCAN_INTERVAL.
function processWeaponPickups(sessions, tick) {
  if (!PICKUP_ENABLED) return;
  const pts = bpw.pickupPoints || [];
  if (pts.length !== _pickupState.length) _resetPickupState();   // first boot, or the map changed
  if (!pts.length) return;
  for (let i = 0; i < pts.length; i++) {
    const st = _pickupState[i];
    if (tick < st.availableAtTick) continue;   // on cooldown — see buildWeaponPickupBlock for the hide side of this
    const pt = pts[i];
    for (const s of sessions.values()) {
      if (!s || !s.accepted) continue;
      if (s.isBot && !PICKUP_BOT_ENABLED) continue;
      // Sword bots are melee-only by design (own combat frame, own count/level settings — see
      // _swordCombatFrame / isSwordBot throughout) and never switch weapons (driveBotFrame never
      // presses a switch action for them either), so a gun pickup would just sit in their
      // weaponList forever doing nothing. Skip them entirely rather than hand them dead weight.
      if (s.isSwordBot) continue;
      const p = s.playerState;
      if (!p || !p.position || p._holdForPlay) continue;
      if (p.deathStateTimer > 0 || p.healthPoints <= 0) continue;
      const dist = Math.hypot(p.position.x - pt.x, (p.position.y + 1) - pt.y, p.position.z - pt.z);
      if (dist > PICKUP_RADIUS) continue;
      _grantPickupWeapon(p, st.weaponTypeId, !!s.isBot);
      st.weaponTypeId = _randomPickupWeapon();   // pre-roll the NEXT weapon this point will offer
      st.availableAtTick = tick + PICKUP_RESPAWN_TICKS;
      break;   // point is now empty; no one else can take it this tick
    }
  }
}

// Comfortably beyond any tick count a server or client will ever reach (999999999 ticks ≈ 1585
// years at 20Hz) — used as the "hide until tick" sentinel below.
const PICKUP_HIDE_SENTINEL = 999999999;

// ── Weapon pickup protocol stream (worldState.Q6cohc3/pickupMap, opcodes 270-278) ───────────────
// The client already knows every pickup point's POSITION from its own evmap parse (bundle
// :48394 renders at `Qwhyo8k.Q6cohc3[a].Qdsukt4`, the STATIC per-map list) — we stream only the
// live STATE, keyed by the point's INDEX, which is why bpw.pickupPoints must never be reordered/
// filtered: index parity with the client's own parse of the identical evmap array is what makes
// `i` below line up with the client's `a`.
//
// CORRECTED from an earlier version of this stream that deleted the index entirely while a point
// was on cooldown (278,-1,i), mirroring the activeEntities (grenade) idiom. That is wrong here:
// read against the actual renderer (bundle :48363-48399), a DELETED index just makes the loop
// `return 'continue'` for it — nothing ever calls the scene-remove for whatever mesh was already
// built, so the model stays floating forever even after being picked up. The renderer's ONLY
// removal code path is the OTHER branch, gated on `o.Qwqshlj > e.Q1o118x` ("hide until tick" is in
// the future) — which explicitly does `Qm6b0u4.remove(...)`. So an index must be announced
// ONCE and then live forever (until a map switch tears down the client's whole world state
// anyway); availability toggles by varying opcode 273 (Qwqshlj) between 0 (already in the past —
// visible) and PICKUP_HIDE_SENTINEL (always in the future — hidden), never by removing the entry.
function buildWeaponPickupBlock() {
  const pts = bpw.pickupPoints || [];
  if (pts.length !== _pickupState.length) _resetPickupState();
  const now = _live.globalTick || 0;
  const block = [];
  for (let i = 0; i < _pickupState.length; i++) {
    const st = _pickupState[i];
    const hidden = now < st.availableAtTick;
    // 275 (Qt34en0) MUST be sent explicitly as null — the renderer's branch selection is
    // `if (null !== o.Qt34en0)`, and a field we never send at all decodes as `undefined`, and
    // `null !== undefined` is TRUE in JS. That silently sent every pickup down the "custom CMS
    // model" branch (bundle :48374), which tries to load a mesh from `cmsBaseURL + undefined` — an
    // async loader that never resolves and never throws, so the model just never appeared, with no
    // error anywhere to point at. Sending 275=null explicitly is what makes it fall through to the
    // correct branch (48381-48385), which looks the model up by weaponTypeId (271) from the
    // client's own weapon catalogue — the same one every carried gun already resolves its model
    // from, so nothing else is needed for it to render correctly.
    // 274 (Qwhlcdr) selects the glow sprite's style from the renderer's own hardcoded palette
    // (7 entries, indexed by this field) — a separate billboard Sprite added to the scene at the
    // pickup point, NOT part of the weapon model itself. Never emitting it decodes on the client as
    // `undefined`, and the renderer's lookup (`i[o.Qwhlcdr]`) then falls through to its own default
    // fallback style, which has opacity 0 — the sprite is still created and added to the scene, just
    // fully transparent, which is exactly "spawns with no glow at all". Index 0 is that same
    // palette's OTHER 'default'-labelled entry, at the renderer's normal 0.7 opacity — visible,
    // without claiming a specific weapon rarity we have no source data for (the weapon catalogue
    // carries no rarity field at all).
    block.push(278, i, 270, i, 271, st.weaponTypeId, 273, hidden ? PICKUP_HIDE_SENTINEL : 0, 274, 0, 275, null);
  }
  return block;
}

// Splice the weapon-pickup block in just before opcode 280, same slot activeEntities uses (order
// between the two doesn't matter to the decoder — both are simple keyed maps scanned independently).
function flushWeaponPickups(body) {
  const block = buildWeaponPickupBlock();
  if (block.length === 0) return;
  const insertAt = body.lastIndexOf(280);
  if (insertAt >= 0) body.splice(insertAt, 0, ...block);
  else body.push(...block);
}

// Per-weapon recoil inputs (field_weapon_data.knockback / knockbackMax), keyed by nid. These feed
// the client's recoil curve, which kicks the camera PITCH — a field the reconciler compares. The
// server must reproduce it or the prediction diverges on every shot (visible as a per-shot stutter).
const WEAPON_KNOCKBACK = (() => {
  const map = {};
  try {
    for (const it of (Array.isArray(cachedWeaponsData.data) ? cachedWeaponsData.data : [])) {
      const a = it && it.attributes;
      if (!a || a.drupal_internal__nid == null) continue;
      let wd = null;
      try { wd = JSON.parse(a.field_weapon_data); } catch (_) { wd = null; }
      if (!wd) continue;
      const kb = parseFloat(wd.knockback), kbMax = parseFloat(wd.knockbackMax);
      map[a.drupal_internal__nid] = {
        knockback: Number.isFinite(kb) ? kb : 1,
        knockbackMax: Number.isFinite(kbMax) ? kbMax : 2,
      };
    }
  } catch (_) {}
  return map;
})();
// Server-side recoil reproduction toggle (default ON). The recoil curve is already ported in the
// extracted physics (l() at physics_extracted.js:3392, applied every tick); it only fires when the
// shot tick sets the action-tick counter (Qezh4wz) to 0 and arms the magnitudes (Qmgh2i6). The
// server never did either — so recoil stayed 0 server-side while the client kicked, diverging
// pitch/pitchOffset every shot. EVIO_SERVER_RECOIL=0 disables it for A/B testing.
let SERVER_RECOIL = S.define({
  key: "serverRecoil", env: "EVIO_SERVER_RECOIL", type: "bool", def: true,
  category: "Combat", label: "Server-side recoil",
  desc: "Reproduce the client's recoil pitch kick server-side. Turning this OFF makes the "
      + "server emit pitchOffset 0 while the client kicks — it CREATES divergence, it does not "
      + "remove it. For A/B testing only.",
}, (v) => { SERVER_RECOIL = v; });
// Server-side ADS/zoom state (default ON). The client sets Qgk2mcg in Qwhlcfo (which our _g path
// skips), so the server never applied the 0.65× aim move-speed cut → 35% speed divergence every tick
// while aiming+moving → big reconcile (the "aiming while strafing" stutter). EVIO_SERVER_ZOOM=0 off.
let SERVER_ZOOM = S.define({
  key: "serverZoom", env: "EVIO_SERVER_ZOOM", type: "bool", def: true,
  category: "Combat", label: "Server-side ADS/zoom",
  desc: "Track the zooming flag server-side. `zooming` is a reconciler-compared field, so this "
      + "should stay on for any weapon that can aim down sights.",
}, (v) => { SERVER_ZOOM = v; });

// Arm the recoil magnitudes for a shot — the exact Qmgh2i6 logic (physics_extracted.js:3380),
// run on the extracted physics state (ps) the moment its action-tick counter hits 0.
//   Qezh4wz = actionTickCounter, Qm2pxgr = recoil carry, Qq1azjr/Qq1azd5 = curve endpoints,
//   Qgk2mcg = zooming.
function armRecoil(ps, nid) {
  if (!ps || ps.Qezh4wz !== 0) return;
  const kb = WEAPON_KNOCKBACK[nid] || { knockback: 1, knockbackMax: 2 };
  ps.Qq1azjr = 20 * (ps.Qm2pxgr || 0);
  ps.Qq1azd5 = ps.Qq1azjr + 0.5 * (kb.knockbackMax - ps.Qq1azjr) * kb.knockback * (ps.Qgk2mcg ? 0.6 : 1);
  if (ps.Qq1azjr > ps.Qq1azd5) ps.Qq1azjr = ps.Qq1azd5;
}

// Which weapons are MELEE (field_weapon_data.melee), keyed by nid. Melee uses a short swept-sphere
// (phys.meleeHit) instead of a hitscan ray, deals no headshot, and spawns no tracer.
const WEAPON_MELEE = (() => {
  const set = {};
  try {
    for (const it of (Array.isArray(cachedWeaponsData.data) ? cachedWeaponsData.data : [])) {
      const a = it && it.attributes;
      if (!a || a.drupal_internal__nid == null) continue;
      let wd = null;
      try { wd = JSON.parse(a.field_weapon_data); } catch (_) { wd = null; }
      if (wd && wd.melee === true) set[a.drupal_internal__nid] = true;
    }
  } catch (_) {}
  return set;
})();

// ── SWORD-ONLY MODE (EVIO_SWORD_ONLY=1) ─────────────────────────────────────────────────
// Melee-only lobby: every player carries the sword (262) and nothing else, whatever their real
// account loadout says. Why this exists: the two remaining reconciler work-arounds (userscript
// 6b7 pitch/pitchOffset skip + 6b8 recoil/ammo preserve) both hang off the GUN path —
//   • ammo/reload divergence is gone outright: the sword's clipSize is 999999 and the client's
//     reload gate (`ammoInMag < 9999`, bundle :43981) can therefore never fire, so there is no
//     magazine state left to preserve through a reconcile reset.
//   • zooming (a compared field) is gone: no melee weapon has field_weapon_data.zoom.
//   • recoil still exists — the sword has knockback 2 and the client's arm (Qmgh2i6, :34614) is
//     NOT gated on melee — but the sword's cooldown is 16 ticks while the recoil curve dies at
//     actionTickCounter > 9 (l(), :34626). The kick fully settles between swings, so it can never
//     accumulate the way sustained auto-rifle fire does. We keep reproducing it server-side
//     (armRecoil) so it stays in parity rather than becoming a new divergence.
// Everything else (grenades/abilities) is untouched — set EVIO_SWORD_ONLY=1 and restart.
// Enabled by EVIO_SWORD_ONLY=1 or the `--sword-only` CLI flag (the flag exists because setting
// an env var inline differs between cmd.exe, PowerShell and sh — `npm run start:sword` works
// the same everywhere).
const SWORD_WEAPON_ID = 262;
let SWORD_ONLY = S.define({
  key: "swordOnly", env: "EVIO_SWORD_ONLY", type: "bool",
  def: process.argv.includes("--sword-only"),
  category: "Gameplay", label: "Sword-only mode",
  desc: "Every player carries only the sword (262), whatever their account loadout says. "
      + "Applies to players who join AFTER the change; already-connected players keep their "
      + "current weapon until they rejoin.",
}, (v) => { SWORD_ONLY = v; });
// Force any loadout-supplied primary to the sword in sword-only mode. Applied at every point a
// weapon nid enters the server: the join handshake, the in-game loadout RPC ('6'), and the
// userscript's live '#EVL#' loadout bridge.
function resolveLoadoutWeapon(nid) {
  if (SWORD_ONLY) return SWORD_WEAPON_ID;
  return nid;
}
if (SWORD_ONLY) console.log("[evio-local] SWORD-ONLY mode: all players carry only the sword (262)");

// Extension-host-only knob — the Node server runs on a real network and never needed this. See
// the code "8" case below for why it only delays the ping measurement itself, nothing else.
let PING_FLOOR_MS = S.define({
  key: "pingFloorMs", env: "EVIO_PING_FLOOR_MS", type: "int", def: 40, min: 0, max: 500,
  category: "Extension host", label: "Minimum displayed ping (ms)",
  desc: "Floors the client's displayed ping by delaying only the latency-RPC reply — gameplay "
      + "packets (tick state, combat) are never delayed. 0 disables (shows the true near-0ms "
      + "round trip of the Port relay).",
}, (v) => { PING_FLOOR_MS = v; });

function handleBacktickRpc(ws, text) {
  const secondTick = text.indexOf("`", 1);
  if (secondTick < 0) return false;
  const code = text.slice(1, secondTick);
  const rawArg = text.slice(secondTick + 1);
  let arg = null;
  try {
    arg = JSON.parse(rawArg || "0");
  } catch (_) {
    arg = rawArg;
  }

  let response;
  switch (code) {
    case "2":
      // Weapon JSONAPI payload. The loading path calls Q7s8q9s() and then
      // hb.Qhkjwni.Ql2t0ys(response), which expects the public weapons JSON shape.
      response = cachedWeaponsData;
      break;
    case "3":
      // Render/map asset scalar assigned to rb.Qb6vu87.Qqqaei8. Default 1 is safe.
      response = 1;
      break;
    case "18":
      // Loadout/weapons bootstrap used immediately after join. The client reads
      // Qzfaeyw with hb.Qhkjwni.Ql2t0ys(...) and optionally Ql1n0js overrides.
      response = { Qzfaeyw: cachedWeaponsData, Ql1n0js: null };
      break;
    case "14":
      // Twitch/promos HTML. Empty hidden HTML avoids a pending promise without
      // affecting core gameplay protocol.
      response = "none";
      break;
    case "8": {
      // Latency ping. Bundle Qh4roex() records Date.now(), awaits Qp7ipew('8'),
      // then returns elapsed time; the response value itself is not used.
      // This can be called frequently, especially with multiple clients, so do
      // not log it per request.
      //
      // PING_FLOOR_MS: this RPC's round-trip time IS the client's displayed ping — there is no
      // separate number to fake. On the extension host (same machine, Port relay, no real
      // network), the real round trip is near-0ms, which reads as broken/suspicious rather than
      // "fast." Delaying only THIS response — not tick/state/combat packets, which stay at true
      // zero added latency — gives a realistic-looking floor without touching gameplay
      // responsiveness at all.
      if (PING_FLOOR_MS > 0) {
        setTimeout(() => safeSend(ws, "`" + JSON.stringify(1)), PING_FLOOR_MS);
        return true;
      }
      response = 1;
      break;
    }
    case "6":
    case "7":
      // Loadout RPCs. handleLoadoutRpc has already applied the side effects; this only has to
      // ACK so the client's serial event queue advances (see the dispatch comment).
      response = 1;
      break;
    default:
      // Keep unknown request promises from hanging, but log the code so the
      // protocol map can be extended with concrete evidence.
      response = 0;
      break;
  }

  const summary = typeof response === "object" ? `object keys=${Object.keys(response).slice(0, 8).join(",")}` : JSON.stringify(response);
  if (code !== "8") {
    console.log(`[evio-local] rpc code=${code} arg=${JSON.stringify(arg).slice(0, 120)} -> ${summary}`);
  }
  safeSend(ws, "`" + JSON.stringify(response));
  return true;
}

// ── In-game chat (event code 4) + emotes ─────────────────────────────────────────────────
// PROTOCOL (all over the GAME socket — the social service at wss://social.ev.io is dead, so this
// is the only working chat path):
//   client -> server : `4`{"msg":"hello","team":<id|undefined>}     (sendChat = sendEvent('4', …))
//   server -> client : ~0{channel,from,msg,uid,insignia}            (notification 0 -> addChatMessage)
//
// EMOTES. '/dance' and '/examine' are sent as ORDINARY CHAT to this same endpoint (the client's
// dispatcher routes them here explicitly). They are NOT rendered as chat — they set isDancing /
// isExamining (opcodes 185/186), which the client itself only ever CLEARS. Shooting or aiming
// cancels them client-side, so we clear ours on the same events to stay in agreement.
//
// SECURITY — the client renders chat with `a.innerHTML += … + e.msg` (raw HTML, no escaping). A
// message like `<img src=x onerror=…>` would therefore execute in EVERY other player's page. We
// HTML-escape both the message and the display name before broadcasting. Emoji are plain unicode
// (the client's emoji popup just inserts characters) and are unaffected by escaping.
const CHAT_MAX_LEN = 300;          // matches the client's own input cap closely enough
const CHAT_MIN_INTERVAL_MS = 400;  // simple flood guard, per session

function escapeChatHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Broadcast one chat line to every accepted client via notification 0.
function broadcastChat(sessions, entry) {
  const msg = "~0`" + JSON.stringify(entry);
  for (const s of sessions.values()) if (s && s.accepted) safeSend(s.ws, msg);
}

// Handle one `4` chat event. Returns true if it was consumed as an emote (no chat line emitted).
function handleChatEvent(session, sessions, arg) {
  const playerState = session.playerState;
  const raw = (arg && typeof arg === "object") ? arg.msg : arg;
  if (typeof raw !== "string") return false;
  const text = raw.trim();
  if (!text) return false;

  // Emotes: consumed, never echoed as chat.
  const lower = text.toLowerCase();
  if (lower === "/dance" || lower.startsWith("/dance ")) {
    playerState.isDancing = !playerState.isDancing;   // toggle, matching the client's emote feel
    playerState.isExamining = false;
    console.log(`[evio-local] ${session.displayName} /dance -> ${playerState.isDancing}`);
    return true;
  }
  if (lower === "/examine" || lower.startsWith("/examine ")) {
    playerState.isExamining = !playerState.isExamining;
    playerState.isDancing = false;
    console.log(`[evio-local] ${session.displayName} /examine -> ${playerState.isExamining}`);
    return true;
  }

  // Flood guard: drop messages sent faster than CHAT_MIN_INTERVAL_MS.
  const now = Date.now();
  if (session._lastChatAt && now - session._lastChatAt < CHAT_MIN_INTERVAL_MS) return false;
  session._lastChatAt = now;

  const entry = {
    // `from` and `msg` are both interpolated into innerHTML by the client — escape both.
    from: escapeChatHtml(session.displayName || "player"),
    msg: escapeChatHtml(text.slice(0, CHAT_MAX_LEN)),
    uid: session.uid,
  };
  // The client renders an insignia <img> from this when present; it is OUR value, but keep the
  // path shape it expects ('https://ev.io' + insignia).
  if (typeof session.clanImgUrl === "string" && session.clanImgUrl) {
    entry.insignia = session.clanImgUrl.replace(/^https?:\/\/ev\.io/i, "");
  }
  if (arg && arg.team !== undefined && arg.team !== null) entry.team = arg.team;

  broadcastChat(sessions, entry);
  console.log(`[evio-local] chat <${session.displayName}> ${text.slice(0, 120)}`);
  return false;
}

const ACTION_NAMES = {
  0: "Walk forward",
  1: "Walk backward",
  2: "Walk left",
  3: "Walk right",
  4: "Jump",
  5: "Shoot",
  6: "Zoom",
  7: "Run",
  8: "Crouch",
  9: "Teleport",
  10: "Next weapon",
  11: "Previous weapon",
  12: "Primary weapon",
  13: "Shotgun",
  14: "Sniper",
  15: "Rocket Launcher",
  19: "Throw HE",
  20: "Throw Smoke",
  21: "Throw Flashbang",
  22: "Throw Stick Grenade",
  23: "Throw Mine",
  24: "Throw Trip Mine",
  30: "Reload",
  32: "Homing Launcher",
  33: "Sword",
  34: "SMG",
  35: "Desert Eagle",
  36: "Grenade Launcher",
  37: "Resurrect",
  38: "Throw Impulse",
  39: "Free spec cam",
  40: "Defuse Bomb",
  41: "Bomb",
  42: "Drop Bomb",
  43: "Light Machine Gun",
};

function actionSummary(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => `${value}:${ACTION_NAMES[value] || "unknown"}`);
}

function summarizeInputFrame(frame) {
  if (!Array.isArray(frame)) return null;
  const [fraction, packedInput] = frame;
  if (!Array.isArray(packedInput)) return { fraction, malformed: true, rawType: typeof packedInput };
  const [held, pressed, released, lookDelta, absoluteAxes, eventMap] = packedInput;
  const events = eventMap && typeof eventMap === "object" ? eventMap : {};
  return {
    fraction,
    held: actionSummary(held),
    pressed: actionSummary(pressed),
    released: actionSummary(released),
    lookDelta: Array.isArray(lookDelta) ? lookDelta.map((value) => Number(value.toFixed ? value.toFixed(6) : value)) : lookDelta,
    absoluteAxes,
    eventKeys: Object.keys(events).sort((a, b) => Number(a) - Number(b)),
    events,
  };
}

function summarizeClientInputPacket(decoded) {
  if (!Array.isArray(decoded)) {
    return { malformed: true, rawType: typeof decoded };
  }

  const inputFrames = Array.isArray(decoded[5]) ? decoded[5] : [];
  const summarizedFrames = inputFrames.map(summarizeInputFrame);
  return {
    previousServerTick: decoded[0],
    currentServerTick: decoded[2],
    clientTick: decoded[4],
    inputFrameCount: inputFrames.length,
    latestInput: summarizedFrames[summarizedFrames.length - 1],
    interestingInputs: summarizedFrames.filter(isInterestingInputFrame),
  };
}

function isInterestingInputFrame(input) {
  if (!input) return false;
  const nonEmptyActions = [input.held, input.pressed, input.released].some((values) => Array.isArray(values) && values.length > 0);
  const nonZeroLook = Array.isArray(input.lookDelta) && input.lookDelta.some((value) => Number(value) !== 0);
  // event 4 appears in idle packets as routine client timing / input sampling metadata.
  // Its value changes constantly (82, 104, 183, ...), so treating it as interesting
  // logs every idle packet and can stutter the game at 20Hz. Other event keys still
  // remain visible for protocol discovery unless EVIO_INPUT_LOG_ALL=0 and no actions/look occur.
  const nonRoutineEvents = input.events && Object.entries(input.events).some(([key]) => key !== "4");
  return nonEmptyActions || nonZeroLook || nonRoutineEvents;
}

function shouldLogInputFrame(count, summary) {
  if (LOG_ALL_INPUT) return true;
  if (count <= 5) return true;                  // startup sanity: input is arriving and parsing
  if (!INPUT_DEBUG) return false;               // quiet during normal play
  return count % 100 === 0 || (summary.interestingInputs && summary.interestingInputs.length > 0);
}

// Weapon switching — replicates the client's sendInputFrame switch block
// (bundle ~34531). The client predicts the switch from its OWN input; since the
// reconciler comparator checks equippedWeaponId, the server must process the same
// input and echo the result, or the predicted switch reverts once it ages out of
// the replay buffer.  Direct-select action → weapon nid (Qtwp2vf); actions 10/11
// cycle next/prev among the carried weapons (y()).  On a switch we flag a few
// ticks of opcode 127/128 emission (appendPlayerTickBody) so self + peers update.
const ACTION_TO_WEAPON = { 12: 4, 13: 7, 14: 6, 43: 687, 15: 8, 32: 129, 33: 262, 34: 282, 35: 281, 36: 283, 41: 635 };

// Begin a weapon-switch: Q3igok2 (opcode 129) counts down from the weapon's switch delay.
//
// This is NOT a "respawnTimer" despite what the emit site used to call it. The client (bundle
// :34743) sets it to `Qz8l93a.Qhswtsz / Qq5sl76` on its own switch, and then:
//   :43956  a shot is refused while Q3igok2 > 0        (you cannot fire mid-swap)
//   :43981  a reload is refused while Q3igok2 >= 1
//   :45718  PEERS play 'switch_weapon' / 'sword_unsheath' off it
//   :48111  the first-person weapon dips through the swap
//   :48143  first-person renders the PREVIOUS weapon for the first half of the timer
//
// We never set it, so none of that happened: a loadout change swapped the weapon silently and
// peers kept rendering the old model until the owner did a manual switch, which is the only thing
// that was re-sending opcode 127.
function startWeaponSwitch(playerState) {
  const ps = playerState && playerState._ps;
  const delay = ps && ps.Qz8l93a && Number.isFinite(ps.Qz8l93a.Qhswtsz) ? ps.Qz8l93a.Qhswtsz : 0;
  const ticks = Math.max(0, Math.floor(delay));
  playerState.switchTimer = ticks;
  if (ps) ps.Q3igok2 = ticks;   // keep the physics state in step: g() reads it to gate firing
}

function processWeaponSwitch(playerState, heldSet, pressedSet) {
  const list = playerState.weaponList;
  if (!Array.isArray(list) || list.length < 2) return;
  const apply = (target) => {
    if (!list.includes(target) || target === playerState.equippedWeaponId) return;
    playerState.backupWeaponId = playerState.equippedWeaponId;
    playerState.equippedWeaponId = target;
    playerState.weaponSendCount = WEAPON_SEND_REPEAT_TICKS; // emit 127/128 for a few ticks (packet-loss safety)
    startWeaponSwitch(playerState);
  };
  // Cycle (client: q.activeActions.has(10)=next / has(11)=prev → y()). Check both the
  // held and pressed sets so a momentary scroll/swap that lands in either is caught.
  let dir = 0;
  if (heldSet.has(10) || pressedSet.has(10)) dir = 1;
  else if (heldSet.has(11) || pressedSet.has(11)) dir = -1;
  if (dir !== 0) {
    const i = list.indexOf(playerState.equippedWeaponId);
    apply(list[((i < 0 ? 0 : i) + dir + list.length) % list.length]);
  }
  // Direct select (client: q.justPressed → Qtwp2vf → weapon nid). NOTE: do NOT also treat
  // a pressed action id that equals a carried weapon nid as a switch — action ids and
  // weapon nids overlap (e.g. action 9 = Teleport, weapon nid 9 = Laser), so that would
  // make teleporting switch you to the gun. The client only uses the Qtwp2vf map.
  for (const a of pressedSet) {
    let target = ACTION_TO_WEAPON[a];
    if (target === undefined) continue;
    // Action 12 → Qh9s4po(4) is the generic "primary weapon" key: weapons 4/5/9/336/701
    // ALL bind to action 12 (bundle Q7tsmu1). The client doesn't equip literal weapon 4 —
    // it cycles among the carried PRIMARY weapons (non-sword) (bundle ~34539). Replicate
    // that so the primary key selects the player's actual gun (e.g. Laser 9), not AR 4.
    if (target === 4) {
      const primaries = list.filter((w) => w !== 262); // 262 = sword (Q67s71q), not a primary
      if (primaries.length > 0) {
        const s = primaries.indexOf(playerState.equippedWeaponId);
        target = primaries[(s + 1) % primaries.length];
      }
    }
    apply(target);
  }
}

// Active-ability (grenade) cast — Section 3, Phase 3a (cast + charge only; the projectile
// entity is Phase 3b). Mirrors the client's Q86l0mc (bundle 44023): on justRELEASED of the
// ability trigger key, if the ability is allocated AND its timer covers the cost, set
// justUsedActiveAbility and subtract the cost from the timer. Smoke (action 20, ability sid 9)
// and Flash (action 21, sid 10) both drain abilityTimer1 (Qctsdxf); cost 1.0 = a single
// charge. The timer recharge (Q30g2w8/tick) is already done by the physics _w().
// released action id -> ability sessionId. Smoke(20→9)/Flash(21→10) share abilityTimer1;
// Impulse(38→16, Section 4) uses abilityTimer6.
// action key -> ability sessionId.  Utility: Smoke(20→9)/Flash(21→10)/Impulse(38→16).
// Section 4 DAMAGE grenades: HE(19→8)/Sticky(22→13)/Mine(23→14)/Trip Mine(24→15).
const GRENADE_ACTIONS = { 19: 8, 20: 9, 21: 10, 22: 13, 23: 14, 24: 15, 38: 16 };
const GRENADE_TYPE    = { 8: 46, 9: 52, 10: 53, 13: 172, 14: 173, 15: 176, 16: 355 };  // sid -> projectile weaponTypeId
const GRENADE_NAME    = { 8: "HE", 9: "SMOKE", 10: "FLASH", 13: "STICKY", 14: "MINE", 15: "TRIPMINE", 16: "IMPULSE" };
// timer index (ABILITY_TIMER) -> obfuscated ps field. Qctsdx[g..a] = abilityTimer[0..6].
const TIMER_FIELD = ["Qctsdxg", "Qctsdxf", "Qctsdxe", "Qctsdxd", "Qctsdxc", "Qctsdxb", "Qctsdxa"];
// The weaponStats field that recharges each timer, in the same order. Timer 0 is the odd one out:
// it refills from the engine constant Q51lhke rather than a per-loadout stat, so there is no
// weaponStats key for it and its base rate is read from the constant instead.
const TIMER_RATE_STAT = [null, "Q30g2w8", "Qpe67c9", "Qn97q6u", "Qvhlqt", "Qli8ip8", "Qr55etv"];
const TIMER0_CONST_RATE = 0.002;                    // Q4b9iia.Q51lhke
const TELEPORT_TIMER_INDEX = 3;                     // ability id 0 (Teleport) drains abilityTimer3
// Timers drained by the throwables, derived from the table rather than written out — a literal here
// would silently miss a grenade if the ability table ever gains one.
const GRENADE_TIMER_INDEXES = [...new Set(Object.values(GRENADE_ACTIONS)
  .map((sid) => ABILITY_TIMER[sid]).filter((i) => Number.isInteger(i)))];

let THROWABLE_COOLDOWN_SCALE = S.define({
  key: "throwableCooldownScale", env: "EVIO_THROWABLE_COOLDOWN", type: "number",
  def: 1, min: 0, max: 10, step: 0.1,
  category: "Grenades", label: "Throwable cooldown (x normal)",
  desc: "Scales how long grenades/throwables take to recharge. 1 = the real game. 0.5 = twice as "
      + "fast. 0 = NO COOLDOWN, throw as fast as you can press. 2 = twice as long.",
}, (v) => { THROWABLE_COOLDOWN_SCALE = v; });

let TELEPORT_COOLDOWN_SCALE = S.define({
  key: "teleportCooldownScale", env: "EVIO_TELEPORT_COOLDOWN", type: "number",
  def: 1, min: 0, max: 10, step: 0.1,
  category: "Gameplay", label: "Teleport ability cooldown (x normal)",
  desc: "Scales the Teleport ability's recharge (abilityTimer3). 1 = the real game. 0 = NO COOLDOWN, "
      + "blink continuously. 2 = twice as long.",
}, (v) => { TELEPORT_COOLDOWN_SCALE = v; });

/**
 * Adjust ability-timer recharge to match the configured cooldown scales.
 *
 * Deliberately tops the TIMER up rather than rewriting the recharge rate in ps.Qz8l93a. Those stats
 * are the loadout's computed values and g() reads them every tick; scaling them in place would
 * compound each tick and permanently corrupt the loadout. Reading the rate and adding the difference
 * to the timer is idempotent and leaves the stats untouched.
 *
 * Runs AFTER the physics step, which is where g() has already applied one tick of normal recharge —
 * so this only has to supply (or remove) the difference.
 */
function applyAbilityCooldownScales(ps) {
  if (!ps) return;
  const stats = ps.Qz8l93a || {};
  const adjust = (timerIndex, scale) => {
    if (scale === 1) return;                        // the real game — nothing to do
    const field = TIMER_FIELD[timerIndex];
    if (!field || typeof ps[field] !== "number") return;
    if (scale === 0) { ps[field] = 1; return; }     // no cooldown: always fully charged
    const statKey = TIMER_RATE_STAT[timerIndex];
    const base = statKey ? stats[statKey] : TIMER0_CONST_RATE;
    if (!(base > 0)) return;                        // this ability does not recharge at all
    // g() already added `base` this tick. The target rate is base/scale, so supply the difference.
    const delta = base * (1 / scale) - base;
    ps[field] = Math.max(0, Math.min(1, ps[field] + delta));
  };
  if (THROWABLE_COOLDOWN_SCALE !== 1) {
    for (const t of GRENADE_TIMER_INDEXES) {
      // The teleport timer is never a grenade timer, but guard anyway so the two settings can never
      // fight over the same field if the ability table changes.
      if (t !== TELEPORT_TIMER_INDEX) adjust(t, THROWABLE_COOLDOWN_SCALE);
    }
  }
  if (TELEPORT_COOLDOWN_SCALE !== 1) adjust(TELEPORT_TIMER_INDEX, TELEPORT_COOLDOWN_SCALE);
}
// A short throw cooldown after any grenade cast. The client's release edge (justReleased) can arrive
// across two consecutive processed client ticks (redundant input frames / the release spanning a tick
// boundary), which made us cast the SAME throw twice — a spurious extra grenade, and on a 2-charge
// ability it drained both charges at once. One cooldown blocks the duplicate edge without impeding a
// genuine second throw (which is always >6 ticks later — release, re-press, release).
// How long an impulse grenade is kept alive AFTER its blast has already been applied. The client
// plays the explosion on entity REMOVAL, so this is visual delay on top of the real impact — but it
// cannot be zero, because the entity has to exist long enough for the client to build its mesh or
// nothing renders at all. 3 ticks (150ms) instead of the old hardcoded 5 (250ms).
let IMPULSE_LINGER_TICKS = S.define({
  key: "impulseLingerTicks", type: "int", def: 3, min: 1, max: 20,
  category: "Gameplay", label: "Impulse grenade linger (ticks)",
  desc: "Ticks an impulse grenade stays on the wire after its blast. The client plays the explosion "
      + "when the entity disappears, so this is how far the bang trails the actual hit. Too low and "
      + "the client never builds the model, so there is no visible grenade or explosion at all.",
}, (v) => { IMPULSE_LINGER_TICKS = v; });

let GRENADE_THROW_COOLDOWN = S.define({
  key: "grenadeThrowCooldown", type: "int", def: 6, min: 0, max: 200,
  category: "Grenades", label: "Throw cooldown (ticks)",
  desc: "Minimum ticks between grenade casts. 6 = ~0.3s at 20Hz.",
}, (v) => { GRENADE_THROW_COOLDOWN = v; });
function processGrenadeCast(playerState, releasedSet) {
  const ps = playerState._ps;
  if (!ps) return;
  if (playerState._grenadeThrowCd > 0) playerState._grenadeThrowCd--;
  const arr = ps.weaponStateArray;
  if (!Array.isArray(arr)) return;
  for (const action of Object.keys(GRENADE_ACTIONS)) {
    if (!releasedSet.has(Number(action))) continue;
    if (playerState._grenadeThrowCd > 0) continue;   // just threw → ignore the duplicate release edge
    const sid = GRENADE_ACTIONS[action];
    const level = arr[sid] | 0;
    if (level <= 0) continue;                 // ability not allocated → Q94ze8t would return false
    const costs = ABILITY_COST[sid] || [1];
    const cost = costs[Math.min(level - 1, costs.length - 1)];
    const field = TIMER_FIELD[ABILITY_TIMER[sid] | 0]; // which abilityTimer this grenade drains
    const timer = ps[field];
    if (typeof timer !== "number" || timer < cost) continue; // not enough charge
    ps[field] = timer - cost;
    playerState._grenadeThrowCd = GRENADE_THROW_COOLDOWN;
    playerState.justUsedActiveAbility = true;  // opcode 187, one tick (reset each tick)
    playerState.lastGrenadeSid = sid;
    spawnGrenade(playerState, sid);            // Phase 3b: spawn the thrown projectile entity
    console.log(`[evio-local] grenade cast: action=${action} sid=${sid} (${GRENADE_NAME[sid]}) weaponTypeId=${GRENADE_TYPE[sid]} timer=${ps[field].toFixed(3)} entities=${activeEntities.size}`);
  }
}

// ── Section 3 Phase 3b: thrown grenade projectiles (worldState.activeEntities, opcode 268) ──
// A thrown grenade is a server-simulated projectile streamed to EVERY client as an
// activeEntities entry. The decoder (Qpdy7i3) reads activeEntities AFTER the 244 player
// blocks (delimiter 268), so the block is spliced just before opcode 280. Fields emitted:
// 246 sessionId, 247 ownerSid, 248 position, 249 projVelocity, 250 spawn-frame, 251 damage,
// 260 weaponTypeId (52 smoke / 53 flash), 262 isArmed. Grenades are server-authoritative
// (the client's cast discards its local projectile), so the thrower sees it ~1 buffer tick
// after release. The client renders the flying grenade and plays the smoke/flash on removal.
const activeEntities = new Map();        // key -> { sessionId, ownerSid, pos{}, vel{}, type, spawnTick, fuse, isStuck }
let _entityCounter = 0;
const removedEntityKeys = [];            // keys deleted this tick → emitted as `268,-1,key`
const _entityRemovalRepeat = new Map();  // key -> ticks left to keep re-announcing that removal
// The client CANNOT simulate a server-spawned grenade: its grenade physics (Q4z2d8n
// .sendInputFrame, bundle ~43884) bails with "missing collider" because the collider is
// only registered by the client's own spawn (Qo1ywyz), which never runs for our entity.
// So the client just RENDERS the position (248) we stream. We must run the full arc on the
// server and stream position every tick. projVelocity (249) is cosmetic on the client (facing
// + a short trail), sent at the client's small scale. Speed/gravity are TUNABLE u/s values
// (the streamed position is the source of truth, not the catalogue per-tick numbers).
// Throw speed, PER WEAPON, straight from the catalogue's `projectileSpeed` (u/client-tick).
// Our velocities are u/s and the client ticks at 20Hz, so the conversion is x20.
//
// This was hardcoded to 42 ("1.5x the old 28") while the comment at the spawn site correctly
// documented projectileSpeed = 0.9 — i.e. 18 u/s. Throwing 2.33x too fast flattens the arc, and a
// flat arc reads as "gravity is too weak" even when gravity is exactly right. Both halves of the
// trajectory have to come from the catalogue or neither matches.
// MEASURED from the official server, not taken from the catalogue. Telemetry over 83 live
// projectiles (evio-throwable-logger v3) gives a launch speed of ~1.50 u/tick for EVERY hand-thrown
// grenade:
//     HE 1.4948   Sticky 1.5020   Impulse 1.5139   Flash 1.4667   GrenadeLauncher 1.5121
// while the catalogue lists projectileSpeed 0.9 for all of them. The Grenade Launcher is the tell:
// it is the one weapon whose catalogue value IS 1.5, and it measures the same as the rest. So
// `projectileSpeed` governs weapon-FIRED projectiles; ability THROWS use a fixed ~1.5 and ignore it.
//
// 1.5 u/tick x 20 = 30 u/s. That also reconciles both play reports: the old hand-tuned 42 threw too
// flat, the catalogue-derived 18 too short.
//
// Gravity, by contrast, was confirmed EXACT by the same capture (0.048 / 0.068), so the catalogue is
// right there and only the speed needed measuring.
// Below this a thrown entity has left the map; the engine uses the same plane for players
// (Q4b9iia.Qq85ufw = -30). Despawn rather than pretend there is a floor.
const FALL_KILL_Y = phys.CONST.Qq85ufw;

const GRENADE_SPEED      = 30;           // 1.5 u/tick — measured, every hand-thrown grenade
const GRENADE_SPEED_BY_TYPE = {
  46:  1.5 * 20,   // HE Grenade        measured 1.4948
  172: 1.5 * 20,   // Sticky Grenade    measured 1.5020
  173: 1.5 * 20,   // Mine
  176: 1.5 * 20,   // Trip Mine
  355: 1.5 * 20,   // Impulse Grenade   measured 1.5139
  52:  1.5 * 20,   // Smoke Grenade
  53:  1.5 * 20,   // Flash Grenade     measured 1.4667
  283: 1.5 * 20,   // Grenade Launcher  measured 1.5121 (catalogue agrees at 1.5)
  // Rocket Launcher: no live telemetry (it's a FIRED weapon, not a thrown ability, so the earlier
  // throw-speed measurement campaign never covered it) — straight from the catalogue's own
  // projectileSpeed (1.4 u/tick), unlike the throwables above where the catalogue value was
  // proven wrong. No contradicting evidence here, so trust it.
  8:   1.4 * 20,
};
// Live tuning multipliers. Both default to 1.0, i.e. EXACTLY the catalogue values verified against
// the client's own integration — so any deviation is a deliberate, visible departure from parity
// rather than a hidden hand-tune (which is how GRENADE_SPEED drifted to 42 in the first place).
//
// If a non-1.0 value is what actually matches official, that number is itself evidence: it tells us
// the size of whatever multiplier we have not yet found in the bundle.
let GRENADE_SPEED_MULT = S.define({
  key: "grenadeSpeedMult", env: "EVIO_GRENADE_SPEED_MULT", type: "number", def: 1.0,
  min: 0.25, max: 4, step: 0.05,
  category: "Grenades", label: "Throw speed x",
  desc: "Multiplier on the catalogue projectileSpeed (0.9 u/tick = 18 u/s for every hand-thrown "
      + "grenade). 1.0 = parity with the client's own value.",
}, (v) => { GRENADE_SPEED_MULT = v; });
let GRENADE_GRAVITY_MULT = S.define({
  key: "grenadeGravityMult", env: "EVIO_GRENADE_GRAVITY_MULT", type: "number", def: 1.0,
  min: 0.25, max: 4, step: 0.05,
  category: "Grenades", label: "Throw gravity x",
  desc: "Multiplier on the catalogue gravity (0.048/tick for HE/sticky/mine/trip/impulse, 0.068 "
      + "for smoke/flash). 1.0 = parity. Lower = floatier, longer arc.",
}, (v) => { GRENADE_GRAVITY_MULT = v; });

const grenadeSpeed = (type) =>
  (GRENADE_SPEED_BY_TYPE[type] !== undefined ? GRENADE_SPEED_BY_TYPE[type] : GRENADE_SPEED)
  * GRENADE_SPEED_MULT;
// Arc gravity, PER WEAPON — the catalogue carries a `gravity` field and the client applies
//   vel.y -= Qq5sl76 * gravity * Qsvkg5s.Qn0kxxb / Q4b9iia.Qyw1swv
// Both constants are 0.07, so they cancel: the per-TICK delta is exactly the catalogue value.
// Our velocities are u/s rather than u/tick, so the same acceleration is gravity x 20 x 20.
//
// A single hardcoded 22 was wrong in both directions: too strong for the 0.048 group (they flew
// flatter and dropped shorter than official) and too weak for the 0.068 group.
const GRENADE_GRAVITY    = 22;           // fallback for any type not in the table below (u/s^2)
const GRENADE_GRAVITY_BY_TYPE = {
  46:  0.048 * 400,   // HE Grenade        19.2
  172: 0.048 * 400,   // Sticky Grenade    19.2
  173: 0.048 * 400,   // Mine              19.2
  176: 0.048 * 400,   // Trip Mine         19.2
  355: 0.048 * 400,   // Impulse Grenade   19.2
  52:  0.068 * 400,   // Smoke Grenade     27.2
  53:  0.068 * 400,   // Flash Grenade     27.2
  283: 0.048 * 400,   // Grenade Launcher  19.2 (catalogue gravity 0.048, same as HE)
  // Rocket Launcher: the catalogue has NO `gravity` field at all — confirmed against the client's
  // own projectile tick (bundle :43917/:43942), an undefined gravity means the flight is a dead
  // straight line with no arc, not "fall back to some default acceleration". An explicit 0 here
  // (rather than omitting the entry, which would fall through to the generic GRENADE_GRAVITY
  // fallback of 22 below) is what preserves that — a dumbfire rocket that drops out of the sky
  // like a lobbed grenade would be a very different, wrong weapon.
  8:   0,
};
const grenadeGravity = (type) =>
  (GRENADE_GRAVITY_BY_TYPE[type] !== undefined ? GRENADE_GRAVITY_BY_TYPE[type] : GRENADE_GRAVITY)
  * GRENADE_GRAVITY_MULT;

// Bounce, ported from the client's Q5vtwm(vel, normal, 0.5, 0.9) (bundle, called at the wall-hit
// branch of the projectile tick). It is NOT a uniform restitution: the velocity is split against
// the surface and the two parts are scaled differently —
//   normal component     reversed and scaled by RESTITUTION (0.5)
//   tangential component kept and scaled by FRICTION       (0.9)
// We were applying a single 0.55 to the whole vector, which bleeds 45% of the SLIDING speed on
// every bounce where official bleeds 10%. That is why our grenades stopped dead on impact instead
// of skipping and rolling on.
const GRENADE_BOUNCE_RESTITUTION = 0.5;
const GRENADE_BOUNCE_FRICTION    = 0.9;
function bounceVelocity(vel, nx, ny, nz) {
  // a = vel x normal; degenerate (velocity parallel to the normal) => straight reflect x restitution
  let ax = vel.y * nz - vel.z * ny;
  let ay = vel.z * nx - vel.x * nz;
  let az = vel.x * ny - vel.y * nx;
  const alen = Math.hypot(ax, ay, az);
  if (alen * alen < 1e-6) {
    const d = vel.x * nx + vel.y * ny + vel.z * nz;
    vel.x = (vel.x - 2 * d * nx) * GRENADE_BOUNCE_RESTITUTION;
    vel.y = (vel.y - 2 * d * ny) * GRENADE_BOUNCE_RESTITUTION;
    vel.z = (vel.z - 2 * d * nz) * GRENADE_BOUNCE_RESTITUTION;
    return;
  }
  ax /= alen; ay /= alen; az /= alen;
  // s = a x normal  (the in-surface direction the grenade is sliding along)
  const sx = ay * nz - az * ny;
  const sy = az * nx - ax * nz;
  const sz = ax * ny - ay * nx;
  const l = vel.x * nx + vel.y * ny + vel.z * nz;   // into the surface
  const u = vel.x * ax + vel.y * ay + vel.z * az;   // ~0: a is perpendicular to vel by construction
  const c = vel.x * sx + vel.y * sy + vel.z * sz;   // sliding along the surface
  vel.x = nx * (l * -GRENADE_BOUNCE_RESTITUTION) + ax * (u * GRENADE_BOUNCE_FRICTION) + sx * (c * GRENADE_BOUNCE_FRICTION);
  vel.y = ny * (l * -GRENADE_BOUNCE_RESTITUTION) + ay * (u * GRENADE_BOUNCE_FRICTION) + sy * (c * GRENADE_BOUNCE_FRICTION);
  vel.z = nz * (l * -GRENADE_BOUNCE_RESTITUTION) + az * (u * GRENADE_BOUNCE_FRICTION) + sz * (c * GRENADE_BOUNCE_FRICTION);
}
let GRENADE_FUSE_TICKS = S.define({
  key: "grenadeFuseTicks", type: "int", def: 70, min: 1, max: 600,
  category: "Grenades", label: "Default fuse (ticks)",
  desc: "Fallback lifetime for grenades without a per-type fuse. 70 = ~3.5s at 20Hz.",
}, (v) => { GRENADE_FUSE_TICKS = v; });

// Per-type fuse, in TICKS, from the weapon catalogue's `timer` field and CONFIRMED against live
// telemetry from the official server (logger v3, 83 projectiles).
//
// Every throwable used to spawn with the single GRENADE_FUSE_TICKS fallback of 70, so flash went
// off at 3.5s instead of 1.75s and impulse at 3.5s instead of 3.0s — all of them wrong except by
// accident.
//
// Reading the measurements: types WITHOUT `timerAfterCollision` count down from the throw, so the
// first sampled value is timer-1 (sticky 29/30, flash 34/35, impulse 59/60). Types WITH it (HE,
// Grenade Launcher) hold the full value until they hit something, and measured exactly 40 and 20.
// That difference is itself the confirmation that timerAfterCollision behaves as the name says.
const GRENADE_FUSE_BY_TYPE = {
  46:  40,    // HE Grenade      timerAfterCollision — 2.0s, STARTS ON CONTACT
  172: 30,    // Sticky Grenade  1.5s from the throw
  53:  35,    // Flash Grenade   1.75s from the throw
  355: 60,    // Impulse Grenade 3.0s from the throw
  52:  200,   // Smoke Grenade   10s — the cloud's lifetime
  283: 20,    // Grenade Launcher timerAfterCollision — 1.0s
  // Rocket Launcher has no `timer` field either — it detonates on the FIRST contact (wall or
  // player, see GRENADE_COMBAT[8]'s "impact" behaviour), so this is never actually consulted in
  // normal play. Generous absolute-lifetime fallback only, for a rocket that somehow never hits
  // anything (fired into open sky) — 200 ticks = 10s, comfortably longer than any sane engagement
  // range at 28 u/s flight speed.
  8:   200,
  // Mine (173) and Trip Mine (176) have no `timer` at all: they are proximity/beam triggered and
  // live until tripped, so they keep MINE_LIFETIME as a self-clean.
};
// Types whose fuse does not start until first contact.
const GRENADE_TIMER_AFTER_COLLISION = { 46: true, 283: true };
const grenadeFuse = (type) =>
  (GRENADE_FUSE_BY_TYPE[type] !== undefined ? GRENADE_FUSE_BY_TYPE[type] : GRENADE_FUSE_TICKS);
const GRENADE_EYE_Y      = 1.8;          // Qyohfua (standing eye height)
const MINE_LIFETIME      = 1200;         // ~60s @20Hz — a mine/tripmine that's never tripped self-cleans
// When a grenade sticks, push its streamed position OUT along the surface normal by this much. Our
// raycast returns the BARE surface point, but the client renders the stuck model at position−0.2·normal
// (bundle :50740) — without the push the model ends up ~0.2u INSIDE the wall/floor (the mine "sank").
// 0.3 lands the model just proud of the surface (real client's sphere sweep stops ~projectileRadius out).
let STICK_SURFACE_OFFSET = S.define({
  key: "stickSurfaceOffset", type: "number", def: 0.3, min: 0, max: 3, step: 0.05,
  category: "Grenades", label: "Stick surface offset (u)",
  desc: "How far off a surface a sticky grenade rests once attached.",
}, (v) => { STICK_SURFACE_OFFSET = v; });

// ── Section 4: DAMAGE grenades (HE / Sticky / Mine / Trip Mine) ────────────────────────────────
// Keyed by projectile weaponTypeId. Values from field_weapon_data (server/weapons.json).
// `behavior` drives the detonation trigger; the rest mirror the client's projectile fields. dmg is
// the catalogue dmg (×0.01 → normalized HP via the blast falloff, exactly like the client). All four
// have noPlayerCollision (they pass THROUGH players in flight; damage is dealt by the AoE sphere on
// detonation, or — for the trip mine — directly to whoever crosses its beam).
//   timer    HE: arc (bounces), then ~2s after first contact it airbursts an AoE.
//   sticky   sticks to the first wall/ground, detonates after a fixed timer → AoE.
//   mine     sticks + arms, then detonates → AoE when any ENEMY enters proxyDistance.
//   tripmine sticks to a wall, projects a beam along the surface normal; an ENEMY crossing it takes
//            direct dmg (no AoE sphere — aoe 0).
//   impact   Rocket Launcher only: detonates on the FIRST contact — a wall/floor hit (no bounce,
//            unlike "timer"), OR flying within direct range of a live enemy capsule (checked every
//            tick in stepEntity) — matching the client's dumbfire projectile, which has no
//            noPlayerCollision flag (unlike every other entry here) and so explodes on touching a
//            player mid-flight rather than passing through them.
const GRENADE_COMBAT = {
  46:  { behavior: "timer",    dmg: 250, aoe: 11, fuse: 40 },                  // HE Grenade (on contact)
  172: { behavior: "sticky",   dmg: 200, aoe: 8,  fuse: 30 },                  // Sticky Grenade
  173: { behavior: "mine",     dmg: 125, aoe: 8,  proxyDistance: 6 },          // Mine
  176: { behavior: "tripmine", dmg: 200, aoe: 0,  tripRayLen: 50, tripRadius: 0.6 }, // Trip Mine
  283: { behavior: "timer",    dmg: 150, aoe: 10, fuse: 20 },                  // Grenade Launcher (fired)
  8:   { behavior: "impact",   dmg: 150, aoe: 10, directHitRadius: 1.2 },      // Rocket Launcher (fired)
};

// AoE explosion damage — mirrors the client's Q4z2d8n.Qtdn48t blast loop (bundle :43808-43828):
// Sphere(blastPos, aoe) ∩ each alive player's box → distance-falloff damage measured from the
// player's chest (feet+1, :43818). Falloff (:43819): z = clamp(rawDmg·(aoe − .9·(dist−1))/aoe,
// .2·rawDmg, rawDmg); final HP = z · 0.01 · lobbyMult. We are fully server-authoritative for grenade
// damage (the client can't simulate our server-spawned entity — no collider — so it never predicts
// this), so there is no double-apply and no lag comp: the blast is a fixed server point vs current
// target positions, exactly as the client's own blast loop reads i.playerList.
function applyExplosionDamage(blastPos, rawDmg, aoe, ownerSid, weaponType, sessions) {
  if (!(rawDmg > 0) || !(aoe > 0)) return 0;
  let hits = 0;
  for (const s of sessions.values()) {
    if (!s.accepted) continue;
    const v = s.playerState;
    if (!v || !v.position || v.deathStateTimer > 0 || v.healthPoints <= 0) continue;
    // Box-sphere gate: closest point on the player AABB (±0.5 wide, feet..feet+2 tall) to the blast.
    const qx = Math.max(v.position.x - 0.5, Math.min(blastPos.x, v.position.x + 0.5));
    const qy = Math.max(v.position.y,       Math.min(blastPos.y, v.position.y + 2));
    const qz = Math.max(v.position.z - 0.5, Math.min(blastPos.z, v.position.z + 0.5));
    if (Math.hypot(qx - blastPos.x, qy - blastPos.y, qz - blastPos.z) > aoe) continue;
    // Falloff distance = blast → chest (feet+1), matching bundle :43818.
    const dist = Math.hypot(v.position.x - blastPos.x, (v.position.y + 1) - blastPos.y, v.position.z - blastPos.z);
    let z = rawDmg * (aoe - 0.9 * (dist - 1)) / aoe;
    z = Math.max(Math.min(z, rawDmg), 0.2 * rawDmg);
    dealGrenadeHit(v, ownerSid, z * DMG_GLOBAL_MULT * LOBBY_DAMAGE_MULT, weaponType, blastPos, sessions);
    applyExplosionKnockback(v, blastPos, rawDmg, aoe, dist);   // HE/sticky/mine also FLING the player
    hits++;
  }
  return hits;
}

// Push a server-applied force from the PHYSICS state back into the legacy mirror.
//
// The tick order is: integrate players -> simulate grenades -> build tick bodies. integratePlayerSim
// copies ps -> playerState at the END of integration, but grenades run AFTER that, so an impulse or
// explosion knockback writes ps.Qyaswvo / ps.Q9t2fit while the mirror still holds the PRE-blast
// values — and the mirror is what appendPlayerTickBody actually serialises.
//
// The result was that on the very tick a player got flung, the server told them "you are still
// grounded and moving as you predicted". Q9t2fit is one of the fields the client's comparator
// (Qqx5i3b) checks, so that packet reads as a MATCH and reconciliation does NOT fire; the divergence
// only surfaces a tick later, by which point the ring/tick-index path can delay the correction. The
// client cannot predict any of this itself (grenades are server-streamed entities with no client
// collider), so the server has to be truthful on the blast tick, not the tick after.
function syncMirrorFromPhysics(p) {
  const ps = p && p._ps;
  if (!ps || !ps.Qyaswvo || !ps.Qdsukt4) return;
  p.velocity.x = ps.Qyaswvo.x; p.velocity.y = ps.Qyaswvo.y; p.velocity.z = ps.Qyaswvo.z;
  p.position.x = ps.Qdsukt4.x; p.position.y = ps.Qdsukt4.y; p.position.z = ps.Qdsukt4.z;
  p.grounded = ps.Q9t2fit;
}

// Explosion KNOCKBACK on a player (Qnjkdtj, bundle :43836). HE/sticky/mine define no bounceStrength,
// so the strength comes from the grenade damage and uses the +0.66 vertical-boost branch (a player
// caught in a frag is thrown up-and-away). Magnitude (units/tick): a = .01·clamp(dmg·(aoe−.55·(dist−1))
// /aoe, .4·dmg, dmg). We SET the velocity (overwrite) and clear grounded, exactly like applyImpulse.
function applyExplosionKnockback(victim, blastPos, rawDmg, aoe, dist) {
  const ps = victim && victim._ps;
  if (!ps || !ps.Qyaswvo) return;
  let a = rawDmg * (aoe - 0.55 * (dist - 1)) / aoe;
  a = 0.01 * Math.max(Math.min(a, rawDmg), 0.4 * rawDmg);
  let kx = victim.position.x - blastPos.x;
  let ky = (victim.position.y + 1.75) - blastPos.y;
  let kz = victim.position.z - blastPos.z;
  let l = Math.hypot(kx, ky, kz) || 1;
  kx = kx / l * a; ky = ky / l * a + 0.66 * a; kz = kz / l * a;   // away-from-blast + upward boost
  l = Math.hypot(kx, ky, kz) || 1;                                // re-normalize to length a (setLength)
  ps.Qyaswvo.x = kx / l * a; ps.Qyaswvo.y = ky / l * a; ps.Qyaswvo.z = kz / l * a;
  ps.Q9t2fit = false;                                            // grounded = false → airborne
  syncMirrorFromPhysics(victim);
  // The client cannot predict a blast, so with echoLagTicks=-1 it would never feel this push.
  // Ask for a short reconcile burst: the echo carries a real tick just long enough for the client
  // to adopt the new velocity, then it goes back to running free.
  requestReconcile(victim);
}

// Apply one grenade/explosion hit to a victim: HP/armor/death (applyDamage) + the lastHitInfo channel
// (damage-direction indicator + hit reaction), gated like the hitscan path. No playerMap prune key is
// needed — the client doesn't predict grenade damage, so HP arrives cleanly via opcode 166.
function dealGrenadeHit(victim, ownerSid, damage, weaponType, srcPos, sessions) {
  if (!(damage > 0)) return;
  // Credit the thrower when we can resolve them; self-damage counts as a suicide in creditKill.
  let owner = null, ownerSession = null;
  if (sessions) {
    for (const s of sessions.values()) {
      if (s && s.playerState && s.playerState._ownerSid === ownerSid) { owner = s.playerState; ownerSession = s; break; }
    }
  }
  const victimSession = sessions ? sessions.get(victim._ownerSid) : null;
  const GRENADE_MEDAL = { 46: "frag", 172: "sticky", 173: "mine", 176: "tripmine" };
  applyDamage(victim, damage, owner, {
    weaponMedal: GRENADE_MEDAL[weaponType] || null,
    victimUid: _uidForPlayerState(sessions, victim),
    // Same botFriendlyFire resolution applyHit does — see its call site for the full rationale.
    attackerIsBot: !!(ownerSession && ownerSession.isBot),
    victimIsBot: !!(victimSession && victimSession.isBot),
  });
  if (LASTHITINFO_EVENTS) {
    victim._pendingHit = {
      attackerSid: ownerSid, dmg: round(damage, 4),
      wpnType: weaponType, headshot: false,
      src: { x: srcPos.x, y: srcPos.y, z: srcPos.z },
    };
  }
}

// Is there a LIVE enemy (not the owner) within `radius` of point P? Returns the nearest, or null.
function nearestEnemyWithin(point, radius, ownerSid, sessions) {
  let best = null, bestD = radius;
  for (const s of sessions.values()) {
    if (!s.accepted) continue;
    const p = s.playerState;
    if (!p || !p.position || p._ownerSid === ownerSid) continue;       // dontTriggerOnSelf
    if (p.deathStateTimer > 0 || p.healthPoints <= 0) continue;
    const d = Math.hypot(p.position.x - point.x, (p.position.y + 1) - point.y, p.position.z - point.z);
    if (d <= bestD) { bestD = d; best = p; }
  }
  return best;
}

// Distance from a point to the trip-mine beam SEGMENT (origin + t·dir, t∈[0,len]).
function pointToSegDist(px, py, pz, ray, len) {
  const ax = px - ray.ox, ay = py - ray.oy, az = pz - ray.oz;
  let t = ax * ray.dx + ay * ray.dy + az * ray.dz;
  if (t < 0) t = 0; else if (t > len) t = len;
  return Math.hypot(px - (ray.ox + ray.dx * t), py - (ray.oy + ray.dy * t), pz - (ray.oz + ray.dz * t));
}
// Did a LIVE enemy cross the trip-mine beam? Samples the body at 3 heights (feet/chest/head) so a
// player can break the beam with a leg or head, not just the chest. Returns the tripper, or null.
function enemyCrossingRay(ray, len, radius, ownerSid, sessions) {
  for (const s of sessions.values()) {
    if (!s.accepted) continue;
    const p = s.playerState;
    if (!p || !p.position || p._ownerSid === ownerSid) continue;       // dontTriggerOnSelf
    if (p.deathStateTimer > 0 || p.healthPoints <= 0) continue;
    for (const hy of [0.2, 1.0, 1.8]) {
      if (pointToSegDist(p.position.x, p.position.y + hy, p.position.z, ray, len) <= radius) return p;
    }
  }
  return null;
}

function spawnGrenade(playerState, sid) {
  const ps = playerState._ps;
  const yaw   = ps ? ps.Qqg4go0 : playerState.yaw;
  const pitch = ps ? ps.Qcrzrpr : playerState.pitch;
  const dir = phys.aimDirection(yaw, pitch);
  const key = ++_entityCounter;
  // projVelocity is sent once — the CLIENT advances the grenade each tick via its own
  // simulation (Q4z2d8n.sendInputFrame: pos += projVelocity * tickDuration; gravity applied
  // to projVelocity per tick). We must NOT stream updated positions — that fights the client.
  // projectileSpeed = 0.9 u/client-tick (from field_weapon_data); client tickDuration defaults
  // to 1, so projVelocity magnitude = 0.9. eye-height = Qyohfua = 1.8.
  // Resolve the type first so the throw speed can be looked up per weapon (see grenadeSpeed).
  const gtype = GRENADE_TYPE[sid] || 53;
  const gspeed = grenadeSpeed(gtype);
  activeEntities.set(key, {
    sessionId: key,
    ownerSid: playerState._ownerSid,
    // Spawn 0.4u along the aim direction, matching the client's `o.add(s.clone().setLength(.4))`.
    pos: {
      x: playerState.position.x + dir.x * 0.4,
      y: playerState.position.y + GRENADE_EYE_Y + dir.y * 0.4,
      z: playerState.position.z + dir.z * 0.4,
    },
    vel: { x: dir.x * gspeed, y: dir.y * gspeed, z: dir.z * gspeed },
    type: gtype,           // 52 smoke / 53 flash / 355 impulse / 46 HE / 172 sticky / 173 mine / 176 trip
    // number_prop (opcode 259) = explosion size; only grenades with a frag burst need it (impulse +
    // the Section-4 AoE grenades). The client's removal explosion needs bounceStrength + number_prop
    // both defined; sending it for smoke/flash would instead trigger their projectile wobble. Set from
    // the combat table's aoe so the client plays the right-sized blast on removal.
    numberProp: sid === 16 ? 11 : ((GRENADE_COMBAT[GRENADE_TYPE[sid]] || {}).aoe || 0),
    spawnTick: Number.isFinite(playerState._lastClientTick) ? playerState._lastClientTick : 0,
    // Server tick of birth, for the absolute lifetime cap. spawnTick above is the owner's CLIENT tick
    // (opcode 250, which the client uses to age the projectile) and cannot be compared with ours.
    _bornTick: _live.globalTick || 0,
    fuse: grenadeFuse(gtype),
    isStuck: 0,
    // Section-4 combat fields (null/undefined for utility grenades). `behavior` selects the
    // detonation trigger in simulateGrenades; `armed` flips true once a mine/trip mine sticks; `ray`
    // is the trip-mine beam {ox,oy,oz,dx,dy,dz} set at stick time from the wall normal.
    combat: GRENADE_COMBAT[GRENADE_TYPE[sid]] || null,
    armed: false,
    ray: null,
    // ── Catch-up: the single largest source of live server/client divergence ────────────────────
    // MEASURED: server and client ran in perfect lockstep for 237 consecutive ticks (0.000u), then an
    // impulse grenade detonated TWO TICKS LATER on the server, and from that instant the server ran
    // the identical trajectory permanently 2 ticks behind. Once the positions differ the two sims
    // start hitting different geometry — one clips a wall the other sails past — so the gap compounds
    // without bound: 30u after 100 ticks, 90u after 200.
    //
    // The cause is timing, not physics. The CLIENT simulates its own thrown grenade from the tick it
    // threw on; we only spawn ours when we PROCESS that input, which is one tick of network plus
    // inputBufferDepth later. So our grenade is born late, flies late, and detonates late.
    //
    // Fix: advance the new grenade by exactly the input lag, so its flight is measured from the
    // client's throw tick rather than ours. The steps run on the first sim tick (simulateGrenades),
    // where `sessions` is available for damage/knockback — a grenade that should ALREADY have
    // detonated then does so immediately, which is the correct outcome.
    _catchUp: Math.max(0, Math.min(10, playerState._inputLagTicks || 0)),
    // Qt6bqft (opcode 261): smoke-emission start frame. null = grenade model visible, no smoke
    // (correct during flight, and always for flash). Phase 3c: set to a client frame when a
    // SMOKE grenade lands → client hides the model and spawns the vision-blocking cloud there.
    qt6bqft: null,
  });
}

// FIRED projectile weapons (Rocket Launcher / Grenade Launcher) — the same activeEntities struct
// spawnGrenade builds for a thrown ability grenade, via the SAME wire mechanism (opcode 268), but
// from a trigger-pull rather than a grenade-key release. Confirmed against the client's own
// projectile factory (bundle Q4z2d8n.Qo1ywyz, :43754-43780): a fired round's weaponTypeId
// (Qanwr22) is the GUN's OWN nid (`t.id`), not some separate ability-sid-derived projectile id the
// way thrown grenades use GRENADE_TYPE — so `type` below is `nid` directly, and GRENADE_COMBAT/
// GRENADE_SPEED_BY_TYPE/GRENADE_GRAVITY_BY_TYPE/GRENADE_FUSE_BY_TYPE all carry entries keyed by the
// gun nid (8, 283) for exactly this reason.
//
// `eye`/`dir` come from shotRay (the same aim reconstruction fireHitscan uses — the client's exact
// ray when available, else the server's own reconstruction), NOT playerState.position + a fixed eye
// height like spawnGrenade uses for ability throws: those cast from a fixed stance, but a shot's
// origin should track crouch/lean exactly the way a hitscan bullet's does.
function spawnFiredProjectile(shooter, nid, eye, dir) {
  const key = ++_entityCounter;
  const gspeed = grenadeSpeed(nid);
  activeEntities.set(key, {
    sessionId: key,
    ownerSid: shooter._ownerSid,
    pos: { x: eye.x + dir.x * 0.4, y: eye.y + dir.y * 0.4, z: eye.z + dir.z * 0.4 },
    vel: { x: dir.x * gspeed, y: dir.y * gspeed, z: dir.z * gspeed },
    type: nid,
    numberProp: (GRENADE_COMBAT[nid] || {}).aoe || 0,
    spawnTick: Number.isFinite(shooter._lastClientTick) ? shooter._lastClientTick : 0,
    _bornTick: _live.globalTick || 0,
    fuse: grenadeFuse(nid),
    isStuck: 0,
    combat: GRENADE_COMBAT[nid] || null,
    armed: false,
    ray: null,
    // Same input-lag catch-up spawnGrenade uses, for the same reason: the client fired this round
    // on ITS current tick, we only spawn it once we've processed that input.
    _catchUp: Math.max(0, Math.min(10, shooter._inputLagTicks || 0)),
    qt6bqft: null,
  });
}

// Apply the flash blind to every player when a flash grenade detonates. Mirrors the client's
// Q4z2d8n.Qtdn48t (bundle ~43789): for each alive player, blind = ((π−angle)/π)^0.6 · (1−0.01·dist)
// · 2.05, where angle is between the flash→eye vector and the player's look direction (so looking
// AT the flash = max blind). The result drives energyCharge (opcode 198) = the white-screen blind.
// NOTE: no line-of-sight raycast yet (a refinement) — a wall between player and flash won't block it.
function applyFlashBlind(flashPos, sessions) {
  for (const s of sessions.values()) {
    if (!s.accepted) continue;
    const p = s.playerState;
    if (!p || !p.position) continue;
    const eyeY = p.position.y + (p.crouching ? 1 : 2);
    const mx = flashPos.x - p.position.x;
    const my = flashPos.y - eyeY;
    const mz = flashPos.z - p.position.z;
    const dist = Math.hypot(mx, my, mz);
    if (dist < 0.01) { p.energyCharge = 2.05; continue; }
    const look = phys.aimDirection(p.yaw, p.pitch);
    const dot = (mx * look.x + my * look.y + mz * look.z) / dist;     // cos(angle)
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    const w = Math.pow((Math.PI - angle) / Math.PI, 0.6) * (1 - 0.01 * dist) * 2.05;
    if (w > 0 && w > (p.energyCharge || 0)) {
      p.energyCharge = w;
      p.qwv47ix = 0;   // restart the fade so the new (stronger) blind shows from full
    }
  }
  console.log(`[evio-local] flash detonated at (${flashPos.x.toFixed(1)},${flashPos.y.toFixed(1)},${flashPos.z.toFixed(1)})`);
}

// Impulse grenade (Section 4, non-damage): on detonation, fling every player within the
// aoe away from the blast. Mirrors the client knockback Qnjkdtj (bundle 43836), which is
// actually TWO different formulas selected by whether the weapon's own data defines
// `bounceStrength`:
//   bounceStrength UNDEFINED — push along (victim_pos+1.75 - blast), length a, THEN add a
//     flat 0.66*a to the Y component, THEN renormalize the whole vector back to length a
//     (this is the "generic explosion knockback" shape, e.g. a rocket's blast push).
//   bounceStrength DEFINED — push along (victim_pos+1 - blast), length a. That's it: no
//     extra vertical boost, no second renormalize.
// Impulse Grenade's own catalogue entry (nid 355) HAS bounceStrength (250 — same number as
// IMPULSE_STRENGTH below, confirming this is the weapon it names), so official takes the
// SECOND branch — no 0.66*a boost at all, and a shallower +1 (not +1.75) height offset. We
// were unconditionally running the FIRST branch's math for every impulse throw, which is
// exactly the earlier "impulse grenade pushes players upward too much" report: the extra
// boost plus the taller chest offset both bias the launch vertically well past what official
// actually does for this weapon. a = 0.01*clamp(bounceStrength*(aoe-0.55*(dist-1))/aoe,
// 0.4*bounceStrength, bounceStrength) in units/tick either way. We write it straight to the
// physics velocity (Qyaswvo) + clear grounded so the player goes airborne. The client can't
// run this (no collider), so the fling reaches it via the streamed position + reconcile.
let IMPULSE_AOE = S.define({
  key: "impulseAoe", type: "number", def: 11, min: 0, max: 60, step: 0.5,
  category: "Grenades", label: "Impulse radius (u)",
  desc: "Radius within which an impulse grenade flings players.",
}, (v) => { IMPULSE_AOE = v; });
let IMPULSE_STRENGTH = S.define({
  key: "impulseStrength", type: "number", def: 250, min: 0, max: 2000, step: 10,
  category: "Grenades", label: "Impulse strength",
  desc: "Knockback force applied by an impulse grenade at the centre of the blast.",
}, (v) => { IMPULSE_STRENGTH = v; });
function applyImpulse(blastPos, sessions) {
  for (const s of sessions.values()) {
    if (!s.accepted) continue;
    const p = s.playerState;
    const ps = p && p._ps;
    if (!ps || !ps.Qyaswvo || !p.position) continue;
    let dx = p.position.x - blastPos.x;
    let dy = (p.position.y + 1) - blastPos.y;   // bounceStrength branch: +1, not the +1.75 chest offset
    let dz = p.position.z - blastPos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > IMPULSE_AOE) continue;
    let a = IMPULSE_STRENGTH * (IMPULSE_AOE - 0.55 * (dist - 1)) / IMPULSE_AOE;
    a = 0.01 * Math.max(Math.min(a, IMPULSE_STRENGTH), 0.4 * IMPULSE_STRENGTH);
    const len = dist || 1;
    // No extra vertical boost and no second renormalize here — those belong only to the OTHER
    // branch (bounceStrength undefined), which this weapon does not take. See the comment above.
    const vx = dx / len * a, vy = dy / len * a, vz = dz / len * a;
    ps.Qyaswvo.x = vx; ps.Qyaswvo.y = vy; ps.Qyaswvo.z = vz;
    ps.Q9t2fit = false;                              // grounded = false → airborne fling
    syncMirrorFromPhysics(p);                        // this tick's packet must show the fling
    requestReconcile(p);                             // and the client must be told it was flung
  }
  console.log(`[evio-local] impulse detonated at (${blastPos.x.toFixed(1)},${blastPos.y.toFixed(1)},${blastPos.z.toFixed(1)})`);
}

// Impulse grenade DISABLES nearby deployed grenades (field_weapon_data disableGrenades=true; bundle
// :43830-43833 sets Qi98px5 on entities within 0.65·aoe). A disabled grenade is DEFUSED — its
// detonation handler bails (Qtdn48t :43788 `if (Qi98px5) return !1`) so it deals nothing — then is
// cleaned up. This is the counter-play to enemy traps. We mark our damage grenades inert (can't
// trigger / no AoE), freeze them, stream Qi98px5=true so the client shows the disabled state, and
// silent-remove them after a short linger. Counts only the Section-4 damage grenades (g.combat).
let DISABLE_RADIUS_FACTOR = S.define({
  key: "disableRadiusFactor", type: "number", def: 0.65, min: 0, max: 2, step: 0.05,
  category: "Grenades", label: "Chain-disable radius (× aoe)",
  desc: "A detonation disables other grenades within aoe × this factor.",
}, (v) => { DISABLE_RADIUS_FACTOR = v; });
const DISABLED_LINGER       = 12;   // ticks (~0.6s) the defused grenade shows as disabled before despawning

// Hard ceiling on how long ANY entity may exist, independent of its own fuse or trigger. This is a
// backstop, not a game rule: it must sit above the longest legitimate lifetime (MINE_LIFETIME, 1200)
// so it never cuts a working mine short, while still guaranteeing nothing becomes permanent scenery.
let ENTITY_MAX_LIFETIME_TICKS = S.define({
  key: "entityMaxLifetimeTicks", env: "EVIO_ENTITY_MAX_LIFETIME", type: "int", def: 2400,
  min: 200, max: 20000,
  category: "Grenades", label: "Absolute entity lifetime cap (ticks)",
  desc: "Force-removes any grenade/mine older than this regardless of its fuse — the catch-all for a "
      + "throwable that somehow never triggers. 2400 = 120s at 20Hz, double the 60s mine lifetime.",
}, (v) => { ENTITY_MAX_LIFETIME_TICKS = v; });

// A hard ceiling on concurrent thrown entities. The lifetime cap alone bounds how LONG one lives, not
// how MANY exist: at a 6-tick throw cooldown and a 120s lifetime a single player can hold hundreds of
// mines alive, and every live entity is streamed to EVERY client EVERY tick — so the cost is
// entities x players, in both bandwidth and per-tick CPU. A full server laying traps reaches that
// without anyone trying to. When the cap is hit the OLDEST entities are dropped: a grenade that
// vanishes the instant you throw it is far more noticeable than a two-minute-old mine disappearing.
let MAX_ACTIVE_ENTITIES = S.define({
  key: "maxActiveEntities", env: "EVIO_MAX_ENTITIES", type: "int", def: 120, min: 8, max: 2000,
  category: "Grenades", label: "Max concurrent thrown entities",
  desc: "Ceiling on live grenades/mines/trip mines across the whole server. Every one of them is sent "
      + "to every player every tick, so this bounds packet size and tick cost. Oldest are dropped first.",
}, (v) => { MAX_ACTIVE_ENTITIES = v; });

// How many ticks an entity removal is re-announced. A removal used to be sent on exactly ONE tick, so
// any client that did not decode that packet's entity block kept rendering the grenade for ever —
// which is how one player could see an unexploded grenade that others did not. Peer removals already
// use this repeat-for-N pattern (pendingPeerRemovals) for the same reason.
let ENTITY_REMOVAL_REPEAT = S.define({
  key: "entityRemovalRepeatTicks", env: "EVIO_ENTITY_REMOVAL_REPEAT", type: "int", def: 5,
  min: 1, max: 40,
  category: "Grenades", label: "Entity removal re-announce (ticks)",
  desc: "Ticks to keep re-sending `268,-1,key` after an entity is removed, so a client that missed "
      + "the first one does not keep a ghost grenade on screen for ever.",
}, (v) => { ENTITY_REMOVAL_REPEAT = v; });
function disableNearbyGrenades(blastPos, aoe, selfKey) {
  const r = DISABLE_RADIUS_FACTOR * aoe;
  for (const [key, g] of activeEntities) {
    if (key === selfKey || g.disabled || !g.combat) continue;   // only live damage grenades
    if (Math.hypot(g.pos.x - blastPos.x, g.pos.y - blastPos.y, g.pos.z - blastPos.z) > r) continue;
    g.disabled = true;                                 // inert: armed/contact/fuse triggers all skip it
    g.armed = false;
    g.vel.x = 0; g.vel.y = 0; g.vel.z = 0;             // freeze in place
    g.fuse = DISABLED_LINGER;                           // → silent removal after the linger
  }
}

// Advance the grenade arc one server tick and stream the position (the client renders it;
// it cannot simulate the entity itself — no collider). Smoke settles + emits a cloud on
// landing; flash DETONATES on ground contact (or on fuse if it never lands) → blind + remove.
// Detonate an AoE damage grenade in place and queue its removal (client plays the blast on removal).
// Remove every live entity and tell the clients. Used at a round boundary and on a map switch: the
// removals go through the normal `268,-1,key` path (with the re-announce window) so no client is left
// rendering something the server has forgotten.
function clearAllEntities(why) {
  if (activeEntities.size === 0) return 0;
  const n = activeEntities.size;
  for (const key of activeEntities.keys()) removedEntityKeys.push(key);
  activeEntities.clear();
  console.log(`[evio-local] cleared ${n} active entit${n === 1 ? "y" : "ies"} (${why})`);
  return n;
}

function detonateAoe(key, g, sessions) {
  if (g.combat && g.combat.aoe > 0) applyExplosionDamage(g.pos, g.combat.dmg, g.combat.aoe, g.ownerSid, g.type, sessions);
  activeEntities.delete(key);
  removedEntityKeys.push(key);
}

// Drop the oldest entities until the map is within the cap. Age is _bornTick (a SERVER tick), the
// same field the lifetime cap uses; entities without one are treated as ancient so a malformed entry
// is evicted first rather than pinned forever.
function enforceEntityCap() {
  const over = activeEntities.size - MAX_ACTIVE_ENTITIES;
  if (over <= 0) return 0;
  const byAge = [...activeEntities.entries()]
    .sort((a, b) => (Number.isFinite(a[1]._bornTick) ? a[1]._bornTick : -Infinity)
                  - (Number.isFinite(b[1]._bornTick) ? b[1]._bornTick : -Infinity));
  for (let i = 0; i < over; i++) {
    const [key] = byAge[i];
    activeEntities.delete(key);
    removedEntityKeys.push(key);   // tell clients, or they render it forever
  }
  console.warn(`[evio-local] entity cap: dropped ${over} oldest (cap ${MAX_ACTIVE_ENTITIES})`);
  return over;
}

// Temporary, targeted diagnostic (see _simSubTimings' own comment) — a live overrun log showed the
// "grenades" phase spike to 282ms in a single tick, an order of magnitude past anything else logged,
// tied to an actual grenade throw. The likely cause is the catch-up replay below (a freshly thrown
// grenade fast-forwards through the ticks it should already have flown, synchronously, in one call)
// running many steps on a large map (The Lab: 109480 collision triangles) — but that is a guess until
// the next live spike names it. Reset once per global tick alongside _simSubTimings.
let _grenadeSubTimings = {};
function _resetGrenadeSubTimings() { _grenadeSubTimings = {}; }
function _addGrenadeSubTiming(name, ms) { _grenadeSubTimings[name] = (_grenadeSubTimings[name] || 0) + ms; }

function simulateGrenades(dt, sessions) {
  enforceEntityCap();
  // NOTE: removedEntityKeys is NOT reset here — it accumulates entity removals from BOTH this grenade
  // sim AND the firing path (shooting a mine, fireHitscan runs earlier in the tick) and is cleared
  // once, after the broadcast (next to _pendingBullets). Resetting here would drop firing-time removals.
  for (const [key, g] of activeEntities) {
    // ── Per-entity isolation ────────────────────────────────────────────────────────────────────
    // This loop used to be bare. A throw from any one entity's trigger logic (a proximity scan, an
    // explosion, a raycast against geometry) escaped the whole function, which is called straight
    // from the tick with no guard of its own — so it also abandoned firing, death/respawn and the
    // broadcast for that tick. Worse, it aborted the loop at the SAME entity every tick, so that
    // entity and every one after it in the Map stopped advancing entirely: a grenade that never
    // explodes and never disappears, which is exactly the reported symptom.
    try {
      // Catch-up steps: replay the ticks this grenade should already have flown, so its detonation
      // lands on the same client tick as the client's own. Consumed once, on the first sim tick.
      // Bounded, and abandoned the moment the entity is gone (an early step may detonate it).
      if (g._catchUp > 0) {
        const extra = g._catchUp;
        g._catchUp = 0;
        _addGrenadeSubTiming("catchUpSteps", extra);
        const _t0 = Date.now();
        for (let i = 0; i < extra && activeEntities.has(key); i++) stepEntity(key, g, dt, sessions);
        _addGrenadeSubTiming("catchUpMs", Date.now() - _t0);
        if (!activeEntities.has(key)) continue;   // detonated during catch-up
      }
      {
        const _t0 = Date.now();
        stepEntity(key, g, dt, sessions);
        _addGrenadeSubTiming("stepMs", Date.now() - _t0);
      }
    } catch (err) {
      _live.simErrors = (_live.simErrors || 0) + 1;
      _live.lastSimError = `entity ${key} (type ${g && g.type}): ${(err && err.message) || err}`;
      console.error(`[evio-local] ENTITY SIM ERROR key=${key} type=${g && g.type}:`,
        (err && err.stack) || err);
      // Remove it rather than leave it to throw again next tick. A grenade that cannot be simulated
      // is worse than no grenade: it is permanent scenery that also costs everyone a tick.
      activeEntities.delete(key);
      removedEntityKeys.push(key);
    }
  }
}

// One entity, one tick. Split out of simulateGrenades so a fault can be contained per entity.
function stepEntity(key, g, dt, sessions) {
  {
    // ── Absolute lifetime cap ───────────────────────────────────────────────────────────────────
    // The backstop for every "it never went away" case, whatever the cause — a fuse that stopped
    // counting, a trigger that can never fire because its owner left, an arming delay that never
    // completes. Nothing may outlive this, so a leak is bounded instead of permanent. It sits above
    // every other rule deliberately: it must not be reachable only via some other branch.
    if (!Number.isFinite(g.fuse)) g.fuse = 1;   // a non-finite fuse never satisfies <= 0

    // ── Non-finite position/velocity ────────────────────────────────────────────────────────────
    // A NaN here is NOT cosmetic. The client's reconciler comparator treats NaN as a MATCH, so the
    // desync it causes is never corrected and the only recovery is a page refresh — one bad throw
    // bricks every client that can see it. The maths that can produce one is right here: normalising
    // a zero-length direction, or a bounce off a degenerate surface normal.
    //
    // An entity whose POSITION has gone bad cannot be placed anywhere sensible, so it is removed. A
    // bad VELOCITY is recoverable — zero it and let it sit — because the position is still good.
    if (!Number.isFinite(g.pos.x) || !Number.isFinite(g.pos.y) || !Number.isFinite(g.pos.z)) {
      console.error(`[evio-local] entity ${key} (type ${g.type}) has a non-finite position `
        + `(${g.pos.x},${g.pos.y},${g.pos.z}) — removing before it reaches the wire`);
      activeEntities.delete(key);
      removedEntityKeys.push(key);
      return;
    }
    if (!Number.isFinite(g.vel.x) || !Number.isFinite(g.vel.y) || !Number.isFinite(g.vel.z)) {
      console.error(`[evio-local] entity ${key} (type ${g.type}) has a non-finite velocity `
        + `(${g.vel.x},${g.vel.y},${g.vel.z}) — zeroing it`);
      g.vel.x = 0; g.vel.y = 0; g.vel.z = 0;
    }
    // Age is measured against _bornTick, a SERVER tick. Deliberately not `spawnTick`: that field
    // carries the owner's CLIENT tick (the client needs it to age the projectile visually), and the
    // two counters are unrelated — subtracting one from the other yields a meaningless number that
    // would either never trip or trip immediately. Missing values are stamped rather than assumed, so
    // this can never delete something spuriously.
    const now = _live.globalTick || 0;
    if (!Number.isFinite(g._bornTick)) g._bornTick = now;
    if (now - g._bornTick > ENTITY_MAX_LIFETIME_TICKS) {
      console.warn(`[evio-local] entity ${key} (type ${g.type}) hit the ${ENTITY_MAX_LIFETIME_TICKS}-tick `
        + `lifetime cap — force-removing (fuse=${g.fuse} stuck=${!!g.isStuck} armed=${!!g.armed})`);
      activeEntities.delete(key);
      removedEntityKeys.push(key);
      return;
    }
    g.fuse -= 1;

    // ── Disabled (defused by an impulse) ────────────────────────────────────────────────────────
    // A grenade an impulse blast caught is inert: it can't trigger and deals nothing — it just
    // counts down its short linger (still streamed, with Qi98px5=true so the client shows it defused)
    // then is silently removed. Skip ALL of its normal trigger/contact/detonation logic.
    if (g.disabled) {
      if (g.fuse <= 0) { activeEntities.delete(key); removedEntityKeys.push(key); }
      return;
    }

    // ── Owner-death cleanup ─────────────────────────────────────────────────────────────────────
    // A planted mine / trip mine despawns with its owner: once the deploying player is dead (or gone),
    // their trap is removed so it doesn't outlive them on the map. Checked every tick while stuck.
    // The isStuck requirement is gone: a mine still in the air when its owner died used to slip
    // through, land, and only then be checked — and if it landed somewhere the stick never registered
    // it was never checked at all. Ownership does not depend on whether the thing has landed yet.
    if (g.combat && (g.combat.behavior === "mine" || g.combat.behavior === "tripmine")) {
      let ownerAlive = false;
      for (const s of sessions.values()) {
        const op = s.accepted && s.playerState;
        if (op && op._ownerSid === g.ownerSid) { ownerAlive = op.deathStateTimer <= 0 && op.healthPoints > 0; break; }
      }
      if (!ownerAlive) { activeEntities.delete(key); removedEntityKeys.push(key); return; }
    }

    // ── Arming delay ────────────────────────────────────────────────────────────────────────────
    // A planted mine / trip mine is INERT for a short time after it sticks (bundle :43877 arms it
    // `isMine?30:1` ticks after the stick), so it doesn't detonate the instant it lands next to
    // someone (the thrower, a teammate walking past, a 2nd player) — that read as "disappears the
    // moment it lands". Mines arm after ~1.5s; trip mines after 1 tick. The model + trip beam are
    // still streamed during the delay so players can see the threat; it just can't trigger yet.
    if (g.isStuck && g.combat && !g.armed && typeof g.armDelay === "number" && --g.armDelay <= 0) {
      g.armed = true;
    }

    // ── Section-4 armed triggers (run EVERY tick, even while stuck) ──────────────────────────────
    // A planted Mine watches for an enemy within proxyDistance; a Trip Mine watches for an enemy
    // breaking its beam. Both fire the moment the condition is met (independent of the fuse).
    if (g.armed && g.combat) {
      if (g.combat.behavior === "mine") {
        if (nearestEnemyWithin(g.pos, g.combat.proxyDistance, g.ownerSid, sessions)) { detonateAoe(key, g, sessions); return; }
      } else if (g.combat.behavior === "tripmine" && g.ray) {
        const tripped = enemyCrossingRay(g.ray, g.tripLen || g.combat.tripRayLen, g.combat.tripRadius, g.ownerSid, sessions);
        if (tripped) {
          // Trip Mine deals DIRECT damage to the crosser (aoe 0 → no sphere), mirroring bundle :43870.
          dealGrenadeHit(tripped, g.ownerSid, g.combat.dmg * DMG_GLOBAL_MULT * LOBBY_DAMAGE_MULT, g.type, g.pos, sessions);
          activeEntities.delete(key); removedEntityKeys.push(key); return;
        }
      }
    }

    // Rocket Launcher ("impact"): explodes the instant it touches a live player mid-flight, not
    // just a wall — unlike every other entry in GRENADE_COMBAT it has no noPlayerCollision flag
    // client-side, so it can't pass through someone the way a thrown grenade does. Checked every
    // tick, same priority as the mine/tripmine triggers above. Guarded to the tick AFTER spawn
    // (never on g._bornTick itself) so the shooter's own capsule at the muzzle can't self-detonate
    // it the instant it's created — mirrors the client's own spawn-tick guard (bundle :43787).
    if (g.combat && g.combat.behavior === "impact" && (_live.globalTick || 0) > g._bornTick) {
      const victim = nearestEnemyWithin(g.pos, g.combat.directHitRadius || 1, g.ownerSid, sessions);
      if (victim) { detonateAoe(key, g, sessions); return; }
    }

    if (g.fuse <= 0) {
      if (!g.detonated) {   // don't re-fire if it already detonated on contact (impulse linger)
        if (g.type === 53) applyFlashBlind(g.pos, sessions);          // airborne flash times out → still blinds
        else if (g.type === 355) { applyImpulse(g.pos, sessions); disableNearbyGrenades(g.pos, IMPULSE_AOE, key); }  // airborne impulse → fling + defuse
        else if (g.combat && (g.combat.behavior === "timer" || g.combat.behavior === "sticky")) {
          // HE post-bounce timer / Sticky timer expired (or HE airburst if it never landed) → AoE.
          applyExplosionDamage(g.pos, g.combat.dmg, g.combat.aoe, g.ownerSid, g.type, sessions);
        }
        // mine / trip mine: lifetime expired untriggered → silent cleanup (no detonation).
      }
      activeEntities.delete(key);
      removedEntityKeys.push(key);
      return;
    }
    if (g.isStuck || g.settled) return;   // resting grenades neither move nor re-collide
    g.vel.y -= grenadeGravity(g.type) * dt;
    const dx = g.vel.x * dt, dy = g.vel.y * dt, dz = g.vel.z * dt;
    const dist = Math.hypot(dx, dy, dz);
    let detonate = false;
    // Raycast this tick's flight segment against world geometry (walls AND floor). A hit
    // means the grenade reached a wall/ground this tick → detonate at the hit point.
    const ray = (dist > 0.001 && bpw.ready)
      ? phys.raycastWorld(bpw.world, g.pos.x, g.pos.y, g.pos.z, dx, dy, dz, dist)
      : null;
    if (ray) {
      g.pos.x = ray.x; g.pos.y = ray.y; g.pos.z = ray.z;
      detonate = true;
    } else {
      g.pos.x += dx; g.pos.y += dy; g.pos.z += dz;
      // NO heightmap floor here. This used to fall back to getTerrainHeight(), which reads
      // bishop_heightmap.json — a BISHOP-ONLY grid. On every other map it happily returned a
      // Bishop floor height for the same XZ, so grenades stopped dead or bounced back off an
      // invisible surface in mid-air, while players and bullets (which use the real collision
      // world) passed straight through it. Even on Bishop the grid is coarse and reports the
      // HIGHEST floor level for a cell, which can sit well above the actual geometry.
      //
      // The evmap collision world is authoritative for every map now, and the raycast above
      // already covers walls and floors. The only remaining guard is the kill plane, which is a
      // real game rule rather than a geometry guess.
      if (g.pos.y < FALL_KILL_Y) { activeEntities.delete(key); removedEntityKeys.push(key); return; }
    }
    if (detonate) {
      // Surface normal at the contact: from the raycast, or straight up for the terrain-floor fallback.
      let nx = ray ? ray.nx : 0, ny = ray ? ray.ny : 1, nz = ray ? ray.nz : 0;
      const nlen = Math.hypot(nx, ny, nz);
      if (nlen < 1e-4) { nx = 0; ny = 1; nz = 0; }   // degenerate normal (no triangle normal) → use up
      else { nx /= nlen; ny /= nlen; nz /= nlen; }

      if (g.combat && g.combat.behavior === "timer") {
        // HE GRENADE: does NOT stick — it BOUNCES off walls and rolls on the ground, detonating on
        // its timer (started on the first contact, matching catalogue timerAfterCollision). Reflect
        // the velocity about the surface normal with restitution, then nudge off the surface so the
        // next raycast doesn't immediately re-hit. Keep simulating so it keeps rolling/bouncing.
        // Bounce VFX state. The client plays the 'grenadeBounce' smoke ring when the STREAMED
        // bounce counter changes and the impact speed exceeds 0.5 (bundle :50831):
        //   n.Qp9j5e3 !== i.Qp9j5e3 && n.Qxxwo42 > .5 && emit('grenadeBounce', ...)
        // Both come purely from the entity stream, so without them nobody sees a ring — not the
        // thrower and not peers. Impact speed is measured BEFORE the bounce damps the velocity, and
        // in client units (u/tick) because that is what the 0.5 threshold is expressed in.
        // Impact speed in CLIENT units (u/tick), measured before the bounce damps it.
        const impact = Math.hypot(g.vel.x, g.vel.y, g.vel.z) / 20;
        if (impact < GRENADE_SETTLE_SPEED) {
          // Too slow to be a real bounce: settle instead of micro-bouncing forever. Our raycast
          // hits again every tick once a grenade is resting on the floor, which inflated the bounce
          // counter (9 "bounces" while coming to rest) and made the client re-fire the smoke ring
          // each time the counter changed.
          g.vel.x = 0; g.vel.y = 0; g.vel.z = 0;
          g.settled = true;
          if (!g.bounced) { g.bounced = true; g.fuse = g.combat.fuse; }
        } else {
          g.bounces = (g.bounces || 0) + 1;
          g.impactSpeed = impact;
          // Split restitution/friction, exactly as the client's Q5vtwm does — see bounceVelocity.
          bounceVelocity(g.vel, nx, ny, nz);
        }
        g.pos.x += nx * 0.05; g.pos.y += ny * 0.05; g.pos.z += nz * 0.05;
        if (!g.bounced) { g.bounced = true; g.fuse = g.combat.fuse; }   // start the ~2s countdown
      } else if (g.combat && g.combat.behavior === "impact") {
        // ROCKET LAUNCHER: dumbfire — no gravity (see GRENADE_GRAVITY_BY_TYPE[8]), no bounce,
        // detonates on the FIRST wall/floor contact exactly like it does on a direct player hit
        // above. This is the client's `void 0 === m.gravity` branch (bundle :43917) — every other
        // projectile type here either bounces (timer) or sticks (sticky/mine/tripmine).
        detonateAoe(key, g, sessions);
        return;
      } else {
        g.vel.x = 0; g.vel.y = 0; g.vel.z = 0;
        g.isStuck = 1;
        if (g.type === 52) {
          // SMOKE: detonate-in-place → start the smoke cloud (Q66him0 hides the model + emits).
          g.qt6bqft = g.spawnTick;
        } else if (g.type === 53) {
          // FLASH: detonate on first wall/ground contact → blind everyone + remove.
          applyFlashBlind(g.pos, sessions);
          activeEntities.delete(key);
          removedEntityKeys.push(key);
        } else if (g.type === 355) {
          // IMPULSE: fling on first contact, then LINGER ~5 ticks before removing. The grenade
          // detonates instantly (model + raycast hit too fast otherwise), so without the linger
          // the entity is gone before the client builds its mesh → no projectile + no explosion
          // (the explosion plays on the mesh's removal). The 5-tick linger gives the model time
          // to load + renders the frag burst on removal. detonated=true blocks a re-fling.
          applyImpulse(g.pos, sessions);
          disableNearbyGrenades(g.pos, IMPULSE_AOE, key);   // defuse enemy traps in the blast
          g.detonated = true;
          // The blast has ALREADY been applied, so every tick of this linger is purely visual delay:
          // the client plays the explosion when the entity is removed, so the bang trails the actual
          // impact by exactly this many ticks. It was a hardcoded 5 (250ms), which is most of the
          // "detonation feels late on impact" report. It cannot go to 0 — the entity must survive
          // long enough for the client to build its mesh, or there is no projectile and no explosion
          // at all — so it is a trade-off, exposed rather than baked in.
          g.fuse = IMPULSE_LINGER_TICKS;
        } else if (g.combat) {
          // Sticky / Mine / Trip Mine: stick FLAT to the surface. Record the normal so the client
          // orients the model against the wall/ground (bundle :50739) AND stops the in-flight trail
          // particles a non-stuck entity emits every tick (:50790 — that was the "smoke" on mines).
          g.stuckNormal = { x: nx, y: ny, z: nz };
          // Lift the model out of the surface so it sits ON the wall/floor instead of sinking into it
          // (counters the client's −0.2·normal render embed; see STICK_SURFACE_OFFSET).
          g.pos.x += nx * STICK_SURFACE_OFFSET; g.pos.y += ny * STICK_SURFACE_OFFSET; g.pos.z += nz * STICK_SURFACE_OFFSET;
          if (g.combat.behavior === "sticky") {
            g.fuse = g.combat.fuse;                       // detonate (AoE) when the timer expires
          } else if (g.combat.behavior === "mine") {
            g.armed = false; g.armDelay = 30; g.fuse = MINE_LIFETIME;   // arms ~1.5s after planting
          } else if (g.combat.behavior === "tripmine") {
            g.armed = false; g.armDelay = 1; g.fuse = MINE_LIFETIME;    // beam live after 1 tick
            // Project the beam OUT from the wall along its normal, stopping at the first surface it
            // meets, so the visible tripwire (aimTarget, :50753) and the trip zone match the geometry.
            const len = g.combat.tripRayLen;
            let ex = g.pos.x + nx * len, ey = g.pos.y + ny * len, ez = g.pos.z + nz * len, tripLen = len;
            if (bpw.ready) {
              const hit = phys.raycastWorld(bpw.world, g.pos.x, g.pos.y, g.pos.z, nx, ny, nz, len);
              if (hit) { ex = hit.x; ey = hit.y; ez = hit.z; tripLen = Math.hypot(ex - g.pos.x, ey - g.pos.y, ez - g.pos.z); }
            }
            g.aimTarget = { x: ex, y: ey, z: ez };
            g.tripLen = tripLen;
            g.ray = { ox: g.pos.x, oy: g.pos.y, oz: g.pos.z, dx: nx, dy: ny, dz: nz };
          }
        }
      }
    }
  }
}

// Build the activeEntities delta block (non-destructive — same block goes to all clients).
function buildActiveEntityBlock() {
  const block = [];
  for (const [, g] of activeEntities) {
    // Stream the server-simulated position (248) every tick — the client renders it (it can't
    // simulate the entity itself). projVelocity (249) is cosmetic: it sets the grenade's facing
    // and a short flight trail (position - projVelocity*0.25). The client expects a small
    // magnitude (dir * projectileSpeed ≈ 0.9), so send the direction at that scale — NOT the
    // raw 26 u/s velocity, which scattered the trail ~6 units behind and over-rotated it.
    const sp = Math.hypot(g.vel.x, g.vel.y, g.vel.z) || 1;
    const pvx = g.vel.x / sp * 0.9, pvy = g.vel.y / sp * 0.9, pvz = g.vel.z / sp * 0.9;
    block.push(
      268, g.sessionId,
      246, g.sessionId,
      247, g.ownerSid,
      // round() routes non-finite values through fin(), which substitutes a safe number and logs.
      // The raw values used to go straight out here, unlike player transforms — so this was the one
      // path by which a NaN could still reach the client and brick it. Belt and braces: the sim step
      // already removes an entity with a bad position, and this is the last gate before msgpack.
      248, 0, round(g.pos.x, 6), round(g.pos.y, 6), round(g.pos.z, 6),
      249, 0, round(pvx, 6), round(pvy, 6), round(pvz, 6),
      250, g.spawnTick,
      251, 0,          // damage — utility grenades deal none
    );
    // 253 isStuck + 255 stuckNormal (submode 0 = full xyz): set once a sticky/mine/trip mine plants.
    // The client orients the model FLAT against the surface (lookAt position+stuckNormal, bundle
    // :50739) and — because a non-stuck entity spawns a trail particle every tick (:50790) — sending
    // isStuck STOPS that trail (the "smoke" the planted mine appeared to leak). Only damage grenades
    // that stick set g.stuckNormal, so smoke/flash/impulse are unchanged.
    if (g.stuckNormal) block.push(253, true, 255, 0, g.stuckNormal.x, g.stuckNormal.y, g.stuckNormal.z);
    // number_prop (259): explosion size. The client's removal explosion (Qwhyuq8 ~50434) only
    // fires when BOTH bounceStrength (read from the catalogue) AND number_prop are defined.
    // Sent only for the impulse (g.numberProp = aoe 11) so its frag burst plays; omitted for
    // smoke/flash so it stays undefined (sending it would trigger their projectile wobble).
    // 257 Qp9j5e3 bounce count · 258 Qxxwo42 impact speed — the pair that drives the bounce ring.
    // Ascending order matters: these sit between 256 and 259 in the client's forward scan.
    if (g.bounces) block.push(257, g.bounces | 0, 258, round(g.impactSpeed || 0, 3));
    if (g.numberProp) block.push(259, g.numberProp);
    block.push(
      260, g.type,     // weaponTypeId 52 smoke / 53 flash / 355 impulse / 46 HE / 172 sticky / 173 mine / 176 trip
      // Qt6bqft (261): null while flying (model visible, no smoke) → set to a frame when a
      // smoke grenade lands (model hides, cloud spawns). MUST always be sent explicitly —
      // omitting it decodes as undefined, and null!==undefined is true → false smoke.
      261, g.qt6bqft,
      262, true,       // isArmed
    );
    // 265 aimTarget (submode 0 = full xyz): the trip-mine beam endpoint. The client draws the visible
    // electrical tripwire from the mine to this point (:50753), giving players the hint. Trip mine only.
    if (g.aimTarget) block.push(265, 0, g.aimTarget.x, g.aimTarget.y, g.aimTarget.z);
    // 267 Qi98px5: this grenade was DEFUSED by an impulse blast — the client renders it disabled and
    // its detonation handler bails (Qtdn48t :43788). Only sent while disabled.
    if (g.disabled) block.push(267, true);
  }
  // Removals: this tick's, plus any still inside their re-announce window. Deduped — a key can be in
  // both, and sending `268,-1,key` twice in one block would stall the client's ascending scan.
  const sent = new Set();
  for (const key of removedEntityKeys) { if (!sent.has(key)) { sent.add(key); block.push(268, -1, key); } }
  for (const key of _entityRemovalRepeat.keys()) {
    if (!sent.has(key)) { sent.add(key); block.push(268, -1, key); }
  }
  return block;
}

// Splice the activeEntities block in just before opcode 280 (after every 244 player block,
// matching the decoder's scan order: 244 loop → activeEntities (268) → … → 280).
function flushActiveEntities(body) {
  const block = buildActiveEntityBlock();
  if (block.length === 0) return;
  const insertAt = body.lastIndexOf(280);
  if (insertAt >= 0) body.splice(insertAt, 0, ...block);
  else body.push(...block);
}

// ── Bullet / tracer stream (worldState.bulletMap) ──────────────────────────────────────
// Every shot spawns a bullet the client renders as a tracer, then ages out client-side (age>=5 →
// deleted, bundle 65684), so we emit each bullet exactly ONCE. Block marker is opcode 55; the
// decoder runs the bullet loop right after the lobbyData header and BEFORE the 244 player blocks
// (so buildTickBody inserts it there). Entry (ascending): 55,id · 46 sessionId · 47 age · 48
// ownerSid · 49 rayOrigin(sub-mode 0=full xyz) · 50 rayDirection · 51 hitDamage · 54 weaponType.
// Filled by spawnBullet() in fireHitscan, emitted by buildBulletBlock(), cleared after broadcast.
const _pendingBullets = [];
let _bulletIdCounter = 1;
function spawnBullet(ownerSid, origin, dir, dmg, weaponType) {
  _pendingBullets.push({
    id: _bulletIdCounter++, owner: ownerSid,
    ox: origin.x, oy: origin.y, oz: origin.z, dx: dir.x, dy: dir.y, dz: dir.z,
    dmg: dmg, wpn: weaponType,
  });
  if (_pendingBullets.length > 256) _pendingBullets.splice(0, _pendingBullets.length - 256);
}
function buildBulletBlock() {
  const out = [];
  for (const b of _pendingBullets) {
    out.push(
      55, b.id,
      46, b.id,
      47, 0,
      48, b.owner,
      49, 0, round(b.ox), round(b.oy), round(b.oz),
      50, 0, round(b.dx, 4), round(b.dy, 4), round(b.dz, 4),
      51, round(b.dmg, 4),
      54, b.wpn,
    );
  }
  return out;
}

// ── Hit-event stream (worldState.playerMap, block marker 67) ───────────────────────────
// Every confirmed hit emits a playerMap entry the client renders as the floating damage number +
// impact spark, and (for melee weapons owned by self) plays the hit ding. Block marker 67, decoded
// right after the bulletMap and BEFORE the 244 blocks; the client auto-ages entries out (age>=5).
// Entry (ascending): 67,id · 57 sessionId · 58 age · 59 string_prop(victimSid) · 60 Qo8o780(attacker)
// · 61 hitDamage · 62 Qwsv9a9(crit mult: 1 body / 1.5 head) · 63 smoothPos(impact, submode0) ·
// 64 aimPos(shooter eye, submode0) · 65/66 render flags(false). EVIO_HIT_EVENTS=0 disables (e.g. if
// the local shooter sees doubled numbers vs its own client prediction).
let HIT_EVENTS = S.define({
  key: "hitEvents", env: "EVIO_HIT_EVENTS", type: "bool", def: true,
  category: "Feedback", label: "Hit events (master)",
  desc: "Master switch for both hit-feedback channels below.",
}, (v) => { HIT_EVENTS = v; _recomputeHitChannels(); });
// Independent channels for bisecting the on-hit model flicker:
//   LASTHITINFO_EVENTS — the victim's lastHitInfo (opcodes 170-176) → damage-direction + hit reaction
//   PLAYERMAP_EVENTS    — the playerMap (67) → damage number + spark + melee ding
let _lastHitInfoOpt = S.define({
  key: "lastHitInfoEvents", env: "EVIO_LASTHITINFO", type: "bool", def: true,
  category: "Feedback", label: "lastHitInfo (170-176)",
  desc: "The victim's damage-direction indicator and hit reaction.",
}, (v) => { _lastHitInfoOpt = v; _recomputeHitChannels(); });
let _playerMapOpt = S.define({
  key: "playerMapEvents", env: "EVIO_PLAYERMAP", type: "bool", def: true,
  category: "Feedback", label: "playerMap (67)",
  desc: "Floating damage numbers, impact sparks, and the melee hit ding.",
}, (v) => { _playerMapOpt = v; _recomputeHitChannels(); });
// Both channels are gated by the master switch, so recompute whenever any of the three changes.
let LASTHITINFO_EVENTS = HIT_EVENTS && _lastHitInfoOpt;
let PLAYERMAP_EVENTS   = HIT_EVENTS && _playerMapOpt;
function _recomputeHitChannels() {
  LASTHITINFO_EVENTS = HIT_EVENTS && _lastHitInfoOpt;
  PLAYERMAP_EVENTS   = HIT_EVENTS && _playerMapOpt;
}
const _pendingHitEvents = [];
let _hitEventIdCounter = 1;
const _hitNoSidStats = { n: 0 };
function spawnHitEvent(attackerSid, victimSid, dmg, critMult, hitPos, aimPos, shotSid) {
  if (!PLAYERMAP_EVENTS) return;
  // DIAGNOSTIC. A hit with no shot sid is keyed by our numeric counter, which the client's prune
  // (`entry.Qkszhck in worldState.playerMap`, bundle :67131) can never match — so its predicted hit
  // survives until the 3-tick STALE path clears it. For those ~150ms the enemy bar shows the client's
  // prediction AND our streamed HP, i.e. double damage, then reverts. That is the "HP bar stutters
  // when damaged" report. Log it so we can see WHICH shots arrive without a sid rather than guess.
  if ((shotSid == null || shotSid === "") && RAY_DEBUG) {
    const q = _hitNoSidStats;
    q.n++;
    if (q.n <= 20 || q.n % 50 === 0) {
      console.log(`[evio-ray] hit event WITHOUT client sid (#${q.n}) — attacker=${attackerSid} `
        + `dmg=${dmg} — the client will double-count this on the victim bar for ~3 ticks`);
    }
  }
  _pendingHitEvents.push({
    // sid = the client's exact shot sessionId "f:p:a" (forwarded with the #SHOT# ray). When present we
    // key the playerMap entry by it so the client's hit-prediction prune (Qkszhck in playerMap) matches
    // and clears the prediction atomically with the HP drop — no double-subtract on the enemy bar.
    id: _hitEventIdCounter++, sid: (shotSid != null && shotSid !== "") ? String(shotSid) : null,
    victim: victimSid, attacker: attackerSid,
    dmg: dmg, crit: critMult,
    hx: hitPos ? hitPos.x : 0, hy: hitPos ? hitPos.y : 0, hz: hitPos ? hitPos.z : 0,
    ax: aimPos ? aimPos.x : 0, ay: aimPos ? aimPos.y : 0, az: aimPos ? aimPos.z : 0,
  });
  if (_pendingHitEvents.length > 256) _pendingHitEvents.splice(0, _pendingHitEvents.length - 256);
}
function buildPlayerMapBlock() {
  const out = [];
  for (const h of _pendingHitEvents) {
    // Key by the client's shot sessionId when we have it (so the prune matches), else fall back to the
    // numeric counter (server-reconstructed shots with no forwarded ray — prune clears via stale path).
    const key = h.sid != null ? h.sid : h.id;
    out.push(
      67, key,
      57, key,
      58, 0,
      59, h.victim,
      60, h.attacker,
      61, round(h.dmg, 4),
      62, round(h.crit, 4),
      63, 0, round(h.hx), round(h.hy), round(h.hz),
      64, 0, round(h.ax), round(h.ay), round(h.az),
      65, false,
      66, false,
    );
  }
  // Medals are a SEPARATE map from hit events. Opcode 67 keys into Qp29ls8.Qh8gbjd (the hit
  // events above); medals live in Qp29ls8.Qfw5vdx, whose entries start at opcode 74:
  //   74 entry key · 69 Q7q6byi · 70 Q616y7o · 71 Qwihvgr (recipient) · 72 Qwhr325 (medal key
  //   string) · 73 Qflcwh7 (points)
  // The client decodes the 67 loop first, then the 74 loop, so medals must follow the hit events
  // here — a single ascending scan would stall otherwise.
  for (const m of _pendingMedals) {
    out.push(
      74, m.id,
      69, m.id,
      70, 0,
      71, m.recipient,
      72, m.medal,
      73, m.points,
    );
  }
  return out;
}

// ── Intermission freeze ──────────────────────────────────────────────────────────────────────────
// Between rounds the official game holds everyone still. Ours kept simulating: players carried on
// running and falling through the scoreboard screen, and because the client STOPS reconciling while
// the match timer is <= 0 (bundle :67052), the two sides drifted apart with no correction until the
// round restarted and everyone snapped.
//
// The freeze is expressed through opcode 168 (Qpjho15) so the CLIENT applies the same rule to its own
// prediction — see the emit site. 1 is enough: the test is `> 0`.
function isIntermission() {
  return !!ROUNDS_ENABLED && match.gameMode !== 0;
}
function intermissionFreezeTicks() {
  return (INTERMISSION_FREEZE && isIntermission()) ? 1 : 0;
}

// Spawn-time counter reset, mirroring the two places the client does it: bundle :34385 (Q1nrrt6 = 0,
// Qalaptp = Qt2pzu8) and :34394 (Qett9p1 = 0, alongside full health).
//
// Qett9p1 is the one with a visible symptom. The client renders a peer at
//     Qgxywsl || Qett9p1 < 2 || Qq7zdfv <= 0  ?  raw position  :  lerp(prev, current)
// (bundle :51860) — for the first two ticks of a life it SNAPS instead of interpolating. We never
// reset it, so a respawning peer was always on the lerp branch and visibly slid across the whole map
// from where they died to where they respawned, through any geometry in between.
function applySpawnCounters(ps) {
  if (!ps) return;
  ps.Qett9p1 = 0;                        // 196 — ticks since spawn; < 2 disables peer interpolation
  ps.Qalaptp = SPAWN_PROTECT_TICKS > 0
    ? SPAWN_PROTECT_TICKS
    : -1;                                // 181 — the client's "no protection" value is -1, not 0
}

// ── Combat loop: server-authoritative hitscan → damage → death → respawn ───────────────
// The client only sends inputs; the server detects firing (action 5 = Shoot), raycasts the
// player's aim against other players, applies damage (armor then health, opcodes 166/167),
// and on healthPoints<=0 starts deathStateTimer (168) → respawn. HP is normalized 0..1.
let FIRE_COOLDOWN_TICKS = S.define({
  key: "fireCooldownTicks", type: "int", def: 3, min: 1, max: 100,
  category: "Combat", label: "Fallback fire cooldown (ticks)",
  desc: "Used only for weapons missing a catalogue cooldown; the real rate is per-weapon.",
}, (v) => { FIRE_COOLDOWN_TICKS = v; });
let DMG_GLOBAL_MULT = S.define({
  key: "dmgGlobalMult", type: "number", def: 0.01, min: 0, max: 1, step: 0.001,
  category: "Combat", label: "Global damage mult (Qalrljx)",
  desc: "Scales catalogue damage into normalized 0..1 HP. 0.01 is the client's value — changing "
      + "it makes server damage disagree with the client's own prediction.",
}, (v) => { DMG_GLOBAL_MULT = v; });

// THE SYNCED WAY TO SCALE DAMAGE.
//
// The client PREDICTS damage for its own health bar: Q2ngzid subtracts from Qq7zdfv and Qd032mo
// locally, and even decides the kill. That prediction ends with `o *= Qsvkg5s.Qbb5ka8` — a global
// damage multiplier in game settings, which is opcode 27, and which we were never sending.
//
// So dmgGlobalMult above is the WRONG knob for balance: it is a unit conversion (catalogue damage ->
// normalized 0..1 HP, matching the 0.01 the client bakes into its own explosion formula), and
// changing it makes the server disagree with a prediction the client is still making. The bar shows
// one number, then snaps to another.
//
// This one is applied on BOTH sides — written into gameSettings.Qbb5ka8 so our sim uses it, streamed
// as opcode 27 so the client's prediction uses the same value, and folded into our own damage path.
let DAMAGE_SCALE = S.define({
  key: "damageScale", env: "EVIO_DAMAGE_SCALE", type: "number", def: 1, min: 0, max: 20, step: 0.05,
  category: "Combat", label: "Damage multiplier (x normal)",
  desc: "Scales ALL damage. 1 = the real game. 2 = everything hurts twice as much. 0 = nobody can be "
      + "hurt. Applied to the server AND streamed to the client (opcode 27) so the health bar the "
      + "client predicts matches what the server actually applies. Prefer this over dmgGlobalMult.",
}, (v) => { DAMAGE_SCALE = v; applyDamageScaleToWorld(); });

function applyDamageScaleToWorld() {
  const gs = bpw && bpw.gameSettings;
  if (gs) gs.Qbb5ka8 = DAMAGE_SCALE;
}
bpw.ready.then(applyDamageScaleToWorld).catch(() => {});
let HEADSHOT_MULT = S.define({
  key: "headshotMult", type: "number", def: 1.5, min: 1, max: 10, step: 0.05,
  category: "Combat", label: "Headshot multiplier (Q9r9lxn)",
  desc: "Default head multiplier; per-weapon overrides still win.",
}, (v) => { HEADSHOT_MULT = v; });
// Per-weapon headshot multiplier overrides (most are 1.5; measured from an official capture).
// nid 701 (Sweeper) = 1.33 (head 6.4 / body 4.8). nid 281 (Desert Eagle) = 1.55 (base dmg 65,
// reported official headshot = 101 at 1x damage multiplier: 65*1.55=100.75, rounds to 101 — the
// default 1.5 gives 97.5->98, visibly short). Add others here as captures reveal them.
const WEAPON_HEADSHOT_MULT = { 701: 1.33, 281: 1.55 };
let LOBBY_DAMAGE_MULT = S.define({
  key: "lobbyDamageMult", type: "number", def: 1.0, min: 0, max: 20, step: 0.1,
  category: "Gameplay", label: "Lobby damage multiplier",
  desc: "lobbyData.damageMultiplier. Deathmatch = 1.0. Raise for a faster-killing lobby.",
}, (v) => { LOBBY_DAMAGE_MULT = v; });
let BOT_DAMAGE_MULT = S.define({
  key: "botDamageMult", env: "EVIO_BOT_DAMAGE_MULT", type: "number", def: 1.0, min: 0, max: 5, step: 0.05,
  category: "Bots", label: "Bot damage multiplier",
  desc: "Extra multiplier applied ONLY to damage a BOT deals (checked via the shooter's owning "
      + "session, applyHit) — stacks with dmgGlobalMult/lobbyDamageMult, which still apply to "
      + "everyone. Lower it to make bots less lethal for a softer lobby without touching real-player "
      + "damage, or raise it for bots that hit harder without changing their aim/reaction skill "
      + "(botLevel/bot_difficulty.js stays purely about accuracy and movement).",
}, (v) => { BOT_DAMAGE_MULT = v; });
let BOT_FRIENDLY_FIRE = S.define({
  key: "botFriendlyFire", env: "EVIO_BOT_FRIENDLY_FIRE", type: "bool", def: true,
  category: "Bots", label: "Bots can damage each other",
  desc: "OFF blocks damage between two DIFFERENT bots entirely — checked via each side's owning "
      + "session (applyDamage), the same resolution botDamageMult uses. A bot vs a real player is "
      + "never affected, and a bot's own self-damage (a fall, its own grenade going off nearby) is "
      + "never affected either — this only ever blocks bot-on-bot. ON (default) matches every other "
      + "player: bots can kill each other same as anyone.",
}, (v) => { BOT_FRIENDLY_FIRE = v; });
let RESPAWN_TICKS = S.define({
  key: "respawnTicks", type: "int", def: 60, min: 0, max: 600,
  category: "Gameplay", label: "Respawn delay (ticks)",
  desc: "Ticks dead before respawning. 60 = ~3s at 20Hz.",
}, (v) => { RESPAWN_TICKS = v; });
// Qalaptp / opcode 181. The client already enforces this: Q2ngzid (its damage-eligibility check,
// bundle :34453) returns null while Qalaptp > 0, so a protected player takes no damage from the
// shooter's own local hit path either. Both sides have to agree — if only the server protected, the
// client would keep applying local damage and the health bar would drop and snap back, which is the
// same double-damage artefact we chased before. 40 ticks (2s) is the client's own Qt2pzu8.
// How long a player's input queue may be empty before the server simulates them anyway. Must be more
// than a normal hiccup (a dropped packet, a slow frame) and less than the point at which a frozen
// player becomes noticeable to everyone else. 10 ticks = 500ms.
let IDLE_SIM_GRACE_TICKS = S.define({
  key: "idleSimGraceTicks", env: "EVIO_IDLE_SIM_GRACE", type: "int", def: 10, min: 0, max: 400,
  category: "Netcode", label: "Idle simulation grace (ticks)",
  desc: "Ticks with no client input before the server simulates a player with empty input, so a "
      + "backgrounded tab still falls, takes knockback and runs its timers. 0 disables it (the old "
      + "behaviour: the player freezes until input resumes).",
}, (v) => { IDLE_SIM_GRACE_TICKS = v; });

let SPAWN_PROTECT_TICKS = S.define({
  key: "spawnProtectTicks", env: "EVIO_SPAWN_PROTECT", type: "int", def: 40, min: 0, max: 600,
  category: "Gameplay", label: "Spawn protection (ticks)",
  desc: "Invulnerable ticks after spawning or respawning. 40 = 2s at 20Hz, matching official ev.io "
      + "(Q4b9iia.Qt2pzu8). 0 disables it.",
}, (v) => { SPAWN_PROTECT_TICKS = v; });

let PLAYER_HALF_WIDTH = S.define({
  key: "playerHalfWidth", type: "number", def: 0.5, min: 0.1, max: 3, step: 0.05,
  category: "Combat", label: "Hitbox half-width (u)",
  desc: "Half-width of the axis-aligned hit box used by the server's ray test.",
}, (v) => { PLAYER_HALF_WIDTH = v; });
let PLAYER_HEIGHT = S.define({
  key: "playerHeight", type: "number", def: 1.8, min: 0.5, max: 5, step: 0.05,
  category: "Combat", label: "Hitbox height (u)",
  desc: "Height of the hit box measured from the feet.",
}, (v) => { PLAYER_HEIGHT = v; });
let HEAD_Y = S.define({
  key: "headY", type: "number", def: 1.65, min: 0, max: 5, step: 0.05,
  category: "Combat", label: "Headshot threshold Y (u)",
  desc: "A hit above feet + this counts as a headshot.",
}, (v) => { HEAD_Y = v; });
// Shooter eye height = the EXACT camera height the client raycasts from (bundle 64718):
//   feet.y + (crouching ? Qymlxst(1.0) : Qyohfua(1.8)) * scale.
// The old flat 1.6 started the ray ~0.2u too low, so level shots landed below where the client
// aimed → headshots (Qh04ltj from the capsule head region) were scored as body shots.
let STAND_EYE_Y = S.define({
  key: "standEyeY", type: "number", def: 1.8, min: 0.1, max: 5, step: 0.05,
  category: "Combat", label: "Standing eye height (u)",
  desc: "Bundle Qyohfua. The exact camera height the client raycasts from — must match or "
      + "level shots land low.",
}, (v) => { STAND_EYE_Y = v; });
let CROUCH_EYE_Y = S.define({
  key: "crouchEyeY", type: "number", def: 1.0, min: 0.1, max: 5, step: 0.05,
  category: "Combat", label: "Crouched eye height (u)",
  desc: "Bundle Qymlxst.",
}, (v) => { CROUCH_EYE_Y = v; });

// Ray vs an axis-aligned player box (feet at pos.y). Slab method. Returns {dist,head} or null.
function rayVsPlayerBox(eye, dir, pos) {
  const axes = [
    [eye.x, dir.x, pos.x - PLAYER_HALF_WIDTH, pos.x + PLAYER_HALF_WIDTH],
    [eye.y, dir.y, pos.y,                     pos.y + PLAYER_HEIGHT],
    [eye.z, dir.z, pos.z - PLAYER_HALF_WIDTH, pos.z + PLAYER_HALF_WIDTH],
  ];
  let tmin = 0, tmax = Infinity;
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-8) { if (o < lo || o > hi) return null; }
    else {
      let t1 = (lo - o) / d, t2 = (hi - o) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  if (tmin <= 0) return null;   // behind the shooter / inside the box
  return { dist: tmin, head: (eye.y + dir.y * tmin) > pos.y + HEAD_Y };
}

// Apply damage to a victim (armor absorbs first). Starts the death state at <=0.
// `attacker` is optional: pass the shooter's playerState so the kill is credited. Fall damage and
// other world kills pass nothing, which still counts the death.
// Every guest shares ev.io's single guest account (GUEST_UID, declared with the scoring constants),
// so the uid identifies a guest but cannot distinguish one from another.
//
// A name we are allowed to replace with a numbered one: the bare default a guest arrives with,
// or nothing at all. A player who set a real name keeps it.
function isGuestName(name) {
  if (!name) return true;
  const n = String(name).trim();
  return n === "" || n === "Guest" || /^local-/.test(n) || /^Guest\d{1,4}$/.test(n);
}

// "Guest" + 1..9999, matching the official server's format. Collisions are avoided by checking the
// names already in the lobby: with a handful of players a random pick is almost always free, and
// after enough tries we fall back to a scan so this can never loop forever on a full lobby.
function allocateGuestName(sessions) {
  const taken = new Set();
  for (const s of (sessions ? sessions.values() : [])) {
    if (s && s.displayName) taken.add(String(s.displayName));
  }
  for (let i = 0; i < 50; i++) {
    const candidate = `Guest${1 + Math.floor(Math.random() * 9999)}`;
    if (!taken.has(candidate)) return candidate;
  }
  for (let n = 1; n <= 9999; n++) {
    if (!taken.has(`Guest${n}`)) return `Guest${n}`;
  }
  return `Guest${1 + Math.floor(Math.random() * 9999)}`;   // lobby of 9999 guests; give up gracefully
}

// Resolve a session's account uid from its sessionId / playerState — needed for the guest score
// multiplier (uid 17 = GUEST_UID scores x0.3).
function _uidForSession(sessions, sid) {
  if (!sessions) return undefined;
  for (const s of sessions.values()) if (s && s.sessionId === sid) return s.uid;
  return undefined;
}
function _uidForPlayerState(sessions, ps) {
  if (!sessions) return undefined;
  for (const s of sessions.values()) if (s && s.playerState === ps) return s.uid;
  return undefined;
}

// ── Health regeneration (bundle :34554-34558) ────────────────────────────────────────────────
// Two ways to start regenerating, and the kill path is the reason the game feels forgiving:
//   * ordinary: no damage taken for REGEN_DELAY ticks;
//   * after a kill: REGEN_AFTER_KILL_TICKS after the kill, regardless of the damage timer.
// Once started it continues until HP is full or you are hit again. HP is 0..1, so the rate is a
// FRACTION of max health per tick.
//
//   if (regenXTicksAfterKill !== undefined && ticksSinceKill === regenXTicksAfterKill)
//       forceRegen = true;
//   if (hp < max && !dead && (ticksSinceDamage > delay && !noHealthRegen || forceRegen))
//       hp = min(max, hp + Qewwuid);
//   else forceRegen = false;
//
// Taking damage resets ticksSinceDamage AND clears forceRegen (:34472), so a kill does not make
// you immune to being interrupted.
let REGEN_DELAY = S.define({
  key: "regenDelayTicks", env: "EVIO_REGEN_DELAY", type: "int", def: 100, min: 0, max: 600,
  category: "Combat", label: "Regen delay (ticks)",
  desc: "Ticks without taking damage before health regenerates. Bundle Q4b9iia.Qmu3ptg = 100 (5s).",
}, (v) => { REGEN_DELAY = v; });
let REGEN_AFTER_KILL_TICKS = S.define({
  key: "regenAfterKillTicks", env: "EVIO_REGEN_AFTER_KILL", type: "int", def: 20, min: 0, max: 600,
  category: "Combat", label: "Regen after kill (ticks)",
  desc: "Ticks after a kill before health regenerates, bypassing the damage timer. Deathmatch "
      + "gameConfig regenXTicksAfterKill = 20 (1s).",
}, (v) => { REGEN_AFTER_KILL_TICKS = v; });
let REGEN_RATE = S.define({
  key: "regenRate", env: "EVIO_REGEN_RATE", type: "number", def: 0.01, min: 0, max: 1, step: 0.005,
  category: "Combat", label: "Regen per tick",
  desc: "Health restored per tick, as a fraction of max (HP is 0..1). Bundle Q4b9iia.Qewwuid = "
      + "0.01, i.e. a full heal takes 100 ticks / 5s.",
}, (v) => { REGEN_RATE = v; });
let REGEN_ENABLED = S.define({
  key: "healthRegen", env: "EVIO_HEALTH_REGEN", type: "bool", def: true,
  category: "Combat", label: "Health regeneration",
  desc: "Off reproduces a gamemode with noHealthRegen.",
}, (v) => { REGEN_ENABLED = v; });

// Advance the regen timers and heal. Call once per server tick, per player.
function tickHealthRegen(p) {
  if (!p) return;
  p.ticksSinceDamage = (p.ticksSinceDamage || 0) + 1;
  p.ticksSinceKill = (p.ticksSinceKill || 0) + 1;
  if (p.deathStateTimer > 0) return;                 // dead players do not regenerate

  // Fires on the exact tick, matching the client's `=== round(regenXTicksAfterKill)`.
  if (p.ticksSinceKill === REGEN_AFTER_KILL_TICKS) p.forceRegen = true;

  const max = 1;
  const byTimer = p.ticksSinceDamage > REGEN_DELAY && REGEN_ENABLED;
  if (p.healthPoints < max && (byTimer || p.forceRegen)) {
    p.healthPoints = Math.min(max, Number((p.healthPoints + REGEN_RATE).toFixed(4)));
  } else {
    p.forceRegen = false;
  }
}

function applyDamage(victim, amount, attacker, opts) {
  // Spawn protection, matching the client's own gate (Q2ngzid, bundle :34453: `if (Qalaptp > 0)
  // return null`). It must be checked here rather than at each call site so every damage source is
  // covered — hitscan, melee, explosions, mines — because the client rejects them all uniformly and
  // any source we let through would show as a health bar that drops and then snaps back.
  //
  // World damage (fall deaths, the kill plane) is NOT exempt on the client either: Q2ngzid is the
  // single funnel for all of it, so a protected player surviving a fall is faithful, not a loophole.
  // The protection window is 2s and the kill plane is far below any spawn, so this cannot strand
  // anyone.
  if (victim && victim._ps && Number.isFinite(victim._ps.Qalaptp) && victim._ps.Qalaptp > 0) return;
  // A player waiting to play is not in the match. The client refuses damage for any state other than
  // 1 (Q2ngzid, :34450), so the server has to agree — accepting it here would drop their health bar
  // and snap it back, the same artefact spawn protection had to avoid.
  if (victim && victim._holdForPlay) return;
  // Bot-vs-bot friendly fire gate. attacker/victim are playerStates, which carry no isBot flag of
  // their own, so the caller resolves each side via its OWNING SESSION and passes the result in
  // opts (opts.attackerIsBot/victimIsBot) — the exact same resolution botDamageMult already does at
  // the applyHit call site. Threading it through opts rather than looking up a global session
  // registry here keeps applyDamage testable with a synthetic sessions map (see test_bot_settings.js)
  // and correct if it's ever called against anything other than the live game's session set.
  // `attacker !== victim` excludes self-damage (a bot's own fall, or its own grenade catching it) —
  // this only ever blocks damage between two DIFFERENT bots.
  if (!BOT_FRIENDLY_FIRE && attacker && attacker !== victim
      && opts && opts.attackerIsBot && opts.victimIsBot) {
    return;
  }
  // The global damage scale, applied HERE so every damage source goes through it exactly once —
  // bullets, explosions, melee, fall damage. The client applies the same factor to its own predicted
  // health bar via Qsvkg5s.Qbb5ka8 (opcode 27), so the two agree; see the DAMAGE_SCALE note.
  let o = amount * DAMAGE_SCALE;
  if (o > victim.armorPoints) {
    o -= victim.armorPoints; victim.armorPoints = 0;
    if (o > victim.healthPoints) o = victim.healthPoints;
    victim.healthPoints -= o;
  } else {
    victim.armorPoints -= o;
  }
  victim.healthPoints = Math.max(0, Number(victim.healthPoints.toFixed(4)));
  // Being hit restarts the regen wait and cancels a kill-granted regen (bundle :34472).
  victim.ticksSinceDamage = 0;
  victim.forceRegen = false;
  // Remember the attacker so they can earn an assist if someone else finishes the job.
  recordDamager(victim, attacker);
  if (victim.healthPoints <= 0 && victim.deathStateTimer <= 0) {
    victim.deathStateTimer = 1;
    victim.killStreak = 0;   // dying ends the streak (bundle :34440)
    // The KILLER's post-kill regen window starts here (bundle :34437 sets Qezc1on = 0).
    if (attacker && attacker !== victim) {
      // Read the gap BEFORE resetting it: a kill inside the window extends the multikill chain,
      // anything slower starts a new one (bundle :34437).
      attacker.multiKill = (attacker.ticksSinceKill < MULTIKILL_WINDOW)
        ? (attacker.multiKill || 1) + 1 : 1;
      attacker.ticksSinceKill = 0;
    }
    // Assists first: the killer must already be known so they can be excluded, but the scoreboard
    // has not been touched yet.
    const assisted = awardAssists(victim, attacker || null);
    creditKill(attacker || null, victim, opts);
    if (assisted) console.log(`[evio-local] ${assisted} assist(s) awarded`);
    console.log(`[evio-local] player killed`
      + (attacker && attacker !== victim ? ` by ${attacker.id || "?"} (kills=${attacker.kills})` : ""));
  }
}

// Per-player position history for lag compensation. Each entry is the feet position the player
// occupied at one client tick; ring-buffered to the last LAGCOMP_HISTORY ticks. Recorded only
// when lag-comp is enabled (otherwise it's wasted work).
function recordPositionSnapshot(session, serverTick) {
  if (!LAGCOMP) return;
  const ps = session.playerState && session.playerState._ps;
  if (!ps || !ps.Qdsukt4) return;
  const h = session._posHistory || (session._posHistory = []);
  // One entry per server tick: overwrite if this tick was already recorded (catch-up drains many
  // client ticks within one globalTick — we only want the final position for that server tick).
  if (h.length && h[h.length - 1].tick === serverTick) {
    h[h.length - 1].x = ps.Qdsukt4.x; h[h.length - 1].y = ps.Qdsukt4.y; h[h.length - 1].z = ps.Qdsukt4.z;
  } else {
    h.push({ tick: serverTick, x: ps.Qdsukt4.x, y: ps.Qdsukt4.y, z: ps.Qdsukt4.z });
    if (h.length > LAGCOMP_HISTORY) h.splice(0, h.length - LAGCOMP_HISTORY);
  }
}

// Where to rewind a victim: their recorded position at-or-before `targetServerTick` (the server
// tick the shooter last saw). Returns {x,y,z} or null when history doesn't reach back that far
// (then the caller leaves the live position — better to use current than to guess).
function positionAtTick(session, targetServerTick) {
  const h = session._posHistory;
  if (!Array.isArray(h) || h.length === 0) return null;
  for (let i = h.length - 1; i >= 0; i--) if (h[i].tick <= targetServerTick) return h[i];
  return null;
}

// Interpolated rewind: where the SHOOTER actually rendered this target = lerp between its position
// at the two server ticks the client was interpolating (A=prevTick, B=currTick) at `alpha`. This
// matches the client's Qcw4fab lerp; a single floored tick (alpha=0) leaves moving targets behind.
function positionAtTickInterp(session, prevTick, currTick, alpha) {
  const b = positionAtTick(session, currTick);
  if (!b) return null;
  if (!(prevTick < currTick)) return b;          // same/invalid window → just the newer frame
  const a = positionAtTick(session, prevTick);
  if (!a || a === b) return b;                    // history floored both to the same entry
  return {
    x: a.x + (b.x - a.x) * alpha,
    y: a.y + (b.y - a.y) * alpha,
    z: a.z + (b.z - a.z) * alpha,
  };
}

// ── Peer-broadcast position smoothing ───────────────────────────────────────────────────────────
// REPORTED SYMPTOM: a player with a high/unstable ping (200-400ms, packet loss) appears to OTHER
// players as constantly teleporting instead of moving smoothly — even though the player's own
// connection is server-authoritative and their true simulated position is correct every tick.
//
// ROOT CAUSE: a stalled connection delivers input in BURSTS (TCP head-of-line blocking — one lost
// packet stalls everything behind it until retransmission, then it all arrives at once). When that
// burst is drained, processBufferedTick correctly advances the player's TRUE position through every
// buffered tick — but the broadcast only samples the FINAL result once, at the end of that one
// server tick. Up to INPUT_BUFFER_MAX_CATCHUP ticks' worth of real movement (up to 3+ seconds at the
// live default) lands in a single visible update. Every OTHER client's peer-interpolation (lerp
// between the last two states it received) has no way to know that jump represents several seconds
// of motion rather than one 50ms tick, so it renders as an instant teleport.
//
// FIX: peers are shown a SEPARATE, SMOOTHED position that eases toward the true simulated position
// at a bounded max speed — decoupled from however bursty the source player's own connection is. This
// is what makes "server peers isolated from client condition" literal: the peer view is authored by
// the server's own pacing, never by however input happened to arrive. The player's OWN client still
// sees (and reconciles against) the TRUE position — self-view is intentionally untouched, both
// because the player's own reconciliation needs the real value and because lag-compensated hit
// registration (recordPositionSnapshot/positionAtTick) reads the true simulated position, never this
// smoothed one. Genuine instant repositioning (teleporter, respawn, admin teleport) SNAPS instead of
// easing — those are meant to look instantaneous, not like a fast slide.
let PEER_SMOOTH_MAX_SPEED = S.define({
  key: "peerSmoothMaxSpeed", env: "EVIO_PEER_SMOOTH_MAX_SPEED", type: "number", def: 40, min: 5, max: 500,
  category: "Netcode", label: "Peer broadcast max speed (u/s) — fallback",
  desc: "Cap used only when adaptive smoothing is OFF (peerSmoothAdaptive=false), or as the value "
      + "callers get if they don't ask for a per-player adaptive cap. Prefer peerSmoothAdaptive for "
      + "real players — see peerSmoothCapFor.",
}, (v) => { PEER_SMOOTH_MAX_SPEED = v; });

// ── Adaptive peer smoothing ──────────────────────────────────────────────────────────────────────
// The fixed cap above is a single global tradeoff: tight enough to hide a bursty connection's snap,
// but that SAME tightness adds a needless, permanent catch-up lag to every player with a perfectly
// smooth connection who never needed smoothing in the first place. There is no one number that is
// right for both a LAN player and a 700ms VPN tunnel.
//
// So the cap is derived PER SOURCE PLAYER from their own recently observed burst behaviour
// (session._burstLevel, fed by processBufferedTick) rather than fixed. A player whose input arrives
// one tick at a time (burstLevel stays at 1) gets peerSmoothStableSpeed — high enough it never
// engages, i.e. zero added delay. A player whose uplink is dumping several ticks at once gets
// smoothed down toward peerSmoothBurstySpeed, same as the fixed cap used to unconditionally. Every
// player in between gets a proportional cap — no admin has to notice a bad connection and hand-tune
// a setting; the tightness follows the actual current condition and relaxes again once it improves.
let PEER_SMOOTH_ADAPTIVE = S.define({
  key: "peerSmoothAdaptive", env: "EVIO_PEER_SMOOTH_ADAPTIVE", type: "bool", def: true,
  category: "Netcode", label: "Adaptive peer smoothing (per-player, ping/burst-aware)",
  desc: "true (default) = derive each player's own peer-broadcast smoothing cap from THEIR recent "
      + "burst behaviour — stable connections get no added delay, bursty ones get smoothed toward "
      + "peerSmoothBurstySpeed. false = use the single fixed peerSmoothMaxSpeed for everyone.",
}, (v) => { PEER_SMOOTH_ADAPTIVE = v; });
let PEER_SMOOTH_STABLE_SPEED = S.define({
  key: "peerSmoothStableSpeed", env: "EVIO_PEER_SMOOTH_STABLE_SPEED", type: "number", def: 250, min: 20, max: 2000,
  category: "Netcode", label: "Adaptive smoothing cap — stable connection (u/s)",
  desc: "Cap applied to a player whose burstLevel is at its floor (1 — input arriving one tick at a "
      + "time, no catch-up bursts). Set far above any real movement speed so smoothing never visibly "
      + "engages for a healthy connection — this is the whole point of making it adaptive.",
}, (v) => { PEER_SMOOTH_STABLE_SPEED = v; });
let PEER_SMOOTH_BURSTY_SPEED = S.define({
  key: "peerSmoothBurstySpeed", env: "EVIO_PEER_SMOOTH_BURSTY_SPEED", type: "number", def: 13.5, min: 5, max: 200,
  category: "Netcode", label: "Adaptive smoothing cap — bursty connection (u/s)",
  desc: "Cap applied to a player whose burstLevel is at or above peerSmoothBurstSaturation (their "
      + "uplink is regularly dumping several ticks at once). Set at or just above normal run speed so "
      + "a catch-up never visibly outpaces ordinary movement — it just takes longer to fully close.",
}, (v) => { PEER_SMOOTH_BURSTY_SPEED = v; });
let PEER_SMOOTH_BURST_SATURATION = S.define({
  key: "peerSmoothBurstSaturation", env: "EVIO_PEER_SMOOTH_BURST_SAT", type: "number", def: 6, min: 2, max: 20,
  category: "Netcode", label: "Adaptive smoothing — burst level at full penalty",
  desc: "burstLevel (peak ticks drained in one server tick, decayed over time) at which a player "
      + "reaches the FULL bursty-speed cap. Between 1 and this, the cap interpolates linearly between "
      + "peerSmoothStableSpeed and peerSmoothBurstySpeed.",
}, (v) => { PEER_SMOOTH_BURST_SATURATION = v; });
let BURST_LEVEL_DECAY = S.define({
  key: "peerSmoothBurstDecay", type: "number", def: 0.985, min: 0.8, max: 0.999,
  category: "Netcode", label: "Adaptive smoothing — burst-level decay per tick",
  desc: "Per-tick multiplicative decay on the peak-hold burst tracker. 0.985 at 20Hz ≈ 2s to relax "
      + "back toward calm after the last burst — long enough that a rhythmic bursty connection stays "
      + "recognised as bursty between bursts, short enough that a connection which genuinely recovers "
      + "(VPN reconnects, congestion clears) is treated as stable again within a few seconds.",
}, (v) => { BURST_LEVEL_DECAY = v; });

// The cap to use for ONE source player this tick. `session` may be undefined (bots, or callers that
// only have a playerState) — falls back to the fixed cap, same as adaptive being off.
function peerSmoothCapFor(session) {
  if (!PEER_SMOOTH_ADAPTIVE || !session) return PEER_SMOOTH_MAX_SPEED;
  const level = session._burstLevel || 1;
  if (level <= 1) return PEER_SMOOTH_STABLE_SPEED;
  const t = Math.min(1, (level - 1) / Math.max(1e-6, PEER_SMOOTH_BURST_SATURATION - 1));
  return PEER_SMOOTH_STABLE_SPEED + (PEER_SMOOTH_BURSTY_SPEED - PEER_SMOOTH_STABLE_SPEED) * t;
}

// ── Peer replay queue ────────────────────────────────────────────────────────────────────────────
// A capped-SPEED ease (peerSmoothCapFor/updateBroadcastPosition) takes a shortcut: it interpolates
// straight from the last shown position toward wherever the player IS NOW, which is correct for a
// single physics-driven jump (explosion knockback) but wrong for an input-catchup burst — when
// processBufferedTick drains 4 buffered client ticks in one server tick, the player's true position
// already reflects 4 real, DIFFERENT intermediate positions, and easing toward only the last one
// discards the actual path taken. Because a full-speed ease can close a small burst gap in a single
// tick, the peer ends up watching a brief stretch of faster-than-normal motion — visibly a "dash",
// even though it is never an instant teleport.
//
// This queue instead records the REAL position after every sub-tick simulated inside a drain (see
// the push in processBufferedTick's batch loop) and releases exactly one entry per server tick — so
// a peer always sees genuine positions at the speed they actually happened, just delayed by however
// deep the backlog was, and the delay drains back to zero on its own once the burst passes. A stable
// connection never accumulates more than 0-1 entries, so this adds no delay for it at all.
// DEFAULT RAISED 20 -> 40 (1s -> 2s at 20Hz). Reported live: a real player on a genuinely long-haul
// connection (Australia, real geographic RTT ~300-400ms) saw their OWN ping spike as high as 1300ms
// under normal jitter, and every other player watched them "float and glitch" — the queue was
// overflowing on the bigger spikes, silently dropping the oldest queued real positions (see the
// drop-oldest comment below), so peers periodically watched a discontinuous jump instead of the
// intended smooth catch-up. 40 ticks covers a genuine ~2s worst-case burst with real margin over the
// observed 1300ms peaks; a STABLE connection still never accumulates more than 0-1 entries regardless
// of the cap, so this costs nothing for anyone else.
let PEER_REPLAY_QUEUE_MAX = S.define({
  key: "peerReplayQueueMax", env: "EVIO_PEER_REPLAY_QUEUE_MAX", type: "int", def: 40, min: 2, max: 200,
  category: "Netcode", label: "Peer replay queue cap (ticks)",
  desc: "Hard cap on how many real sub-tick positions can be queued for smooth replay to peers, per "
      + "source player. Bounds worst-case peer-visible delay to this many ticks (40 ≈ 2s at 20Hz, "
      + "raised from 20 after a genuinely-long-haul connection's ping spikes overflowed the smaller "
      + "cap and caused visible floating/glitching for everyone watching them). A backlog beyond this "
      + "drops the OLDEST queued position rather than growing further — matches this codebase's "
      + "existing input-queue drop-oldest convention (unbounded growth is accumulation, not smoothing).",
}, (v) => { PEER_REPLAY_QUEUE_MAX = v; });

// Called once per sub-tick actually simulated inside a drain (processBufferedTick's batch loop, and
// the idle-sim path) — records the REAL resulting position for later smooth release to peers.
//
// Tags the entry with playerState.justTeleported AS OF THIS SUB-TICK. This matters because a burst
// can drain several client ticks in one server-tick call, and a map portal (Qgxywsl) can fire on ANY
// one of them — g() resets the flag at the start of every sub-tick, so by the time the whole burst
// finishes, playerState.justTeleported only reflects the LAST sub-tick, not whichever one actually
// teleported. Without a per-entry tag, a portal crossing buried inside a burst would be queued like
// ordinary motion and later released through updateBroadcastPosition's capped ease — replaying an
// instant teleport as a slow slide across the map instead of a snap.
function pushReplaySnapshot(session, playerState) {
  const p = playerState.position;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
  let q = session._peerReplayQueue;
  if (!q) q = session._peerReplayQueue = [];
  q.push({ x: p.x, y: p.y, z: p.z, teleported: !!playerState.justTeleported });
  if (q.length > PEER_REPLAY_QUEUE_MAX) q.shift();
}

// Called once per server tick, before updateBroadcastPosition — returns the position peers should
// move TOWARD this tick: the oldest still-queued real sub-tick position (tagged `teleported` if THAT
// specific sub-tick was a portal fire — updateBroadcastPosition snaps instead of easing for those),
// or null when there is no backlog (caught up — updateBroadcastPosition then eases toward the live
// true position as normal, exactly as it did before this queue existed).
//
// A teleport reflected in the CURRENT tick's playerState.justTeleported (no burst involved, or the
// portal fired on the tick's only/last sub-tick) discards the whole queue outright: replaying stale
// pre-teleport positions afterward would walk the peer view backward through where the player used to
// be. A teleport buried EARLIER inside a queued burst is handled differently, by the per-entry tag
// above — those are legitimate future positions, not stale ones, so only that one entry snaps.
function popReplayTarget(session) {
  const ps = session.playerState;
  if (ps && ps.justTeleported) {
    if (session._peerReplayQueue) session._peerReplayQueue.length = 0;
    return null;
  }
  const q = session._peerReplayQueue;
  return (q && q.length > 0) ? q.shift() : null;
}

// ── Peer extrapolation (OFF by default — see the correctness note below) ───────────────────────────
// Requested live, after peerReplayQueueMax/sendBufferSkipBytes tuning still left genuine network
// gaps visible: "is there any way to COMPLETELY avoid the floating and glitching" — there is not,
// and this specific idea turned out to be the WRONG direction to chase it in, not just an
// incomplete one.
//
// During a real input gap, processBufferedTick correctly refuses to guess (see its own "Holding is
// right for a BRIEF gap" comment) — advancing the AUTHORITATIVE position without real input would
// drift it away from whatever the client actually did. The peer-replay queue (pushReplaySnapshot/
// popReplayTarget, above) exists for exactly this reason: it is a STRICT replay of real, already-
// simulated positions, never a guess, so what a peer sees is always literally what happened, just
// delayed by however deep the backlog is.
//
// This extrapolation layer breaks that guarantee, and was a mistake to default on: while starved it
// guesses ahead on last-known velocity, and when real data resumes it eases from that GUESS toward
// the first real queued position — which can be a LARGER, more visible correction than simply
// staying frozen would have needed, if the guess was wrong (the player actually stopped, turned, or
// hit a wall). That trades "briefly frozen, then exactly right" for "confidently wrong, then a snap
// to fix it" — worse instability, not less. Reconciling a mispredicted position belongs on the
// CLIENT side (the existing echo/lag-comp reconcile loop), which is what it is for; the server's
// peer-broadcast layer should only ever show real, already-known-true data, never invent it.
// Left in as an explicit opt-in (0 = off, the recommended and default setting) rather than deleted
// outright, in case a future, more careful design wants a bounded, reconciled version of this idea —
// but the queue depth (peerReplayQueueMax) and reducing our own added delay (sendBufferSkipBytes)
// are the correct, already-applied fixes for the actual complaint.
let PEER_EXTRAPOLATION_MS = S.define({
  key: "peerExtrapolationMs", env: "EVIO_PEER_EXTRAPOLATION_MS", type: "int", def: 0, min: 0, max: 2000,
  category: "Netcode", label: "Peer extrapolation window (ms) — NOT recommended",
  desc: "During a real input gap, keep a peer's broadcast position moving on their last known "
      + "velocity for up to this long before giving up and freezing in place, instead of the "
      + "strict real-data replay this system otherwise always shows. 0 (default, recommended) "
      + "disables it — a wrong guess here corrects by easing toward the next REAL replayed "
      + "position, which can be a bigger, more visible snap than just staying frozen would have "
      + "been. Purely cosmetic either way: never touches the authoritative position real hit "
      + "detection and physics use.",
}, (v) => { PEER_EXTRAPOLATION_MS = v; });
let PEER_EXTRAPOLATION_MAX_SPEED = S.define({
  key: "peerExtrapolationMaxSpeed", env: "EVIO_PEER_EXTRAPOLATION_MAX_SPEED", type: "number", def: 25, min: 1, max: 200,
  category: "Netcode", label: "Peer extrapolation max speed (u/s)",
  desc: "Sanity clamp on the velocity used to extrapolate — bounds how far a bad/stale velocity "
      + "reading can carry a guess before the window above cuts it off anyway.",
}, (v) => { PEER_EXTRAPOLATION_MAX_SPEED = v; });

// Advances playerState._broadcastPos toward TARGET (the true position, unless a replay queue is
// supplying an earlier real sub-tick position — see popReplayTarget) at the capped speed, or snaps
// it instantly on a genuine teleport/first-tick. Called once per accepted player per server tick,
// BEFORE any peer body is built this tick (see runGlobalTickInner) — every recipient who sees this
// player as a peer this tick reads the SAME already-updated value via the per-tick block cache.
// `starved` = true when this session had no real data drained THIS tick (session._drainedThisTick
// false) — the trigger for extrapolation, see the comment block above.
function updateBroadcastPosition(playerState, dtSeconds, capOverride, targetPos, starved) {
  const cap = Number.isFinite(capOverride) ? capOverride : PEER_SMOOTH_MAX_SPEED;
  // Extrapolate only when genuinely starved AND already caught up (no queued real position to show
  // instead — that always wins, it is real data, not a guess) AND there is a prior broadcast
  // position to extrapolate FROM (not a fresh spawn/teleport, handled by the snap branch below).
  if (starved && !targetPos && playerState._broadcastPos && !playerState.justTeleported
      && PEER_EXTRAPOLATION_MS > 0) {
    const elapsed = (playerState._extrapolatedMs || 0) + dtSeconds * 1000;
    if (elapsed <= PEER_EXTRAPOLATION_MS) {
      const v = playerState.velocity;
      if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) {
        const speed = Math.hypot(v.x, v.y, v.z);
        const s = speed > PEER_EXTRAPOLATION_MAX_SPEED ? PEER_EXTRAPOLATION_MAX_SPEED / speed : 1;
        const b = playerState._broadcastPos;
        b.x += v.x * s * dtSeconds; b.y += v.y * s * dtSeconds; b.z += v.z * s * dtSeconds;
      }
      playerState._extrapolatedMs = elapsed;
      return;
    }
    // Window exhausted this tick — fall through to the normal path below, which will now ease from
    // the extrapolated position toward wherever the (still-frozen) true position actually is; since
    // the true position never moved during the gap, that is typically a short, bounded correction.
  }
  if (!starved) playerState._extrapolatedMs = 0;   // real data resumed — the window resets
  const p = targetPos || playerState.position;
  if (!p) return;
  // NaN/Infinity guard, same class of bug this project has fought before (see the emit-boundary
  // fin() guards): a transient non-finite true position must NOT be allowed to poison
  // _broadcastPos, because it silently would — NaN propagates through every arithmetic op below and
  // is STICKY (dist becomes NaN forever after, since dx = p.x - b.x is NaN once b.x is), so one bad
  // tick would permanently freeze this player as NaN for every peer until their next teleport/
  // respawn (the only other place _broadcastPos gets reset). Skip the update instead — the last
  // known-good broadcast position is a far better peer-visible value than NaN, and if the true
  // position recovers next tick, smoothing resumes normally from where it left off.
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
  const b = playerState._broadcastPos;
  // No prior value (first tick since spawn/respawn/teleport — all three null it out), OR this
  // specific target came from a replay-queue entry tagged `teleported` (a portal fire buried inside a
  // burst — see pushReplaySnapshot) — appearing exactly at the target is correct; there is nothing to
  // smooth FROM, or the ease would wrongly render an instant teleport as a slide.
  if (!b || playerState.justTeleported || (targetPos && targetPos.teleported)) {
    playerState._broadcastPos = { x: p.x, y: p.y, z: p.z };
    return;
  }
  const dx = p.x - b.x, dy = p.y - b.y, dz = p.z - b.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const maxStep = cap * dtSeconds;
  if (dist <= maxStep || dist < 1e-6) {
    b.x = p.x; b.y = p.y; b.z = p.z;
  } else {
    const s = maxStep / dist;
    b.x += dx * s; b.y += dy * s; b.z += dz * s;
  }
}

// Lag compensation: rewind every OTHER player to where the shooter saw them (their position at the
// shooter's last-received server tick − render interp), run fn() (the hit test), then restore live
// positions so the next tick's physics is untouched. The shooter's own position is never rewound.
function withLagComp(shooter, sessions, fn) {
  const ps = shooter._ps;
  const rewound = [];
  // The two server ticks the shooter was interpolating between when it fired (from its input).
  const currTick = (Number.isFinite(shooter._viewServerTick) ? shooter._viewServerTick : -1) - LAGCOMP_INTERP;
  const prevTick = (Number.isFinite(shooter._viewPrevServerTick) ? shooter._viewPrevServerTick : currTick) - LAGCOMP_INTERP;
  // The client rewinds peer capsules at the SAME render alpha it fired its own position from
  // (Qcw4fab uses `c`), so use the firing sub-frame's alpha when sub-frame parity is on.
  const alpha = (SUBFRAME_SHOT && Number.isFinite(shooter._fireAlpha)) ? shooter._fireAlpha : LAGCOMP_ALPHA;
  if (LAGCOMP && currTick >= 0) {
    for (const s of sessions.values()) {
      const t = s.accepted && s.playerState;
      if (!t || t === shooter) continue;
      const tps = t._ps;
      if (!tps || !tps.Qdsukt4) continue;
      const snap = positionAtTickInterp(s, prevTick, currTick, alpha);
      if (!snap) continue;
      rewound.push({ tps, x: tps.Qdsukt4.x, y: tps.Qdsukt4.y, z: tps.Qdsukt4.z });
      tps.Qdsukt4.x = snap.x; tps.Qdsukt4.y = snap.y; tps.Qdsukt4.z = snap.z;
    }
    if (rewound.length) _syncPhysWorldCapsules(ps.Q7q6byi);
  }
  try {
    return fn();
  } finally {
    if (rewound.length) {
      for (const r of rewound) { r.tps.Qdsukt4.x = r.x; r.tps.Qdsukt4.y = r.y; r.tps.Qdsukt4.z = r.z; }
      _syncPhysWorldCapsules(ps.Q7q6byi);
    }
  }
}

// Apply a confirmed hit (hitscan OR melee): find the victim, compute + apply damage (dmg * 0.01 *
// critMult * lobbyMult — exact client formula), set the victim's lastHitInfo (direction/hit
// reaction), and emit a playerMap hit event (damage number + spark, and the melee ding). `eye` is
// the shooter's camera position (for the hit-source direction).
function applyHit(shooter, sessions, hit, eye, shotSid) {
  if (!hit || hit.victimSid == null) return;
  let victim = null;
  for (const s of sessions.values()) {
    const t = s.accepted && s.playerState;
    if (t && t._ps && t._ps.Q7q6byi === hit.victimSid) { victim = t; break; }
  }
  if (!victim || victim.deathStateTimer > 0 || victim.healthPoints <= 0) return;
  const baseDmg = WEAPON_DMG[shooter.equippedWeaponId];
  if (!(baseDmg > 0)) return;   // unknown weapon → no damage (avoids desync from a guess)
  const critMult = hit.headshot ? (WEAPON_HEADSHOT_MULT[shooter.equippedWeaponId] || HEADSHOT_MULT) : 1;
  // Bot-only extra multiplier — resolved via the shooter's OWNING SESSION (shooter itself is a
  // playerState, which has no isBot flag of its own; the session does). Real players are completely
  // unaffected: this only ever multiplies by anything other than 1 when the attacker is a bot.
  const shooterSession = sessions.get(shooter._ownerSid);
  const botMult = (shooterSession && shooterSession.isBot) ? BOT_DAMAGE_MULT : 1;
  const damage = baseDmg * DMG_GLOBAL_MULT * critMult * LOBBY_DAMAGE_MULT * botMult;
  // Same resolution as botMult above, reused for the botFriendlyFire gate inside applyDamage.
  const victimSession = sessions.get(victim._ownerSid);
  // Medal context for scoring: headshot bonus (+10) and the sword medal (+20). victimUid drives the
  // guest multiplier (x0.3 when the victim is uid 17).
  // Everything the conditional medals need, gathered where it is actually known.
  const wdef = (WEAPON_DB && (WEAPON_DB.dataById || WEAPON_DB))[shooter.equippedWeaponId] || {};
  let topKills = 0, alive = 0;
  for (const sx of sessions.values()) {
    const px = sx.accepted && sx.playerState;
    if (!px) continue;
    alive++;
    if ((px.kills | 0) > topKills) topKills = px.kills | 0;
  }
  applyDamage(victim, damage, shooter, {
    headshot: !!hit.headshot,
    weaponMedal: WEAPON_MELEE[shooter.equippedWeaponId] ? "sword" : null,
    victimUid: _uidForSession(sessions, hit.victimSid),
    dist: Math.hypot(shooter.position.x - victim.position.x,
                     shooter.position.y - victim.position.y,
                     shooter.position.z - victim.position.z),
    noDefaultCrosshair: !!wdef.noDefaultCrosshair,
    melee: !!wdef.melee,
    zooming: !!(shooter._ps && shooter._ps.Qgk2mcg),
    victimWasLeader: (victim.kills | 0) >= topKills && topKills > 0,
    playerCount: alive,
    attackerIsBot: !!(shooterSession && shooterSession.isBot),
    victimIsBot: !!(victimSession && victimSession.isBot),
  });
  // Hit feedback, split into two independently-gated channels to bisect the on-hit model flicker.
  // HP/damage always applies regardless.
  if (LASTHITINFO_EVENTS) {
    victim._pendingHit = {
      attackerSid: shooter._ownerSid, dmg: round(damage, 4),
      wpnType: shooter.equippedWeaponId, headshot: !!hit.headshot, src: { x: eye.x, y: eye.y, z: eye.z },
    };
  }
  if (PLAYERMAP_EVENTS) {
    const hitPos = hit.point || { x: victim._ps.Qdsukt4.x, y: victim._ps.Qdsukt4.y + 1, z: victim._ps.Qdsukt4.z };
    spawnHitEvent(shooter._ownerSid, victim._ownerSid, round(damage, 4), critMult, hitPos, eye, shotSid);
  }
  console.log(`[evio-local] hit ${hit.headshot ? "HEAD" : "body"} wpn=${shooter.equippedWeaponId} dmg=${damage.toFixed(3)} victimHP=${victim.healthPoints.toFixed(2)}`);
}

// Shooter camera eye = feet + (crouching ? 1.0 : 1.8) * scale, matching the client exactly.
// With sub-frame parity, the feet position is the RENDER position the client fired from:
// lerp(prevTickPos, currTickPos, fireAlpha) — not the end-of-tick position.
function shooterEye(shooter) {
  const ps = shooter._ps;
  const scale = (typeof ps.scale === "number" && ps.scale > 0) ? ps.scale : 1;
  const eyeY = (shooter.crouching ? CROUCH_EYE_Y : STAND_EYE_Y) * scale;
  let fx = ps.Qdsukt4.x, fy = ps.Qdsukt4.y, fz = ps.Qdsukt4.z;
  const a = shooter._fireAlpha;
  const prev = shooter._prevTickPos;
  if (SUBFRAME_SHOT && prev && Number.isFinite(a) && a < 1) {
    fx = prev.x + (fx - prev.x) * a;
    fy = prev.y + (fy - prev.y) * a;
    fz = prev.z + (fz - prev.z) * a;
  }
  return { x: fx, y: fy + eyeY, z: fz };
}

// Queue the client's exact shot ray (parsed from "#SHOT#ox,oy,oz,dx,dy,dz"), consumed FIFO when the
// server fires this player's next shot.
function enqueueClientRay(playerState, csv) {
  if (!CLIENT_RAY || !playerState || typeof csv !== "string") return;
  const tok = csv.split(",");
  const p = tok.slice(0, 6).map(Number);
  if (p.length < 6 || p.some((v) => !Number.isFinite(v))) return;
  // 7th field (optional) = the client's shot sessionId string "f:p:a" (pelletIndex:shooterSid:fireTick).
  // We echo it back as the playerMap entry KEY so the client's hit-prediction prune matches it
  // (Qkszhck in worldState.playerMap, bundle :67131) and clears the prediction atomically with the HP
  // drop — without it the prune only fires on the 3-tick stale path → double damage on the enemy bar.
  // Length-capped: this string is echoed back as a playerMap KEY, so an unbounded one is bandwidth
  // amplification — a 64 KiB sid arrives once and goes out to every peer, every tick it is live.
  // Real ones are "pelletIndex:shooterSid:fireTick", well under 64 characters.
  const sid = tok.length > 6 && tok[6] !== "" ? String(tok[6]).slice(0, 64) : null;
  const q = playerState._clientRays || (playerState._clientRays = []);
  q.push({ ox: p[0], oy: p[1], oz: p[2], dx: p[3], dy: p[4], dz: p[5], sid, t: Date.now() });
  if (q.length > 32) q.splice(0, q.length - 32);
}
// Dequeue the oldest FRESH client ray for this shooter, or null. Rejects rays whose origin is
// implausibly far from the server's reconstructed eye (anti-teleport — keeps the server honest).
function takeClientRay(shooter) {
  if (!CLIENT_RAY) return null;
  const q = shooter._clientRays;
  if (!Array.isArray(q) || q.length === 0) return null;
  const now = Date.now();
  const eye = shooterEye(shooter);
  while (q.length) {
    const r = q.shift();
    if (now - r.t > CLIENT_RAY_MAX_AGE_MS) continue;                                  // stale
    if (Math.hypot(r.ox - eye.x, r.oy - eye.y, r.oz - eye.z) > CLIENT_RAY_MAX_ORIGIN_DRIFT) continue;  // implausible
    return r;
  }
  return null;
}
// SR1 (page-socket-hook.js's __EVIO_EXT_SHOTRAY__) sends ONE "#SHOT#" ray PER PELLET for a multi-
// pellet weapon (count of them per trigger pull), but a shotgun shot only ever dequeues ONE via
// takeClientRay() above — fireShotgunPellets recomputes the other pellet offsets itself
// deterministically (see pelletDirections), it doesn't need the client's own per-pellet rays at
// all. The other count-1 sibling rays would otherwise sit in the FIFO queue unconsumed: under
// default cooldowns they age out (clientRayMaxAgeMs) before any later shot could reach them, but a
// shortened fireCooldownScale or a fast weapon swap right after the shotgun could let a NEXT,
// unrelated shot's takeClientRay() dequeue one of THESE leftover pellet rays instead of its own.
// Sibling pellet rays share the same "shooterSid:fireTick" suffix (only the leading pelletIndex
// differs — see enqueueClientRay's own comment on the sid format), so once we know the just-
// consumed ray belongs to a multi-pellet shot, drop every other queued ray with that same suffix
// right away — precise (a genuinely later shot has a different fireTick, so it's never touched)
// and cheap (the queue is capped at 32 entries).
function dropSiblingPelletRays(shooter, sid) {
  const q = shooter._clientRays;
  if (!Array.isArray(q) || !q.length || typeof sid !== "string") return;
  const cut = sid.indexOf(":");
  if (cut < 0) return;
  const suffix = sid.slice(cut + 1);   // "shooterSid:fireTick"
  for (let i = q.length - 1; i >= 0; i--) {
    const s = q[i].sid;
    const sc = typeof s === "string" ? s.indexOf(":") : -1;
    if (sc >= 0 && s.slice(sc + 1) === suffix) q.splice(i, 1);
  }
}
// Resolve the shot's eye + aim direction: prefer the client's exact ray (zero reconstruction
// divergence), else fall back to the server's reconstruction.
function shotRay(shooter, clientRay) {
  if (clientRay) {
    const len = Math.hypot(clientRay.dx, clientRay.dy, clientRay.dz) || 1;
    return {
      eye: { x: clientRay.ox, y: clientRay.oy, z: clientRay.oz },
      dir: { x: clientRay.dx / len, y: clientRay.dy / len, z: clientRay.dz / len },
      fromClient: true,
    };
  }
  const ps = shooter._ps;
  return { eye: shooterEye(shooter), dir: phys.aimDirection(ps.Qqg4go0, ps.Qcrzrpr), fromClient: false };
}

// RANGED shot — the client's exact ray (or reconstructed) vs the lag-compensated capsules; walls
// block naturally. Spawns a tracer for every shot (hit or miss).
// Shooting a planted mine / trip mine sets it off: a Mine detonates (AoE) where it sits, a Trip Mine
// is simply destroyed (its dmg is direct-on-cross, so a shot just removes it). Ray-vs-sphere over the
// stuck traps, nearest first, capped at the first wall the shot meets (you can't shoot one through a
// wall). Radius ~0.4u around the entity. Lets players clear traps without walking into them.
function destroyMineInLineOfFire(eye, dir, sessions) {
  let wallDist = 200;
  if (bpw.ready) {
    const w = phys.raycastWorld(bpw.world, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, wallDist);
    if (w) wallDist = Math.hypot(w.x - eye.x, w.y - eye.y, w.z - eye.z);
  }
  let bestKey = null, bestG = null, bestT = wallDist;
  for (const [key, g] of activeEntities) {
    if (!g.isStuck || !g.combat || (g.combat.behavior !== "mine" && g.combat.behavior !== "tripmine")) continue;
    const ox = g.pos.x - eye.x, oy = g.pos.y - eye.y, oz = g.pos.z - eye.z;
    const t = ox * dir.x + oy * dir.y + oz * dir.z;     // distance along the ray to the entity's closest point
    if (t < 0 || t > bestT) continue;
    const cx = eye.x + dir.x * t, cy = eye.y + dir.y * t, cz = eye.z + dir.z * t;
    if (Math.hypot(g.pos.x - cx, g.pos.y - cy, g.pos.z - cz) <= 0.4) { bestT = t; bestKey = key; bestG = g; }
  }
  if (!bestKey) return false;
  if (bestG.combat.behavior === "mine") detonateAoe(bestKey, bestG, sessions);   // mine → blast in place
  else { activeEntities.delete(bestKey); removedEntityKeys.push(bestKey); }       // trip mine → destroyed
  return true;
}

function fireHitscan(shooter, sessions, clientRay) {
  const ps = shooter._ps;
  if (!ps || !ps.Qdsukt4 || !bpw.world) return;
  const { eye, dir } = shotRay(shooter, clientRay);
  const hit = withLagComp(shooter, sessions, () =>
    phys.hitscanPlayers(bpw.world, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, ps.Q7q6byi));
  const bd = WEAPON_DMG[shooter.equippedWeaponId];
  spawnBullet(shooter._ownerSid, eye, dir, (bd > 0 ? bd * DMG_GLOBAL_MULT * LOBBY_DAMAGE_MULT : 0), shooter.equippedWeaponId);
  applyHit(shooter, sessions, hit, eye, clientRay && clientRay.sid);
  destroyMineInLineOfFire(eye, dir, sessions);   // a shot through a planted mine / trip mine sets it off
}

// PROJECTILE weapon shot (Rocket Launcher / Grenade Launcher) — spawns a travelling entity via the
// same mechanism a thrown ability grenade uses (see spawnFiredProjectile) instead of an instant
// hitscan ray. No bulletMap tracer: the projectile's own activeEntities stream IS the visible shot,
// the same way a thrown grenade needs no separate tracer.
function fireProjectileShot(shooter, sessions, clientRay) {
  const ps = shooter._ps;
  if (!ps || !ps.Qdsukt4) return;
  const { eye, dir } = shotRay(shooter, clientRay);
  spawnFiredProjectile(shooter, shooter.equippedWeaponId, eye, dir);
}

// Rotate a small LOCAL cone offset (lx, ly, forward=-1, already normalized) into world space around
// a known forward direction `fwd` — the shotgun pellet-spread equivalent of phys.aimDirection.
// `fwd` plays the role of the camera's own forward axis; right/up are derived from it exactly like
// any look-basis construction (world-up as the stabilizing reference, degenerate only when fwd is
// itself near-vertical, negligible for a roughly-forward-facing shot).
// lx/ly are the RAW (not pre-normalized) local cone offsets — this function builds the full local
// vector (lx, ly, -1) (forward = local -Z, matching the real client's own `new Vector3(lx, ly,
// -1).normalize()` before rotating it by the camera's yaw/pitch) and normalizes it as one 3D unit
// vector before rotating, so the forward component gets the same 1/L scaling the lateral ones do.
// A previous version had the caller pre-divide lx/ly by hypot(lx,ly,1) and used a bare coefficient
// of 1 for fwd here — correct in the limit lx=ly=0, but at the shotgun's own spread radius (0.1)
// that under-scaled forward relative to the exact per-component normalization by about 0.03°: real
// enough to be worth fixing exactly (one caller, zero cost), negligible enough that it was never
// going to be the difference between a landed and a missed pellet.
function _coneOffsetToWorld(fwd, lx, ly) {
  const l = Math.hypot(lx, ly, 1) || 1;
  const nx = lx / l, ny = ly / l, nz = 1 / l;
  let rx = -fwd.z, ry = 0, rz = fwd.x;             // cross(worldUp(0,1,0), fwd)
  let rl = Math.hypot(rx, ry, rz);
  if (rl < 1e-6) { rx = 1; ry = 0; rz = 0; rl = 1; }   // fwd ~vertical: fall back to world +x as "right"
  rx /= rl; ry /= rl; rz /= rl;
  const ux = fwd.y * rz - fwd.z * ry, uy = fwd.z * rx - fwd.x * rz, uz = fwd.x * ry - fwd.y * rx;
  const wx = rx * nx + ux * ny + fwd.x * nz, wy = ry * nx + uy * ny + fwd.y * nz, wz = rz * nx + uz * ny + fwd.z * nz;
  const wl = Math.hypot(wx, wy, wz) || 1;
  return { x: wx / wl, y: wy / wl, z: wz / wl };
}

// Pellet directions for a multi-projectile weapon (Shotgun), reproducing the client's OWN
// deterministic double-ring formula (bundle :44037-44045) rather than random spread — the client
// does not randomize shotgun pellets at all (spreadMax/spreadMin, used for single-projectile
// recoil, are not consulted here): p = ceil(count/2) pellets on an inner ring at HALF the spread
// radius, then p more on an outer ring at the full radius, evenly spaced by angle around the aim
// axis. `spread` is sprayPatternSpreadADS while zooming, else sprayPatternSpread (both from the
// weapon catalogue), falling back to the client's own 0.1 default if neither is defined.
function pelletDirections(nid, fwd, count, zooming) {
  const spreadDef = WEAPON_SPRAY_SPREAD[nid];
  const spreadADS = WEAPON_SPRAY_SPREAD_ADS[nid];
  const spread = (zooming && Number.isFinite(spreadADS)) ? spreadADS
    : (Number.isFinite(spreadDef) ? spreadDef : 0.1);
  const p = Math.ceil(count / 2);
  const dirs = [];
  for (const scale of [0.5, 1]) {
    for (let f = 0; f < p && dirs.length < count; f++) {
      const m = (f / p) * Math.PI * 2;
      const lx = Math.cos(m) * spread * scale, ly = Math.sin(m) * spread * scale;
      dirs.push(_coneOffsetToWorld(fwd, lx, ly));
    }
  }
  return dirs;
}

// SHOTGUN (and any future multi-pellet weapon): N independent hitscan rays from one trigger pull,
// each with its own lag-compensated hit test and its own full-weapon-damage hit — the client fires
// the same N independent rays locally (bundle Q1hatp1's per-pellet loop, :44002-44021), so a
// point-blank hit can land all of them. One bulletMap tracer per pellet, matching a real shotgun's
// visible spread of tracers rather than one.
function fireShotgunPellets(shooter, sessions, clientRay) {
  const ps = shooter._ps;
  if (!ps || !ps.Qdsukt4 || !bpw.world) return;
  const { eye, dir: fwd } = shotRay(shooter, clientRay);
  const nid = shooter.equippedWeaponId;
  const count = weaponPelletCount(nid);
  const zooming = !!ps.Qgk2mcg;
  const bd = WEAPON_DMG[nid];
  for (const dir of pelletDirections(nid, fwd, count, zooming)) {
    const hit = withLagComp(shooter, sessions, () =>
      phys.hitscanPlayers(bpw.world, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, ps.Q7q6byi));
    spawnBullet(shooter._ownerSid, eye, dir, (bd > 0 ? bd * DMG_GLOBAL_MULT * LOBBY_DAMAGE_MULT : 0), nid);
    applyHit(shooter, sessions, hit, eye, clientRay && clientRay.sid);
  }
  destroyMineInLineOfFire(eye, fwd, sessions);
}

// MELEE swing — the swept-sphere the client runs (Qex8ya5) vs the lag-compensated capsules. Short
// range, no headshot, no tracer. The hit event drives the melee ding + damage number.
// DELIBERATE deviation from strict official parity — everything else about melee already matches
// the real client exactly (phys.meleeHit is the verbatim extracted swept-sphere sweep, and it runs
// under the same lag-comp + exact-client-ray machinery hitscan uses — confirmed live via rayDebug
// that the client's precise swing ray DOES reach the server for every sword swing). What's left is
// the real official reach genuinely being tight (~3.25u total), and the client's own hit-prediction
// feedback firing optimistically a moment before the server's authoritative check lands — a normal
// client-prediction artifact, not a bug. Requested anyway as a deliberate trade of some parity for
// fewer borderline "client hit, server miss" swings: on a miss, retry ONCE with the swing's origin
// nudged forward along the aim direction by this margin — same real sweep, same wall-blocking, just
// started a little further out. 0 (default) restores exact official behaviour.
let MELEE_FORGIVENESS_MARGIN = S.define({
  key: "meleeForgivenessMargin", env: "EVIO_MELEE_FORGIVENESS", type: "number", def: 0, min: 0, max: 2, step: 0.1,
  category: "Netcode", label: "Melee forgiveness margin (u)",
  desc: "Extra reach (units) tried ONLY on a miss, by nudging the swing's origin forward along the "
      + "aim before retrying the same real sweep. 0 = exact official reach. A deliberate deviation "
      + "from parity, not a bug fix — raise it if sword swings feel too strict, keep it at 0 for the "
      + "true official feel.",
}, (v) => { MELEE_FORGIVENESS_MARGIN = v; });

function fireMelee(shooter, sessions, clientRay) {
  const ps = shooter._ps;
  if (!ps || !ps.Qdsukt4 || !bpw.world) return;
  const { eye, dir } = shotRay(shooter, clientRay);
  let hit = withLagComp(shooter, sessions, () =>
    phys.meleeHit(bpw.world, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, ps.Q7q6byi));
  if (!hit && MELEE_FORGIVENESS_MARGIN > 0) {
    const fx = eye.x + dir.x * MELEE_FORGIVENESS_MARGIN;
    const fy = eye.y + dir.y * MELEE_FORGIVENESS_MARGIN;
    const fz = eye.z + dir.z * MELEE_FORGIVENESS_MARGIN;
    hit = withLagComp(shooter, sessions, () =>
      phys.meleeHit(bpw.world, fx, fy, fz, dir.x, dir.y, dir.z, ps.Q7q6byi));
  }
  applyHit(shooter, sessions, hit, eye, clientRay && clientRay.sid);
}

// Dispatch a shot to the melee or ranged path based on the equipped weapon, using the client's exact
// ray when one is available.
function fireWeapon(shooter, sessions) {
  const ray = takeClientRay(shooter);
  // DIAGNOSTIC (see spawnHitEvent). Which shots reach us with the client's exact ray + sid, and which
  // do not. SR1 hooks the client's non-projectile bullet-push path — MELEE goes through the same
  // push as hitscan client-side (no projectileSpeed defined), so it DOES normally arrive too;
  // confirmed live (rayDebug=1, every wpn=262 swing logged ray=YES). PROJECTILE weapons are the
  // real gap — they take a different branch client-side that never reaches this push at all, so
  // they never carry a sid, and without one the victim's bar double-counts for ~3 ticks. `queued`
  // distinguishes "client never sent one this shot" (0) from "FIFO drifted out of step".
  if (RAY_DEBUG) {
    const q = shooter._clientRays;
    console.log(`[evio-ray] fire wpn=${shooter.equippedWeaponId}`
      + ` melee=${WEAPON_MELEE[shooter.equippedWeaponId] ? 1 : 0}`
      + ` ray=${ray ? 'YES' : 'no'} sid=${ray && ray.sid ? ray.sid : '-'}`
      + ` queued=${Array.isArray(q) ? q.length : 0}`);
  }
  const nid = shooter.equippedWeaponId;
  if (WEAPON_MELEE[nid]) fireMelee(shooter, sessions, ray);
  else if (isProjectileWeapon(nid)) fireProjectileShot(shooter, sessions, ray);
  else if (weaponPelletCount(nid) > 1) {
    fireShotgunPellets(shooter, sessions, ray);
    if (ray && ray.sid) dropSiblingPelletRays(shooter, ray.sid);
  }
  else fireHitscan(shooter, sessions, ray);
}

// ── Per-tick firing, split to match the client's tick order ────────────────────────────────
// The client each tick: (1) increments actionTickCounter, (2) if it shoots, resets the counter
// to 0 and arms recoil (Qmgh2i6), (3) runs movement/recoil (which kicks pitch).  We split firing
// the same way so the server's pitch matches the client's after a shot:
//   preTickFire  — BEFORE the physics step: advance the counter, decide the shot, arm recoil.
//   postTickFire — AFTER the physics step:  run the hitscan from the now-final tick position.
// Decoupling them is what lets the extracted recoil curve (l()) reproduce the client's kick.
// The render alpha (frameDeltaTime ∈ [0,1)) of the sub-frame the client fired on = the FIRST
// sub-frame this tick that holds Shoot (action 5). That's the `c` in lerp(prevPos, currPos, c).
// Falls back to 1 (end-of-tick) when no per-sub-frame data is available.
function firingAlphaFromFrames(frames) {
  if (Array.isArray(frames)) {
    for (const f of frames) {
      // Bounded like every other read of this list (see heldThisTick): indexOf on an unbounded array,
      // for each of up to 64 sub-frames, is millions of comparisons inside the tick loop.
      const held = Array.isArray(f) && Array.isArray(f[1]) && Array.isArray(f[1][0])
        ? _boundedActions(f[1][0]) : null;
      if (held && held.indexOf(5) !== -1) {
        const c = Number(f[0]);
        return (Number.isFinite(c) && c >= 0 && c <= 1) ? c : 1;
      }
    }
  }
  return 1;
}
// The keys held during THIS tick, unioned across its sub-frames — the same merge the movement step
// does (client bundle ~18652 unions held/pressed and sums look, then runs g() once).
//
// preTickFire runs BEFORE integratePlayerSim (the drain at ~3053), and integratePlayerSim is what
// assigns playerState.heldActions. So reading heldActions here saw the PREVIOUS tick's input and
// every gate below fired one tick late. The client merges the current tick's sub-frames and fires on
// that same tick, so its recoil curve ran a tick ahead of ours: with fire held, the server kicked on
// ticks 2,4,6,8 where the client kicked on 1,3,5,7. A one-tick phase shift in the curve leaves pitch
// off by the tick-to-tick delta (~2.5e-3 rad) EVERY tick — 25x the reconciler's 1e-4 tolerance — so
// the camera reconciled continuously for as long as the trigger was down, with or without movement.
//
// Falls back to heldActions when called without frames (the hybrid no-drain path at ~2641).
function heldThisTick(p, frames) {
  if (!Array.isArray(frames) || frames.length === 0) return p.heldActions || new Set();
  const held = new Set();
  for (const frame of frames) {
    const packed = Array.isArray(frame[1]) ? frame[1] : [];
    // _boundedActions, not the raw array: this is a SECOND reader of the same client-supplied list
    // (foldInputFrameIntoSim is the other), and capping only there left this one iterating all
    // 60,000 elements of a hostile frame — the cap has to sit at every read, not at one of them.
    if (Array.isArray(packed[0])) for (const k of _boundedActions(packed[0])) held.add(k);
  }
  return held;
}
function preTickFire(p, frames) {
  if (!p) return;
  const ps = p._ps;
  const held = heldThisTick(p, frames);
  // NOTE: actionTickCounter (Qezh4wz) advance + recoil arm + curve are NOT done here — they must run
  // in the EXACT client order (arm-if-atc0 → atc++ → l() → reset) which spans the movement step, so
  // they live in _integrateWithExtractedPhysics. preTickFire only decides the shot (_firingThisTick).
  // Zoom/ADS state (Qwhlcfo:3255) — BEFORE the recoil arm (which reads Qgk2mcg) and before movement
  // (g() cuts move speed to Q6o3kdb*Qaezxaf when zooming). Without it the server moves at full speed
  // while the client moves at 0.65× → reconcile every aiming tick.
  if (SERVER_ZOOM && ps) {
    const wasZoom = ps.Qgk2mcg;
    ps.Qgk2mcg = !!(ps.Qq7zdfv > 0 && held.has(6)
                    && weaponHasZoom(p.equippedWeaponId) && (p.reloadTicks || 0) < 1);
    if (wasZoom !== ps.Qgk2mcg) ps.Qcqj5jb = 0;                 // reset zoom-transition counter on change
    if (ps.Qgk2mcg) { ps.Qcdx4mh = false; ps.Qkno30b = false; } // zooming clears dancing/examining
    // Keep OUR emote flags in step with the client, which clears isDancing/isExamining on zoom
    // (here) and on every shot (Qswb1wq). Without this the server would keep streaming
    // isDancing=true after the player aims or fires, and the reconciler compares isDancing.
    if (ps.Qgk2mcg) { p.isDancing = false; p.isExamining = false; }
  }
  p._firingThisTick = false;
  if (p.fireCooldown > 0) p.fireCooldown -= 1;
  // Reload countdown: when it finishes, the magazine refills to the clip size (reserve is infinite).
  // The remaining count is streamed as reloadTimer (opcode 130) so the CLIENT doesn't run its own
  // independent reload and reconcile-loop (the "reloading loop" bug). reloadTimer<1 ⇒ not reloading.
  if (p.reloadTicks > 0 && --p.reloadTicks <= 0) { p.gunAmmo = weaponClip(p._ammoGunId, p); p.reloadTicks = 0; }
  if (p.deathStateTimer > 0 || p.healthPoints <= 0) return;
  const isGun = !WEAPON_MELEE[p.equippedWeaponId];
  // Keep the magazine pointed at the equipped gun. For a REGULAR primary this gives a full clip —
  // harmless, since its reserve is unlimited (field_weapon_data startAmmo != 0), so a full mag on
  // switch-back costs nothing real. For a PICKUP weapon (finite playerState.pickupAmmo[nid] pool,
  // startAmmo:0) that same "full clip" call was a real exploit: weaponClip() caps the mag at
  // min(clipSize, pool), and the pool itself is correctly debited by firing — but recomputing that
  // cap on every switch-BACK instantly restores a full magazine's worth from the pool with none of
  // the normal reload wait, letting a player tap away and back to "reload" for free. Reported live
  // as "shoot the pickup weapon, switch away and back, ammo is instantly recovered without
  // reloading" — most visible on a small-clip weapon like Rocket Launcher (clipSize 1), where every
  // switch-back looked like an infinite-ammo bug even though the POOL was genuinely draining.
  // Fixed by remembering the exact loaded-magazine count per pickup nid across switches instead of
  // recomputing a fresh cap — switching away freezes it, switching back restores exactly what was
  // there (clamped to the pool, in case something else drained it meanwhile), and only an actual
  // reload (below) tops it back up from the pool. Regular guns are untouched — they have no entry
  // in pickupAmmo, so they keep the original always-full-on-switch behaviour.
  if (isGun && p._ammoGunId !== p.equippedWeaponId) {
    const isPickup = (nid) => p.pickupAmmo && Object.prototype.hasOwnProperty.call(p.pickupAmmo, nid);
    if (isPickup(p._ammoGunId)) {
      if (!p._pickupMagAmmo) p._pickupMagAmmo = {};
      p._pickupMagAmmo[p._ammoGunId] = p.gunAmmo;
    }
    p._ammoGunId = p.equippedWeaponId;
    if (isPickup(p.equippedWeaponId) && p._pickupMagAmmo
        && Object.prototype.hasOwnProperty.call(p._pickupMagAmmo, p.equippedWeaponId)) {
      p.gunAmmo = Math.max(0, Math.min(p._pickupMagAmmo[p.equippedWeaponId], weaponClip(p.equippedWeaponId, p)));
    } else {
      p.gunAmmo = weaponClip(p.equippedWeaponId, p);
    }
    p.reloadTicks = 0;
  }
  // A spent pickup weapon (empty mag AND no reserve left) auto-clears back to the player's own
  // loadout — official "use it till the ammo runs out" behaviour — rather than leaving them
  // holding a gun that can never fire or reload again. Checked every tick (not just on fire) so
  // switching TO an already-empty pickup weapon clears it right away too. Only THIS slot clears —
  // any other special weapons still carried are untouched.
  if (p.pickupAmmo && Object.prototype.hasOwnProperty.call(p.pickupAmmo, p.equippedWeaponId)
      && p.gunAmmo <= 0 && (p.pickupAmmo[p.equippedWeaponId] || 0) <= 0) {
    _clearPickupSlot(p, p.equippedWeaponId);
  }
  // Start a reload — AUTO when the mag is empty, MANUAL when action 30 is held with rounds to spare.
  // This must match the client's own trigger `(ammoInMag<=0 || reloadKey)` exactly and NOT be gated on
  // holding fire: the client auto-reloads the instant the mag empties, so if our server only reloaded
  // while firing it would keep streaming "mag 0 / not reloading" and the client would re-trigger every
  // reconcile → the auto-reload LOOP. Now both sides start the reload on the same tick → reloadTimer (130)
  // syncs them and there is no loop.
  // "a reload is refused while Q3igok2 >= 1" (bundle :43981) — see the switchTimer note below the
  // fire gate for the matching "no firing mid-swap" rule and why both were missing entirely.
  if (isGun && !(p.switchTimer > 0) && p.reloadTicks <= 0 && p.gunAmmo < weaponClip(p.equippedWeaponId, p) &&
      (p.gunAmmo <= 0 || held.has(30))) {
    p.reloadTicks = weaponReloadTicks(p.equippedWeaponId, p);
  }
  // Fire gate = the client's EXACT condition: actionTickCounter + 1 >= cooldown (bundle, see :311).
  // atc (Qezh4wz) is the recoil counter, incremented later in tickRecoilPitch, so use the pre-increment
  // value +1. Coupling fire timing to atc makes shots — and thus recoil kicks — land on the SAME ticks
  // the client fires; the old separate fireCooldown countdown drifted one tick out of phase, which is
  // why ADS (cooldown=2, spaced shots) jerked while non-aim (every-tick fire) didn't show it. Fall back
  // to the countdown only when SERVER_RECOIL is off (atc not advanced then).
  const _cdTicks = weaponCooldownTicks(p.equippedWeaponId);
  const _fireReady = (SERVER_RECOIL && ps && Number.isFinite(ps.Qezh4wz))
    ? (ps.Qezh4wz + 1 >= _cdTicks) : (p.fireCooldown <= 0);
  // "a shot is refused while Q3igok2 > 0 (you cannot fire mid-swap)" — bundle :43956, documented on
  // startWeaponSwitch above since we already replicate the TIMER's value (switchTimer/Q3igok2), but
  // never actually consulted it here before this fix. Applies to BOTH guns and melee — the client's
  // gate is on the fire action itself, not per-weapon-type. Confirmed live: a sword swing landing a
  // hit with no swing animation, reported right after this session added multi-slot weapon pickups
  // (auto-equip on grant/depletion calls startWeaponSwitch far more often than a plain 2-weapon
  // loadout ever did, so a fire input landing inside that now-much-more-frequent window went from a
  // rare edge case to something a player would actually notice) — the CLIENT correctly refused to
  // play the swing locally while switchTimer was still counting down, but our server had nothing
  // stopping it from confirming the hit anyway.
  if (held.has(5) && _fireReady && !(p.switchTimer > 0)) {
    if (isGun && (p.reloadTicks > 0 || p.gunAmmo <= 0)) return;          // reloading or empty → no shot
    p.fireCooldown = _cdTicks;
    p._firingThisTick = true;
    p.isDancing = false; p.isExamining = false;   // client's Qswb1wq clears these on every shot
    if (isGun) {
      p.gunAmmo -= 1;                                                    // consume a round
      // A picked-up special weapon's pool is the ONLY ammo it has (no reserve refill — see
      // weaponClip). pickupAmmo[nid] is the TOTAL left for that nid (chambered included), so it
      // drains in lockstep with the magazine here; a reload later just redistributes what's left
      // between chamber and reserve without needing to touch this figure separately.
      if (p.pickupAmmo && Object.prototype.hasOwnProperty.call(p.pickupAmmo, p.equippedWeaponId)) {
        p.pickupAmmo[p.equippedWeaponId] = Math.max(0, (p.pickupAmmo[p.equippedWeaponId] || 0) - 1);
      }
    }
    p._fireAlpha = SUBFRAME_SHOT ? firingAlphaFromFrames(frames) : 1;   // render alpha of the firing sub-frame
    // Recoil arm + actionTickCounter reset are NOT done here — they run in the correct client order
    // inside _integrateWithExtractedPhysics (arm uses the PREV tick's atc==0; reset is AFTER l()).
  }
}
function postTickFire(p, sessions) {
  if (p && p._firingThisTick) { p._firingThisTick = false; fireWeapon(p, sessions); }
}

// Hybrid-mode firing (no per-tick drain): pre + post back-to-back once per global tick. Buffer
// mode (the default) instead brackets the physics step with preTickFire/postTickFire so recoil
// lands in the same tick the client kicked, and the shot uses the exact reconstructed position.
function processFiring(sessions) {
  for (const s of sessions.values()) {
    if (!s.accepted) continue;
    preTickFire(s.playerState);
    postTickFire(s.playerState, sessions);
  }
}

// ── Bot AI ──────────────────────────────────────────────────────────────────────────────────────
// Turns a bot session's per-tick decision into the SAME wire-format input real players send. The
// only caller of everything below is driveBotFrame (in startServer's closure, near spawnBot) — these
// are plain functions so they can be unit-tested without a running server/socket.
//
// Vision uses the bare geometry raycast (phys.raycastWorld) — the same primitive
// destroyMineInLineOfFire and a thrown grenade's wall-detonation check already use — never the full
// hitscanPlayers path, which is for taking an actual shot, not for deciding whether one is possible.
const DEG2RAD = Math.PI / 180;

// yaw/pitch <-> bearing. forward = (-sin(yaw), -cos(yaw)) in x/z — CONFIRMED EMPIRICALLY against
// the real movement path (integratePlayerSim with held=forward at yaw=PI/2 moves x NEGATIVE), not
// derived from the hand-rolled teleport branch a few hundred lines up: that code only runs when
// `!playerState._ps` (extracted physics absent), which is never true on this server, so its sign
// convention is dead-code trivia and an earlier version of this comment wrongly took it as ground
// truth — the resulting sign error passed its own unit test (which regenerated its expected target
// from the SAME wrong formula, so it round-tripped tautologically) and only surfaced when two live
// bots aimed at each other and never once landed a hit. This is the inverse of the confirmed
// relation: given a bearing in server space, the yaw/pitch that produces it.
function _yawPitchToward(fromX, fromY, fromZ, toX, toY, toZ) {
  const dx = toX - fromX, dy = toY - fromY, dz = toZ - fromZ;
  const dist = Math.hypot(dx, dy, dz) || 1;
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.asin(Math.max(-1, Math.min(1, dy / dist)));
  return { yaw, pitch, dist };
}

function _wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Cached by IDENTITY of bpw.navmesh, not deep-compared: a real map switch (switchMap) assigns a
// brand-new array, so an identity check is exactly the right invalidation and avoids rebuilding the
// graph every tick for every bot on an unchanged map.
let _botNavGraphCache = null;
let _botNavGraphSrc = null;
function _botNavGraph() {
  const navmesh = bpw.navmesh;
  if (_botNavGraphCache && _botNavGraphSrc === navmesh) return _botNavGraphCache;
  _botNavGraphSrc = navmesh;
  _botNavGraphCache = navPath.buildGraph(navmesh || [], bpw.teleporters || []);
  return _botNavGraphCache;
}

// A patrol destination: a random navmesh node, preferring ones tagged 'Ground' (ordinary walkable
// floor) over ability-specific nodes like 'Bot Party'/'Bot Exits', which exist for battle-royale
// glide logic this server does not run (see the navmesh test's tag survey).
function _pickWanderGoal(graph) {
  const nodes = graph.nodes;
  if (!nodes.length) return null;
  const grounded = nodes.filter((n) => n.tag === "Ground");
  const pool = grounded.length ? grounded : nodes;
  return pool[Math.floor(Math.random() * pool.length)];
}

const BOT_ENGAGE_DIST = 60;   // beyond this a bot does not even consider fighting

// Every other accepted, alive, in-match player the bot has a clear wall-free line to, nearest first.
// `globalTick` is optional (defensive: some call sites predate it) — without it every candidate's
// LIVE position is used, same as before BOT_SIM_LATENCY_MS existed.
function _visibleEnemies(session, sessions, maxDist, globalTick) {
  const p = session.playerState;
  const eyeY = p.crouching ? CROUCH_EYE_Y : STAND_EYE_Y;
  const eye = { x: p.position.x, y: p.position.y + eyeY, z: p.position.z };
  const latencyTicks = session.isBot && Number.isFinite(globalTick) ? _botSimLatencyTicks() : 0;
  const out = [];
  for (const other of sessions.values()) {
    if (!other || !other.accepted || other.playerId === session.playerId) continue;
    // botFriendlyFire=false blocks bot-on-bot DAMAGE (applyDamage), but a bot that keeps picking
    // another bot as its target still walks up and swings/shoots at something it can never hurt —
    // which reads as broken, not "friendly". So when it's off, bots don't even TARGET each other:
    // both sides of the pair have to be bots (a real player is never filtered either direction).
    if (session.isBot && other.isBot && !BOT_FRIENDLY_FIRE) continue;
    const op = other.playerState;
    if (!op || op._holdForPlay) continue;
    if (op.deathStateTimer > 0 || op.healthPoints <= 0) continue;
    const oEyeY = op.crouching ? CROUCH_EYE_Y : STAND_EYE_Y;
    // Simulated network delay (see BOT_SIM_LATENCY_MS): a bot "sees" a real target the way a
    // real player's screen would — a little late — instead of the true live position. Falls back
    // to live when the position-history ring hasn't accumulated far enough back yet (a fresh
    // spawn), same philosophy as positionAtTick's own null fallback elsewhere.
    const delayed = latencyTicks > 0 ? positionAtTick(other, globalTick - latencyTicks) : null;
    const oEye = delayed
      ? { x: delayed.x, y: delayed.y + oEyeY, z: delayed.z }
      : { x: op.position.x, y: op.position.y + oEyeY, z: op.position.z };
    const dx = oEye.x - eye.x, dy = oEye.y - eye.y, dz = oEye.z - eye.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > maxDist || dist < 0.01) continue;
    const hit = phys.raycastWorld(bpw.world, eye.x, eye.y, eye.z, dx, dy, dz, dist);
    if (hit) {
      const hitDist = Math.hypot(hit.x - eye.x, hit.y - eye.y, hit.z - eye.z);
      if (hitDist < dist - 0.5) continue;   // a wall sits between the bot and this player
    }
    out.push({ session: other, eye: oEye, dist });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out;
}

// _visibleEnemies raycasts against EVERY other session, every call — with N bots all in combat that
// is O(N) raycasts per bot per tick, O(N^2) total per tick. MEASURED live on the VPS: with 4 sword
// bots fighting, driveBots (which calls this once per bot, every tick, via _updateBotTarget) cost
// 10-24ms on its own and tick overruns climbed measurably during active bot combat versus zero
// growth with no bots — this is the actual hot path. Re-verifying full visibility (including the
// raycast) every single tick is far more often than needed: a target's LOS status does not change
// tick-to-tick nearly as fast as the tick rate itself. Caching the result for a few ticks cuts the
// raycast volume by roughly BOT_VISION_SCAN_INTERVAL while costing at most that many ticks (~150ms
// at the default) of staleness in when a newly-hidden/newly-visible enemy gets noticed — well under
// the reaction-time delay every bot already has regardless (700-150ms, see bot_difficulty.js).
let BOT_VISION_SCAN_INTERVAL = S.define({
  key: "botVisionScanIntervalTicks", env: "EVIO_BOT_VISION_SCAN_INTERVAL", type: "int", def: 3, min: 1, max: 20,
  category: "Bots", label: "Bot vision scan interval (ticks)",
  desc: "How often each bot re-runs its full line-of-sight raycast scan (1 = every tick, the old "
      + "behaviour). Higher values cut CPU cost roughly proportionally — measured as the actual "
      + "hot path in driveBots under real bot combat — at the cost of that many ticks of extra delay "
      + "noticing a newly hidden or newly visible enemy. 3 (150ms) is well under a bot's own "
      + "reaction-time delay, so it costs nothing perceptible.",
}, (v) => { BOT_VISION_SCAN_INTERVAL = v; });

// A real player's own network round trip means they see the world a bit late (server->client) and
// their input arrives a bit late too (client->server) — commonly ~35ms each way, ~70-80ms total. A
// bot runs server-side with neither leg: it targets and fires off the TRUE current-tick position,
// which is a structural advantage on top of (and separate from) the reactionMs skill curve in
// bot_difficulty.js (that curve models HUMAN decision/reflex delay; this models NETWORK delay, which
// every real opponent pays regardless of skill). Reported live: bots feel like they "react almost
// instantly" compared to real players even at the same difficulty level.
//
// Applied in two places, both keyed off the same tick count so they stay consistent with each other:
//   - _visibleEnemies looks up each candidate's position from BOT_SIM_LATENCY_TICKS ago (via the
//     existing per-player lag-comp position ring, recordPositionSnapshot/positionAtTick) instead of
//     their live position — this is the "observation" delay: a bot's targeting/aim tracks where an
//     enemy WAS, exactly like a real player's screen does.
//   - the bot's own playerState._inputLagTicks (normally derived from real queue backlog — see its
//     own comment above) is floored to this same value, so fireHitscan's lag-comp rewind of the
//     VICTIM is computed against that SAME delayed frame the bot aimed at, not the live one. Without
//     this a bot would aim at a stale position but still hit-check against the target's true current
//     position — an inconsistency that would just make bots miss more, not simulate latency.
let BOT_SIM_LATENCY_MS = S.define({
  key: "botSimLatencyMs", env: "EVIO_BOT_SIM_LATENCY_MS", type: "int", def: 80, min: 0, max: 500,
  category: "Bots", label: "Simulated bot network latency (ms)",
  desc: "Delays a bot's target observation AND hitscan resolution by this many ms, to match a real "
      + "player's round-trip network delay (~35ms each way is typical). 0 disables — bots see and "
      + "hit off the true live position, as before. Separate from reactionMs (bot_difficulty.js), "
      + "which models human reflexes, not network delay.",
}, (v) => { BOT_SIM_LATENCY_MS = v; });
function _botSimLatencyTicks() { return Math.round(BOT_SIM_LATENCY_MS / TICK_MS); }

function _visibleEnemiesThrottled(session, sessions, maxDist, globalTick) {
  const ai = session._ai;
  if (!ai) return _visibleEnemies(session, sessions, maxDist, globalTick);
  if (!ai._visCache || !Number.isFinite(ai._visCacheTick)
      || globalTick - ai._visCacheTick >= BOT_VISION_SCAN_INTERVAL) {
    ai._visCache = _visibleEnemies(session, sessions, maxDist, globalTick);
    ai._visCacheTick = globalTick;
  }
  return ai._visCache;
}

// Picks/updates the bot's current target, applying the difficulty curve's drop/reacquire timing.
// Mutates and returns { current, visible } — `current` is null when nothing is being engaged.
function _updateBotTarget(session, sessions, curve, globalTick) {
  const ai = session._ai;
  const visible = _visibleEnemiesThrottled(session, sessions, BOT_ENGAGE_DIST, globalTick);
  const nearest = visible[0] || null;

  let current = ai.targetId ? visible.find((v) => v.session.playerId === ai.targetId) : null;
  if (current) {
    ai.lastSeenTick = globalTick;
  } else if (ai.targetId) {
    const dropTicks = Math.max(1, Math.round(curve.targetDropMs / TICK_MS));
    if (globalTick - ai.lastSeenTick > dropTicks) ai.targetId = null;
  }
  if (!ai.targetId && nearest) {
    ai.targetId = nearest.session.playerId;
    ai.acquiredTick = globalTick;
    ai.lastSeenTick = globalTick;
    current = nearest;
  }
  ai.targetLockTicks = current ? (ai.targetLockTicks || 0) + 1 : 0;
  return { current, visible };
}

// Aim + fire decision for one tick, given the currently-tracked target (may be null).
// Returns { lookDelta:[dx,dy], fire:boolean }.
function _aimAndFire(session, curve, target, dtSeconds, globalTick) {
  const ai = session._ai;
  if (!target) return { lookDelta: [0, 0], fire: false };

  // Neither aiming nor firing starts until the reaction delay has passed — a bot that could snap
  // its aim toward a target the instant it appears would read as robotic regardless of how sloppy
  // its actual aim was afterward.
  const reactionTicks = Math.max(0, Math.round(curve.reactionMs / TICK_MS));
  if (globalTick - ai.acquiredTick < reactionTicks) return { lookDelta: [0, 0], fire: false };

  const p = session.playerState;
  const eyeY = p.crouching ? CROUCH_EYE_Y : STAND_EYE_Y;
  const eye = { x: p.position.x, y: p.position.y + eyeY, z: p.position.z };
  const { yaw: trueYaw, pitch: truePitch } = _yawPitchToward(
    eye.x, eye.y, eye.z, target.eye.x, target.eye.y, target.eye.z);

  // The cone shrinks toward its floor the longer this SAME target has been continuously tracked.
  const lockMs = ai.targetLockTicks * TICK_MS;
  const coneDeg = curve.aimConeFloorDeg
    + (curve.aimConeInitialDeg - curve.aimConeFloorDeg) * Math.exp(-lockMs / curve.lockOnTauMs);
  const coneRad = coneDeg * DEG2RAD;

  // A slow random WALK within the cone, not fresh white noise every tick — a persistent wobble reads
  // as a human tracking imperfectly; independent per-tick noise reads as static/jitter instead.
  ai.aimNoiseYaw = Math.max(-coneRad, Math.min(coneRad,
    (ai.aimNoiseYaw || 0) + (Math.random() - 0.5) * coneRad * 0.3));
  ai.aimNoisePitch = Math.max(-coneRad, Math.min(coneRad,
    (ai.aimNoisePitch || 0) + (Math.random() - 0.5) * coneRad * 0.3));

  const desiredYaw = trueYaw + ai.aimNoiseYaw;
  const desiredPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, truePitch + ai.aimNoisePitch));

  // Turn rate bounds how fast the aim solution can physically catch up, independent of the cone
  // noise above — a wide-open cone still can't outrun a hard strafe if the turn rate is slow.
  const maxStep = curve.turnRateDegPerSec * DEG2RAD * dtSeconds;
  let dYaw = _wrapAngle(desiredYaw - p.yaw);
  dYaw = Math.max(-maxStep, Math.min(maxStep, dYaw));
  let dPitch = desiredPitch - p.pitch;
  dPitch = Math.max(-maxStep, Math.min(maxStep, dPitch));

  const scale = (typeof LOOK_SCALE === "number" && LOOK_SCALE) ? LOOK_SCALE : 1;
  const lookDelta = [dYaw / scale, dPitch / scale];

  // Fires once aim error is within THIS level's cone and there is a clear shot — folding "fire
  // discipline" into the same cone the aim itself uses avoids a second, redundant threshold: a
  // low-level bot's wide cone already means it fires while sloppily aimed, and a high-level bot's
  // tight cone already means it only fires once sharp.
  const bearingErr = Math.hypot(_wrapAngle(trueYaw - p.yaw), truePitch - p.pitch);
  const fire = bearingErr <= Math.max(coneRad * 1.5, 3 * DEG2RAD);
  return { lookDelta, fire };
}

// Per-tick chance of a mobility hop while moving in a straight line — not gated by botLevel (every
// level navigates equally competently; see the module header), just enough to read as a bot that
// actually uses its jump ability rather than one that has it and never touches it.
const PATROL_JUMP_CHANCE = 0.02;
// Higher than PATROL_JUMP_CHANCE on purpose: a strafe-jumping bot is trying to be a harder target,
// which reads as more deliberate than a patrol hop. Only ever consulted for botLevel >= 5 — see
// driveBotFrame's combat branch.
const COMBAT_JUMP_CHANCE = 0.04;

// ── Stuck detection & recovery ──────────────────────────────────────────────────────────────────
// _navigate previously had no notion of "am I actually making progress" — it just re-issued
// forward+sprint toward the same waypoint every tick forever. Real level geometry (stairwell
// corners, doorframes, low railings) can trap that blindly: the path is valid and the waypoint is
// theoretically reachable, but the bot's capsule is physically wedged and neither the pathfinder nor
// the movement code ever asks whether the last few ticks of "trying" actually went anywhere. Found
// live — a bot pinned in a corner, holding forward+sprint at a wall, forever.
const STUCK_CHECK_TICKS = 10;        // ~0.5s between progress checks
const STUCK_DIST_THRESHOLD = 0.75;   // must cover at least this much ground (x/z) in that window
const STUCK_STRIKES_TO_TRIGGER = 3;  // ~1.5s of no progress before recovery kicks in
const RECOVERY_TICKS = 24;           // ~1.2s of scripted unstick behaviour

// One tick of the scripted "get unstuck" maneuver: turn away from whatever trapped it and walk
// there while jumping every grounded tick — a jump clears most ledges/lips a walk alone cannot, and
// turning away (rather than continuing to face the old waypoint) actually leaves the corner instead
// of pressing back into it.
function _recoveryFrame(ai, p) {
  const maxStep = 220 * DEG2RAD * (TICK_MS / 1000);
  const dYaw = Math.max(-maxStep, Math.min(maxStep, _wrapAngle(ai._recoveryYaw - p.yaw)));
  const scale = (typeof LOOK_SCALE === "number" && LOOK_SCALE) ? LOOK_SCALE : 1;
  return { held: [0, 2, 7], pressed: p.grounded ? [4] : [], lookDelta: [dYaw / scale, 0] };
}

// Path-follow toward the bot's current wander goal, replanning on discrete triggers (arrived, no
// path, or none found last time) rather than every tick.
// Returns { held:[...], pressed:[...], lookDelta:[dx,dy] }.
function _navigate(session, globalTick) {
  const ai = session._ai;
  const p = session.playerState;
  const graph = _botNavGraph();
  if (!graph.nodes.length) return { held: [], pressed: [], lookDelta: [0, 0] };

  // Recovery takes priority over everything below — a bot mid-recovery ignores its path entirely
  // until the scripted maneuver finishes, then forces a genuinely fresh goal (never a retry of the
  // one that trapped it — that just walks it straight back into the same corner).
  if (ai._recoveryUntilTick) {
    if (globalTick < ai._recoveryUntilTick) return _recoveryFrame(ai, p);
    ai._recoveryUntilTick = 0;
    ai.path = null;
    ai._stuckStrikes = 0;
    ai._stuckRefPos = null;
  }

  const ARRIVE_DIST = 2.5;
  if (!ai.path || !ai.path.length) {
    if (globalTick < (ai.nextRepathTick || 0)) return { held: [], pressed: [], lookDelta: [0, 0] };
    const goal = _pickWanderGoal(graph);
    // ~2s before trying again — covers both "no path exists from here" and "arrived, need a new one".
    ai.nextRepathTick = globalTick + 40;
    if (!goal) return { held: [], pressed: [], lookDelta: [0, 0] };
    const path = navPath.findPath(graph, p.position, goal, { snapDist: 40 });
    if (!path || !path.length) return { held: [], pressed: [], lookDelta: [0, 0] };
    ai.path = path;
  }

  const wp = ai.path[0];
  const dx = wp.x - p.position.x, dz = wp.z - p.position.z;
  if (Math.hypot(dx, dz) < ARRIVE_DIST) {
    ai.path.shift();
    return { held: [], pressed: [], lookDelta: [0, 0] };
  }
  const desiredYaw = Math.atan2(-dx, -dz);   // see _yawPitchToward's header comment for the sign
  // Patrol turning is not gated by combat skill — every level navigates equally competently (see
  // the module header): only the COMBAT axes above scale with botLevel.
  const maxStep = 220 * DEG2RAD * (TICK_MS / 1000);
  const dYaw = Math.max(-maxStep, Math.min(maxStep, _wrapAngle(desiredYaw - p.yaw)));
  const scale = (typeof LOOK_SCALE === "number" && LOOK_SCALE) ? LOOK_SCALE : 1;
  // Only walk forward once roughly facing the waypoint — advancing while still turning hard reads
  // as sliding sideways past it rather than turning to approach it.
  const moving = Math.abs(_wrapAngle(desiredYaw - p.yaw)) < 60 * DEG2RAD;

  // Progress check — only meaningful while actually trying to walk forward (a bot correctly standing
  // still to finish turning toward a waypoint is not "stuck", so don't accumulate strikes for that).
  if (moving) {
    if (globalTick - (ai._stuckCheckTick || 0) >= STUCK_CHECK_TICKS) {
      if (ai._stuckRefPos) {
        const moved = Math.hypot(p.position.x - ai._stuckRefPos.x, p.position.z - ai._stuckRefPos.z);
        ai._stuckStrikes = (moved < STUCK_DIST_THRESHOLD) ? (ai._stuckStrikes || 0) + 1 : 0;
      }
      ai._stuckRefPos = { x: p.position.x, z: p.position.z };
      ai._stuckCheckTick = globalTick;
      if (ai._stuckStrikes >= STUCK_STRIKES_TO_TRIGGER) {
        ai._recoveryUntilTick = globalTick + RECOVERY_TICKS;
        // Roughly about-face, randomized so two bots stuck the same way don't turn identically —
        // "roughly forward" is exactly the direction that just failed.
        ai._recoveryYaw = p.yaw + Math.PI + (Math.random() - 0.5) * Math.PI;
        ai._stuckStrikes = 0;
        return _recoveryFrame(ai, p);   // don't waste the triggering tick — start the maneuver now
      }
    }
  } else {
    ai._stuckRefPos = null;   // not trying to move right now; a stale reference would misread as stuck
  }

  const held = moving ? [0, 7] : [];   // 7 = sprint: a bot that only ever walks looks broken, not calm
  // Jump (key 4) belongs in the wire's `pressed` slot, not `held`. Verified directly against the
  // extracted physics source (physics_extracted.js ~3518: `F = !l && y.Qkovvb8.has(4) && ...` — the
  // ENTIRE jump gate, ground or air — where Qkovvb8 is built purely from the pressed array
  // (_integrateWithExtractedPhysics reads packed[1] straight off each explicit frame; bots always
  // send an explicit frame, so the diff-against-heldActions idle-tick path never applies to them).
  // An earlier version of this comment claimed the opposite from reading the WRONG branch of that
  // function (the no-frames idle case) and "fixed" this into `held`, which — being continuously
  // true rather than a discrete edge — never actually triggered a jump at all.
  const pressed = (moving && p.grounded && Math.random() < PATROL_JUMP_CHANCE) ? [4] : [];
  return { held, pressed, lookDelta: [dYaw / scale, 0] };
}

// ── Sword bot combat ─────────────────────────────────────────────────────────────────────────────
// Unlike the gun bots (plant + strafe, engage at any range a hitscan reaches), a sword is
// melee-only: doing nothing but the gun bots' "hold ground and shoot" would mean a sword bot never
// actually lands a hit. This closes distance, uses the ability kit tactically, and swings once in
// range — see reconcileSwordBotCount/SWORD_BOT_ABILITY_SEED for how it gets spawned.
const SWORD_MELEE_RANGE = 4.0;            // approach closes to this before swinging
// Lowered from 18: with the level-5 teleport's 25u blink (see SWORD_BOT_ABILITY_SEED) a rush now
// covers most of BOT_ENGAGE_DIST in one go, and this threshold is deliberately set to exactly meet
// SWORD_MELEE_RANGE*2.5 (the juke zone's own boundary below) — together the two zones cover the
// WHOLE distance range with no dead gap in between where neither tactic used to fire.
const SWORD_RUSH_TELEPORT_DIST = 10;      // only consider closing-the-gap via teleport past this
const SWORD_TELEPORT_MIN_GAP_TICKS = 40;  // ~2s between teleport attempts even with charge to spare
const SWORD_TELEPORT_JUKE_CHANCE = 0.02;    // per tick, once already close: blink to a flank/behind
const SWORD_TELEPORT_RUSH_CHANCE = 0.05;    // per tick, while far and healthy: blink toward target
const SWORD_TELEPORT_RETREAT_CHANCE = 0.06; // per tick, once wounded: blink directly away
const SWORD_LOW_HP_FRACTION = 0.5;        // health <= this switches on retreat/impulse tactics
const SWORD_IMPULSE_MIN_GAP_TICKS = 60;   // ~3s between impulse throws
const SWORD_IMPULSE_CHANCE = 0.04;        // per tick, once wounded and in range
const SWORD_IMPULSE_RANGE = 10;
// HE has 2 starting charges at cost 0.5 (ABILITY_COST[8]=[0.5], see SWORD_BOT_ABILITY_SEED); Sticky
// has 1 at cost 1 (ABILITY_COST[13]=[1]) — so Sticky's effective gap is bounded far more by its own
// recharge time than by this constant, this just stops back-to-back throws the instant it's ready.
const SWORD_HE_MIN_GAP_TICKS = 100;       // ~5s between HE throws
const SWORD_HE_CHANCE = 0.05;             // per tick, once in range and off cooldown
const SWORD_STICKY_MIN_GAP_TICKS = 140;   // ~7s between Sticky throws
const SWORD_STICKY_CHANCE = 0.04;         // per tick, once in range and off cooldown

let SWORD_BOT_IMPULSE_ENABLED = S.define({
  key: "swordBotImpulseEnabled", env: "EVIO_SWORD_BOT_IMPULSE", type: "bool", def: true,
  category: "Bots", label: "Sword bots can use Impulse",
  desc: "OFF stops sword bots throwing the Impulse ability when wounded (the space-buying/escape "
      + "throw) — they still carry the ability (weaponStateArray is unchanged), they simply never "
      + "choose to use it. Purely a tactic toggle for tuning/testing; does not change the ability seed.",
}, (v) => { SWORD_BOT_IMPULSE_ENABLED = v; });
let SWORD_BOT_GRENADES_ENABLED = S.define({
  key: "swordBotGrenadesEnabled", env: "EVIO_SWORD_BOT_GRENADES", type: "bool", def: true,
  category: "Bots", label: "Sword bots can use HE/Sticky grenades",
  desc: "OFF stops sword bots throwing HE or Sticky grenades as ranged offense before/while closing "
      + "— they still carry both (weaponStateArray is unchanged), they simply never choose to throw "
      + "them. Independent of swordBotImpulseEnabled, which is a separate tactic.",
}, (v) => { SWORD_BOT_GRENADES_ENABLED = v; });
// Teleport is action 9 in the wire's PRESSED slot (see foldInputFrameIntoSim's fallback comment and
// physics_extracted.js `y.Qkovvb8.has(9)`). It always moves the caster forward along whatever yaw
// they are facing the moment the physics tick runs, a FIXED distance set by the ability's level (14
// units at level 3 — see SWORD_BOT_ABILITY_SEED). There is no "teleport TO a point": the whole
// tactic is which direction the bot faces when it presses the key, so every branch below sets an
// absolute yaw via lookDelta in the SAME tick, bypassing the normal tracked-aim turn-rate cap on
// purpose — this is a deliberate snap-turn-and-blink, not slow tracking.
const TELEPORT_ACTION = 9;
const IMPULSE_ACTION = 38;   // GRENADE_ACTIONS[38] = 16 (impulse) — cast on RELEASE, not press
const HE_ACTION = 19;        // GRENADE_ACTIONS[19] = 8  (HE Grenade)
const STICKY_ACTION = 22;    // GRENADE_ACTIONS[22] = 13 (Sticky Grenade)

// Charge availability, read directly off the extracted physics mirror. Qctsdxd is Teleport's
// (timer3) current charge fraction (0..1, recharging at Qz8l93a.Qn97q6u/tick); Qctsdxa is Impulse's
// (timer6); Qctsdxg is HE's (timer0); Qctsdxc is Sticky's (timer4). All are maintained ENTIRELY by
// physics_extracted.js — nothing here writes to them, only reads, exactly like a real client reading
// its own HUD charge indicator.
function _abilityCharge(playerState, field) {
  return (playerState._ps && Number.isFinite(playerState._ps[field])) ? playerState._ps[field] : 0;
}
// Absolute yaw delta to face `desiredYaw` exactly THIS tick, ignoring the normal turn-rate cap.
function _snapTurnDelta(p, desiredYaw) {
  const scale = (typeof LOOK_SCALE === "number" && LOOK_SCALE) ? LOOK_SCALE : 1;
  return _wrapAngle(desiredYaw - p.yaw) / scale;
}

// ── Threat detection & dodge tactics ────────────────────────────────────────────────────────────
// "is anything about to hurt me right now" — a gun actively lined up on us, or live enemy ordnance
// (a flying/planted HE or sticky, an armed mine, or an armed trip-mine beam) within its own effective
// radius of us. Two different escape shapes fall out of this distinction: a gun threat only threatens
// along ONE line (so stepping off that line to either side defeats it), while ordnance threatens
// equally from every direction (so the only correct escape vector is radially away from it) — which
// is why they get two separate detectors instead of one generic "something dangerous is near" check.
const SWORD_GUN_THREAT_CONE_DEG = 6;      // half-angle: enemy aim within this of us counts as "lined up"
const SWORD_GUN_THREAT_RANGE = 55;        // ~ typical hitscan weapon's effective range
const SWORD_GRENADE_THREAT_MARGIN = 3;    // extra radius past the blast aoe treated as "still in range"
const SWORD_MINE_THREAT_MARGIN = 2;
const SWORD_TRIPMINE_THREAT_MARGIN = 1.5;
const SWORD_DODGE_JUMP_CHANCE = 0.5;      // per tick while dodging — well above the ambient COMBAT_JUMP_CHANCE
const SWORD_DODGE_TELEPORT_URGENCY = 0.6; // ordnance urgency (0..1) above which a ready teleport is
                                           // spent escaping instead of any other tactic this tick

// Is a live enemy gun currently aimed at us (within the cone, in range)? Sword-wielding enemies never
// register — a sword has no line-of-fire, only melee proximity, which the approach/melee logic below
// already handles. Returns the nearest-to-dead-centre match, or null.
function _findGunLineThreat(session, sessions) {
  if (!sessions) return null;
  const p = session.playerState;
  const eyeY = p.crouching ? CROUCH_EYE_Y : STAND_EYE_Y;
  const myEye = { x: p.position.x, y: p.position.y + eyeY, z: p.position.z };
  let best = null, bestAngle = SWORD_GUN_THREAT_CONE_DEG;
  for (const s of sessions.values()) {
    if (!s || !s.accepted || s === session) continue;
    const e = s.playerState;
    if (!e || !e.position || e.deathStateTimer > 0 || e.healthPoints <= 0) continue;
    if (e.equippedWeaponId === SWORD_WEAPON_ID) continue;   // melee — no line-of-fire threat
    const eEyeY = e.crouching ? CROUCH_EYE_Y : STAND_EYE_Y;
    const ex = e.position.x, ey = e.position.y + eEyeY, ez = e.position.z;
    const dx = myEye.x - ex, dy = myEye.y - ey, dz = myEye.z - ez;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.5 || dist > SWORD_GUN_THREAT_RANGE) continue;
    const dir = phys.aimDirection(e.yaw, e.pitch);
    const dot = (dx * dir.x + dy * dir.y + dz * dir.z) / dist;
    const angleDeg = Math.acos(Math.max(-1, Math.min(1, dot))) * (180 / Math.PI);
    if (angleDeg < bestAngle) {
      bestAngle = angleDeg;
      best = { shooterEye: { x: ex, y: ey, z: ez }, aimDir: dir, dist };
    }
  }
  return best;
}

// Nearest/most urgent piece of LIVE enemy ordnance we're currently within blast/beam range of.
// urgency is 0..1 (1 = right on top of it). Our own thrown entities never count as a threat.
function _findExplosiveThreat(session) {
  const p = session.playerState;
  const chestY = p.position.y + 1;
  let best = null, bestUrgency = 0;
  for (const [, g] of activeEntities) {
    if (!g.combat || g.disabled || g.ownerSid === p._ownerSid) continue;
    if (g.type === 176) {   // trip mine: the threat is the BEAM, not the device itself
      if (!g.armed || !g.ray) continue;
      const d = pointToSegDist(p.position.x, chestY, p.position.z, g.ray, g.combat.tripRayLen);
      const margin = g.combat.tripRadius + SWORD_TRIPMINE_THREAT_MARGIN;
      if (d > margin) continue;
      const urgency = 1 - d / margin;
      if (urgency > bestUrgency) { bestUrgency = urgency; best = { type: "tripmine", g, dist: d }; }
      continue;
    }
    const dist = Math.hypot(g.pos.x - p.position.x, g.pos.y - chestY, g.pos.z - p.position.z);
    if (g.type === 173) {   // mine: only a threat once armed, inside its own proximity trigger + margin
      if (!g.armed) continue;
      const margin = g.combat.proxyDistance + SWORD_MINE_THREAT_MARGIN;
      if (dist > margin) continue;
      const urgency = 1 - dist / margin;
      if (urgency > bestUrgency) { bestUrgency = urgency; best = { type: "mine", g, dist }; }
      continue;
    }
    // HE / sticky, in flight or planted — threat radius is its own blast aoe plus a margin.
    const margin = g.combat.aoe + SWORD_GRENADE_THREAT_MARGIN;
    if (dist > margin) continue;
    const urgency = 1 - dist / margin;
    if (urgency > bestUrgency) { bestUrgency = urgency; best = { type: "grenade", g, dist }; }
  }
  return best ? Object.assign(best, { urgency: bestUrgency }) : null;
}

// Convert a world-space XZ escape direction into body-relative held keys (0 forward/1 back/2 left/3
// right), using the SAME forward/right axes the real movement path integrates against (see the
// ground-truth check in test_bot_ai.js: forward = (-sin(yaw), -cos(yaw))). Deliberately NOT a snap
// turn — dodge movement rides on top of whatever the bot is already looking at (its melee target),
// exactly like a real player strafing while keeping their crosshair up.
function _bodyRelativeEscapeKeys(p, ex, ez) {
  const mag = Math.hypot(ex, ez);
  if (mag < 1e-6) return [];
  const ux = ex / mag, uz = ez / mag;
  const rightX = Math.cos(p.yaw), rightZ = -Math.sin(p.yaw);
  const fwdX = -Math.sin(p.yaw), fwdZ = -Math.cos(p.yaw);
  const rightDot = ux * rightX + uz * rightZ;
  const fwdDot = ux * fwdX + uz * fwdZ;
  const keys = [];
  if (Math.abs(rightDot) > 0.25) keys.push(rightDot > 0 ? 3 : 2);
  if (Math.abs(fwdDot) > 0.25) keys.push(fwdDot > 0 ? 0 : 1);
  return keys;
}

function _swordCombatFrame(session, curve, target, tick, sessions) {
  const ai = session._ai;
  const p = session.playerState;
  if (!target) {
    // Engaged (ai.targetId still set) but momentarily out of sight (LOS drop-grace window) — hold
    // position and stay alert rather than reverting to patrol navigation mid-fight, same reasoning
    // as the gun bots' ai.targetId-vs-`current` distinction in driveBotFrame.
    return { held: [], pressed: [], released: [], lookDelta: [0, 0] };
  }
  let held = [];
  let pressed = [];
  let released = [];

  const dx = target.eye.x - p.position.x, dz = target.eye.z - p.position.z;
  const dist = Math.hypot(dx, dz);
  const toTargetYaw = Math.atan2(-dx, -dz);   // see _yawPitchToward's header comment for the sign
  const hpFraction = Number.isFinite(p.healthPoints) ? p.healthPoints : 1;
  const wounded = hpFraction <= SWORD_LOW_HP_FRACTION;
  const targetPs = target.session && target.session.playerState;
  const targetIsGunUser = !!targetPs && targetPs.equippedWeaponId !== SWORD_WEAPON_ID;

  // Aim/swing reuses the exact same cone/reaction/turn-rate model every bot uses — melee needs no
  // different AIM logic, only a distance gate on top (no point swinging from 10 units away).
  const { lookDelta: aimLook, fire: aimFire } = _aimAndFire(session, curve, target, TICK_MS / 1000, tick);
  let lookDelta = aimLook;
  const fire = aimFire && dist <= SWORD_MELEE_RANGE;

  // Close to melee range if not already there — reuses _navigate's "only walk once roughly facing
  // the target" rule so approaching doesn't read as sliding sideways past it. A GUN-wielding target
  // gets an extra zigzag strafe layered on top of the straight walk-in (see "different tactics
  // depending on whether the enemy uses a gun or sword" below): closing on a sword user is already
  // safe (no line-of-fire to dodge), closing on a gun user is the exposed part of the engagement.
  if (dist > SWORD_MELEE_RANGE) {
    const facingErr = Math.abs(_wrapAngle(toTargetYaw - p.yaw));
    if (facingErr < 60 * DEG2RAD) {
      held.push(0); held.push(7);
      if (targetIsGunUser) {
        if (tick >= (ai._zigzagUntilTick || 0)) {
          ai._zigzagDir = Math.random() < 0.5 ? -1 : 1;
          ai._zigzagUntilTick = tick + 8 + Math.floor(Math.random() * 10);   // re-roll every ~0.4-0.9s
        }
        held.push(ai._zigzagDir > 0 ? 3 : 2);
      }
    }
  }
  // Jump while closing or fighting, for unpredictability — sword bots are inherently the
  // aggressive, hard-to-pin archetype, so this is not level-gated the way the gun bots' strafe-jump
  // is (see driveBotFrame's plain-bot branch).
  if (p.grounded && Math.random() < COMBAT_JUMP_CHANCE) pressed.push(4);

  // ── Reactive dodging — gun line-of-fire and live enemy ordnance ──────────────────────────────
  // Independent of which enemy is currently the melee target: a THIRD player's gunfire, or anyone's
  // planted mine/trip mine/grenade, threatens the bot regardless of who it's about to swing at.
  const gunThreat = _findGunLineThreat(session, sessions);
  const explosiveThreat = _findExplosiveThreat(session);
  let dodgingByTeleport = false;

  // ── Teleport tactics — at most one attempt per tick, and mutually exclusive with every throw
  // below (all of them would otherwise fight over lookDelta, and a teleport MUST land in the
  // direction it decided on, not whatever direction a same-tick throw aim happened to want).
  let teleported = false;
  const teleportCharge = _abilityCharge(p, "Qctsdxd");
  const teleportCost = 0.2;   // ABILITY_COST[0][4] — level 5, see SWORD_BOT_ABILITY_SEED
  const teleportReady = teleportCharge >= teleportCost
    // Number.isFinite, NOT `||` — a cooldown that last fired on tick 0 is a legitimate recent value,
    // but `0 || -1e9` treats 0 as falsy and silently discards it, reopening the gate one tick after
    // a teleport that happened to land on tick 0 (found once the gun-target rush below became
    // deterministic, which made landing on tick 0 the common case instead of a rare fluke).
    && (tick - (Number.isFinite(ai.lastTeleportTick) ? ai.lastTeleportTick : -1e9)) >= SWORD_TELEPORT_MIN_GAP_TICKS;
  if (teleportReady) {
    let teleportYaw = null;
    if (explosiveThreat && explosiveThreat.urgency >= SWORD_DODGE_TELEPORT_URGENCY) {
      // Emergency escape: an armed mine/tripmine beam/live grenade is close enough that walking
      // away won't clear it in time — spend the teleport blinking straight away from the danger
      // point, overriding every other tactic this tick (survival beats positioning).
      const gp = explosiveThreat.g.pos;
      teleportYaw = Math.atan2(-(p.position.x - gp.x), -(p.position.z - gp.z)) + Math.PI;
      dodgingByTeleport = true;
    } else if (wounded && Math.random() < SWORD_TELEPORT_RETREAT_CHANCE) {
      // Pull away: face directly away and blink backward — the requested "pull away distance"
      // tactic once hurt, using the real ability instead of a scripted repositioning hack.
      teleportYaw = toTargetYaw + Math.PI;
    } else if (!wounded && dist >= SWORD_RUSH_TELEPORT_DIST
        && (targetIsGunUser || Math.random() < SWORD_TELEPORT_RUSH_CHANCE)) {
      // Rush: close a big gap instantly rather than the long walk-in — reads as an aggressive
      // engage. Against a GUN user this is no longer a flavour roll — with 5 teleport charges and a
      // 25u blink (see SWORD_BOT_ABILITY_SEED), the entire fight is won or lost on how little time
      // is spent walking through open ground under fire, so every ready charge is spent the instant
      // it's usable. Against a sword user (no line-of-fire to escape) it stays a probabilistic
      // aggression flourish instead, since there's nothing costly about the walk-in there.
      teleportYaw = toTargetYaw;
    } else if (dist <= SWORD_MELEE_RANGE * 2.5 && Math.random() < SWORD_TELEPORT_JUKE_CHANCE) {
      // Distract/juke: already close — blink to a flank or behind, breaking the target's aim
      // without fully disengaging. Not gated on health; this is the "distract" behaviour.
      const lateral = (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2 + (Math.random() - 0.5) * (Math.PI / 3));
      teleportYaw = toTargetYaw + lateral;
    }
    if (teleportYaw !== null) {
      lookDelta = [_snapTurnDelta(p, teleportYaw), lookDelta[1]];
      pressed.push(TELEPORT_ACTION);
      ai.lastTeleportTick = tick;
      teleported = true;
    }
  }

  // Non-teleport dodging (strafe/sideway/jump) — applies whenever a threat is live and we didn't
  // already spend a teleport escaping it this tick. Ordnance threat wins over a gun threat when
  // both are present (an AoE about to detonate outranks merely being aimed at).
  if (!dodgingByTeleport && (gunThreat || explosiveThreat)) {
    let ex = 0, ez = 0;
    if (explosiveThreat) {
      // Radial escape: straight away from the danger point, in every direction equally.
      const gp = explosiveThreat.g.pos;
      ex = p.position.x - gp.x; ez = p.position.z - gp.z;
    } else {
      // Lateral escape: step off the shooter's aim line to whichever side we're already biased
      // toward (continuing that way clears the cone fastest instead of crossing back through it).
      const se = gunThreat.shooterEye, dir = gunThreat.aimDir;
      const perpX = -dir.z, perpZ = dir.x;
      const toMeX = p.position.x - se.x, toMeZ = p.position.z - se.z;
      const side = (toMeX * perpX + toMeZ * perpZ) >= 0 ? 1 : -1;
      ex = perpX * side; ez = perpZ * side;
    }
    for (const key of _bodyRelativeEscapeKeys(p, ex, ez)) held.push(key);
    if (p.grounded && Math.random() < SWORD_DODGE_JUMP_CHANCE) pressed.push(4);
  }

  // ── Throwables — HE / Sticky (offense) and Impulse (defensive space-buying). At most one throw
  // per tick, mutually exclusive with teleport (see above). Priority: Impulse when badly wounded
  // (buy space right now) outranks the offensive throws (there's no point lobbing HE while about to
  // be finished off in melee).
  if (!teleported) {
    const impulseCharge = _abilityCharge(p, "Qctsdxa");
    const impulseCost = 0.5;   // ABILITY_COST[16][0] — level 1, see SWORD_BOT_ABILITY_SEED
    const impulseReady = SWORD_BOT_IMPULSE_ENABLED && wounded && impulseCharge >= impulseCost
      && dist <= SWORD_IMPULSE_RANGE
      && (tick - (Number.isFinite(ai.lastImpulseTick) ? ai.lastImpulseTick : -1e9)) >= SWORD_IMPULSE_MIN_GAP_TICKS;
    if (impulseReady && Math.random() < SWORD_IMPULSE_CHANCE) {
      // Face the target so the thrown grenade actually travels toward them (spawnGrenade launches
      // along the caster's current aim, same as a real player's throw).
      lookDelta = [_snapTurnDelta(p, toTargetYaw), lookDelta[1]];
      released.push(IMPULSE_ACTION);
      ai.lastImpulseTick = tick;
    } else {
      // HE and Sticky: mid-range offense before/while closing, thrown MORE readily against a gun
      // user (softening a ranged opponent before eating their fire in melee is the professional
      // play) than a sword user (who has no ranged threat to answer, so the throw is more optional —
      // still occasionally used for chip damage, just at half the base chance).
      const heCharge = _abilityCharge(p, "Qctsdxg");
      const heCost = 0.5;                       // ABILITY_COST[8][0] — level 1
      const heReady = SWORD_BOT_GRENADES_ENABLED && heCharge >= heCost && dist >= 5 && dist <= 24
        && (tick - (Number.isFinite(ai.lastHeTick) ? ai.lastHeTick : -1e9)) >= SWORD_HE_MIN_GAP_TICKS;
      const stickyCharge = _abilityCharge(p, "Qctsdxc");
      const stickyCost = 1;                      // ABILITY_COST[13][0] — level 1
      const stickyReady = SWORD_BOT_GRENADES_ENABLED && stickyCharge >= stickyCost && dist >= 5 && dist <= 20
        && (tick - (Number.isFinite(ai.lastStickyTick) ? ai.lastStickyTick : -1e9)) >= SWORD_STICKY_MIN_GAP_TICKS;
      const rangedChanceMult = targetIsGunUser ? 1 : 0.5;
      if (heReady && Math.random() < SWORD_HE_CHANCE * rangedChanceMult) {
        lookDelta = [_snapTurnDelta(p, toTargetYaw), lookDelta[1]];
        released.push(HE_ACTION);
        ai.lastHeTick = tick;
      } else if (stickyReady && Math.random() < SWORD_STICKY_CHANCE * rangedChanceMult) {
        lookDelta = [_snapTurnDelta(p, toTargetYaw), lookDelta[1]];
        released.push(STICKY_ACTION);
        ai.lastStickyTick = tick;
      }
    }
  }

  if (fire) held.push(5);
  return { held, pressed, released, lookDelta };
}

// Below this world Y a player has fallen off the map → instant death (matches the client's own
// `position.y < Qq85ufw` 999999-damage fall kill, bundle :34575). The client predicts it; the server
// MUST apply it too, or the reconciler reverts the client's HP to our (still-alive) value and the
// player falls forever without ever entering the respawn path.
let FALL_DEATH_Y = S.define({
  key: "fallDeathY", type: "number", def: -30, min: -1000, max: 100, step: 1,
  category: "Gameplay", label: "Fall-death plane Y",
  desc: "Below this world Y a player dies instantly (bundle Qq85ufw). The client predicts this, "
      + "so the server must apply it too or the reconciler reverts the death.",
}, (v) => { FALL_DEATH_Y = v; });

// Per-tick: advance the death state; respawn (full HP, new spawn, zero velocity) after the timer.
function processDeathRespawn(sessions) {
  for (const s of sessions.values()) {
    const p = s.accepted && s.playerState;
    if (!p) continue;
    // Fall death: kill an ALIVE player who has dropped below the kill plane. applyDamage routes it
    // through the same authoritative health/death path as combat (sets healthPoints=0 + deathStateTimer).
    if (p.deathStateTimer <= 0 && p.healthPoints > 0 && p.position && p.position.y < FALL_DEATH_Y) {
      applyDamage(p, 999, null);   // world kill: counts a death, credits no one
      console.log(`[evio-local] fall death at y=${p.position.y.toFixed(1)}`);
    }
    if (p.deathStateTimer <= 0) continue;
    p.deathStateTimer += 1;
    if (p.deathStateTimer > RESPAWN_TICKS) respawnPlayerNow(p);
  }
}

// The respawn EFFECT — full HP, a spawn point, a full magazine, the primary in hand, cleared physics
// and recoil state — with no waiting attached. Extracted so arriving from the CLICK TO PLAY screen can
// have all of it immediately.
//
// Joining used to be expressed as `deathStateTimer = 1`, which borrowed the death path's DELAY along
// with its effects: the emitter reports 91 = 4 for as long as that timer runs, so a player who clicked
// to play was told "you are dead" for RESPAWN_TICKS (60 ticks = 3s) and the client showed the DEATH
// CAMERA (:53226) throughout. That was the 2-3 second spectator-like view on entering the match.
function respawnPlayerNow(p) {
    {
      const spawns = activeSpawnPoints();
      const sp = (spawns && spawns.length ? spawns[(p.spawnSeed++) % spawns.length] : null) || { x: 0, y: GROUND_Y, z: 0 };
      p.healthPoints = 1; p.armorPoints = 0; p.deathStateTimer = 0; p.fireCooldown = 0;
      p.ticksSinceDamage = 99999; p.ticksSinceKill = 99999; p.forceRegen = false;
      if (p._damagedBy) p._damagedBy.clear();   // the damage log is per-life
      // A pickup weapon NEVER survives death (official behaviour), every slot at once — cleared
      // before the primary-restore check below so weaponList[0] is unambiguously the primary again.
      _clearAllPickupWeapons(p);
      p.gunAmmo = weaponClip(p._ammoGunId, p); p.reloadTicks = 0;   // respawn with a full magazine
      // Respawn holding the PRIMARY, not whatever was in hand at death. A player who died mid-melee
      // came back with the sword out, which is not how the official game behaves and is a nasty
      // surprise when you respawn into a firefight. weaponList[0] is the primary (the sword is
      // always last); in sword-only mode the list is [262] and this correctly leaves it alone.
      if (!SWORD_ONLY && Array.isArray(p.weaponList) && p.weaponList.length
          && Number.isFinite(p.weaponList[0]) && p.weaponList[0] !== 262
          && p.equippedWeaponId !== p.weaponList[0]) {
        p.backupWeaponId = p.equippedWeaponId;
        p.equippedWeaponId = p.weaponList[0];
        p._ammoGunId = p.weaponList[0];
        p.gunAmmo = weaponClip(p.weaponList[0], p);
        // equippedWeaponId (127) is DELTA-emitted — absent means unchanged — so changing it here is
        // invisible unless we also schedule the re-send. Without this the server believed the player
        // was holding the rifle while the client carried on rendering the sword, and they only
        // agreed again after a manual switch.
        p.weaponSendCount = WEAPON_SEND_REPEAT_TICKS;
        startWeaponSwitch(p);
      }
      p.position.x = sp.x; p.position.y = sp.y; p.position.z = sp.z;
      p.velocity.x = 0; p.velocity.y = 0; p.velocity.z = 0;
      const ps = p._ps;
      if (ps && ps.Qdsukt4) { ps.Qdsukt4.x = sp.x; ps.Qdsukt4.y = sp.y; ps.Qdsukt4.z = sp.z; }
      if (ps && ps.Qyaswvo) { ps.Qyaswvo.x = 0; ps.Qyaswvo.y = 0; ps.Qyaswvo.z = 0; }
      // Reset the PHYSICS health/armor/death-timer too: a fall death runs the bundle's own fall damage
      // (Q2ngzid) which zeroes ps.Qq7zdfv and sets the death timer ps.Qpjho15 — and the movement step
      // bails while either holds (bundle :34491), so without this the respawned player stays FROZEN.
      if (ps) {
        ps.Qq7zdfv = (ps.Qz8l93a && Number.isFinite(ps.Qz8l93a.Qtgt1xt)) ? ps.Qz8l93a.Qtgt1xt : 1;  // full HP
        ps.Qd032mo = 0;     // armor
        ps.Qpjho15 = 0;     // physics death-state timer
        applySpawnCounters(ps);
      }
      // Clear recoil/pitch-kick state so a player who died mid-burst doesn't respawn with a
      // pending pitch kick (which would diverge from the freshly-spawned client prediction).
      if (ps) {
        ps.Qezh4wz = 9999; ps.Qm2pxgr = 0; ps.Qq1azjr = 0; ps.Qq1azd5 = 0; ps.Qd0yy90 = 0;
      }
      p.pitchOffset = 0;
      // Drop pre-respawn lag-comp history so a shooter can't rewind this player back across the
      // teleport. This was setting the field on the wrong object (playerState, not the session that
      // actually owns _posHistory — see recordPositionSnapshot/positionAtTick) and had been a no-op
      // ever since it was added; found while adding the broadcast-position reset right below it,
      // which needed the same "which object actually owns this" check.
      const _ownerSession = _live.sessions && p._ownerSid && _live.sessions.get(p._ownerSid);
      if (_ownerSession) {
        _ownerSession._posHistory = null;
        // Any queued pre-death sub-tick positions must not replay AFTER the respawn snap — see the
        // matching reset below for why.
        if (_ownerSession._peerReplayQueue) _ownerSession._peerReplayQueue.length = 0;
      }
      // Drop the peer-broadcast smoothing state too — respawning IS a genuine instant reposition
      // (new spawn point, not organic movement), so peers must see it as a snap, not an eased slide
      // across the map from the death location. updateBroadcastPosition treats a null value as
      // "nothing to ease from yet" and snaps straight to the true (new) position on its next call.
      p._broadcastPos = null;
      console.log(`[evio-local] respawned at (${sp.x.toFixed(1)},${sp.y.toFixed(1)},${sp.z.toFixed(1)})`);
    }
}

// NOTE: this is deliberately NOT a non-finite guard — Number(NaN.toFixed(4)) === NaN, so NaN and
// ±Infinity pass straight through and msgpack ships them intact. Use `fin()` for anything that
// goes on the wire; a non-finite position permanently bricks the client's comparator.
function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return fin(value);
  return Number(value.toFixed(decimals));
}

// Emit-boundary guard: coerce any non-finite number to a safe finite fallback, loudly. This is the
// last line before msgpack, so nothing downstream can poison the client (see _sanitizePlayerSim
// for why a single NaN is unrecoverable without a page refresh).
let _finWarned = 0;
function fin(value, fallback = 0) {
  if (Number.isFinite(value)) return value;
  if (_finWarned < 20) {
    _finWarned++;
    console.error(`[evio-local] blocked non-finite value (${value}) at the emit boundary — `
      + `substituting ${fallback}. A NaN reaching the client desyncs it until a page refresh.`);
  }
  return fallback;
}

// Counter for generating unique extracted-physics player IDs.
let _physStateCounter = 0;

function createPlayerSimState(spawn = {}, sessionId = null) {
  const spawnX = Number.isFinite(spawn.x) ? spawn.x : 0;
  const spawnZ = Number.isFinite(spawn.z) ? spawn.z : 0;
  // Y comes from the evmap spawn, else flat GROUND_Y. This used to consult the Bishop heightmap
  // first, but spawns are now resolved onto the real collision floor by resolveSpawnsToFloor in
  // physics_world, so the heightmap only ever returned its FLAT_Y fallback here — at which
  // point the old expression collapsed to exactly these two lines (FLAT_Y and GROUND_Y are both 2.0).
  const y = Number.isFinite(spawn.y) ? spawn.y : GROUND_Y;
  const onGround = true;
  const yaw = Number.isFinite(spawn.yaw) ? spawn.yaw : 0;

  const state = {
    _ownerSid: sessionId,   // = playerId (opcode 90); a grenade's ownerSid must match this
    energyCharge: 0,        // flash-blind intensity (opcode 198); 0 = no blind
    qwv47ix: 0,             // flash-blind fade counter (opcode 197); blind = .5*(eC - .01*qwv47ix)^2
    // ── Combat (opcodes 166 health / 167 armor / 168 deathStateTimer) — normalized 0..1 HP ──
    healthPoints: 1,        // full = 1.0; damage reduces it; <=0 → death
    armorPoints: 0,         // absorbs damage before health
    deathStateTimer: 0,     // 0 = alive; >0 counts up while dead until respawn
    fireCooldown: 0,        // ticks until the weapon can fire again
    spawnSeed: 0,           // which spawn point this player last used (cycles on respawn)
    position: {
      x: spawnX,
      y,
      z: spawnZ,
    },
    velocity: { x: 0, y: 0, z: 0 },
    yaw,
    pitch: 0,
    pitchOffset: 0,   // pending recoil/look kick (opcode 141); synced from ps.Qd0yy90 each tick
    grounded: onGround,
    airJumps: 0,
    heldActions: new Set(),
    jumpQueued: false,
    // crouchQueued retained only for jump-while-crouching interactions
    crouchQueued: false,
    // crouching = Q2r3ysn (crouching AND grounded, from physics).  NOT the raw key.
    crouching: false,
    // sprinting = Q2xg3ev (sprinting flag, from physics). Includes stamina/conditions.
    sprinting: false,
    // justTeleported = Qgxywsl (set true by g() when teleport fires, reset next tick)
    justTeleported: false,
    // sliding: true when crouching+grounded AND horizontalSpeed >= walkSpeed * SLIDE_THRESHOLD.
    sliding: false,
    // Prev-frame state for slide entry boost (bundle: i.Q9t2fit && !b conditions).
    // prevGrounded: was player on ground at END of previous integratePlayerSim call.
    // prevCrouching: was player crouching+grounded (Q2r3ysn) at end of previous call.
    // slideCooldownTicks: ticks remaining before next entry boost is allowed (bundle: 50/Qq5sl76).
    prevGrounded: onGround,
    prevCrouching: false,
    slideCooldownTicks: 0,
    // Qctsdxd: teleport ability charge (starts at 1, max 1, recharges over time)
    // ed.Q94ze8t: player can teleport when Qctsdxd >= 1
    // ed.Qai8iwi: costs 1 charge per use
    abilityCharge: 1,
    abilityRechargeTicks: 0,
    // Bundle Qkm4yk4: server/game tick when the last slide-entry boost fired.
    // The client-side boost gate checks `Qkm4yk4 + 50/tickRate <= currentTick`.
    // Emit this as opcode 151 so local prediction sees an official-style slide cooldown timestamp.
    slideBoostTick: 0,
    // Ticks since this player last attacked (opcode 146). 0 on the attack tick; large = idle.
    // Drives peer attack animations — see integratePlayerSim.
    actionTickCounter: 9999,
    // Per-round scoreboard stats (opcodes 214/215/216). Reset by startNewRound.
    kills: 0,
    assists: 0,
    jumpTick: 9999,                          // Qezbnmf — 0 on the tick a jump starts
    wallNormal: { x: 0, y: 0, z: 0 },        // Q1gkus6 — wall normal on a wall-jump tick
    killStreak: 0,     // Q1nrrt6 — kills without dying
    multiKill: 0,      // Q5l0v64 — consecutive kills inside MULTIKILL_WINDOW
    // Regen bookkeeping. ticksSinceDamage starts high so a fresh spawn is already regen-eligible.
    ticksSinceDamage: 99999,
    ticksSinceKill: 99999,
    forceRegen: false,
    deaths: 0,
    score: 0,
    // Emote state (opcodes 185/186), toggled by the /dance and /examine chat commands.
    // Server-authoritative: the client only ever clears these.
    isDancing: false,
    isExamining: false,
    inputFramesApplied: 0,
    // ── Weapon switching ──────────────────────────────────────────────────────
    // equippedWeaponId = the weapon currently held (opcode 127). weaponList = the
    // nids the player carries (set at accept = [primary, sword]). backupWeaponId =
    // the previous weapon (opcode 128). weaponSendCount counts down ticks during
    // which appendPlayerTickBody re-emits 127/128 after a switch.
    // Sword-only mode carries a single weapon, so weaponList has one entry — processWeaponSwitch
    // early-returns on `length < 2` and the switch keys become inert (matching the client, which
    // has nothing to cycle to).
    equippedWeaponId: SWORD_ONLY ? SWORD_WEAPON_ID : 4,
    backupWeaponId: -1,
    weaponList: SWORD_ONLY ? [SWORD_WEAPON_ID] : [4, 262],
    weaponSendCount: 0,
    // Picked-up special weapons (Sniper/Shotgun/Rocket/SMG/Grenade Launcher) — see
    // processWeaponPickups/_grantPickupWeapon/_clearPickupSlot/_clearAllPickupWeapons. Map of
    // nid -> rounds remaining (total, chambered included — no reserve refill), one entry per
    // DISTINCT special weapon currently carried; {} = carrying none. Every key here is ALSO
    // appended to weaponList (so the existing generic cycle/direct-select switching in
    // processWeaponSwitch already works for all of them — no special-cased switch handling needed).
    pickupAmmo: {},
    switchTimer: 0,        // Q3igok2 — ticks left in a weapon swap (opcode 129)
    // ── Ammo / reload (the primary gun's magazine) ──
    // gunAmmo drains per shot; at 0 the gun auto-reloads (reloadTicks counts down, then refills to
    // the clip size). _ammoGunId = the gun gunAmmo belongs to (resets ammo when the primary changes).
    // Reserve is infinite (HUD ∞). Streamed every tick via the weaponSlots (135) block.
    // _ammoGunId = 262 in sword-only mode so appendPlayerTickBody's gun weaponSlots block
    // (gated on `_gunId !== 262`) is skipped and only the sword slot is streamed.
    gunAmmo: weaponClip(SWORD_ONLY ? SWORD_WEAPON_ID : 4),
    reloadTicks: 0,
    _ammoGunId: SWORD_ONLY ? SWORD_WEAPON_ID : 4,
    // Snapshot of which non-sword weapon nids' 135 slots were emitted LAST tick — advanced once per
    // tick (post-broadcast sweep), diffed against the CURRENT weaponList every tick to know which
    // slots to delete (see appendPlayerTickBody's weaponSlots block).
    _prevEmitWeaponIds: null,
    // ── Extracted-physics state ───────────────────────────────────────────────
    // _ps: the bundle physics player state object (phys.createPlayerState).
    //      null if the physics world is not yet loaded (falls back to hand-rolled sim).
    // _prevHeldKeys: Set of keys held at end of previous tick, for press-edge detection.
    // _pendingRawFrames: raw per-sub-frame arrays stored by foldClientInputIntoSim.
    //   _integrateWithExtractedPhysics drains this list and runs tickMovement once
    //   per sub-frame to match the client's ~60fps physics rate (fixes "Player A
    //   looks like walking speed from Player B's perspective" — previously the server
    //   ran only 1 physics step per 50ms tick while the client ran ~3).
    _ps: null,
    _prevHeldKeys: new Set(),
    _pendingRawFrames: [],
  };

  // Held out of the match until they choose to play. Expressed with the client's own spectator/dead
  // state (opcode 91 = 4 plus a large opcode 168), so the overlay, the scoreboard row and the hidden
  // weapon UI all come from the client unchanged.
  if (CLICK_TO_PLAY) state._holdForPlay = true;

  // Attach the extracted physics state if the bishop physics world is already loaded.
  // When bpw.world is non-null, bpw.gameSettings is also ready.
  if (bpw.world) {
    const psId = sessionId || `ps-${++_physStateCounter}`;
    state._ps = phys.createPlayerState(psId, { x: spawnX, y, z: spawnZ }, yaw);
    // Joining is a spawn too: without this the very first life was the only one with no protection,
    // which is the worst case — you land in a live firefight with no idea the rules differ.
    applySpawnCounters(state._ps);
    // Add to global registry BEFORE syncing so this player's capsule is included.
    _physWorldPlayers.set(psId, state._ps);
    // Sync ALL players: Qcw4fab would delete existing capsules if called with
    // only the new player (the original registerPlayer bug for multi-player).
    _syncPhysWorldCapsules(psId);
    console.log(`[evio-local] extracted physics state created for ${psId} at (${spawnX.toFixed(2)},${y.toFixed(2)},${spawnZ.toFixed(2)}) totalPhysPlayers=${_physWorldPlayers.size}`);
  }

  return state;
}

// Action ids are a small fixed vocabulary (0..11 or so). Slice BEFORE mapping so a hostile length
// costs nothing at all — mapping first would do the expensive work and then throw it away.
const MAX_ACTIONS_PER_FRAME = 32;
function _boundedActions(arr) {
  const src = arr.length > MAX_ACTIONS_PER_FRAME ? arr.slice(0, MAX_ACTIONS_PER_FRAME) : arr;
  return src.map(Number).filter(Number.isFinite);
}

function foldInputFrameIntoSim(playerState, frame) {
  if (!Array.isArray(frame) || !Array.isArray(frame[1])) return;
  const [held, pressed, released, lookDelta] = frame[1];

  // The client sends the full currently-held set in every sampled input state.
  // Keep the latest full set as authoritative intent for the next server tick.
  //
  // LENGTH CAPPED. There are about a dozen action ids, so anything longer is not a real input state.
  // Uncapped, a single 60,000-element array cost 11ms of map+filter — inside the tick loop, for one
  // player, on one sub-frame. At the permitted message rate that is more CPU than the server has,
  // and the whole tick loop (everyone's physics) stalls behind it. maxPayload bounds the message but
  // 64 KiB of small msgpack integers is still tens of thousands of elements.
  if (Array.isArray(held)) {
    playerState.heldActions = new Set(_boundedActions(held));
  }

  const pressedActions = Array.isArray(pressed) ? _boundedActions(pressed) : [];
  if (pressedActions.includes(4) && playerState.grounded) {
    playerState.jumpQueued = true;
  }
  // Teleport (key 9, ability type 0): ed.Qvxae88(0) / ed.Q94ze8t path in g().
  // When extracted physics (_ps) is active, g() handles the teleport position
  // change internally (copies Qi9m618 result to Qdsukt4) and decrements Qctsdxd.
  // Doing it here too causes a DOUBLE teleport (2× the expected distance).
  // Only use the hand-rolled fallback when extracted physics is NOT available.
  if (pressedActions.includes(9) && !playerState._ps && playerState.abilityCharge >= 1) {
    const TELEPORT_RANGE = 12;  // Qkrh1tv in bundle
    const sinYaw = Math.sin(playerState.yaw);
    const cosYaw = Math.cos(playerState.yaw);
    playerState.position.x += sinYaw * TELEPORT_RANGE;
    playerState.position.z -= cosYaw * TELEPORT_RANGE;
    playerState.abilityCharge = 0;
    playerState.abilityRechargeTicks = 0;
  }
  if (pressedActions.includes(8)) {
    playerState.crouchQueued = true;
  }

  if (Array.isArray(released)) {
    // Release edges are already reflected by the next `held` set, but keeping
    // this explicit makes the fold robust if a frame omits `held` later.
    for (const action of _boundedActions(released)) playerState.heldActions.delete(action);
  }

  if (Array.isArray(lookDelta)) {
    const dx = Number(lookDelta[0]) || 0;
    const dy = Number(lookDelta[1]) || 0;
    // Second half of the input accounting. `lookKept` (in enqueueClientInput) covers ingest ->
    // queue; this covers queue -> APPLIED. A queued sub-frame that is never folded is just as lost
    // as a discarded one, and only this counter can tell the two apart.
    playerState._lookApplied = (playerState._lookApplied || 0) + Math.abs(dx) + Math.abs(dy);
    playerState.yaw += dx * LOOK_SCALE;
    // Clamp to the client's exact limit Q2a8w9c = π/2 (not ±1.55) so extreme pitch doesn't reconcile.
    playerState.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, playerState.pitch + dy * LOOK_SCALE));
  }

  playerState.inputFramesApplied += 1;
}

function foldClientInputIntoSim(playerState, decoded) {
  const inputFrames = Array.isArray(decoded && decoded[5]) ? decoded[5] : [];
  if (!Array.isArray(playerState._pendingRawFrames)) playerState._pendingRawFrames = [];
  for (const frame of inputFrames) playerState._pendingRawFrames.push(frame);
  for (const frame of inputFrames) foldInputFrameIntoSim(playerState, frame);
}

// ── Buffer tick model ───────────────────────────────────────────────────────
// Enqueue one client input message keyed by its client tick index (decoded[4] =
// Qo9o4y1).  decoded[5] = the sub-frames the client tagged for that tick.
// Total |look| carried by a set of sub-frames. Used purely for accounting: the client's yaw is the
// SUM of these, so magnitude lost here is rotation the server will never apply, and shows up as the
// server turning less far than the client.
function _lookMag(frames) {
  let m = 0;
  if (!Array.isArray(frames)) return m;
  for (const f of frames) {
    const p = f && f[1];
    const d = p && p[3];
    if (Array.isArray(d)) m += Math.abs(Number(d[0]) || 0) + Math.abs(Number(d[1]) || 0);
  }
  return m;
}

// Upper bound on sub-frames merged into one client tick. 240fps gives ~12; this is pure abuse
// protection, not a functional limit.
const MAX_SUBFRAMES_PER_TICK = 64;
// A peer bootstrap delta is ~120 ops, so this is roughly 25 queued peers — far past any real lobby.
const MAX_PENDING_BOOTSTRAP_OPS = 3000;
// Carry sub-frames that arrive after their tick was simulated into the NEXT tick instead of
// dropping them. Look deltas are summed, so a dropped sub-frame is rotation the server never
// applies; carrying it applies the same rotation one tick late, which self-corrects, instead of
// losing it permanently. This is what makes inputBufferDepth = 0 viable.
let CARRY_LATE_INPUT = S.define({
  key: "carryLateInput", env: "EVIO_CARRY_LATE_INPUT", type: "bool", def: true,
  category: "Netcode", label: "Carry late input forward",
  desc: "Apply sub-frames that arrive after their tick was simulated on the following tick instead "
      + "of discarding them. Required if inputBufferDepth is 0.",
}, (v) => { CARRY_LATE_INPUT = v; });

// Does this batch show a player actually DOING something, as opposed to the client idling?
//
// "Any input packet" is not the signal for "clicked to play": the client keeps sending frames while
// its own menu is up — measured, the hold ended about half a second after joining, before the player
// touched anything. What changes at the click is that the pointer LOCKS, and only then can the client
// produce mouse-look deltas or route keys to the game instead of the menu. So intent is a held or
// pressed action, or a look delta big enough not to be noise.
//
// This is a heuristic and worth being honest about: it is inferring a click that the protocol simply
// does not carry (Qxobfsk sends nothing). It errs toward holding — a player who clicks and then does
// not move stays on the arrival screen until they do, which is a far better failure than being forced
// into the match before they asked.
// ── The lobby signal IS on the wire, in the input frame's EVENT MAP ──────────────────────────────
// The packed input is [held, pressed, released, lookDelta, absoluteAxes, eventMap] — six fields, and
// I had only ever read the first four. The sixth is a one-shot map the client fills from its lobby
// flow (bundle :71599):
//
//     c && (a.Qwhpsyt[0] = !0, c = !1)      // c is set by Qapllfd (pointer lock acquired) and by
//                                           // Qjyg4om, the [ JOIN ] button  -> "I am entering the game"
//     x && (a.Qwhpsyt[1] = !0, x = !1)      // x is set by Qapllfd when the SPECTATE path armed it
//                                           //                              -> "I am entering spectate"
//
// So the official server does not infer the click at all: it reads it. Everything before this —
// releasing on any packet, then on "intent" — was working around a field I had not decoded.
const LOBBY_EVENT_PLAY = 0;
const LOBBY_EVENT_SPECTATE = 1;
function frameEventMap(frame) {
  const packed = Array.isArray(frame) && Array.isArray(frame[1]) ? frame[1] : null;
  const map = packed && packed[5];
  return map && typeof map === "object" ? map : null;
}
// Returns "play" | "spectate" | null for a batch of sub-frames.
function lobbyEventInFrames(frames) {
  if (!Array.isArray(frames)) return null;
  for (const f of frames) {
    const map = frameEventMap(f);
    if (!map) continue;
    if (map[LOBBY_EVENT_PLAY]) return "play";
    if (map[LOBBY_EVENT_SPECTATE]) return "spectate";
  }
  return null;
}
// Does this client populate the event map at all? The official client writes slot 4 on EVERY frame
// (bundle :71602, `a.Qwhpsyt[4] = A`), so seeing any map at all proves it will also send slots 0 and 1
// when the player clicks — which means the input heuristic must never run for this client.
//
// That heuristic is not merely redundant once the real signal works, it is harmful: a player who clicks
// SPECTATE enters free camera and immediately moves the mouse, the look delta reads as "intent", and
// they are dragged into the match a moment after choosing not to be. Auto-detecting is better than a
// setting because it cannot be left configured wrongly.
function framesHaveEventMap(frames) {
  if (!Array.isArray(frames)) return false;
  for (const f of frames) if (frameEventMap(f)) return true;
  return false;
}

const INTENT_LOOK_EPSILON = 1e-4;
function framesShowIntent(frames) {
  if (!Array.isArray(frames)) return false;
  for (const f of frames) {
    const packed = Array.isArray(f) && Array.isArray(f[1]) ? f[1] : null;
    if (!packed) continue;
    if (Array.isArray(packed[0]) && packed[0].length) return true;   // holding something
    if (Array.isArray(packed[1]) && packed[1].length) return true;   // pressed this frame
    if (Array.isArray(packed[2]) && packed[2].length) return true;   // released this frame
    const look = packed[3];
    if (Array.isArray(look)) {
      const dx = Math.abs(Number(look[0]) || 0), dy = Math.abs(Number(look[1]) || 0);
      if (dx > INTENT_LOOK_EPSILON || dy > INTENT_LOOK_EPSILON) return true;   // mouse moved
    }
  }
  return false;
}

// The player pressed something in the arrival menu. Verbs come from the userscript bridge.
//   play     — enter the match now (the CLICK TO PLAY overlay)
//   spectate — stay out, but move to the state whose menu offers [ JOIN ]
// Unknown verbs are ignored rather than guessed at, so a newer userscript talking to an older server
// degrades to "nothing happens" instead of something surprising.
// One line per inbound frame from a player still on the arrival screen. Deliberately prints the raw
// action arrays rather than a verdict: the question is what the client sends, and a summary that
// already assumed the answer would be useless.
function logHeldFrame(session, kind, detail) {
  if (!LOG_HELD_INPUT) return;
  const p = session && session.playerState;
  if (!p || !p._holdForPlay) return;
  console.log(`[evio-held] ${session.sessionId} ${kind}: ${detail}`);
}
// Text frames must NEVER be logged verbatim. The join payload carries a live session token and the
// RPC channel carries wallet addresses; the first version of this diagnostic printed both straight
// into the journal, which is exactly what redact() exists to prevent. Only the SHAPE is diagnostic
// anyway — which prefix, and for an RPC which code — so that is all this keeps.
function describeTextFrame(text) {
  const s = String(text || "");
  if (s.startsWith(";")) return `join payload (${s.length} bytes, redacted)`;
  if (s.startsWith("`")) {
    const m = s.match(/^`(\d+)`/);
    return m ? `rpc code=${m[1]} (arg redacted)` : "rpc (unparsed, redacted)";
  }
  if (s.startsWith("!")) return `signal ${s.slice(1, 8)}`;
  if (s.startsWith("@")) return `lobby intent ${JSON.stringify(s.slice(1, 24))}`;
  // Anything else is not a known credential carrier, but cap it hard regardless.
  return `${JSON.stringify(s.slice(0, 40))}${s.length > 40 ? ` (+${s.length - 40} bytes)` : ""}`;
}
function describeInputFrames(frames) {
  if (!Array.isArray(frames) || !frames.length) return "(no frames)";
  const parts = [];
  for (const f of frames.slice(0, 4)) {
    const q = Array.isArray(f) && Array.isArray(f[1]) ? f[1] : null;
    if (!q) { parts.push("(malformed)"); continue; }
    const held = Array.isArray(q[0]) ? q[0] : [];
    const pressed = Array.isArray(q[1]) ? q[1] : [];
    const released = Array.isArray(q[2]) ? q[2] : [];
    const look = Array.isArray(q[3]) ? q[3] : [0, 0];
    const evMap = q[5] && typeof q[5] === 'object' ? q[5] : null;
    const ev = evMap ? Object.keys(evMap).map((k) => `${k}=${JSON.stringify(evMap[k])}`).join(',') : '';
    parts.push(`held=[${held}] pressed=[${pressed}] released=[${released}] `
      + `look=(${Number(look[0]) || 0},${Number(look[1]) || 0})`
      + (ev ? ` events{${ev}}` : ''));
  }
  if (frames.length > 4) parts.push(`+${frames.length - 4} more`);
  return parts.join(" | ");
}

function handleLobbyIntent(session, verb) {
  const p = session && session.playerState;
  if (!p) return;
  if (verb === "play" || verb === "join") {
    if (!p._holdForPlay) return;                 // already playing — a duplicate click
    p._holdForPlay = false;
    p._spectating = false;
    // Respawn NOW rather than via deathStateTimer: the effects are wanted, the 3-second dead state
    // (and the death camera it puts on screen) is not. 91 goes straight 0 -> 1.
    p.deathStateTimer = 0;
    respawnPlayerNow(p);
    // The weapon was WITHHELD while held (no 135 slots, 127/128 as -1), and both are delta-emitted —
    // absent means unchanged. Without forcing a re-send the player would enter the match empty-handed,
    // because the last thing the client heard was "no weapon". Clearing _prevEmitWeaponIds also stops
    // the slot-delete path firing for a slot the client never received.
    p.weaponSendCount = WEAPON_SEND_REPEAT_TICKS;
    p._prevEmitWeaponIds = null;
    console.log(`[evio-local] ${session.sessionId} chose PLAY — entering the match`);
    return;
  }
  if (verb === "spectate" || verb === "spec") {
    p._holdForPlay = true;
    p._spectating = true;    // state 2: the menu then offers [ JOIN ] instead of [ SPECTATE ]
    console.log(`[evio-local] ${session.sessionId} chose SPECTATE`);
    return;
  }
  console.log(`[evio-local] ${session.sessionId} sent an unknown lobby intent: ${JSON.stringify(verb)}`);
}

function enqueueClientInput(session, decoded) {
  const clientTick = Number(decoded && decoded[4]);
  const frames = Array.isArray(decoded && decoded[5]) ? decoded[5] : [];
  if (!Number.isFinite(clientTick)) return;
  // The idle-simulation clock, stamped before any of the early returns below. Time since input
  // ARRIVED is the only signal that cannot be confused with a queue legitimately sitting at
  // inputBufferDepth (see processBufferedTick). Sub-frames that merge into an existing batch return
  // early without ever reaching q.push, and they are input just the same — a client sending only
  // those is awake and must not be declared idle.
  session._lastInputMs = Date.now();
  session._idleTicks = 0;
  session._idleSimStartTick = 0;
  logHeldFrame(session, "input", "clientTick=" + clientTick + " " + describeInputFrames(frames));

  // Release a click-to-play hold. The click itself is not on the wire (Qxobfsk only tears down the
  // menu and locks the pointer), so input starting IS the signal — provided the client is silent while
  // the overlay is up, which is what probe_click_to_play.js exists to establish.
  // The client's OWN lobby signal, straight out of the input event map. This is what the official
  // server reads, so it is checked first and unconditionally.
  const lobbyEvent = lobbyEventInFrames(frames);
  if (lobbyEvent) handleLobbyIntent(session, lobbyEvent);
  // Once a client has shown it fills the event map, it will also send the real click signal, so the
  // heuristic is switched off for it permanently. Leaving it on dragged a player who chose SPECTATE
  // into the match the moment they moved the free camera — the look delta read as "intent".
  if (!session._clientSendsLobbyEvents && framesHaveEventMap(frames)) {
    session._clientSendsLobbyEvents = true;
  }

  const held = session.playerState;
  if (held && held._holdForPlay && LOBBY_INTENT_FALLBACK && !session._clientSendsLobbyEvents
      && framesShowIntent(frames)) {
    held._holdForPlay = false;
    // Immediate, for the same reason as the explicit intent path: the dead state would show the death
    // camera for 3 seconds between the arrival view and first person.
    held.deathStateTimer = 0;
    respawnPlayerNow(held);
    held.weaponSendCount = WEAPON_SEND_REPEAT_TICKS;
    held._prevEmitWeaponIds = null;
    console.log(`[evio-local] ${session.sessionId} clicked to play — entering the match`);
  }
  // ── Input accounting ────────────────────────────────────────────────────────────────────────
  // The client's yaw is the SUM of every sub-frame's look delta, so any sub-frame discarded here is
  // rotation the server will never apply. Measured client-side, the server was turning ~0.70x as
  // far as the client with single-tick losses up to 24 deg — an intermittent DROP, not a scale
  // error. These counters say exactly which discard path is responsible.
  session._lookRecv = (session._lookRecv || 0) + _lookMag(frames);
  const lose = (why) => {
    const m = _lookMag(frames);
    session._lookLost = (session._lookLost || 0) + m;
    session._lostBy = session._lostBy || {};
    session._lostBy[why] = (session._lostBy[why] || 0) + m;
    session._lostCount = (session._lostCount || 0) + 1;
  };
  if (clientTick <= session.lastProcessedClientTick) {
    // LATE — this tick has already been simulated. Discarding the sub-frames loses their look
    // deltas outright (they are SUMMED, so a dropped frame is rotation the server never applies).
    //
    // Carry them into the next tick instead. The input is then applied one tick late rather than
    // never: yaw still ends up exactly where the client put it, just 50ms behind, and the error
    // self-corrects on the following tick instead of accumulating for ever.
    //
    // This is what makes inputBufferDepth = 0 viable. The buffer exists because a client sends
    // SEVERAL packets per 50ms tick and simulating on the first one strands the rest; with
    // carry-forward, being early costs a tick of delay on some input instead of losing it. Pair it
    // with echoLagTicks = -1 (client-authoritative, what official ev.io does) so the one-tick
    // offset never shows up as a correction.
    if (CARRY_LATE_INPUT) {
      const carry = session._carryFrames || (session._carryFrames = []);
      carry.push(...frames);
      if (carry.length > MAX_SUBFRAMES_PER_TICK) carry.splice(0, carry.length - MAX_SUBFRAMES_PER_TICK);
      session._lookCarried = (session._lookCarried || 0) + _lookMag(frames);
    } else {
      lose("late-already-simulated");
    }
    return;
  }
  const q = session.inputQueue;
  if (q.length && clientTick < q[q.length - 1].clientTick) {
    lose("out-of-order");
    return;
  }
  if (q.length && clientTick <= q[q.length - 1].clientTick) {
    if (clientTick === q[q.length - 1].clientTick) {
      // MERGE, never replace. A client rendering above 20fps sends SEVERAL packets per 50ms tick,
      // each carrying the sub-frames produced since the last send and all stamped with the same
      // client tick. The client's authoritative state for that tick is the merge of ALL of them.
      //
      // Replacing the entry kept only the final packet's sub-frames. Held keys survived that (a key
      // held across sub-frames reappears in the last packet) but LOOK DELTA IS SUMMED, so every
      // discarded sub-frame was lost rotation. Hence the signature symptom: moving without turning
      // felt fine — all the deltas are zero, nothing diverges — while turning diverged the yaw
      // every single tick and the reconciler corrected it every single tick.
      const merged = q[q.length - 1].frames.concat(frames);
      // Bounded so a client that floods one tick index cannot grow this without limit; far above
      // any real frame rate (240fps is ~12 sub-frames per 50ms tick).
      q[q.length - 1] = {
        clientTick,
        frames: merged.length > MAX_SUBFRAMES_PER_TICK
          ? merged.slice(merged.length - MAX_SUBFRAMES_PER_TICK)
          : merged,
      };
    }
    return;                                                    // stale / out of order
  }
  // Cap the sub-frames for a NEW tick as well. MAX_SUBFRAMES_PER_TICK was only applied when merging
  // into an existing batch and when prepending the carry, so the first packet for a tick could queue
  // any number — 5,000 sub-frames were accepted, and every one of them is folded on the drain. The
  // newest are kept because they are the freshest input; the client legitimately sends about three.
  q.push({
    clientTick,
    frames: frames.length > MAX_SUBFRAMES_PER_TICK
      ? frames.slice(frames.length - MAX_SUBFRAMES_PER_TICK)
      : frames,
  });
  session._enqCount = (session._enqCount || 0) + 1;
  // See INPUT_QUEUE_MAX_TICKS: this bound is not just a memory guard, it is what keeps a stale
  // backlog from ever growing past what the client's reconciliation ring could match against even
  // in principle. Trimming the OLDEST entries here means the tick we eventually echo is always the
  // freshest end of whatever arrived — the part of the backlog most likely to still be inside the
  // client's ring by the time it's processed and sent back.
  if (q.length > INPUT_QUEUE_MAX_TICKS) {
    const over = q.length - INPUT_QUEUE_MAX_TICKS;
    session._dropCount = (session._dropCount || 0) + over;
    for (const b of q.slice(0, over)) {
      const m = _lookMag(b.frames);
      session._lookLost = (session._lookLost || 0) + m;
      session._lostBy = session._lostBy || {};
      session._lostBy["queue-overflow"] = (session._lostBy["queue-overflow"] || 0) + m;
    }
    q.splice(0, over);
  } // unbounded-growth guard (DROPS = accumulation) — see INPUT_QUEUE_MAX_TICKS for the ring-size reasoning
}

// Advance the player's authoritative sim by draining the input queue toward
// INPUT_BUFFER_DEPTH — processing each buffered client-tick's frames through the
// same extracted g() the client runs, one client tick per batch.  Records the
// last processed client tick (echoed so the reconciler can match its ring).
// Temporary, targeted diagnostic (see _tickTimings' own comment near runGlobalTickInner): the
// top-level "bufferedTick" bucket in a TICK OVERRUN breakdown was found to dominate overruns even
// with only 2-3 players connected, but that bucket wraps the whole per-session drain loop — it
// cannot say WHICH part of a tick's physics step is slow, or whether the cost is one expensive
// call or many cheap ones stacked up by a catch-up burst (inputBufferMaxCatchup). This sub-timing
// object is reset once per global tick (in runGlobalTickInner) and folded into the same overrun
// log line, so the next real overrun on the live server names the actual hot call.
let _simSubTimings = {};
function _resetSimSubTimings() { _simSubTimings = {}; }
function _addSimSubTiming(name, ms) { _simSubTimings[name] = (_simSubTimings[name] || 0) + ms; }

function processBufferedTick(session, globalTick, sessions) {
  session._drainedThisTick = false;
  const q = session.inputQueue;
  const playerState = session.playerState;
  // Honour the buffer depth STRICTLY. This used to fall through to "advance 1 if anything is
  // buffered", which drained the queue to empty and made inputBufferDepth a no-op — the server
  // always simulated right up to the newest client tick it had.
  //
  // That is what forced ECHO_LAG_TICKS to exist: the client rejects an echo newer than its own
  // newest prediction, so the echo had to be pushed back artificially. But the echo is only a
  // LABEL — the body still carried the state as of the LATEST processed tick. The client then
  // compared its prediction for tick T-lag against a state that was really tick T, and while
  // rotating those differ by exactly `lag` ticks of rotation. Measured: 11.4 deg mean same-tick
  // yaw error at lag 3, which is far past the comparator's 1e-4 tolerance, so it corrected every
  // single tick — the rotation stutter.
  //
  // Holding the tick back instead makes the echo trail HONESTLY: lastProcessedClientTick is
  // genuinely older than the newest received tick, and the state we send really is that tick's
  // state. Echo and body agree, so the comparison is apples to apples.
  // rawBacklog = how far above target depth the queue ACTUALLY got this tick, before applying the
  // inputBufferMaxCatchup drain-rate limit — the true severity of the burst, independent of how much
  // of it we chose to process in this one server tick. `n` below is the (separately capped) amount
  // actually drained; keeping the two distinct matters regardless of what inputBufferMaxCatchup is
  // currently set to — feeding the BURST-SEVERITY signal from the capped `n` instead would silently
  // ceiling burstLevel at that same cap, collapsing "mildly bursty" and "severely bursty" into the
  // same reading and defeating peerSmoothCapFor/syncAdaptiveBurst's whole point (they need to tell
  // those apart), even if that cap happens to be generous most of the time.
  let rawBacklog = q.length - INPUT_BUFFER_DEPTH;
  if (rawBacklog < 1) rawBacklog = 0;
  rawBacklog = Math.min(rawBacklog, q.length);
  const n = Math.min(rawBacklog, INPUT_BUFFER_MAX_CATCHUP);
  if (n > 0) session._procCount = (session._procCount || 0) + n;
  if (n > 0) _addSimSubTiming("catchupTicks", n);
  // Peak-with-decay burst tracker. Feeds the adaptive peer-smoothing cap (see peerSmoothCapFor) and
  // the adaptive sync widening (syncAdaptiveBurst): a connection that never bursts (rawBacklog stays
  // at 0) should never be smoothed/widened at all, a connection that regularly dumps several ticks at
  // once should be smoothed/widened hard. A straight average would hide the very spikes that cause
  // the visible snap, so this holds the peak and lets it decay back down over a couple of seconds of
  // calm — the same peak-hold-with-decay shape a VU meter uses, for the same reason (the spike
  // matters, not the mean).
  if (rawBacklog > 0) {
    session._burstLevel = Math.max(rawBacklog, (session._burstLevel || 1) * BURST_LEVEL_DECAY);
  }
  // Send credit for the rate-match gate: one per CLIENT TICK consumed, not one per server tick that
  // happened to consume something. Those differ whenever a packet lands just after a tick boundary —
  // the next tick then drains TWO client ticks but the old gate still allowed only one send, so a send
  // was lost every time it happened. Measured: 16 packets/s instead of 20, in a 48ms/108ms alternating
  // pattern. Peers are drawn by interpolating between the last two positions received, so a doubled gap
  // is a doubled step to cover — the "choppy, snapping" peer movement.
  if (n > 0) {
    session._sendCredit = Math.min(SEND_CREDIT_MAX, (session._sendCredit || 0) + n);
  }
  // ── Queue empty ─────────────────────────────────────────────────────────────────────────
  // Holding is right for a BRIEF gap: one dropped packet, or a frame the client has not sent yet.
  // The client advances no tick either, so simulating here would drift the authoritative state away
  // from a prediction that has not moved.
  //
  // It is wrong for a client that has stopped for a long time — a backgrounded browser tab, where
  // the timers are throttled to roughly 1 Hz or stop outright. The player then became a statue: they
  // did not fall, grenade knockback wrote a velocity that was never integrated so they could not be
  // pushed, and spawn protection stopped counting down (it only decrements inside integratePlayerSim)
  // so they were invulnerable for as long as the tab stayed hidden. The server's own clock must not be
  // hostage to a client's.
  //
  // So after a grace period we simulate them anyway, with NO input. That keeps gravity, knockback and
  // every timer running while their screen is frozen, and it costs nothing in fidelity because there
  // is no client prediction left to disagree with — see the echo suppression in computeEchoTick.
  if (n === 0) {
    // Entry is gated on how long it has been since input ARRIVED, not on how many ticks drained
    // nothing. Those are different questions: with inputBufferDepth >= 1 the queue deliberately sits
    // at the hold depth, so n === 0 happens routinely during healthy play and counting those ticks
    // would eventually declare an ACTIVE player idle and clear the keys out from under them.
    // Time since the last packet cannot be confused that way.
    if (!IDLE_SIM_GRACE_TICKS) return;
    const quietMs = Date.now() - (session._lastInputMs || 0);
    if (!session._lastInputMs || quietMs < IDLE_SIM_GRACE_TICKS * TICK_MS) return;
    session._idleTicks = (session._idleTicks || 0) + 1;
    if (session._idleTicks === 1) {
      // Release everything on the way in. An idle tick reuses the LAST known held keys by design
      // (see _integrateWithExtractedPhysics), so a player who backgrounded the tab mid-sprint would
      // otherwise keep running in a straight line for as long as they were away.
      if (playerState.heldActions && playerState.heldActions.clear) playerState.heldActions.clear();
      playerState._prevHeldKeys = null;
      session._idleSimStartTick = globalTick;
    }
    {
      try {
        integratePlayerSim(playerState, TICK_MS / 1000, globalTick, []);
        // Keep feeding the lag-comp ring: a shooter rewinding to where they saw this player still
        // needs snapshots, otherwise an idle player becomes unhittable for a different reason.
        recordPositionSnapshot(session, globalTick);
        pushReplaySnapshot(session, playerState);
      } catch (err) {
        session._simErrors = (session._simErrors || 0) + 1;
        _live.simErrors = (_live.simErrors || 0) + 1;
        _live.lastSimError = `${session.sessionId} @${globalTick} (idle): ${(err && err.message) || err}`;
      }
    }
    return;
  }
  // ── Coming back from idle simulation MUST correct the client ────────────────────────────────────
  // While a client is silent past the grace period we simulate it with empty input, so gravity,
  // knockback and timers keep running for a backgrounded tab. That is deliberate — but it is the
  // server moving a player by an amount their client did not and cannot predict, which is precisely
  // what a reconcile burst is for. Under echoLagTicks = -1 nothing else would ever tell them.
  //
  // MEASURED: a ~650ms browser hitch (13 ticks) while falling left the server 8.3u below the client
  // in a single tick, and because nothing corrected it the gap persisted for 275 ticks and reached
  // 80u — on its own it was 273 of the 339 diverging ticks in the session, i.e. the whole of the
  // residual once the echo-label bug was fixed.
  if (session._idleTicks > 0 && playerState) {
    const idled = session._idleTicks;
    requestReconcile(playerState);
    console.warn(`[evio-local] ${session.sessionId} resumed after ${idled} idle tick(s) — `
      + `requesting a reconcile burst so the client adopts the state we simulated without it`);
  }
  session._idleTicks = 0;
  session._idleSimStartTick = 0;

  for (let i = 0; i < n; i++) {
    const batch = q.shift();
    // ── Why this is wrapped, and why the echo advances in `finally` ──────────────────────────
    // The client's reconciler is TICK-INDEXED: it looks up its own prediction by the client tick
    // the server echoes back. The batch is already shift()ed off the queue by this point, so if
    // anything below throws, that client tick is gone forever — and if the echo did not advance
    // with it, the server would keep echoing a tick the client has already retired while the
    // client keeps predicting past it. The lookup then misses on EVERY subsequent tick, which
    // presents as one player (not the server) stuck in a long, slow-to-correct desync.
    //
    // Losing one tick of physics is recoverable — the next authoritative packet corrects it.
    // A permanently stalled echo is not. So the echo advances no matter what.
    try {
      // Prepend anything carried over from a tick we simulated before all of its sub-frames had
      // arrived. They go FIRST so the ordering within the tick still runs oldest-to-newest, and the
      // carry is cleared unconditionally — leaving it queued would replay the same input every tick.
      if (session._carryFrames && session._carryFrames.length) {
        batch.frames = session._carryFrames.concat(batch.frames);
        if (batch.frames.length > MAX_SUBFRAMES_PER_TICK) {
          batch.frames = batch.frames.slice(-MAX_SUBFRAMES_PER_TICK);
        }
        session._carryFrames = [];
      }
      // During the intermission the client's movement step bails on Qpjho15 (see the opcode 168 emit),
      // so the server must bail on exactly the same tick or it would walk the player somewhere the
      // client never went. The batch is still consumed — the tick accounting and the echo have to keep
      // advancing, and look deltas are still folded so aim is live while frozen, matching the client
      // (its bail happens after the aim is applied).
      // NOT extended to held players, though it looks like it should be. The client's movement bail on
      // Qpjho15 (:34491) is nested inside a conditional, so it does not freeze unconditionally — a
      // held player kept predicting locally while the server pinned them, the two drifted apart, and
      // the userscript's desync watchdog snapped the position over and over. A repeated snap IS a
      // teleport effect, which is what "teleport effect spamming when i join" was.
      //
      // Simulating a held player normally costs nothing: they are held out of the match by their STATE
      // (opcode 91 = spectator, no damage), not by being pinned in place, and the spectator camera
      // means their body's position is not what they are looking through anyway.
      if (intermissionFreezeTicks() > 0) {
        for (const frame of batch.frames) foldInputFrameIntoSim(playerState, frame);
        if (playerState.velocity) { playerState.velocity.x = 0; playerState.velocity.y = 0; playerState.velocity.z = 0; }
        if (playerState._ps && playerState._ps.Qyaswvo) {
          playerState._ps.Qyaswvo.x = 0; playerState._ps.Qyaswvo.y = 0; playerState._ps.Qyaswvo.z = 0;
        }
        recordPositionSnapshot(session, globalTick);
        continue;
      }
      // How far behind the client this batch is, in ticks. MUST be set BEFORE integratePlayerSim,
      // because the grenade cast happens inside it and reads this to size its catch-up — an earlier
      // version assigned it afterwards, so every throw used the PREVIOUS tick's value.
      //
      // `lastClientTick - batch.clientTick` measures only the BUFFER component (inputBufferDepth):
      // the newest tick we have RECEIVED, minus the one we are simulating. It cannot see the packet
      // still in flight, which is the other component — hence GRENADE_CATCHUP_EXTRA. Measured on the
      // live server, the true offset was 2 ticks at inputBufferDepth=1 on a 36ms ping.
      // Bots have no real backlog to derive this from (driveBots feeds one batch per tick, in
      // lockstep — see the comment above driveBotFrame), so the formula below always lands near 0
      // for them. This field only sizes GRENADE catch-up (see its call sites), not hitscan lag-comp
      // (that's shooter._viewServerTick/_viewPrevServerTick — see BOT_SIM_LATENCY_MS's own comment
      // and the assignment near driveBotFrame for how bots get a simulated value there instead).
      // Flooring it to the same simulated latency keeps a bot's thrown grenades consistent with the
      // same delay everywhere else it's modeled, rather than grenades alone reacting instantly.
      playerState._inputLagTicks = session.isBot
        ? _botSimLatencyTicks()
        : Math.max(0, Math.min(10,
            ((session.lastClientTick || 0) - batch.clientTick) + GRENADE_CATCHUP_EXTRA));
      {
        const _t0 = Date.now();
        for (const frame of batch.frames) foldInputFrameIntoSim(playerState, frame);
        _addSimSubTiming("foldInput", Date.now() - _t0);
      }
      // BEFORE physics: advance the recoil counter + arm recoil if this tick fires, so the
      // extracted recoil curve kicks pitch inside this same tick — matching the client order. The
      // sub-frames carry the render alpha (frameDeltaTime) the client fired from.
      {
        const _t0 = Date.now();
        preTickFire(playerState, batch.frames);
        _addSimSubTiming("preTickFire", Date.now() - _t0);
      }
      {
        const _t0 = Date.now();
        integratePlayerSim(playerState, TICK_MS / 1000, globalTick, batch.frames);
        _addSimSubTiming("integrateTotal", Date.now() - _t0);
      }
      // Record this tick's reconstructed position into the lag-comp ring (keyed by SERVER tick) so a
      // shot can rewind victims to where the shooter saw them at its currentServerTick (see fireHitscan).
      recordPositionSnapshot(session, globalTick);
      // Queue this REAL sub-tick position for smooth, true-speed replay to peers (see popReplayTarget)
      // — matters most right here, inside a loop that can run several times in one server tick during
      // a catch-up burst, each iteration producing a genuinely different intermediate position.
      pushReplaySnapshot(session, playerState);
      // LIVE PARITY RING — the server's own state, keyed by the CLIENT tick that produced it.
      // Offline replay proved the physics identical given the same state and input (0.45% divergence
      // over 2447 ticks at up to 44 u/s, all teleports). So any live drift has to come from the state
      // or the input differing — which replay cannot see, because it feeds the right input to the
      // right tick by construction. Keying on batch.clientTick lets the client's own per-tick record
      // be diffed against ours tick-for-tick, so the FIRST tick where they part company is visible,
      // along with what input each side applied to it.
      recordParitySample(session, batch, globalTick);
      // AFTER physics: run the hitscan from THIS tick's final position with THIS tick's aim —
      // matching where/when the client pulled the trigger.
      {
        const _t0 = Date.now();
        postTickFire(playerState, sessions);
        _addSimSubTiming("postTickFire", Date.now() - _t0);
      }
    } catch (err) {
      session._simErrors = (session._simErrors || 0) + 1;
      _live.simErrors = (_live.simErrors || 0) + 1;
      _live.lastSimError = `${session.sessionId} @${globalTick}: ${(err && err.message) || err}`;
      // Loud on the first few, then thinned — a repeating fault must not drown the console.
      if (session._simErrors <= 5 || session._simErrors % 100 === 0) {
        console.error(`[evio-local] SIM ERROR #${session._simErrors} player=${session.sessionId} `
          + `serverTick=${globalTick} clientTick=${batch.clientTick} `
          + `pos=(${playerState.position.x.toFixed(1)},${playerState.position.y.toFixed(1)},`
          + `${playerState.position.z.toFixed(1)}):`, (err && err.stack) || err);
      }
    } finally {
      session.lastProcessedClientTick = batch.clientTick;
      session._drainedThisTick = true;
      session._lastDrainTick = globalTick;
    }
  }
}

function sprintRampSpeed(currentHorizontalSpeed, held, hasForwardInput, dtSeconds = 0.25) {
  let multiplier = SPRINT_RAMP_LOW;
  if (currentHorizontalSpeed > SPRINT_RAMP_THRESHOLD_HIGH) multiplier = SPRINT_RAMP_HIGH;
  else if (currentHorizontalSpeed > SPRINT_RAMP_THRESHOLD_MID) multiplier = SPRINT_RAMP_MID;

  // Official code weakens sprint gain when strafing and disables it when
  // moving backward. This keeps local movement closer before full physics RE.
  if (held.has(2) || held.has(3)) multiplier = (multiplier - 1) * (hasForwardInput ? 0.66 : 0.33) + 1;
  if (held.has(1)) multiplier = 1;

  const base = Math.max(WALK_SPEED, currentHorizontalSpeed);
  const rampedMultiplier = Math.pow(multiplier, Math.max(0, dtSeconds) * SPRINT_RAMP_HZ);
  return Math.min(base * rampedMultiplier, RUN_SPEED);
}

/**
 * Run ONE merged physics step per client tick using the extracted bundle physics
 * (phys.tickMovement).  Called by integratePlayerSim when playerState._ps is available.
 *
 * Merged per-tick processing (matches the client's reconciler/predictState Qto0i2z):
 *   The client's AUTHORITATIVE per-tick state (the one the reconciler compares against
 *   the server) is produced by merging all of a tick's sub-frames into ONE input
 *   (UNION held/pressed/released, SUM look) and running g() ONCE with Qq5sl76=1.  We
 *   reproduce that exactly.  This guarantees one tick of movement regardless of how
 *   many sub-frames arrived or their Qdqadrv fractions — per-sub-frame stepping was
 *   fraction-dependent and over/under-integrated (wrong speed; starved slide threshold).
 *
 *   Buffer mode passes one client tick's sub-frames via explicitFrames; hybrid mode
 *   drains _pendingRawFrames.  Either way we union held/pressed and run one step.
 *   Idle tick (no frames): held = latest known, press-edge = diff vs _prevHeldKeys.
 */
function _integrateWithExtractedPhysics(playerState, serverTick, explicitFrames) {
  const ps = playerState._ps;

  // Buffer mode passes the explicit sub-frames for ONE client tick.  Hybrid mode
  // drains all sub-frames accumulated by foldClientInputIntoSim.
  const rawInputFrames = Array.isArray(explicitFrames)
    ? explicitFrames
    : (Array.isArray(playerState._pendingRawFrames) ? playerState._pendingRawFrames.splice(0) : []);

  // Sync all other players' capsule positions once before this tick.
  {
    const _t0 = Date.now();
    _syncPhysWorldCapsules(ps.Q7q6byi);
    _addSimSubTiming("syncCapsules", Date.now() - _t0);
  }

  // Capture the position at the START of this tick (= end of the previous tick) BEFORE tickMovement
  // overwrites ps.Qdsukt4. Sub-frame shot parity fires from lerp(prevTickPos, thisTickPos, alpha).
  playerState._prevTickPos = { x: ps.Qdsukt4.x, y: ps.Qdsukt4.y, z: ps.Qdsukt4.z };

  // Advance the jump counter BEFORE movement, exactly where the client's Qvtrxln runs (it is the
  // first thing Qwhlcfo does, ahead of g()). g() then resets it to 0 on a jump tick, so the client's
  // peer VFX test `0 === Qezbnmf` is true for exactly one tick.
  //
  // We call g() directly rather than Qwhlcfo, so Qvtrxln never ran and nothing ever incremented
  // this. It sat at 0 from the player's first jump onward and the 'jump' puff fired every single
  // tick for the rest of their life.
  if (Number.isFinite(ps.Qezbnmf)) ps.Qezbnmf++;

  // The rest of Qvtrxln's advance, for the counters NOTHING ELSE server-side owns. We deliberately
  // do not call Wh.Qvtrxln wholesale: it moves 15 fields, and nine of them already have a server-side
  // owner (Q3igok2/Qv7w1q0 switch timers, Qcqj5jb zoom, Qezh4wz action counter, Qezbnmf above,
  // Qwwc9lh, Qpgzeeg hit-fade, Qwv47ix flash, Qezc1on ticksSinceKill). Calling it would advance those
  // twice per tick — every timer running at 2x is a worse bug than the one being fixed.
  //
  // Why advancing matters even for the counters we do not put on the wire: the client's own copy in
  // Qa7phk3 is advanced by ITS Qvtrxln every tick, and the reconciler installs that object as the
  // prediction base. A field frozen on our side is a value we would be asserting is correct while it
  // is stale, so the server's copy has to move in step whether or not we emit it.
  //
  // Qd2e7ku and Qezdgca need only the increment here: their RESETS already happen verbatim inside the
  // extracted movement code (physics_extracted.js:3545 — Qd2e7ku=0 on a hard landing, Qezdgca=0 on
  // any position change), which is why they are correct in ps the moment they advance at all.
  if (Number.isFinite(ps.Qalaptp)) ps.Qalaptp--;   // 181 spawn protection, counts DOWN
  if (Number.isFinite(ps.Q5vx943)) ps.Q5vx943--;   // 182 join countdown, counts DOWN
  if (Number.isFinite(ps.Qwx5aeh)) ps.Qwx5aeh++;   // 147 burst-fire window
  if (Number.isFinite(ps.Qezdgca)) ps.Qezdgca++;   // 148 ticks since the player last moved
  if (Number.isFinite(ps.Qd2e7ku)) ps.Qd2e7ku++;   // 190 ticks since a hard landing
  if (Number.isFinite(ps.Qett9p1)) ps.Qett9p1++;   // 196 ticks since spawn

  // Apply accumulated yaw/pitch (already folded into playerState by foldInputFrameIntoSim)
  ps.Qqg4go0 = playerState.yaw;
  ps.Qcrzrpr = playerState.pitch;

  // Equipped weapon + reload timer onto the PHYSICS state. Both were never assigned anywhere, so
  // ps.Qslw9vf sat at its seed value for a player's whole life and ps.Qv7w1q0 stayed -1.
  //
  // g() looks the weapon up as `weaponData.dataById[player.Qslw9vf]` and reads real fields off it
  // (noSprint, speed modifiers, zoom), and the client's own sim reads Qv7w1q0 to block ADS while
  // reloading. Feeding g() the wrong weapon def means every weapon-dependent movement rule was
  // evaluated against whatever weapon the seed happened to name — the client evaluates them against
  // the real one, so anything that differs between the two shows up as a per-tick divergence.
  //
  // Zoom itself is decided in preTickFire (the client's zoom line lives in predictState, which we do
  // not call), so this does not change ADS behaviour — it fixes what g() sees.
  if (Number.isFinite(playerState.equippedWeaponId)) ps.Qslw9vf = playerState.equippedWeaponId;
  ps.Qv7w1q0 = (playerState.reloadTicks || 0) > 0 ? playerState.reloadTicks : -1;

  const gs = {
    Qbu40n9: 1,
    Qwhlcfo: serverTick,
    Qsvkg5s: bpw.gameSettings,
  };

  // MERGED single step per client tick — matches the client's reconciler/predictState
  // (Qto0i2z), the AUTHORITATIVE per-tick state the server must reproduce.  The client
  // merges all sub-frames of a tick into ONE input (bundle merge fn ~18652: UNION
  // held/pressed/released, SUM look) and runs g() ONCE with Qq5sl76=1.  Doing the same
  // yields exactly one tick of movement regardless of sub-frame count/fractions —
  // per-sub-frame stepping was fraction-dependent and over/under-integrated (the
  // "movement slower/faster than client" bug; it also starved the slide-speed threshold
  // so the slide boost never triggered).  lookDelta is already folded into
  // playerState.yaw → ps.Qqg4go0 above, so we union only held/pressed here.
  {
    // Pooled on playerState rather than `new Set()` every tick: this block runs once per player per
    // client tick (more under a catch-up burst — see inputBufferMaxCatchup), and a live GC observer
    // confirmed scavenge (minor GC) pauses of 12-106ms landing at essentially random points in the
    // tick loop, stalling every connected player at once (Node is single-threaded) — the classic
    // signature of high-frequency short-lived allocation, and these three fresh Sets per tick were
    // the most obvious source in this hot path. Safe to reuse: nothing downstream keeps a reference
    // past this synchronous block — heldActions/_prevHeldKeys are assigned FRESH copies (`new
    // Set(curHeld)`), processWeaponSwitch only reads them, and makeRawFrames (physics_extracted.js)
    // copies elements out via forEach rather than retaining the Set itself.
    const curHeld       = playerState._curHeldScratch       || (playerState._curHeldScratch       = new Set());
    const newlyPressed  = playerState._newlyPressedScratch  || (playerState._newlyPressedScratch  = new Set());
    const newlyReleased = playerState._newlyReleasedScratch || (playerState._newlyReleasedScratch = new Set());
    curHeld.clear(); newlyPressed.clear(); newlyReleased.clear();   // packed[2] = justReleased (grenade throw triggers on release)
    let   lastHeldArr   = [];
    if (rawInputFrames.length > 0) {
      for (const frame of rawInputFrames) {
        const packed = Array.isArray(frame[1]) ? frame[1] : [];
        // _boundedActions at every read — see heldThisTick. This is the physics merge, the hottest
        // of the three readers.
        if (Array.isArray(packed[0])) { const a = _boundedActions(packed[0]); for (const k of a) curHeld.add(k); lastHeldArr = a; }
        if (Array.isArray(packed[1])) { for (const k of _boundedActions(packed[1])) newlyPressed.add(k); }
        if (Array.isArray(packed[2])) { for (const k of _boundedActions(packed[2])) newlyReleased.add(k); }
      }
      // _prevHeldKeys stays the LAST sub-frame's set — it exists purely to detect press edges on
      // the next idle tick, and an edge is about the final state.
      playerState._prevHeldKeys = new Set(lastHeldArr.map(Number).filter(Number.isFinite));
      // heldActions must be the UNION, not the last sub-frame. The client merges a tick's
      // sub-frames by UNIONing held (bundle ~18652) and this set is what preTickFire reads next
      // tick to gate firing, zoom and reload.
      //
      // Taking only the last sub-frame silently dropped keys that were held earlier in the tick.
      // While MOVING the client sends several sub-frames per tick, so if the final one did not
      // carry action 5 the shot was lost — and with it `_firingThisTick`, the `Qezh4wz = 0` reset,
      // and therefore the recoil arm. That is why recoil appeared when standing still (few
      // sub-frames, fire present in the last one) and vanished while moving.
      playerState.heldActions   = new Set(curHeld);
    } else {
      // Idle tick: held = latest known; press-edge = keys newly down vs last tick.
      const lastHeld = playerState._prevHeldKeys || new Set();
      for (const k of playerState.heldActions) curHeld.add(Number(k));
      for (const k of curHeld) if (!lastHeld.has(k)) newlyPressed.add(k);
      playerState._prevHeldKeys = new Set(curHeld);
    }
    // Recoil pitch: apply the previous tick's kick + arm this tick's (the client's Qwhlcfo:3302-3307
    // sequence), BEFORE movement — mirrors the client order. preTickFire already advanced Qezh4wz and
    // armed the magnitudes on a shot. Without this the server emits pitchOffset=0 and every shot
    // reconciles the recoil pitch (the sprint/slide-while-shooting stutter). EVIO_SERVER_RECOIL=0 off.
    // Recoil in the EXACT client order (predictState arms → Qwhlcfo's Qvtrxln does atc++ → l() →
    // Qswb1wq resets atc=0): (1) arm IFF Qezh4wz===0 left by the PREVIOUS tick's shot, (2) tickRecoilPitch
    // does atc++ then the pitch curve at i>=1, (3) if THIS tick fired, reset atc=0 for next tick's arm.
    // This makes l() run at i=1 (real kick) on sustained fire; the old order ran it at i=0 (Δ=0, no kick).
    if (SERVER_RECOIL) {
      armRecoil(ps, playerState.equippedWeaponId);          // self-gates on Qezh4wz===0
      phys.tickRecoilPitch(ps, gs);
      if (playerState._firingThisTick) ps.Qezh4wz = 0;
    }
    // Recoil debug (EVIO_RECOIL_DEBUG=1): log per-tick while holding fire — does the server FIRE and
    // emit a recoil pitchOffset while MOVING? Confirms/denies "no recoil during sprint/slide/fall".
    if (RECOIL_DEBUG && playerState.heldActions && playerState.heldActions.has(5)) {
      try {
        require("fs").appendFileSync(require("path").join(__dirname, "recoil.log"),
          `t=${serverTick} fired=${playerState._firingThisTick?1:0} atc=${ps.Qezh4wz} pitchOff=${(ps.Qd0yy90||0).toFixed(4)} ammo=${playerState.gunAmmo} reload=${playerState.reloadTicks||0} | sprint=${ps.Q2xg3ev?1:0} crouch=${ps.Q2r3ysn?1:0} grnd=${ps.Q9t2fit?1:0} vy=${ps.Qyaswvo.y.toFixed(2)}\n`);
      } catch (e) {}
    }
    if (SUBFRAME_MOVE && rawInputFrames.length > 0) {
      // Per-sub-frame movement (matches the LIVE client, for echo=-1 peer parity). Strip per-frame
      // lookDelta (index 3) so look stays at the folded end-of-tick yaw set above — isolates the
      // integration/collision sub-stepping from look-fold. Fractions (frame[0]) drive Qq5sl76 per step.
      const sfNoLook = rawInputFrames.map(f => {
        const p = Array.isArray(f[1]) ? f[1] : [];
        return [f[0], [p[0] || [], p[1] || [], p[2] || []]];
      });
      // Pass the REAL weapon DB (see WEAPON_DB) — without it g() cannot find the equipped weapon
      // and forces zooming=false, undoing the ADS state + its 0.65x move-speed cut every tick.
      const _t0 = Date.now();
      phys.tickMovementSubFrames(bpw.gameSettings, ps, sfNoLook, bpw.world, gs, undefined, WEAPON_DB);
      _addSimSubTiming("tickMovement", Date.now() - _t0);
    } else {
      const rawFrames = phys.makeRawFrames([{ held: curHeld, pressed: newlyPressed }]);
      const _t0 = Date.now();
      phys.tickMovement(bpw.gameSettings, ps, rawFrames, bpw.world, gs, undefined, WEAPON_DB);
      _addSimSubTiming("tickMovement", Date.now() - _t0);
    }
    // Map portals. The client runs this immediately AFTER movement and before the out-of-bounds
    // check (bundle :34560); the order matters because g() clears Qgxywsl at its start, so a flag
    // raised before movement would be wiped. justTeleported is reconciler-compared, so a server
    // that skipped this would snap every player who walked through a portal.
    teleport.applyMapTeleporters(ps, bpw.teleporters, serverTick, match.teleporterUseTicks);

    // Weapon switching uses the same merged held/pressed action sets as movement.
    processWeaponSwitch(playerState, curHeld, newlyPressed);
    // Re-sync the weapon onto the physics state: the copy at the top of this tick ran BEFORE the
    // switch, so without this ps.Qslw9vf trails the mirror by a tick and g() would evaluate the next
    // tick's weapon-dependent rules (noSprint, speed, zoom) against the weapon we just put away.
    // Also leaves ps consistent with what opcode 127 emits, which is what test:fields asserts.
    if (Number.isFinite(playerState.equippedWeaponId)) ps.Qslw9vf = playerState.equippedWeaponId;
    // Active-ability (grenade) cast — reset the one-tick flag (g() does this each tick),
    // then cast on a grenade key release. Drains abilityTimer1 (Qctsdxf); see processGrenadeCast.
    playerState.justUsedActiveAbility = false;
    processGrenadeCast(playerState, newlyReleased);
    // Cooldown tuning, AFTER g() has applied its normal recharge and AFTER the cast has spent the
    // charge — so a zero cooldown refills in the same tick the throw drained it.
    applyAbilityCooldownScales(ps);
  }

  // Copy physics results back to the legacy state format.
  // appendPlayerTickBody reads these fields to build the network packet.
  playerState.position.x  = ps.Qdsukt4.x;
  playerState.position.y  = ps.Qdsukt4.y;
  playerState.position.z  = ps.Qdsukt4.z;
  playerState.velocity.x  = ps.Qyaswvo.x;
  playerState.velocity.y  = ps.Qyaswvo.y;
  playerState.velocity.z  = ps.Qyaswvo.z;
  playerState.grounded     = ps.Q9t2fit;
  // Qcrzrpr (pitch, opcode 140) / Qd0yy90 (pitchOffset, opcode 141): the recoil curve (l()) kicks
  // pitch via pitchOffset DURING tickMovement, and both are reconciler-checked fields. Copy them
  // back so the emitted pitch matches the client's recoiled prediction (no per-shot snap), and so
  // the hitscan below aims with the same recoil the client applied. tickMovement also clamps pitch
  // to the client's exact limit (Q2a8w9c), which is more correct than our ±1.55 input clamp.
  playerState.pitch        = ps.Qcrzrpr;
  playerState.pitchOffset  = (typeof ps.Qd0yy90 === 'number') ? ps.Qd0yy90 : 0;
  // opcode 142: raw crouch-key intent (held.has(8)), not Q2r3ysn (crouch+grounded).
  // Matches the client's animation trigger — crouch anim plays while key is down
  // even when airborne.  Use the final sub-frame's curHeld via heldActions.
  // ── Copy ALL reconciler-checked physics fields back to the legacy state ─────
  //
  // The client's Qqx5i3b divergence check (production, 1e-4 tolerance) compares
  // EVERY field below. If our server sends a wrong value for ANY of them, the
  // reconciler drifts and eventually snaps.
  //
  // Q2r3ysn (opcode 142): crouching AND grounded.  g() sets this at line 34651:
  //   n.Q2r3ysn = !!y.Q38tgef.has(8) && n.Q9t2fit
  // We previously sent held.has(8) (raw key) which diverges whenever the player
  // is crouching while AIRBORNE (raw key=true, physics value=false) → drift.
  playerState.crouching    = ps.Q2r3ysn;   // Q2r3ysn = crouch key AND grounded

  // Q2xg3ev (opcode 143): sprinting flag.  g() sets this at line 34662-34664
  // based on key 7, stamina, slide state, weapon noSprint, input direction.
  // We previously sent a raw expression that didn't match those conditions.
  playerState.sprinting    = ps.Q2xg3ev;   // use physics-computed sprint flag

  // Qgxywsl (justTeleported): set true by g() when teleport fires, reset false
  // at the START of each g() call.  Checked by reconciler; must match prediction.
  playerState.justTeleported = ps.Qgxywsl || false;

  // Qac6dfa (opcode 157): air jump count.
  // Peer jump / wall-jump VFX. The client fires these purely off streamed player state
  // (bundle :45729-45730, inside Qtrjyzn — the PEER render path):
  //     0 === n.Qezbnmf         -> 'jump'      puff
  //     n.Q1gkus6.lengthSq() > 0 -> 'walljump'  ring on the wall
  // g() clears Q1gkus6 at the top of every tick and only sets it (to the wall normal) on a wall
  // jump, and Qezbnmf is reset to 0 on the jump tick then incremented each tick — so both are
  // naturally one-tick pulses and need no edge detection here.
  playerState.jumpTick = Number.isFinite(ps.Qezbnmf) ? ps.Qezbnmf : 9999;
  const wn = ps.Q1gkus6;
  playerState.wallNormal = wn ? { x: wn.x, y: wn.y, z: wn.z } : { x: 0, y: 0, z: 0 };
  playerState.airJumps     = ps.Qac6dfa || 0;
  // Qkm4yk4 (opcode 151): slide-entry boost tick timestamp.
  playerState.slideBoostTick = (ps.Qkm4yk4 > -99990) ? ps.Qkm4yk4 : 0;
  // Qctsdxd (opcode 162): teleport ability charge.
  playerState.abilityCharge = (typeof ps.Qctsdxd === 'number') ? ps.Qctsdxd : 1;
  // Qctsdxf (opcode 160): abilityTimer1 = smoke/flash grenade charge. Drained by
  // processGrenadeCast, recharged by the physics _w(). Echoed so the HUD charge shows.
  playerState.grenadeCharge = (typeof ps.Qctsdxf === 'number') ? ps.Qctsdxf : 0;
  // Qctsdxa (opcode 165): abilityTimer6 = impulse grenade charge. Inits 0.5 (1 charge),
  // caps 1.0 (2 charges, cost 0.5 each), recharges at Qr55etv. Echoed for the HUD pool.
  playerState.impulseCharge = (typeof ps.Qctsdxa === 'number') ? ps.Qctsdxa : 0;
  // Section-4 DAMAGE grenade charges — the SAME physics timers, just the ones the damage grenades
  // drain. The extracted _w() inits + recharges all seven (physics :3160/:3502); we only have to
  // read them back and echo them (159/161/163/164) so the HUD charge fills/drains and the client's
  // own cast prediction (Q86l0mc) stays in sync. Without the echo the client never sees the drain
  // → its predicted charge and the server's diverge ("charge/cooldown not working").
  //   timer0 Qctsdxg → 159 (HE) · timer2 Qctsdxe → 161 (Trip Mine) ·
  //   timer4 Qctsdxc → 163 (Sticky) · timer5 Qctsdxb → 164 (Mine)
  playerState.heCharge     = (typeof ps.Qctsdxg === 'number') ? ps.Qctsdxg : 0;  // HE (abilityTimer0)
  playerState.tripCharge   = (typeof ps.Qctsdxe === 'number') ? ps.Qctsdxe : 0;  // Trip Mine (abilityTimer2)
  playerState.stickyCharge = (typeof ps.Qctsdxc === 'number') ? ps.Qctsdxc : 0;  // Sticky (abilityTimer4)
  playerState.mineCharge   = (typeof ps.Qctsdxb === 'number') ? ps.Qctsdxb : 0;  // Mine (abilityTimer5)
  // Qwhpz0q (opcode 158): stamina (normalized 0..1). Drains while sprinting, refills
  // otherwise. MUST be echoed every tick — otherwise each reconcile snaps the client's
  // stamina back to the stale bootstrap value (1) and the bar never visibly drains.
  playerState.stamina = (typeof ps.Qwhpz0q === 'number') ? ps.Qwhpz0q : 1;
  // Q2r3ysn + speed → sliding animation flag (opcode 174 / Qpgzeeg is NOT this)
  const hSpeed = Math.hypot(ps.Qyaswvo.x, ps.Qyaswvo.z);
  playerState.sliding      = ps.Q2r3ysn && hSpeed >= WALK_SPEED * SLIDE_THRESHOLD;
  // prev-frame tracking
  playerState.prevGrounded  = ps.Q9t2fit;
  playerState.prevCrouching = ps.Q2r3ysn;
}

// When EVIO_COORD_LOG=1, emit one line per physics integration so external
// tools (test_coord_sync.js, test_physics_rate.js) can measure server speed.
let COORD_LOG = S.define({
  key: "coordLog", inert: "legacy sim only - _integratePlayerSimInner never runs while the extracted physics is loaded, so this changes nothing", env: "EVIO_COORD_LOG", type: "bool", def: false,
  category: "Debug", label: "Coordinate log",
  desc: "Emit one COORD line per physics integration, for external trace comparison.",
}, (v) => { COORD_LOG = v; });
let RECOIL_DEBUG = S.define({
  key: "recoilDebug", env: "EVIO_RECOIL_DEBUG", type: "bool", def: false,
  category: "Debug", label: "Recoil log",
  desc: "While fire is held, log per-tick whether the server fired and what pitchOffset/ammo it "
      + "produced. Writes to recoil.log.",
}, (v) => { RECOIL_DEBUG = v; });

// ── Non-finite state guard ───────────────────────────────────────────────────────────────
// A single NaN in the local player's position PERMANENTLY bricks the client, because every NaN
// comparison is false: the divergence comparator (Qqx5i3b, `Math.abs(server.x - client.x) > 1e-4`)
// therefore reports a MATCH forever, reconciliation never corrects anything, and the client's own
// physics keep deriving NaN from NaN. Nothing self-heals — the only recovery is a page refresh,
// which is exactly the reported symptom. It also defeats the SW1 watchdog twice: `NaN < threshold`
// is false so the streak never resets, and the snap would then copy the NaN across.
//
// round() is NOT a guard (Number(NaN.toFixed(4)) === NaN) and msgpack encodes NaN happily, so the
// value would travel intact. We therefore do two things: repair the sim here, and sanitise again
// at the emit boundary (see `fin` in appendPlayerTickBody) so a future code path cannot leak one.
function _sanitizePlayerSim(playerState) {
  const p = playerState.position, v = playerState.velocity;
  const posOk = p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
  const velOk = v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

  if (posOk) {
    // Remember the last trustworthy position so a future repair has somewhere sane to land.
    playerState._lastGoodPos = { x: p.x, y: p.y, z: p.z };
  } else {
    const g = playerState._lastGoodPos || activeSpawnPoints()[0] || { x: 0, y: GROUND_Y, z: 0 };
    console.error(`[evio-local] NON-FINITE POSITION for ${playerState.id || "?"} `
      + `(${p && p.x},${p && p.y},${p && p.z}) — repairing to (${g.x},${g.y},${g.z}). `
      + `This would have permanently desynced the client.`);
    p.x = g.x; p.y = g.y; p.z = g.z;
    v.x = 0; v.y = 0; v.z = 0;
    if (playerState._ps) {
      playerState._ps.Qdsukt4.x = g.x; playerState._ps.Qdsukt4.y = g.y; playerState._ps.Qdsukt4.z = g.z;
      playerState._ps.Qyaswvo.x = 0; playerState._ps.Qyaswvo.y = 0; playerState._ps.Qyaswvo.z = 0;
    }
    return;
  }
  if (!velOk) {
    console.error(`[evio-local] NON-FINITE VELOCITY for ${playerState.id || "?"} `
      + `(${v && v.x},${v && v.y},${v && v.z}) — zeroing.`);
    v.x = 0; v.y = 0; v.z = 0;
    if (playerState._ps) {
      playerState._ps.Qyaswvo.x = 0; playerState._ps.Qyaswvo.y = 0; playerState._ps.Qyaswvo.z = 0;
    }
  }
  // Angles feed the comparator too, so a NaN here is just as fatal.
  for (const f of ["yaw", "pitch", "pitchOffset"]) {
    if (!Number.isFinite(playerState[f])) {
      console.error(`[evio-local] NON-FINITE ${f} for ${playerState.id || "?"} — zeroing.`);
      playerState[f] = 0;
    }
  }
}

function integratePlayerSim(playerState, dtSeconds = TICK_MS / 1000, serverTick = 0, explicitFrames) {
  _integratePlayerSimInner(playerState, dtSeconds, serverTick, explicitFrames);
  // Runs on BOTH the extracted-physics and legacy paths, and after every sub-step, so no
  // integration route can leave a poisoned state behind.
  _sanitizePlayerSim(playerState);
}

function _integratePlayerSimInner(playerState, dtSeconds = TICK_MS / 1000, serverTick = 0, explicitFrames) {
  // ── actionTickCounter (opcode 146) — drives every PEER attack animation ────
  // The client auto-increments this per tick and resets it to 0 the tick a player attacks
  // (Qswb1wq, :43963). Peers' animation code keys off it directly:
  //   • sword: Qy8twrw (:51537) plays SWORD_SLASH on `0 === actionTickCounter` and only blends
  //     the sword pose while `actionTickCounter < 10 / tickDuration`,
  //   • the sprint-anim gate `sprinting && actionTickCounter > 10` (:51480) SUPPRESSES the whole
  //     sword branch while a peer is sprinting-and-not-recently-attacking,
  //   • guns: muzzle/fire pose at `0 === actionTickCounter` (:48137, :44950).
  // We used to emit a hardcoded 9999 → every peer was permanently "has not attacked in ages",
  // so no peer ever played a slash or fire animation (damage landed with no visible swing).
  // Maintained HERE (once per player per tick) because appendPlayerTickBody runs once per
  // RECIPIENT and must stay read-only. Runs before postTickFire, so _firingThisTick is still set.
  //
  // Qezh4wz is the extracted physics' own copy of this counter and is already stepped in the
  // exact client order by the recoil block; prefer it, and fall back to a local count when
  // SERVER_RECOIL is off or the player has no physics state.
  const _atcPs = playerState._ps;
  if (SERVER_RECOIL && _atcPs && Number.isFinite(_atcPs.Qezh4wz)) {
    playerState.actionTickCounter = _atcPs.Qezh4wz;
  } else if (playerState._firingThisTick) {
    playerState.actionTickCounter = 0;
  } else {
    // Clamp so an idle player doesn't grow the counter without bound; anything past the
    // ~10-tick animation window is equivalent to "not recently attacked".
    playerState.actionTickCounter = Math.min(9999, (playerState.actionTickCounter ?? 9999) + 1);
  }

  // ── Fast path: extracted bundle physics ───────────────────────────────────
  // When the bishop physics world is loaded and the player has an extracted state,
  // use the real client physics (capsule sweeps, wall collision, exact jump/gravity).
  // explicitFrames (buffer mode) = the sub-frames for ONE client tick.
  if (playerState._ps && bpw.world) {
    playerState._physicsPath = "extracted";
    _integrateWithExtractedPhysics(playerState, serverTick, explicitFrames);
    if (COORD_LOG) {
      const p = playerState.position;
      process.stdout.write(`COORD ${playerState.id || '?'} tick=${serverTick} x=${p.x.toFixed(4)} y=${p.y.toFixed(4)} z=${p.z.toFixed(4)}\n`);
    }
    return;
  }

  // ── Legacy hand-rolled physics (fallback when physics world not yet loaded) ─
  // WARNING: this path applies a heightmap GROUND SNAP (`position.y = terrainY` below) that the
  // client has no equivalent of — the client only ever does capsule sweeps against the evmap
  // triangles. A player silently on this path will STICK to slopes while the client does not,
  // which is exactly the reported flat→downslope stutter. It should never run once the physics
  // world has loaded, so make it loud rather than silent.
  if (playerState._physicsPath !== "legacy") {
    playerState._physicsPath = "legacy";
    console.warn(`[evio-local] player ${playerState.id || "?"} is on the LEGACY hand-rolled sim `
      + `(_ps=${!!playerState._ps} world=${!!bpw.world}). It ground-snaps to the heightmap, which the `
      + `client never does — expect slope divergence until this is resolved.`);
  }
  const held = playerState.heldActions;
  const crouching = held.has(8);
  // Bundle: sprint (Q2xg3ev) is explicitly blocked when Q2r3ysn=true (crouching+grounded).
  // Mirror that: wantsRun is false whenever crouching, regardless of Shift being held.
  const wantsRun = held.has(7) && !crouching;

  let forward = 0;
  let strafe = 0;
  if (held.has(0)) forward += 1;
  if (held.has(1)) forward -= 1;
  if (held.has(3)) strafe += 1;
  if (held.has(2)) strafe -= 1;

  const magnitude = Math.hypot(forward, strafe);
  if (magnitude > 0) {
    forward /= magnitude;
    strafe /= magnitude;
  }

  const sin = Math.sin(playerState.yaw);
  const cos = Math.cos(playerState.yaw);
  const inputDirX = sin * forward + cos * strafe;
  const inputDirZ = -cos * forward + sin * strafe;

  const currentHorizontalSpeed = Math.hypot(playerState.velocity.x, playerState.velocity.z);

  // ── Bundle slide condition (Q6jiuj, checked every physics frame) ─────────
  // Q6jiuj: Q2r3ysn && horizontalSpeed >= Q6o3kdb * Qyzir06
  //         crouching+grounded && speed >= walkSpeed * 1.1
  // There is no press-triggered entry, no time limit, and no boost multiplier.
  // Slide persists while the velocity condition holds; it ends when speed bleeds
  // below the threshold or the player stops crouching or leaves the ground.
  const isSliding = crouching && playerState.grounded &&
    currentHorizontalSpeed >= WALK_SPEED * SLIDE_THRESHOLD;
  // Log the FIRST tick where sliding becomes true (entry transition)
  if (SLIDE_DEBUG && isSliding && !playerState.sliding) {
    console.log(`[evio-slide] ENTRY: speed=${currentHorizontalSpeed.toFixed(2)} thresh=${(WALK_SPEED * SLIDE_THRESHOLD).toFixed(2)} prevGrounded=${playerState.prevGrounded} prevCrouching=${playerState.prevCrouching} cooldown=${playerState.slideCooldownTicks} → boostEligible=${playerState.prevGrounded && !playerState.prevCrouching && playerState.slideCooldownTicks <= 0}`);
  }
  playerState.sliding = isSliding;
  playerState.crouching = crouching;

  let vx = 0;
  let vz = 0;

  if (playerState.grounded) {
    if (isSliding) {
      // ── Slide physics (bundle lines 34676–34680) ────────────────────────
      const P = currentHorizontalSpeed; // original speed before steer/boost (bundle's P)
      // Steering: Qxabwrz * Q26sgxw * 2 * dt (0.14 * 0.2 * 2 in bundle units).
      // Very limited — player can nudge direction but not fully redirect.
      const slideSteerDelta = SLIDE_STEER_ACCEL * dtSeconds;
      // Add steering impulse toward input direction (if any movement held)
      let steerX = inputDirX * slideSteerDelta;
      let steerZ = inputDirZ * slideSteerDelta;
      // Clamp steer so it can't exceed the steer budget regardless of direction
      const steerMag = Math.hypot(steerX, steerZ);
      if (steerMag > slideSteerDelta) {
        steerX = (steerX / steerMag) * slideSteerDelta;
        steerZ = (steerZ / steerMag) * slideSteerDelta;
      }

      vx = playerState.velocity.x + steerX;
      vz = playerState.velocity.z + steerZ;

      // ── Slide entry boost (bundle line 34679: O+=0.5 → velocity×=1.5) ──
      // Fires when player first crouches while grounded AND was grounded last frame
      // AND prevCrouching (Q2r3ysn from previous frame) was false.
      // The bundle's post-boost clamp allows P + ~4.88 server-unit headroom (O=0.488
      // after decay), so for typical sprint speeds (≤ 14) the full ×1.5 is preserved.
      // prevCrouching is false ONLY when the player was NOT crouching+grounded last tick,
      // i.e. they were airborne OR standing/sprinting (not crouching).
      const isFirstSlideFrame = playerState.prevGrounded && !playerState.prevCrouching
        && playerState.slideCooldownTicks <= 0;
      if (isFirstSlideFrame) {
        const preBoostSpeed = Math.hypot(vx, vz);
        vx *= SLIDE_ENTRY_BOOST;
        vz *= SLIDE_ENTRY_BOOST;
        playerState.slideCooldownTicks = SLIDE_ENTRY_COOLDOWN_TICKS;
        playerState.slideBoostTick = Number.isFinite(serverTick) && serverTick > 0 ? serverTick : playerState.slideBoostTick;
        if (SLIDE_DEBUG) console.log(`[evio-slide] BOOST fired: speed ${preBoostSpeed.toFixed(2)} → ${Math.hypot(vx,vz).toFixed(2)} u/s (×${SLIDE_ENTRY_BOOST}) cooldown=${SLIDE_ENTRY_COOLDOWN_TICKS} qkm4yk4=${playerState.slideBoostTick}`);
      } else {
        // ── Slide decay (bundle: O = -0.012*Qq5sl76 per tick) ────────────
        // clampLength to max(CROUCH_SPEED, P - decay).
        const decay = SLIDE_DECAY_RATE * dtSeconds;
        const newMaxSpeed = Math.max(CROUCH_SPEED, P - decay);
        const newMag = Math.hypot(vx, vz);
        if (newMag > newMaxSpeed && newMag > 0) {
          const scale = newMaxSpeed / newMag;
          vx *= scale;
          vz *= scale;
        }
      }
    } else {
      // ── Normal grounded movement ─────────────────────────────────────────
      let speed = WALK_SPEED;
      if (crouching) {
        // Bundle Q4jg62a=0.5: crouching max speed = walkSpeed * 0.5
        speed = CROUCH_SPEED;
      } else if (wantsRun) {
        speed = sprintRampSpeed(currentHorizontalSpeed, held, forward > 0, dtSeconds);
      }
      vx = inputDirX * speed;
      vz = inputDirZ * speed;
    }
  } else {
    // ── Air movement ────────────────────────────────────────────────────────
    // Bundle: in air j=Q8supmw(0.2), air control scales with fall depth (C factor).
    // Keep existing velocity, allow minimal steering toward input direction.
    vx = playerState.velocity.x;
    vz = playerState.velocity.z;
    if (magnitude > 0) {
      const airAccel = (WALK_SPEED * 0.2) * dtSeconds; // Q8supmw ≈ 0.2 × walkSpeed
      vx += inputDirX * airAccel;
      vz += inputDirZ * airAccel;
      // Soft clamp — don't hard-cut speed, just prevent unlimited air acceleration
      const airSpeedCap = Math.max(WALK_SPEED, currentHorizontalSpeed);
      const airMag = Math.hypot(vx, vz);
      if (airMag > airSpeedCap) {
        vx = (vx / airMag) * airSpeedCap;
        vz = (vz / airMag) * airSpeedCap;
      }
    }
  }

  playerState.velocity.x = vx;
  playerState.velocity.z = vz;
  playerState.crouchQueued = false;

  // ── Jump (bundle: g() jump section) ───────────────────────────────────────
  // Bundle: Qac6dfa (airJumps) starts at 0; after first jump it becomes 1.
  // Second jump (double jump) fires when airJumps < Q7v2lyo (maxAirJumps = 2).
  // Q7v2lyo = 2 means: 0 ground → +1 (ground jump, airJumps=1), 1 air → +1 (double jump, airJumps=2).
  const MAX_AIR_JUMPS = 2;  // Q7v2lyo in bundle
  if (playerState.jumpQueued && playerState.airJumps < MAX_AIR_JUMPS) {
    playerState.velocity.y = JUMP_SPEED;
    playerState.grounded = false;
    playerState.airJumps++;
  }
  playerState.jumpQueued = false;

  // ── Gravity (bundle: velocity.y -= Qn0kxxb * Qq5sl76 per frame) ──────────
  if (!playerState.grounded || playerState.velocity.y > 0) {
    playerState.velocity.y -= GRAVITY * dtSeconds;
  }

  // ── Integration ───────────────────────────────────────────────────────────
  playerState.position.x += playerState.velocity.x * dtSeconds;
  playerState.position.y += playerState.velocity.y * dtSeconds;
  playerState.position.z += playerState.velocity.z * dtSeconds;

  // ── Ground snap ───────────────────────────────────────────────────────────
  // Flat fallback floor. This is the LEGACY hand-rolled sim, which only runs if no collision world
  // was built at all (and warns loudly when it does — see _physicsPath above). It used to query the
  // Bishop heightmap; with that gone the query always returned FLAT_Y, which is GROUND_Y.
  const terrainY = GROUND_Y;
  if (playerState.position.y <= terrainY + 0.05) {
    playerState.position.y = terrainY;
    playerState.velocity.y = 0;
    playerState.grounded = true;
    playerState.airJumps = 0;
  }

  // ── Ability recharge (bundle: _w() recharges Qctsdxd at Qn97q6u per tick) ──
  // Qn97q6u ≈ 0.004 per tick → full recharge in ~250 ticks ≈ 12.5s
  if (playerState.abilityCharge < 1) {
    playerState.abilityRechargeTicks++;
    const RECHARGE_TICKS = 250;  // ≈ 12.5s at 20Hz
    if (playerState.abilityRechargeTicks >= RECHARGE_TICKS) {
      playerState.abilityCharge = 1;
      playerState.abilityRechargeTicks = 0;
    }
  }

  // ── Prev-frame tracking (slide entry boost conditions next tick) ──────────
  // prevGrounded = i.Q9t2fit (bundle), prevCrouching = b (= Q2r3ysn = crouch+grounded).
  playerState.prevGrounded = playerState.grounded;
  playerState.prevCrouching = playerState.crouching && playerState.grounded;
  if (playerState.slideCooldownTicks > 0) playerState.slideCooldownTicks--;
}

function sendState(ws, state) {
  const encoded = encode(state);
  safeSend(ws, encoded, { binary: true });
  return encoded.byteLength;
}

// The Qvtrxln counters live on the extracted physics state, not the legacy mirror. When no collision
// world was built (the fallback sim) there is no _ps at all, so this keeps the emit sites free of
// repeated existence checks and lets them fall back to the client's own factory defaults.
const _EMPTY_PS = Object.freeze({});
function _psOf(playerState) {
  return (playerState && playerState._ps) || _EMPTY_PS;
}

// ── Per-tick player-block cache ────────────────────────────────────────────────────────────────
// buildTickBody's peer loop used to call appendPlayerTickBody once per (RECIPIENT, peer) pair — for
// N accepted players that is N*(N-1) calls every tick, even though appendPlayerTickBody's output
// depends ONLY on (playerId, playerState), never on who is receiving it. Confirmed by inspection:
// the function has zero recipient parameter and mutates nothing on playerState (no assignment to
// any playerState.* field anywhere in its body) — so the SAME player's block is byte-identical
// across every recipient within one tick, and recomputing it for each one is pure waste. Measured
// as the dominant term in the O(N^2) CPU growth this project's load tests found (~0.048 * N^2 in
// the fitted curve). With bots about to raise N substantially, this is worth fixing correctly.
//
// Cached per PLAYER ID, tagged with the TICK it was built for. Tagging (rather than relying solely
// on "cleared once per broadcast phase") is what makes this safe for BOTH call sites: the normal
// per-global-tick broadcast loop, and the hybrid-mode "input-paced" immediate response, which calls
// buildTickBody with `nextTick = globalTick + 1` from an entirely different code path, mid-cycle,
// before the main loop has advanced globalTick to that value. Without the tag, that path could
// either read a stale block (serving position/velocity from before this tick's integration) or
// pollute the cache for a tick number the broadcast loop has not reached yet. The tag makes a
// lookup for the wrong tick a guaranteed miss, so correctness never depends on WHEN something
// clears the map — only on WHAT tick each entry claims to be for.
//
// The map is a module-level singleton (matching the existing style of activeEntities and friends)
// rather than a broadcast-loop local, precisely because both call sites need to share it. It is
// still bounded: cleared wholesale once per global tick (see the broadcast phase in
// runGlobalTickInner), so a departed player's stale entry survives at most one tick before the next
// clear drops it — no unbounded growth from accumulating every playerId ever seen.
let _tickPlayerBlockCache = new Map();   // cacheKey (playerId, or playerId+"|peer") -> { tick, ok, block, err }

// variant "self" (default) = the true authoritative position, for the player's OWN view (their
// reconciliation, and this player's own body when queried as itself). variant "peer" = the SMOOTHED
// broadcast position (see updateBroadcastPosition) — what every OTHER recipient sees this player at.
// Cached separately (two entries per player per tick when both are requested, still O(N) not O(N²))
// because they can legitimately differ for a session whose connection is bursty: self must reconcile
// against the truth, peers must see bounded-speed motion regardless of how that truth arrived.
// How many ticks 214/215/216/226/228/229 keep re-sending after they change — same packet-loss
// safety margin as weaponSendCount (127/128)'s "emit for a few ticks" reliability window.
const STATS_SEND_RELIABILITY_TICKS = 6;

// Change-detection + reliability-window bookkeeping for the send-on-change stats fields, run on the
// REAL playerState object exactly once per tick regardless of how many variants/recipients read it
// this tick. MUST run here, not inside appendPlayerTickBody: the "peer" variant below calls that
// function with a SHALLOW-SPREAD COPY (`emitState`), and writes made to a spread copy's properties
// never propagate back to the original object — bookkeeping done there would silently re-trigger
// "changed" every single tick for the peer path specifically (the exact case this exists to help),
// making the whole mechanism a no-op for peers while looking like it worked for self.
function _updateStatsSendWindow(playerState, tick) {
  if (playerState._statsCheckTick === tick) return;   // already ran this tick (self AND peer share it)
  playerState._statsCheckTick = tick;
  const changed = playerState._lastSentKills !== playerState.kills
    || playerState._lastSentDeaths !== playerState.deaths
    || playerState._lastSentScore !== playerState.score
    || playerState._lastSentAssists !== playerState.assists
    || playerState._lastSentKillStreak !== playerState.killStreak
    || playerState._lastSentMultiKill !== playerState.multiKill;
  // Decremented once per REAL tick in the post-broadcast sweep (mirrors weaponSendCount exactly) —
  // not here, since this can run once per tick same as that, but keeping the single decrement point
  // in one place avoids the two ever drifting out of sync with each other.
  if (changed) playerState._statsSendCount = STATS_SEND_RELIABILITY_TICKS;
  if ((playerState._statsSendCount || 0) > 0) {
    playerState._lastSentKills = playerState.kills;
    playerState._lastSentDeaths = playerState.deaths;
    playerState._lastSentScore = playerState.score;
    playerState._lastSentAssists = playerState.assists;
    playerState._lastSentKillStreak = playerState.killStreak;
    playerState._lastSentMultiKill = playerState.multiKill;
  }
}

function _cachedPlayerBlock(playerId, playerState, tick, variant = "self") {
  const cacheKey = variant === "peer" ? playerId + "|peer" : playerId;
  let entry = _tickPlayerBlockCache.get(cacheKey);
  if (entry && entry.tick === tick) {
    _live.playerBlockCacheHits = (_live.playerBlockCacheHits || 0) + 1;
    return entry;
  }
  _live.playerBlockCacheMisses = (_live.playerBlockCacheMisses || 0) + 1;
  _updateStatsSendWindow(playerState, tick);
  const scratch = [];
  try {
    // Shallow override: every field except `position` stays the EXACT SAME reference as the
    // authoritative playerState (weapon, health, look, held actions, physics state, all of it) —
    // only what a peer visibly sees this player standing at is substituted. _statsSendCount was
    // just updated above on the REAL object, so it comes along correctly in this snapshot too —
    // appendPlayerTickBody only ever READS it, never writes, so the spread copy is safe for that.
    const emitState = (variant === "peer" && playerState._broadcastPos)
      ? { ...playerState, position: playerState._broadcastPos }
      : playerState;
    appendPlayerTickBody(scratch, playerId, emitState);
    entry = { tick, ok: true, block: scratch, err: null };
  } catch (err) {
    entry = { tick, ok: false, block: null, err };
  }
  _tickPlayerBlockCache.set(cacheKey, entry);
  return entry;
}

function appendPlayerTickBody(body, playerId, playerState = createPlayerSimState()) {
  // Zero unless the player wall-jumped this tick (see the copy-back in the physics step).
  const wallN = playerState.wallNormal || { x: 0, y: 0, z: 0 };
  // Explicit player position refresh from the local authoritative simulation.
  // Kept intentionally tiny: movement, run/crouch/slide, jump, gravity/ground,
  // yaw/pitch. Multiple 244 blocks in the same body represent replicated peers.
  //
  // Opcodes 90 (entity player-ID string) and 91 (entity type flag = 1) are
  // included in EVERY tick block, not just the bootstrap.  The ev.io client
  // entity-update path appears to require opcode 91=1 to recognise a 244 block
  // as a live player entity and apply movement opcodes; without it the remote
  // player's model stays frozen at the bootstrap position.
  // A player still on the arrival screen is reported with NO TRANSFORM — position (0,0,0), velocity
  // zero. That is what the official server does, captured directly: while held it sends the local
  // player position (0,0,0), velocity 0, yaw 0, pitch 0, and an entry carrying only opcodes 129/130.
  //
  // We were sending a real spawn position instead, and the client's camera anchored to it — first
  // person, weapon in hand, exactly where the player would stand. Since the arrival camera is driven
  // entirely client-side (it is in neither the map file nor any opcode we send), matching the official
  // transform is the remaining lever we have.
  const HELD_ORIGIN = { x: 0, y: 0, z: 0 };
  const held = !!playerState._holdForPlay;
  const pos = held ? HELD_ORIGIN : playerState.position;
  const emittedY = held ? 0 : pos.y + EMIT_POSITION_Y_OFFSET;
  const vel = held ? HELD_ORIGIN : playerState.velocity;
  body.push(
    244, playerId,
      90, playerId,
      // 91 alive: 4 while dead (deathStateTimer>0 / HP<=0), else 1. ev.io's alive is an ENUM:
      //   1 alive (first-person) · 2/3 SPECTATOR (free-cam, bundle :53212 Qbk8noi(alive,2,3)) ·
      //   4 = the post-death KILLCAM — in non-survival modes alive=4 takes the else branch (:53226)
      //       → Q8m0587, a THIRD-PERSON camera positioned around the corpse/killer (uses deathStateTimer).
      // alive=0 froze first-person + hid the corpse; alive=2 dropped us into the free-cam spectator;
      // alive=4 is the actual "dying perspective". The corpse model renders for Qbk8noi(alive,1,3,2,4).
      // 91 Qyxhj60 — the player STATE enum, not a bool. 1 = playing (the only state the client
      // reconciles, bundle :67052, and the only one that takes damage, :34450). 4 = dead/out, which is
      // also what the click-to-play overlay keys off together with opcode 168 (:63938). A player being
      // held before they have chosen to play uses the same 4: to the client there is no difference
      // between "dead, waiting to respawn" and "here, not playing yet" — both are "not in the match",
      // which is exactly what the spectator row on the scoreboard shows.
      // 91 Qyxhj60 — the player STATE enum. Confirmed values, from the client:
      //   1  playing      — the only state that reconciles (:67052) and takes damage (:34450)
      //   2  spectating   — spectator camera; the menu offers [ JOIN ]
      //   3  spectating   — spectator camera; the menu offers [ SPECTATE ] and CLICK TO PLAY
      //   4  dead / out   — spectatable by others, drives the respawn overlay with opcode 168
      // States 2 and 3 both select the spectator camera rather than the first-person one:
      //   Qbk8noi(Qyxhj60, 2, 3) ? Qz5rgyt.Q4rbazs(...) : Qh71cmr.Q4rbazs(...)      (:53212)
      // Whether that camera FOLLOWS a player or flies free is then a client-side choice inside that
      // mode — Qz5rgyt.Qqre7nm holds the target, null meaning free camera — so the server picks the
      // MODE and the player picks the view.
      //
      // A player waiting to join uses 3, not 4: 3 is the one that shows CLICK TO PLAY together with the
      // [ SPECTATE ] button (:61820), which is the arrival screen. 4 would read as "you died".
      91, playerState._holdForPlay ? (playerState._spectating ? 2 : PLAYER_STATE_HELD)
        : (playerState.deathStateTimer > 0 || playerState.healthPoints <= 0) ? 4 : 1,
      // 95 Qz8l93a.Qtgt1xt — MAX health, the divisor for the peer health bar (bundle :52501 does
      // `m /= c.Qz8l93a.Qtgt1xt`). The first-spawn body sends it, but the 244 tick loop recreates a
      // missing peer as a BARE object (`w in playerList || (playerList[w] = {})`) with no Qz8l93a
      // at all — so the bar divided by undefined, rendered NaN-wide, and appeared irregularly and
      // far too long. Streaming it every tick makes the bar immune to a rebuilt peer object.
      95, Number.isFinite(playerState.maxHealth) ? playerState.maxHealth : 1,
  );
  // Weapon: emit 127 (equippedWeaponId) + 128 (backup) for a few ticks AFTER a switch or
  // loadout change (weaponSendCount), NOT every tick. equippedWeaponId is a reconciler-
  // compared field, so re-sending it every tick makes the comparator re-check it each tick
  // and (if it ever differs from the client's prediction) churns the reconciler → inflated
  // ping. The actual teleport-revert cause was the action-9/weapon-9 id collision (fixed in
  // processWeaponSwitch), not the send cadence. MUST be before 136 (positional decoder).
  if (playerState.weaponSendCount > 0 && Number.isFinite(playerState.equippedWeaponId)) {
    body.push(
      // -1 while held: no equipped weapon, so the client has no model to build.
      127, held ? -1 : playerState.equippedWeaponId,
      128, held ? -1 : (Number.isFinite(playerState.backupWeaponId) ? playerState.backupWeaponId : -1),
    );
    // Not decremented here: this runs once per RECIPIENT, so draining it mid-broadcast burns the
    // budget N times faster with N players and can leave the last recipients without the final
    // emission entirely. Decremented once per tick in the post-broadcast sweep instead.
  }
  // 129 respawnTimer1 — counts down while dead (drives the falling death animation :48111 + the respawn
  // countdown UI); -1 while alive. Paired with alive=2 so the dying perspective animates + times out.
  // 129 Q3igok2 — the WEAPON-SWITCH timer (not a respawn timer, despite the name this used to
  // carry). The client gates firing and reloading on it, plays the peer 'switch_weapon' animation
  // from it, and dips the first-person weapon through it. We only ever sent -1 while alive, so a
  // loadout change swapped the weapon silently and peers kept the old model until a manual switch.
  // While DEAD the countdown is kept: it is what the client's death-cam dip reads, and a dead
  // player cannot fire anyway, so the firing gate is moot there.
  const _dead = playerState.deathStateTimer > 0 || playerState.healthPoints <= 0;
  body.push(129, _dead
    ? Math.max(0, RESPAWN_TICKS - playerState.deathStateTimer)
    : (playerState.switchTimer > 0 ? playerState.switchTimer : -1));
  // 130 reloadTimer — the authoritative reload countdown (>0 while reloading, -1 otherwise). Streaming
  // it stops the client from running its OWN reload + reconciling our empty mag back to 0 every tick
  // (the "reloading loop"); the client's reload-start gate is `reloadTimer<1` (:43981). Before 135/136.
  body.push(130, (playerState.reloadTicks > 0 ? playerState.reloadTicks : -1));
  // weaponSlots (135 blocks) — streamed EVERY tick, one PER CARRIED WEAPON (not just the equipped
  // one), so the HUD's weapon-select row shows every gun/pickup the player actually has, not only
  // whichever is currently in hand. This used to emit only the single equipped nid and explicitly
  // DELETE the previous one on every switch (135,-1,oldId) — correct back when a player could only
  // ever hold [primary, sword] and "switch" meant "replace the primary entirely" (a loadout change),
  // but WRONG once a player can carry several pickup weapons at once: switching among gear you still
  // fully possess isn't a removal, and deleting its slot made every OTHER carried weapon's icon
  // disappear the moment you equipped something else — "the weapon slots don't show up at once" is
  // exactly that bug. Now a slot is only deleted when the weapon actually LEAVES weaponList (ammo
  // depleted, primary changed via loadout, death) — see the removed-slot loop below, and the
  // post-broadcast sweep for how _prevEmitWeaponIds advances.
  //
  // MUST precede 136. A held player is given NO WEAPON at all, matching the official entry — see
  // the ORIGINAL note this file has always carried on that: the first-person viewmodel these slots
  // build is VISIBLE BY DEFAULT and its hide-path never runs once state 0 short-circuits the update
  // chain, so the only way to show nothing is to send nothing.
  const _gunId = held ? null : playerState._ammoGunId;
  if (!held) {
    const weaponIds = (Array.isArray(playerState.weaponList) ? playerState.weaponList : [])
      .filter((w) => w !== SWORD_WEAPON_ID);
    // Removed slots: anything still inside its re-announce window (see the post-broadcast sweep,
    // which is what actually POPULATES/ages playerState._weaponSlotRemovalRepeat — deliberately NOT
    // done here). A removal used to be sent on exactly ONE tick — the SAME mistake activeEntities'
    // removal stream already made once and had to fix (ENTITY_REMOVAL_REPEAT): a client that misses
    // that one packet (backpressure skip, a dropped frame, anything) keeps rendering the icon
    // FOREVER, because nothing ever tells it again. Confirmed live: "special weapon slot doesn't
    // clear after dying and respawning" with server-side state (pickupAmmo/weaponList) provably
    // correct at the moment of respawn — the state was right, the ONE packet announcing it just
    // didn't reliably land.
    //
    // Detecting the removal HERE (comparing against weaponList) has the identical reliability gap
    // one level up: this function runs once PER RECIPIENT, and backpressure skips it ENTIRELY for a
    // congested client BEFORE it's ever called (see the skip a few dozen lines above this one in the
    // broadcast loop) — so the one tick where the removal needs to be first detected can be exactly
    // the tick nothing runs for that recipient, and the repeat window would never even open. The
    // sweep runs unconditionally, once per tick, for every session regardless of any per-recipient
    // skip, which is the only place this can be populated reliably.
    if (playerState._weaponSlotRemovalRepeat) {
      for (const [oldId] of playerState._weaponSlotRemovalRepeat) {
        // A weapon that came back (re-picked-up mid-window) must not still be deleted right after
        // being re-announced below — the ADD for it takes priority.
        if (!weaponIds.includes(oldId)) body.push(135, -1, oldId);
      }
    }
    for (const nid of weaponIds) {
      const isEquipped = nid === _gunId;
      // The magazine figure only tracks the CURRENTLY EQUIPPED gun (gunAmmo is a single shared
      // field, not per-weapon) — a carried-but-not-equipped PICKUP weapon must show its actual
      // remembered magazine (see playerState._pickupMagAmmo, set when switching away from it — the
      // same fix that stopped switching back from instantly refilling it), not a fresh-reload
      // preview: reported live as "switch away from a pickup weapon and its icon shows full ammo,
      // only correct again once you switch back to it" — the icon and the real state had drifted
      // apart because this display line and the switch-restore logic used to disagree with each
      // other. A weapon with no cached entry yet (never equipped this life) still previews a fresh
      // clip, same as any regular (non-pickup) carried weapon.
      const cachedMag = playerState._pickupMagAmmo
        && Object.prototype.hasOwnProperty.call(playerState._pickupMagAmmo, nid)
        ? playerState._pickupMagAmmo[nid] : null;
      const magazine = isEquipped ? Math.max(0, playerState.gunAmmo | 0)
        : (cachedMag != null ? Math.max(0, cachedMag | 0) : weaponClip(nid, playerState));
      // Reserve (132) is infinite for a normal gun (>999 → the client renders ∞) — but a picked-up
      // special weapon has NO reserve at all beyond its finite pool (see weaponClip), so showing ∞
      // for one was a real bug: the HUD claimed unlimited ammo while the gun could — and did — run
      // completely dry. True reserve = the pool total minus whatever's currently/nominally chambered.
      const pool = playerState.pickupAmmo && Object.prototype.hasOwnProperty.call(playerState.pickupAmmo, nid)
        ? playerState.pickupAmmo[nid] : null;
      const reserve = pool != null ? Math.max(0, pool - magazine) : 999999;
      body.push(135, nid, 132, reserve, 133, magazine, 134, 0);
    }
    // NOTE: _prevEmitWeaponIds is deliberately NOT advanced here. This function runs ONCE PER
    // RECIPIENT, so updating it mid-broadcast meant only the first recipient's body carried a
    // delete — every other client stacked the new weapon icon on top of the old one, and whether
    // the shooter saw their OWN icon replaced depended on where they happened to fall in the
    // session iteration order. The snapshot advances exactly once per tick, after every body has
    // been built (see the post-broadcast sweep).
  }
  // The sword is likewise withheld: it is a weapon slot like any other and would render in hand.
  if (!held) body.push(135, 262, 132, 999999, 133, 999999, 134, 0);   // sword — infinite ammo
  body.push(
      // 136/137 position + velocity at SIX decimals, not the default four.
      //
      // The comparator's tolerance is `> 1e-4` (Qqx5i3b). Rounding to 4 decimals makes the wire
      // quantum exactly 1e-4 — the same size as the tolerance — so it can turn a sub-tolerance
      // disagreement into a supra-tolerance one purely as a rounding artefact. Measured from a live
      // divergence log while moving fast:
      //
      //   server 41.0365            client 41.03660000000001      delta exactly 1.0000e-4  -> RECONCILE
      //   server  9.5999            client  9.599900000000002     delta 1.8e-15
      //
      // The raw physics agreed to ~1e-15 on the axis that happened not to straddle a quantum
      // boundary, and to ~5e-5 on the ones that did — comfortably inside tolerance either way. Only
      // the quantisation pushed it over, which is why this showed up at speed (the low digits churn,
      // so a boundary is crossed most ticks) and not standing still.
      //
      // Six decimals puts the quantum at 1e-6, 100x under the tolerance. It costs nothing on the
      // wire: msgpack encodes these as float64 regardless of how many decimals are significant.
      // Angles (139/140/141) already used 6 for exactly this reason.
      136, 0, round(pos.x, 6), round(emittedY, 6), round(pos.z, 6),
      137, 0, round(vel.x, 6), round(vel.y, 6), round(vel.z, 6),
      138, playerState.grounded,
      // Zeroed while held, like the position. The capture showed the official server sending yaw 0;
      // we were sending the spawn yaw (3.927 rad) on every tick, which is another way the client keeps
      // a usable orientation for a player that is supposed to have none.
      139, held ? 0 : round(playerState.yaw, 6),
      140, held ? 0 : round(playerState.pitch, 6),
      // 141: pitchOffset — the pending recoil kick (and look delta) the client folds next tick.
      // Was hardcoded 0; that diverged from the client's recoil every shot. Now echoes the
      // physics value so the reconciler's pitchOffset check matches.
      141, round(playerState.pitchOffset || 0, 6),
      // 142: Q2r3ysn = crouching AND grounded (NOT the raw crouch key).
      // g() computes this as: held.has(8) && Q9t2fit.
      // Sending the raw key was wrong: when airborne + crouching, raw=true but
      // physics=false → reconciler saw a mismatch every airborne-crouch frame →
      // constant 0.0001-unit drift → snap every 20-30 s.
      142, playerState.crouching,        // now stores ps.Q2r3ysn (fixed above)
      // 143: Q2xg3ev = sprinting flag (physics-computed).
      // g() sets this based on key 7, stamina (Qwhpz0q), slide state, weapon noSprint.
      // Raw key expression missed stamina depletion and other conditions.
      143, playerState.sprinting,        // now stores ps.Q2xg3ev (fixed above)
      // 144 Qgk2mcg — ACTUALLY zooming, not "is the aim key down". This used to emit
      // `heldActions.has(6)`, which skipped both of the client's gates:
      //
      //   Qgk2mcg = health > 0 && held(6) && weaponDef.zoom !== undefined && reloadTimer < 1
      //
      // preTickFire already computes exactly that into ps.Qgk2mcg; the emitter just wasn't reading
      // it. With a zoom weapon and no reload the two agree, which is why normal ADS was fine — but
      // holding aim with a weapon that HAS no zoom (sword 262, sweeper 701 define no `zoom` field),
      // or holding it while reloading, made us stream zooming=true while the client predicted false.
      // zooming is a reconciler-compared field, so that diverged every tick the button was held:
      //   "zooming  =>  Server: true   Client: false"
      144, !!(playerState._ps && playerState._ps.Qgk2mcg),
      145, 9999,
      // 146 actionTickCounter — the real per-player value (maintained in integratePlayerSim), NOT
      // a constant. This is what makes peers visibly swing/fire: the client plays SWORD_SLASH on
      // `0 === actionTickCounter` (:51539) and the fire pose likewise (:48137). Hardcoding 9999
      // meant peers took damage from an idle-looking, never-swinging model.
      146, Number.isFinite(playerState.actionTickCounter) ? playerState.actionTickCounter : 9999,
      // 149 Qezbnmf — ticks since the last jump. Was hardcoded 9999, so it was never 0 and peers
      // never showed a jump puff.
      149, Number.isFinite(playerState.jumpTick) ? playerState.jumpTick : 9999,
      150, 9999,
      151, playerState.slideBoostTick || 0,
      157, playerState.airJumps,
      158, Math.max(0, Math.min(1, Number.isFinite(playerState.stamina) ? playerState.stamina : 1)),
      // 159-165: the seven ability timers (Qctsdxg..a). Echoed every tick so each ability's HUD
      // charge ring depletes on use and refills, and the client's cast prediction stays in sync.
      // 159 HE(t0) · 160 smoke/flash(t1) · 161 trip mine(t2) · 162 teleport(t3) · 163 sticky(t4) ·
      // 164 mine(t5) · 165 impulse(t6). Section 4 added the four damage-grenade timers.
      159, Math.max(0, Math.min(1, Number.isFinite(playerState.heCharge) ? playerState.heCharge : 0)),
      160, Math.max(0, Math.min(1, Number.isFinite(playerState.grenadeCharge) ? playerState.grenadeCharge : 0)),
      161, Math.max(0, Math.min(1, Number.isFinite(playerState.tripCharge) ? playerState.tripCharge : 0)),
      162, Math.max(0, Math.min(1, Number.isFinite(playerState.abilityCharge) ? playerState.abilityCharge : 0)),
      163, Math.max(0, Math.min(1, Number.isFinite(playerState.stickyCharge) ? playerState.stickyCharge : 0)),
      164, Math.max(0, Math.min(1, Number.isFinite(playerState.mineCharge) ? playerState.mineCharge : 0)),
      165, Math.max(0, Math.min(1, Number.isFinite(playerState.impulseCharge) ? playerState.impulseCharge : 0)),
      // 166/167/168: combat state — healthPoints (normalized 0..1), armorPoints, deathStateTimer.
      // Sent every tick so damage, death, and respawn are reflected on the HUD + health bars.
      166, Math.max(0, Math.min(1, Number.isFinite(playerState.healthPoints) ? playerState.healthPoints : 1)),
      167, Math.max(0, Number.isFinite(playerState.armorPoints) ? playerState.armorPoints : 0),
      // 168 Qpjho15 doubles as the FREEZE field. The client's own movement step opens with
      //     if (r.Qpjho15 > 0) return void r.Qpjho15++;
      // (bundle :34491) — it bails before gravity, so a non-zero value freezes a player exactly where
      // they are, in mid-air included. Using it for the intermission means both sides stop on the same
      // rule instead of the server freezing while the client keeps predicting, so there is nothing to
      // reconcile when the round restarts.
      //
      // Safe to overload: the client only treats it as a DEATH timer alongside Qyxhj60 === 4 (the
      // click-to-play condition at :63938) or healthPoints <= 0, and an intermission-frozen player is
      // neither. Peer animation also pauses (:52351), which is what "everyone freezes" should look like.
      168, Math.max(
        0,
        Number.isFinite(playerState.deathStateTimer) ? playerState.deathStateTimer : 0,
        intermissionFreezeTicks(),
      ),
      // 170-176: lastHitInfo — emitted ONLY the tick a player is hit (then cleared after broadcast),
      // so every client shows the victim's damage-direction indicator + hit reaction. Strict
      // ascending order (decoder is sequential): 170 attackerSid, 171 hitDamage, 172 hitWeaponType,
      // 173 headshot, 174 Qpgzeeg=0 (resets the fade counter — it auto-increments when 174 is
      // absent), 176 hitSrcPos (sub-mode 0 = full xyz = where the shot came from).
      // 175 Q13f0sb = forceRegen — the client's heal condition is
      //     hp < max && !dead && ... && (ticksSinceDamage > delay || Q13f0sb)
      // so this boolean is the heal-NOW override the client ORs in. It is set true on the tick
      // Qezc1on (227) reaches regenXTicksAfterKill. We own both halves server-side (tickHealthRegen),
      // so stream it or the client predicts a different regen moment than the one we apply.
      //
      // It has to be interleaved into the _pendingHit block rather than emitted after it: the decoder
      // is one ascending scan and 175 sits between 174 and 176, so appending it after 176 would stall
      // the cursor on any tick a player was hit.
      ...(playerState._pendingHit ? [
        170, playerState._pendingHit.attackerSid,
        171, playerState._pendingHit.dmg,
        172, playerState._pendingHit.wpnType,
        173, !!playerState._pendingHit.headshot,
        174, 0,
        175, !!playerState.forceRegen,
        176, 0, round(playerState._pendingHit.src.x), round(playerState._pendingHit.src.y), round(playerState._pendingHit.src.z),
      ] : [
        175, !!playerState.forceRegen,
      ]),
      // 185: Qcdx4mh (isDancing) — always false on our server (no emote actions)
      // 186: Qkno30b (isExamining) — always false
      // 187: Qjb047o (justUsedActiveAbility) — set true for the one tick a grenade is cast
      //      (processGrenadeCast); reconciler-compared, so echo it to match the prediction.
      // 188: Qgxywsl (justTeleported) — reconciler checks this; g() sets it true when
      //      teleport fires, resets to false next tick. Sending every tick ensures the
      //      client's server-decoded state is always authoritative.
      // 185 isDancing / 186 isExamining — the /dance and /examine emotes. The CLIENT never sets
      // these true (Qcdx4mh is only ever assigned !1, 8 sites); it only CLEARS them on shoot
      // (Qswb1wq), zoom, etc. So they are server-authoritative: the client sends '/dance' as chat
      // event 4, we flip the flag here, and the peer + third-person animation follows.
      // isDancing is ALSO a reconciler-compared field (Qqx5i3b), so it must be streamed or the
      // client's prediction and our state disagree every tick while dancing.
      // 181 Qalaptp — spawn protection, in ticks, counting down. The client enforces it itself in
      // Q2ngzid (:34453), so this is not decoration: while it is > 0 the shooter's client refuses to
      // register a hit at all. Never sending it left it at the factory default of -1 and then
      // free-running downward via Qvtrxln, so protection never applied to anyone, ever.
      //
      // Must stay between 176 and 185 in the ascending scan.
      181, Number.isFinite(_psOf(playerState).Qalaptp) ? _psOf(playerState).Qalaptp : -1,
      // 182 Q5vx943 is the spectator JOIN COUNTDOWN ("You will join in ..." — :70569). Deliberately
      // NOT emitted: we have no join queue, its default is -1 = "not queued", and both sides
      // decrement it from that same -1 through their own Qvtrxln, so the two copies cannot drift
      // apart. Sending a number here could only ever put a countdown on screen that means nothing.
      185, !!playerState.isDancing,
      186, !!playerState.isExamining,
      187, !!playerState.justUsedActiveAbility,
      188, !!playerState.justTeleported,
      // 197: Qwv47ix = the flash-blind FADE counter (NOT a placeholder — the old 9999 here
      // pinned it high so the blind formula `energyCharge - 0.01*Qwv47ix` was always ≤ 0,
      // meaning the white screen could never appear). Reset to 0 on flash detonation, then
      // incremented each tick to fade the blind.
      // 190 Qd2e7ku — ticks since a hard landing (touching down with vy < -0.2). Drives a landing
      // effect phased on (Qd2e7ku + partialTick) / 20 (:53326). The client resets it inside its own
      // movement step, which it never runs for PEERS, so peers never showed the landing effect.
      190, Number.isFinite(_psOf(playerState).Qd2e7ku) ? _psOf(playerState).Qd2e7ku : 9999,
      // 196 Qett9p1 — ticks since spawn. < 2 makes the client render a peer at its raw position
      // instead of interpolating (:51860). This is the respawn-slide fix: with this stuck high, a
      // respawning peer was always interpolated and visibly slid across the map from their death
      // spot to their spawn point.
      196, Number.isFinite(_psOf(playerState).Qett9p1) ? _psOf(playerState).Qett9p1 : 0,
      // 147 Qwx5aeh (burst-fire window) and 148 Qezdgca (ticks since the player last moved, which
      // feeds movement spread at :43989) are deliberately absent. Both are reset by paths the CLIENT
      // simulates for itself and we do not own server-side — we have no burst-fire implementation at
      // all — so putting our value on the wire would overwrite a correct client value with a wrong
      // one. They are advanced in integratePlayerSim purely so our copy is not frozen.
      197, Math.max(0, Number.isFinite(playerState.qwv47ix) ? playerState.qwv47ix : 0),
      // 198: energyCharge = flash-blind intensity. flashWhiteDiv.opacity = 0.5*max(energyCharge
      // - 0.01*Qwv47ix, 0)^2. Server-authoritative (the client's own flash detection never
      // runs for our colliderless server-spawned grenade).
      198, Math.max(0, Number.isFinite(playerState.energyCharge) ? playerState.energyCharge : 0),
      // 207 isThirdPerson: kept FALSE. (isThirdPerson would push a DEAD player into the spectator branch
      // (:53201) instead of the alive=4 killcam else-branch, and is meant for a manual 3rd-person toggle.)
      207, false,
      // 211 Q1gkus6 — the wall normal, non-zero for exactly one tick after a wall jump. The client
      // plays the 'walljump' ring on peers when its length is > 0. Vector form matches opcode 137:
      // a sub-mode byte then the components. Must stay between 210 and 214 in the ascending scan.
      211, 0, round(wallN.x, 4), round(wallN.y, 4), round(wallN.z, 4),
  );
  // 214/215/216 = Qty774u kills/deaths/score, 226 = assists, 228/229 = killStreak/multiKill. None of
  // these are reconciler-compared (Qqx5i3b checks only position/yaw/pitch/grounded/weapon/crouch/
  // sprint/zoom/airJumps/dance/examine/ability/teleport — verified directly against the client
  // bundle) and — UNLIKE 227 right after them — omitting them is a plain "keep the client's current
  // value" with no implicit increment (228/229's own comment already established this; 214/215/216/
  // 226 are the identical plain-assignment shape). They change only on a kill/death/round-reset
  // event, so resending them every tick regardless was pure waste — real cost on a weak-CPU client,
  // which has to parse and apply all six fields every single tick for every visible peer for no
  // reason 99%+ of the time.
  //
  // Send-on-change instead, gated on _statsSendCount — a reliability window (same shape as
  // weaponSendCount/127-128) computed and decremented ELSEWHERE (_updateStatsSendWindow, called from
  // _cachedPlayerBlock on the REAL playerState) and only ever READ here. This function can be handed
  // a shallow-spread COPY of playerState for the peer-broadcast variant (see _cachedPlayerBlock) —
  // writing the change-detection bookkeeping here would silently land on that throwaway copy and
  // never persist, making the whole mechanism a no-op for peers specifically, the exact case it
  // exists to help.
  if ((playerState._statsSendCount || 0) > 0) {
    body.push(
      214, playerState.kills | 0,
      215, playerState.deaths | 0,
      216, playerState.score | 0,
      226, playerState.assists | 0,
    );
  }
  body.push(
      // 227 Qezc1on = ticksSinceKill. This one is NOT optional-with-a-safe-default: the decoder reads
      //     227 === n[a] ? (Qezc1on = n[++a], a++) : Qezc1on++
      // so OMITTING it is an implicit increment. The client's copy free-ran, climbing forever and
      // never resetting on a kill, which desynced BOTH consumers:
      //   Qezc1on < Qph2e3n  -> the multikill chain window (our MULTIKILL_WINDOW)
      //   Qezc1on === regenXTicksAfterKill -> sets Q13f0sb (175), the heal-on-kill trigger
      // Unlike 214-216/226/228/229 above and below, this one is UNCONDITIONAL, every tick, always.
      227, Math.max(0, Number.isFinite(playerState.ticksSinceKill) ? playerState.ticksSinceKill : 0),
  );
  if ((playerState._statsSendCount || 0) > 0) {
    // 228 Q1nrrt6 (kill streak) / 229 Q5l0v64 (multikill) — see the shared gate above.
    body.push(228, playerState.killStreak | 0, 229, playerState.multiKill | 0);
  }
}

function buildTickBody(playerId, tick, playerState = createPlayerSimState(), peerSessions = null) {
  // IMPORTANT: opcode 280 (Qbu40n9 / game phase) MUST come AFTER all 244 entity
  // blocks.  The client delta decoder (Qpdy7i3) is a single forward scan: it
  // enters the `for (; 244 === n[a]; )` entity loop at a specific scan position.
  // If 280 appears before any 244 block, `a` is advanced past the 244 data before
  // the entity loop is ever reached, so ALL player positions are silently skipped
  // every tick.  The bootstrap (buildFirstSpawnBody) already places 280 last —
  // this function must match that ordering.
  // ── Tick header ─────────────────────────────────────────────────────────────────────────
  // Emitted SORTED for the same reason as the bootstrap header: the client decodes with one
  // ascending forward scan, and a single out-of-order opcode silently stalls it — dropping every
  // later field AND preventing the 244 player loop from being reached at all.
  const header = new Map();
  header.set(1, tick);
  header.set(4, tick);
  // 7 Qpm8qez = match time remaining in TICKS. Counts down through 0 into NEGATIVE during the
  // intermission; the client renders "Next round/game in" from (400 + this) / matchDuration.
  // NOTE the comparator early-outs while this is <= 0, so reconciliation pauses for those 20s —
  // that is official behaviour, not a bug.
  // 7 Qpm8qez = match time remaining in TICKS. Inflated to a full round ONLY for a player held in
  // state 0, which is the one case where it changes anything.
  //
  // The client's arrival MENU — the blurred canvas with the slow drifting camera — opens only when
  //     roundTime !== undefined && Qpm8qez >= roundTime * ticksPerSecond - 2
  //     && Qyxhj60 === 0 && (gameMode === 0 || gameMode === 4)              (bundle :64553)
  //
  // `roundTime` comes from the CLIENT'S OWN game-mode table, and only 3 of its 17 modes define it:
  // last_team_standing, last_team_standing_earn and search_and_destroy. Deathmatch does not. So on a
  // deathmatch server that branch can never be true no matter what we send, and state 0 leaves the
  // player as an ordinary first-person player who simply cannot reconcile — which is what "shows the
  // first person camera with weapon, same as state 1" was.
  //
  // Hence heldPlayerState defaults to 3 (spectator camera + CLICK TO PLAY) rather than the official 0.
  // The full timer is kept, gated on state 0, so a round-based mode can still take the official path.
  // Per-recipient either way, so everyone actually playing sees the true clock.
  header.set(7, (playerState && playerState._holdForPlay && PLAYER_STATE_HELD === 0)
    ? ROUND_TICKS : match.timer);
  // 8 Qy1p5xf = map GENERATION id. The loader fires whenever this differs from the value the
  // client last loaded, so bumping it at round start reloads the map for everyone.
  header.set(8, ROUNDS_ENABLED ? match.mapGeneration : 1);
  // 26 Qsvkg5s.Qn0kxxb = player GRAVITY, per frame. The client's own sim reads this, so streaming it
  // is what makes the gravity setting real rather than server-only — and with reconciliation on, a
  // server-only change would desync everyone instantly. Sent every tick so a mid-match change and a
  // late joiner are both covered; it is one small float.
  // 27 Qsvkg5s.Qbb5ka8 = GLOBAL DAMAGE multiplier. The client predicts its own health bar and ends
  // that prediction with , so this must match the server or the bar shows one number
  // and then snaps to another.
  header.set(27, (bpw.gameSettings && bpw.gameSettings.Qbb5ka8) != null
    ? bpw.gameSettings.Qbb5ka8 : DAMAGE_SCALE);
  header.set(26, (bpw.gameSettings && bpw.gameSettings.Qn0kxxb) != null
    ? bpw.gameSettings.Qn0kxxb
    : GRAVITY / Math.pow(Math.max(1, Math.round(1000 / TICK_MS)), 2));
  // 15 Qsj9eqq = the map URL the loader fetches when the generation changes. Sent every tick so a
  // client that reloads mid-round always has the current map to load.
  if (ROUNDS_ENABLED) {
    header.set(15, currentMapUrl());
    // Streamed with the URL so the loading screen a client shows for the NEXT map is already right
    // by the time the generation bump makes it open.
    header.set(18, currentMapThumb());
    header.set(19, currentMapName());
  }
  header.set(37, true);
  // 42 Qdh8um3 = matchDuration = TICKS PER SECOND (20). The client already defaults it to 20 and
  // the official server never sends it; this only matters at a non-20Hz tick rate.
  header.set(42, Math.max(1, Math.round(1000 / TICK_MS)));

  const body = [];
  for (const op of [...header.keys()].sort((a, b) => a - b)) body.push(op, header.get(op));

  // Bullet/tracer block (55) then hit-event block (67) — both decoded right after the header and
  // BEFORE the 244 player blocks (decoder order: bulletMap → playerMap → … → 244). Empty when idle.
  const bullets = buildBulletBlock();
  if (bullets.length) body.push(...bullets);
  const hitEvents = buildPlayerMapBlock();
  if (hitEvents.length) body.push(...hitEvents);

  if (peerSessions && typeof peerSessions.values === "function") {
    // Put the recipient/local player first. This preserves the old single-player
    // body shape prefix for reconciliation while still appending peer entities.
    //
    // SELF goes through the cache too, cached once per (playerId, tick) the same as a peer entry
    // would be — but NOT the same VALUE as a peer entry for this player: self uses the true
    // position (variant "self", the default), peers use the smoothed broadcast position (variant
    // "peer" — see the peer loop below and updateBroadcastPosition). A self failure is NOT caught
    // here, matching the pre-cache behaviour exactly: it propagates to this function's caller, which
    // isolates it per-RECIPIENT (this player's own packet build fails; nobody else's does) — a
    // stricter isolation than a peer failure gets, and one this must not weaken.
    const selfEntry = _cachedPlayerBlock(playerId, playerState, tick);
    if (!selfEntry.ok) throw selfEntry.err;
    for (let i = 0; i < selfEntry.block.length; i++) body.push(selfEntry.block[i]);
    for (const peer of peerSessions.values()) {
      // Skip sessions that have not JOINED yet. A session enters `sessions` the moment its
      // WebSocket connects, which is a full network round trip before its join payload (and
      // therefore its name, uid, weapon, skin and loadout) arrives. Streaming it in the meantime
      // made every other client create the entity from a bare movement block: the client fired its
      // "joined" notification and built the scoreboard row from an object with no identity, both
      // reading "undefined", and never attached a weapon or skin model. The bootstrap arrived a
      // moment later and repaired the ENTITY — hence a correct nameplate and a correct entity dump
      // — but the notification and the row had already been captured from the empty version.
      //
      // On localhost that window was sub-tick and invisible; over the internet it is several ticks,
      // which is why this only appeared once the server was hosted.
      //
      // A player is only visible to others once broadcastPeerSpawn has queued their full
      // introduction, so the first thing anyone ever sees of them carries their identity.
      if (!peer || peer.playerId === playerId || !peer.accepted) continue;
      // Per-PEER isolation, and this is the one that actually matters. Per-recipient isolation cannot
      // help when the bad data is shared: every recipient's body contains every peer, so one player
      // whose state cannot be serialised broke the body being built for EVERYONE — the server looked
      // frozen to the whole lobby because of one player. Measured exactly that way: poisoning one
      // player's health left every other client receiving nothing.
      //
      // A player who cannot be serialised is dropped from this body instead. They stop updating for
      // others (their last position persists, as with any missing delta) while everyone else plays on.
      //
      // Computed via the cache: for N recipients this player's block is built ONCE per tick (the
      // first recipient to reach them pays for it; every later recipient this tick gets the cached
      // result), not once per recipient. A failure is therefore also detected once per tick rather
      // than once per (recipient, peer) attempt — the `peer._entryErrorTick` guard below is what
      // keeps the log line and the error counter from being multiplied by N the way the old
      // per-recipient try/catch would have. The NET EFFECT for players — this peer missing from
      // every recipient's body on a bad tick — is unchanged; only the bookkeeping got cheaper.
      const peerEntry = _cachedPlayerBlock(peer.playerId, peer.playerState, tick, "peer");
      if (peerEntry.ok) {
        const blk = peerEntry.block;
        for (let i = 0; i < blk.length; i++) body.push(blk[i]);
        continue;
      }
      {
        const err = peerEntry.err;
        if (peer._entryErrorTick !== tick) {
          peer._entryErrorTick = tick;
          _live.simErrors = (_live.simErrors || 0) + 1;
          _live.lastSimError = `peer entry ${peer.playerId}: ${(err && err.message) || err}`;
          peer._entryErrors = (peer._entryErrors || 0) + 1;
          if (peer._entryErrors <= 3 || peer._entryErrors % 200 === 0) {
            console.error(`[evio-local] PEER ENTRY FAILED #${peer._entryErrors} peer=${peer.playerId} `
            + `(dropped from this body; other players unaffected):`, (err && err.stack) || err);
          }
        }
      }
    }
  } else {
    appendPlayerTickBody(body, playerId, playerState);
  }

  // 280 goes last — after all 244 entity blocks, matching buildFirstSpawnBody.
  body.push(280, ROUNDS_ENABLED ? match.gameMode : GAME_PHASE);
  // 308 Qi3xpyi — per-teleporter last-used tick, driving the client's portal burst effect. It
  // decodes AFTER the 244 player loop (bundle :66224 vs :65808), so unlike the rest of the world
  // state it cannot ride in the header: the client's single ascending scan would stall on it and
  // silently drop every player block. Stays absent until a portal is actually used.
  if (match.teleporterUseTicks.length) body.push(308, match.teleporterUseTicks);

  return body;
}

function extractPlayerSpawnDelta(body) {
  const start = body.indexOf(244);
  const end = body.lastIndexOf(280);
  if (start < 0) return [];
  return body.slice(start, end > start ? end : body.length);
}

function buildPeerBootstrapDelta(peer) {
  if (!peer) return [];
  return extractPlayerSpawnDelta(buildFirstSpawnBody({
    tick: peer.tick || 1,
    playerId: peer.playerId,
    displayName: peer.displayName || `local-${peer.playerId}`,
    uid: Number.isFinite(peer.uid) ? peer.uid : 17,
    weaponId: Number.isFinite(peer.weaponId) ? peer.weaponId : (SWORD_ONLY ? SWORD_WEAPON_ID : 4),
    abilitySeed: peer.abilitySeed,
    teamId: peer.teamId || 0,
    spawnProtectTicks: _psOf(peer.playerState).Qalaptp,
    // The bootstrap is the first state the client decodes, and its lobby UI is built from it — a
    // held player must arrive already marked as not-in-the-match or the menu is torn down at once.
    playerState: peer.playerState && peer.playerState._holdForPlay ? PLAYER_STATE_HELD : 1,
    // Same for a peer introduction — see the self bootstrap.
    spawn: (peer.playerState && peer.playerState._holdForPlay)
      ? { x: 0, y: 0, z: 0, yaw: 0 }
      : {
        x: peer.playerState.position.x,
        y: peer.playerState.position.y,
        z: peer.playerState.position.z,
        yaw: peer.playerState.yaw,
      },
    emitPositionYOffset: EMIT_POSITION_Y_OFFSET,
    gamePhase: GAME_PHASE,
    // Opcode 235 = clan insignia image. This was MISSING, which is why a player saw their OWN clan
    // logo but never a peer's: the avatar is a PROP (the ~3 roster covers every session) whereas
    // the clan image is a per-ENTITY opcode, and it was only ever filled in for the local player's
    // own bootstrap/loadout delta. Both peer paths (initial bootstrap and mid-match spawn) build
    // their entity block here, so passing it once fixes both.
    clan: peer.clanImgUrl,
  }));
}

function appendPeerBootstraps(body, sessions, localPlayerId) {
  if (!sessions || typeof sessions.values !== "function") return;
  const insertAt = body.lastIndexOf(280);
  const peerDeltas = [];
  for (const peer of sessions.values()) {
    // Same rule in the other direction: do not introduce a peer who has not joined yet, or the
    // joining client is handed an identity-less entity to build its UI from.
    if (!peer || peer.playerId === localPlayerId || !peer.accepted) continue;
    peerDeltas.push(...buildPeerBootstrapDelta(peer));
  }
  if (!peerDeltas.length) return;
  if (insertAt >= 0) body.splice(insertAt, 0, ...peerDeltas);
  else body.push(...peerDeltas);
}

function buildPeerSpawnPacketForRecipient(peer, recipientTick = 1, recipientClientTick = 0) {
  const body = [
    1, recipientTick,
    4, recipientTick,
    8, 1,
    37, true,
    ...buildPeerBootstrapDelta(peer),
    280, ROUNDS_ENABLED ? match.gameMode : GAME_PHASE,
  ];
  return [recipientTick, recipientClientTick, body];
}

function broadcastPeerSpawn(sessions, newPeer) {
  if (!sessions || !newPeer) return;
  // ── Queue-based peer introduction ──────────────────────────────────────────
  // Previously this sent an immediate separate packet reusing recipient.tick
  // (== the last globalTick the recipient already received).  Two packets with
  // the same serverTick landing within one client render frame (<16 ms) caused
  // the reconciler ring (Qxo2o14) to empty out → TypeError on the second
  // packet → reconciler crash → teleport + frozen peer model.
  //
  // Fix: append the new peer's bootstrap opcode delta to each recipient's
  // pendingPeerBootstraps queue.  The delta is spliced into the recipient's
  // NEXT regular tick body (global-loop or input-paced), which always carries
  // a strictly-increasing serverTick.  The client receives the peer introduction
  // inside a well-formed tick → no ring exhaustion, no crash.
  for (const recipient of sessions.values()) {
    if (!recipient || recipient.playerId === newPeer.playerId || !recipient.accepted) continue;
    const delta = buildPeerBootstrapDelta(newPeer);
    if (!Array.isArray(recipient.pendingPeerBootstraps)) recipient.pendingPeerBootstraps = [];
    recipient.pendingPeerBootstraps.push(...delta);
    // Overflow escalates to a FULL re-bootstrap rather than truncating. This is a flat opcode stream,
    // so cutting it anywhere lands in the middle of a player entry, and the client decodes with one
    // ascending forward scan — a partial entry stalls the cursor and silently drops everything after
    // it. A full bootstrap is self-contained and carries every peer, so it is both safe and correct.
    // Reachable when a recipient goes many ticks without a send (warmup, or the backpressure skip)
    // while other players are joining.
    if (recipient.pendingPeerBootstraps.length > MAX_PENDING_BOOTSTRAP_OPS) {
      console.warn(`[evio-local] ${recipient.playerId} queued `
        + `${recipient.pendingPeerBootstraps.length} peer-bootstrap ops without a send — `
        + `escalating to a full re-bootstrap`);
      recipient.pendingPeerBootstraps = [];
      recipient.pendingFullBootstrap = true;
      continue;
    }
    console.log(`[evio-local] queued peer-spawn peer=${newPeer.playerId} -> recipient=${recipient.playerId} deltaOps=${delta.length}`);
  }
}

/**
 * Splice any pending peer bootstrap deltas into a tick body before 280,
 * then clear the queue.  Call AFTER buildTickBody, before sendState.
 */
function flushPendingPeerBootstraps(session, body) {
  if (!session.pendingPeerBootstraps || !session.pendingPeerBootstraps.length) return;
  // Insert BEFORE the first 244 block, not before 280.
  //
  // A joining peer is already in `sessions`, so this same body carries their ordinary per-tick 244
  // block — which holds only the movement subset. Splicing the bootstrap after it meant the client
  // met the player as a bare `{}` first: it fired the "joined" notification and created the
  // scoreboard row from that empty object (both showing "undefined"), and only afterwards read the
  // identity. The 3D nameplate then looked CORRECT because it is re-read every frame, while the
  // notification and the scoreboard row had already been captured and were never refreshed — which
  // is exactly the "undefined in chat and scoreboard, right name over their head" symptom.
  //
  // Putting the bootstrap first means the entity exists fully-formed (name, weapon, skin, stats)
  // before anything observes it. Ordering stays valid: the header opcodes are all < 244, and the
  // bootstrap is itself a 244 block, so the client's ascending scan runs header -> bootstrap ->
  // regular blocks without a stall.
  const insertAt = body.indexOf(244);
  if (insertAt >= 0) body.splice(insertAt, 0, ...session.pendingPeerBootstraps);
  else {
    const before280 = body.lastIndexOf(280);
    if (before280 >= 0) body.splice(before280, 0, ...session.pendingPeerBootstraps);
    else body.push(...session.pendingPeerBootstraps);
  }
  console.log(`[evio-local] flushed peer-spawn for ${session.playerId}: ops=${session.pendingPeerBootstraps.length}`);
  session.pendingPeerBootstraps = [];
}

/**
 * Splice peer-removal markers into a tick body before 280.  The client's 244
 * entity loop treats a NEGATIVE 244 value as a delete: `244, -1, <playerId>` →
 * `delete playerList[playerId]` (bundle Qpdy7i3 ~65810), which then prunes the
 * peer's model (Qto0d12) and scoreboard entry.  We resend for a few ticks per
 * departed peer (keyed playerId → ticksRemaining) so a dropped packet can't
 * leave a ghost player.  Call AFTER buildTickBody, before sendState.
 */
function flushPendingPeerRemovals(session, body) {
  const rem = session.pendingPeerRemovals;
  if (!rem || rem.size === 0) return;
  const ops = [];
  for (const [playerId, ticksLeft] of rem) {
    ops.push(244, -1, playerId);
    if (ticksLeft <= 1) rem.delete(playerId);
    else rem.set(playerId, ticksLeft - 1);
  }
  const insertAt = body.lastIndexOf(280);
  if (insertAt >= 0) body.splice(insertAt, 0, ...ops);
  else body.push(...ops);
}

// Live mid-match loadout change. The client sends these RPCs whenever the player edits
// their loadout (also once at join): '6' = setPrimaryWeapon (weapon nid), '7' =
// setAbilityLoadout (the 19-element array). We apply them to the session + authoritative
// physics and queue a loadout delta so the change takes effect instantly — no respawn or
// refresh (matches official). Returns true if it consumed the RPC.
function handleLoadoutRpc(session, playerState, text) {
  const secondTick = text.indexOf("`", 1);
  if (secondTick < 0) return false;
  const code = text.slice(1, secondTick);
  if (code !== "6" && code !== "7") return false;
  let arg = null;
  try { arg = JSON.parse(text.slice(secondTick + 1) || "0"); } catch (_) { arg = null; }

  if (code === "6") {
    const nid = resolveLoadoutWeapon(Number(arg));
    if (Number.isFinite(nid) && nid > 0 && nid !== session.weaponId) {
      const oldPrimary = Array.isArray(playerState.weaponList) ? playerState.weaponList.find((w) => w !== 262) : null;
      session.weaponId = nid;
      playerState.weaponList = nid === 262 ? [262] : [nid, 262];
      // Point the magazine at the new gun (full clip) so the per-tick weaponSlots stream emits the new
      // weapon + a delete for the old one → the old icon is replaced, not stacked on top.
      if (nid !== 262) { playerState._ammoGunId = nid; playerState.gunAmmo = weaponClip(nid, playerState); playerState.reloadTicks = 0; }
      // If currently holding the now-replaced primary (or an invalid weapon), swap to the new gun.
      if (playerState.equippedWeaponId === oldPrimary || !playerState.weaponList.includes(playerState.equippedWeaponId)) {
        playerState.backupWeaponId = playerState.equippedWeaponId;
        playerState.equippedWeaponId = nid;
      }
      session.loadoutDeltaSendCount = 6;
      console.log(`[evio-local] RPC6 setPrimaryWeapon -> ${nid} (equipped=${playerState.equippedWeaponId})`);
    }
    return true;
  }

  // code === "7": setAbilityLoadout. The client sends the 19-array as a JSON STRING
  // (Qth1sma returns the stored field value, then sendEvent JSON-stringifies it), so the
  // arg arrives double-encoded as '"[3,0,0,...]"' — parse the inner string to the array.
  let arr = arg;
  if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch (_) { arr = null; } }
  if (Array.isArray(arr) && arr.length) {
    session.abilitySeed = _sanitizeAbilitySeed(arr);
    if (playerState._ps && playerState._ps.Qz8l93a) {
      Object.assign(playerState._ps.Qz8l93a, computeWeaponStats(session.abilitySeed));
      refreshMagazineCapacity(playerState);   // capacity depends on the stats just applied
      playerState._ps.weaponStateArray = session.abilitySeed;
    }
    session.loadoutDeltaSendCount = 6;
    const drain = playerState._ps && playerState._ps.Qz8l93a ? playerState._ps.Qz8l93a.Qbypopp : "?";
    console.log(`[evio-local] RPC7 setAbilityLoadout -> [${session.abilitySeed.join(",")}] staminaDrain=${drain}`);
  }
  return true;
}

// Splice the loadout delta into a tick body (before 280), re-sent a few ticks for reliability.
function flushLoadoutDelta(session, playerState, body) {
  if (!session.loadoutDeltaSendCount || session.loadoutDeltaSendCount <= 0) return;
  const delta = buildLoadoutDelta({
    playerId: session.playerId,
    weaponId: session.weaponId,
    equippedWeaponId: playerState.equippedWeaponId,
    abilitySeed: session.abilitySeed,
    clan: session.clanImgUrl,   // late-arriving clan insignia (social socket)
    // Must match what the tick body is saying this instant. A held player is mid-arrival, and one
    // stray 1 here locks their clone into first person permanently — see the note in the builder.
    playerState: playerState._holdForPlay ? (playerState._spectating ? 2 : PLAYER_STATE_HELD) : 1,
  });
  const insertAt = body.lastIndexOf(280);
  if (insertAt >= 0) body.splice(insertAt, 0, ...delta);
  else body.push(...delta);
  session.loadoutDeltaSendCount -= 1;
}

// Apply a LIVE loadout/skin change pushed by the userscript over the '#EVL#' channel.
// The in-game loadout RPC (6/7) is account-gated and never reaches our local server, but
// the client re-fetches /me on every edit, so the userscript captures the new loadout and
// forwards it here. We update the session + authoritative physics and queue the loadout
// delta (weapon/abilities) + re-broadcast the skin roster — applied live, no respawn.
function applyLiveLoadout(session, playerState, jsonStr, sessions) {
  let data;
  try { data = JSON.parse(jsonStr); } catch (_) { return; }
  if (!data || typeof data !== "object") return;
  let changed = false;

  const _bridgedWeapon = resolveLoadoutWeapon(data.abilityLoadoutId);
  if (Number.isFinite(_bridgedWeapon) && _bridgedWeapon > 0 && _bridgedWeapon !== session.weaponId) {
    const oldPrimary = Array.isArray(playerState.weaponList) ? playerState.weaponList.find((w) => w !== 262) : null;
    session.weaponId = _bridgedWeapon;
    playerState.weaponList = session.weaponId === 262 ? [262] : [session.weaponId, 262];
    if (playerState.equippedWeaponId === oldPrimary || !playerState.weaponList.includes(playerState.equippedWeaponId)) {
      playerState.backupWeaponId = playerState.equippedWeaponId;
      playerState.equippedWeaponId = session.weaponId;
    }
    // New gun → full magazine; per-tick weaponSlots stream swaps the icon (delete old + add new).
    if (session.weaponId !== 262) { playerState._ammoGunId = session.weaponId; playerState.gunAmmo = weaponClip(session.weaponId, playerState); playerState.reloadTicks = 0; }
    // Re-emit 127/128 so PEERS see the new weapon in hand. equippedWeaponId is delta-emitted (absent
    // means unchanged), so without this the change was invisible to everyone else: the player's own
    // HUD updated from the weaponSlots stream while every other client kept rendering the old model.
    // Same count the in-game weapon switch uses — a few ticks of repetition for packet-loss safety.
    playerState.weaponSendCount = WEAPON_SEND_REPEAT_TICKS;
    // Run the swap through the same switch timer a manual switch uses, so peers get the
    // 'switch_weapon' animation and re-render the model instead of silently keeping the old one.
    startWeaponSwitch(playerState);
    changed = true;
  }
  if (Array.isArray(data.abilitySeed) && data.abilitySeed.length) {
    session.abilitySeed = _sanitizeAbilitySeed(data.abilitySeed);
    if (playerState._ps && playerState._ps.Qz8l93a) {
      Object.assign(playerState._ps.Qz8l93a, computeWeaponStats(session.abilitySeed));
      refreshMagazineCapacity(playerState);   // capacity depends on the stats just applied
      playerState._ps.weaponStateArray = session.abilitySeed;
    }
    changed = true;
  }
  if (typeof data.skinUrl === "string" && data.skinUrl && data.skinUrl !== session.skinUrl) {
    session.skinUrl = _boundedUrl(data.skinUrl);
    changed = true;
  }
  // Changing skin also changes the avatar thumb and its rarity frame, so these ride the same
  // live-update path rather than waiting for a rejoin.
  for (const f of ["thumbUrl", "skinRarity", "clanImgUrl", "clanLink"]) {
    if (typeof data[f] === "string" && data[f] && data[f] !== session[f]) { session[f] = data[f]; changed = true; }
  }
  if (data.weaponSkins && typeof data.weaponSkins === "object") {
    const allowed = new Set(["Qcdgi7s", "Qy8jpjd", "Qclpb4q", "Qb9vw3f", "Ql3d4qw", "Q53m0bo"]);
    const ws2 = {};
    for (const [k, v] of Object.entries(data.weaponSkins)) {
      if (allowed.has(k) && typeof v === "string" && v) ws2[k] = v;
    }
    session.weaponSkins = Object.keys(ws2).length ? ws2 : null;
    changed = true;
  }

  if (!changed) return;
  session.loadoutDeltaSendCount = 6;   // weapon/ability opcodes into the next ticks
  broadcastProfiles(sessions);          // body + weapon skins via the native '~3' roster
  // Re-introduce this player to EVERYONE ELSE so peer-visible entity fields refresh.
  // The clan insignia (opcode 235) resolves ASYNCHRONOUSLY — the userscript fetches clans-all3
  // after the join — so a peer's bootstrap almost always went out with clan=null. The loadout
  // delta above only reaches the player themselves, hence "my logo shows, theirs doesn't".
  // Re-queueing the peer bootstrap pushes the updated 235 (and weapon/skin) to the other clients
  // through the same well-formed-tick path used for joins.
  broadcastPeerSpawn(sessions, session);
  const drain = playerState._ps && playerState._ps.Qz8l93a ? playerState._ps.Qz8l93a.Qbypopp : "?";
  console.log(`[evio-local] LIVE loadout: weapon=${session.weaponId} array=[${(session.abilitySeed || []).join(",")}] staminaDrain=${drain} skinUrl=${session.skinUrl ? "set" : "default"}`);
}

/**
 * Player-prop roster sync using the CLIENT'S OWN native channel — no userscript
 * shadow store. The client's notification handler (bundle y(), case '3') receives
 * a '~3`<json>' event, clears its getPlayerProps map `g`, and for each roster entry
 * does `g[entityId] ||= createPlayerPropStore(); g[entityId][propKey] = propValue`.
 * So the client builds the FULL default store itself (no partial-store crash) and
 * we only override the fields we know — here SKIN_URL (the body skin), resolved
 * client-side from the account's field_eq_skin and bridged in the join as skinUrl.
 *
 * Wire format (see WS dispatch, case '~'): '~' + code + '`' + JSON. entityId is the
 * player's sessionId (= our playerId, opcode 90), which is the key getPlayerProps uses.
 *
 * CRITICAL — OBFUSCATED FIELD NAMES. The client reads the OBFUSCATED property names,
 * NOT the human-readable deobfuscated ones. Verified against evidence/web/assets/bundle.js:
 *   roster entry: { Qwhkhza:<entityId>, Qcxi0k5:<propKey>, Qcou9jy:<propValue> }
 *   case '3' does: g[s.Qwhkhza] ||= createPlayerPropStore(); g[s.Qwhkhza][s.Qcxi0k5] = s.Qcou9jy
 * The propKey (Qcxi0k5) must be the PlayerPropKey VALUE, also obfuscated:
 *   SKIN_URL -> 'Qh52c4d'  (createPlayerPropStore default: Qh52c4d:'.../default_2.evskin')
 * The renderer reads m.Qh52c4d for the body skin. Using the deobfuscated names
 * ('entityId'/'propKey'/'propValue'/'SKIN_URL') silently no-ops -> g["undefined"].
 */
const PROP_KEY_SKIN_URL = "Qh52c4d"; // PlayerPropKey.SKIN_URL (obfuscated value)
// PlayerPropKey.THUMB_URL — the PROFILE AVATAR shown in the scoreboard AND the kill feed. Both
// build their image from the SAME helper:
//   K = function(entity, props, cfg) { var i = props.Qaalbed; ...zombie override...; return i }
//   scoreboard: '<div class="msg_profile_score …"><img src="' + K(e,o,r) + '">'
//   kill feed : '<div class="msg_profile …"><img src="' + K(e,l,o) + '" />'
// so sending this one prop fixes both. It is NOT a user-uploaded picture — it is the equipped
// SKIN's `field_profile_thumb` (cmsBaseURL + that path), which is why the zombie fallback is also
// a skin thumb. Scope is Public in the client's field table, i.e. broadcast to everyone.
const PROP_KEY_THUMB_URL = "Qaalbed";
// PlayerPropKey rarity — the CSS class on the avatar frame in both views
// (`msg_profile_score ' + o.Qy58vo2.toLowerCase()`). Without it the frame renders unstyled.
const PROP_KEY_RARITY = "Qy58vo2";
// PlayerPropKey clan link — the scoreboard's clan insignia is gated on BOTH this prop and the
// per-entity clan image (opcode 235):
//   h = ''; (e.Qdqucnz === null || o.Q3ap9pp === null || s) || (h = '<a href="'+o.Q3ap9pp+'"><img src="'+e.Qdqucnz+'"/></a>')
// so the logo needs the image (235) AND this URL — either one null and the insignia stays empty.
const PROP_KEY_CLAN_LINK = "Q3ap9pp";

function buildPropRoster(sessions) {
  const roster = [];
  for (const s of sessions.values()) {
    if (!s || !s.accepted) continue;
    if (typeof s.skinUrl === "string" && s.skinUrl) {
      roster.push({ Qwhkhza: s.sessionId, Qcxi0k5: PROP_KEY_SKIN_URL, Qcou9jy: s.skinUrl });
    }
    if (typeof s.thumbUrl === "string" && s.thumbUrl) {
      roster.push({ Qwhkhza: s.sessionId, Qcxi0k5: PROP_KEY_THUMB_URL, Qcou9jy: s.thumbUrl });
    }
    if (typeof s.skinRarity === "string" && s.skinRarity) {
      roster.push({ Qwhkhza: s.sessionId, Qcxi0k5: PROP_KEY_RARITY, Qcou9jy: s.skinRarity });
    }
    if (typeof s.clanLink === "string" && s.clanLink) {
      roster.push({ Qwhkhza: s.sessionId, Qcxi0k5: PROP_KEY_CLAN_LINK, Qcou9jy: s.clanLink });
    }
    // Weapon skins: each key is already the obfuscated getPlayerProps field the renderer
    // reads for that weapon (the propKey IS the property name set on the store).
    if (s.weaponSkins) {
      for (const [propKey, url] of Object.entries(s.weaponSkins)) {
        roster.push({ Qwhkhza: s.sessionId, Qcxi0k5: propKey, Qcou9jy: url });
      }
    }
  }
  return roster;
}

let _lastRosterMsg = null;
function broadcastProfiles(sessions) {
  const roster = buildPropRoster(sessions);
  if (!roster.length) return;
  const msg = "~3`" + JSON.stringify(roster);
  // Only log when the roster content actually changes (joins/skin changes), not on
  // every timed resend — keeps the console readable.
  if (msg !== _lastRosterMsg) {
    const recips = [...sessions.values()].filter(s => s && s.accepted).length;
    console.log(`[evio-local] ~3 prop-roster -> ${recips} client(s): ${roster.length} skin(s) [${roster.map(r => r.Qwhkhza).join(", ")}]`);
    _lastRosterMsg = msg;
  }
  for (const s of sessions.values()) {
    if (s && s.accepted) safeSend(s.ws, msg);
  }
}

// ── Match / round state machine ──────────────────────────────────────────────────────────
// One shared match across all sessions (a single deathmatch lobby). See the ROUND_TICKS comment
// for the wire protocol.
const match = {
  timer: 0,        // Qpm8qez: ticks remaining; goes NEGATIVE through the intermission
  gameMode: 0,     // Qbu40n9: 0 playing, 1 game over (end-game scoreboard)
  round: 1,
  // Qy1p5xf (opcode 8) — the map GENERATION id. The client reloads the map whenever this differs
  // from the value it last loaded (`Qrn6ykl: e => e.Qaol467.Qy1p5xf !== h`), and predictState
  // returns null until the load completes. Bump it to force a reload; never reuse a value.
  mapGeneration: 1,
  mapIndex: 0,
  mapUrlOverride: null,     // set by an admin map switch
  mapTitle: "Bishop",
  // Opcode 18 — the loading-screen thumbnail. Held alongside the title so a map switch updates the
  // join/loading screen instead of leaving it on Bishop forever.
  mapThumbUrl: null,
  // Qi3xpyi (opcode 308) — per-teleporter "last used" tick. Purely cosmetic: the client fires the
  // portal burst effect when an entry changes. Reset on every map switch, since ids are per-map.
  teleporterUseTicks: [],
  // Ticks left during which every player is periodically RE-INTRODUCED to every other client.
  // Needed because a map reload rebuilds the client's world state: the 244 tick loop then recreates
  // a missing peer as an EMPTY object (`w in playerList || (playerList[w] = {})`), which carries no
  // name/weapon/skin, so the peer model cannot be built and the peer stays INVISIBLE. Re-sending
  // the full bootstrap restores those fields. Spread over several seconds because the client
  // ignores state while the new map is still loading (predictState returns null until then).
  reintroTicks: 0,
};

/**
 * The spawn table for the map that is ACTUALLY loaded.
 *
 * There used to be two: `bpw.spawnPoints` (parsed from the active .evmap, mirrored correctly and
 * seated on the floor). The old heightmap spawn list (terrain_height) is gone.
 * — a Bishop-only, un-mirrored, un-seated list. Round start used the first; JOIN, death-respawn and
 * admin teleport used the second. That is why spawns were still wrong in play after the transform
 * was fixed: on Bishop players got the mirrored coordinates, and on every other map they got
 * BISHOP's coordinates dropped into unrelated geometry — hence spawning inside walls, in mid-air,
 * or under the map and dying instantly.
 *
 * The heightmap list survives only as a last resort for the legacy fallback sim, when no collision
 * world was built at all.
 */
function activeSpawnPoints() {
  const s = bpw.spawnPoints;
  // Last resort only: the collision world always supplies spawns once it has loaded, and they are
  // seated onto the real floor. The old fallback read the Bishop heightmap, which is gone; its
  // own no-heightmap fallback was this same single origin spawn.
  if (!s || !s.length) return [{ x: 0, y: GROUND_Y, z: 0, yaw: 0 }];

  // Only the GENERAL spawns (evmap flag 1). A map's spawn table also holds team-1 and team-2 pads,
  // which the client keeps in separate lists and uses only when the mode sets useTeamSpawns
  // (bundle :32973). We were flattening all three together, so a free-for-all could drop someone on a
  // team-only pad the official client would never pick for that mode — 10 of Ancient's 30 spawns,
  // 8 of DragonTemple's 30, 4 of Bedlam's 24.
  //
  // Falls back to the unfiltered list if a map marks none of its spawns general, which would otherwise
  // leave nowhere to stand.
  const general = s.filter((p) => p && p.general !== false);
  return general.length ? general : s;
}

function mapRotation() {
  return String(MAP_ROTATION || "").split(",").map((x) => x.trim()).filter(Boolean);
}
function currentMapUrl() {
  // An admin map switch wins over the rotation until the next rotation step.
  if (match.mapUrlOverride) return match.mapUrlOverride;
  const rot = mapRotation();
  return rot.length ? rot[match.mapIndex % rot.length] : "https://ev.io/sites/default/files/maps/HUT8Bishop.evmap";
}
// The map NAME and THUMBNAIL the client shows on the loading screen (opcodes 19 and 18). These
// travel separately from the .evmap URL: the client never derives one from the other, so without
// them a switched map still announces itself as "Bishop" with the Bishop thumb.
function currentMapName() {
  return match.mapTitle || "Bishop";
}
// Opcode 16/18 — the picture the client shows while the map loads, so it wants the FULL-RESOLUTION
// art (field_large_image, map_large_image/*.jpg), not the small picker icon (field_map_thumbnail,
// map_thumbs/*.png). Sending the thumbnail made the client upscale a small PNG to fill the screen,
// which is the blurry loading image. Falls back to the thumbnail for the maps that define no large
// image, since a low-resolution picture still beats none.
function currentMapThumb() {
  try {
    const m = mapLoader.findMap(currentMapUrl());
    if (m && m.largeImageUrl) return m.largeImageUrl;
  } catch { /* catalogue unavailable — fall through */ }
  if (match.mapThumbUrl) return match.mapThumbUrl;
  // Fall back to the catalogue so a rotation entry (which is only a URL) still gets its own art.
  try {
    const m = mapLoader.findMap(currentMapUrl());
    if (m && m.thumbUrl) return m.thumbUrl;
  } catch { /* catalogue unavailable — use the built-in default */ }
  return "https://ev.io/sites/default/files/map_thumbs/BishopThumb.png";
}

// Advance to the next map and bump the generation so clients reload. Returns true if the map
// actually changed (a single-entry rotation reloads the SAME map, which official also does).
// Only bump the generation when the map REALLY changes. Bumping it for a single-map rotation
// forces a pointless full client teardown: predictState returns null, the client sets
// canSendInput=false / isGameActive=false, sends signal 4, and has to re-init its renderer. That
// teardown is what left peers invisible and shooting dead after every round. A same-map round
// restart needs no reload — the server already respawns everyone and resets stats.
function advanceMap() {
  const rot = mapRotation();
  if (rot.length <= 1) return false;          // single map: no reload, no teardown
  match.mapIndex = (match.mapIndex + 1) % rot.length;
  match.mapGeneration += 1;
  // The rotation overrides an admin pick, so its title/art must go with it.
  match.mapUrlOverride = null;
  const next = mapLoader.findMap(currentMapUrl());
  match.mapTitle = next ? next.title : "Bishop";
  match.mapThumbUrl = next ? next.thumbUrl : null;
  return true;
}

function resetMatchTimer() {
  match.timer = ROUNDS_ENABLED ? ROUND_TICKS : 7200000;   // legacy endless value when rounds are off
  match.gameMode = 0;
}
resetMatchTimer();

// Wipe per-round player stats and put everyone back on a spawn, alive and full.
// Client -> server signals ('!' + code). Signal 4 means the client has TORN DOWN its game state
// and needs a full resend; it fires from sendInputFrame when predictState returns null:
//   if (null === l) return canSendInput = false, isGameActive = false, sendSignal(4)
// The client stops sending input until it is re-bootstrapped, so ignoring this leaves it
// permanently inactive — peers invisible, shooting dead.
function handleClientSignal(session, sig) {
  if (!session) return;
  if (sig === 4) {
    // The client restarts its input-tick numbering from its reset world state, so the queue's old
    // high water mark would reject every new input as stale (player frozen server-side).
    resetSessionInputStream(session);
    console.log(`[evio-local] signal 4 from ${session.playerId} — client reset, queueing full re-bootstrap`);
  } else {
    console.log(`[evio-local] signal ${sig} from ${session.playerId}`);
  }
}

// ── Live map switching ──────────────────────────────────────────────────────────────────
// Loads a map on demand (downloading + caching it if needed), swaps the collision world, and
// re-seats every player. The client side of a map change is the generation bump (opcode 8): it
// makes predictState return null, so the client tears its state down, sends signal 4, and reloads
// the .evmap itself from opcode 15. We answer that with a full re-bootstrap.
//
// The world swap is safe mid-session because everything reads bpw.world through a getter and the
// per-tick capsule sync re-registers every player, so no explicit re-registration is needed. What
// is NOT safe is leaving players at their old coordinates — those mean nothing in new geometry —
// hence the forced respawn onto the new map's spawns.
let _mapSwitchInFlight = false;
async function switchMap(sessions, idOrTitle) {
  if (_mapSwitchInFlight) throw new Error("a map switch is already in progress");
  _mapSwitchInFlight = true;
  try {
    const loaded = await mapLoader.loadMap(idOrTitle);
    bpw.setActiveWorld({
      world: loaded.world, spawns: loaded.spawns, teleporters: loaded.teleporters,
      navmesh: loaded.navmesh, pickupPoints: loaded.pickupPoints,
      vertices: loaded.vertices,
      indices: loaded.indices, groupIds: loaded.groupIds, name: loaded.map.title,
    });
    match.mapUrlOverride = loaded.map.evmapUrl;
    match.mapTitle = loaded.map.title;
    match.mapThumbUrl = loaded.map.thumbUrl || null;
    match.teleporterUseTicks = [];
    // Entities are positioned in the OLD geometry — a mine floating where a wall used to be is at
    // best confusing and at worst still lethal. Drop them with the world they belonged to.
    clearAllEntities("map switch");
    // Same reasoning: the OLD map's pickup points/state mean nothing on the new geometry (different
    // count, different positions) — drop and rebuild fresh rather than carry stale cooldowns over.
    // No separate bootstrap queue to clear: buildWeaponPickupBlock resends the FULL live state to
    // every recipient every tick (see its header comment), so the new state simply appears next tick.
    _resetPickupState();
    match.mapGeneration += 1;          // triggers the client-side reload + teardown
    // Re-seat everyone on the NEW map. Deliberately NOT startNewRound: that advances the ROTATION
    // (double-stepping the map) and, for a single-map rotation, would report "no change" and skip
    // the re-bootstrap entirely — which is what left players frozen after a switch.
    respawnAll(sessions);
    for (const s of sessions.values()) if (s && s.accepted) resetSessionInputStream(s);
    match.reintroTicks = 120;
    resetMatchTimer();
    // Remember it for the next boot. Stored as the TITLE rather than whatever the caller typed, so
    // an id-based switch still reloads by a name the map list can resolve.
    S.set("startupMap", loaded.map.title, "map-switch");
    console.log(`[evio-local] MAP -> ${loaded.map.title} (${loaded.tris} tris, `
      + `${loaded.spawns.length} spawns, generation ${match.mapGeneration}, `
      + `${loaded.fromCache ? "cached" : "downloaded"})`);
    return { ok: true, map: loaded.map.title, tris: loaded.tris, spawns: loaded.spawns.length,
             fromCache: loaded.fromCache, generation: match.mapGeneration };
  } finally {
    _mapSwitchInFlight = false;
  }
}

// Reset every player for a fresh start: stats cleared, alive, full ammo, seated on the ACTIVE map's
// spawns. Split out of startNewRound so a map switch can reuse it WITHOUT touching the rotation.
function respawnAll(sessions) {
  // Use the ACTIVE world's spawns — after a map switch the old map's coordinates are meaningless.
  const spawns = activeSpawnPoints();
  let i = 0;
  for (const s of sessions.values()) {
    if (!s || !s.accepted || !s.playerState) continue;
    const p = s.playerState;
    p.kills = 0; p.deaths = 0; p.score = 0; p.assists = 0; p.killStreak = 0; p.multiKill = 0;
    p.healthPoints = 1; p.armorPoints = 0; p.deathStateTimer = 0; p.fireCooldown = 0;
    // Same reasoning as respawnPlayerNow: pickup weapons never survive a reset, all slots at once.
    // Unlike that path, this loop has no separate primary-restore fixup, so
    // _clearAllPickupWeapons's own wasEquipped branch is what puts the player back on their
    // primary if they were holding one of them.
    _clearAllPickupWeapons(p);
    p.gunAmmo = weaponClip(p._ammoGunId, p); p.reloadTicks = 0;
    p.isDancing = false; p.isExamining = false;
    const sp = (spawns && spawns.length) ? spawns[(i++) % spawns.length] : { x: 0, y: GROUND_Y, z: 0 };
    p.position.x = sp.x; p.position.y = sp.y; p.position.z = sp.z;
    p.velocity.x = 0; p.velocity.y = 0; p.velocity.z = 0;
    const ps = p._ps;
    if (ps) {
      if (ps.Qdsukt4) { ps.Qdsukt4.x = sp.x; ps.Qdsukt4.y = sp.y; ps.Qdsukt4.z = sp.z; }
      if (ps.Qyaswvo) { ps.Qyaswvo.x = 0; ps.Qyaswvo.y = 0; ps.Qyaswvo.z = 0; }
      // Same physics fields the respawn path clears — the movement step bails while either holds.
      ps.Qq7zdfv = (ps.Qz8l93a && Number.isFinite(ps.Qz8l93a.Qtgt1xt)) ? ps.Qz8l93a.Qtgt1xt : 1;
      ps.Qd032mo = 0;
      ps.Qpjho15 = 0;
    }
    // Same reasoning as respawnPlayerNow: a map-switch respawn is a genuine instant reposition, so
    // both the lag-comp history and the peer-broadcast smoothing state must be dropped rather than
    // bridging (rewinding hits, or easing peers' view) across the teleport.
    s._posHistory = null;
    p._broadcastPos = null;
    if (s._peerReplayQueue) s._peerReplayQueue.length = 0;
  }
}

// Everything a client must forget when it is re-bootstrapped. The client tears its state down on a
// map change (predictState -> null) and its input-tick numbering restarts from its own reset world
// state; our queue still holds the OLD high water mark, so every new input would be discarded as
// stale by `clientTick <= lastProcessedClientTick` and the player would appear FROZEN server-side
// while moving fine in first person. Clearing it lets the fresh sequence through.
function resetSessionInputStream(session) {
  if (!session) return;
  session.inputQueue = [];
  session.lastProcessedClientTick = -1;
  session.lastClientTick = 0;
  session.pendingFullBootstrap = true;
  // Re-introduce this client's peers once it has finished loading and resumed sending input.
  session._needsPeerReintro = true;
  // Forget when we last drained: the client is about to reload and go quiet, and it must keep
  // receiving authoritative ticks through that window (see the send-rate gate).
  session._lastDrainTick = undefined;
  if (session.playerState) session.playerState._pendingRawFrames = [];
}

function startNewRound(sessions) {
  match.round += 1;
  resetMatchTimer();
  respawnAll(sessions);
  // Nothing cleared thrown entities at a round boundary, so a mine or trip mine planted in round 1
  // was still armed and still killing people in round 2 — and after a map change it sat at
  // coordinates that no longer meant anything. A round is a fresh start for scores and positions; it
  // has to be one for the things people left lying around too.
  clearAllEntities("round start");
  // Cycle the map only at a ROUND boundary. An admin map switch does its own thing.
  const changed = advanceMap();
  if (changed) {
    // A real map change tears the client down (see advanceMap). Every client then needs a COMPLETE
    // first-spawn body — a movement tick body has no weapon/stats/identity and cannot rebuild an
    // entity — and a clean input stream.
    for (const s of sessions.values()) if (s && s.accepted) resetSessionInputStream(s);
    match.reintroTicks = 120;   // re-introduce peers while the new map loads
    console.log(`[evio-local] map CHANGED -> ${currentMapUrl()} (generation ${match.mapGeneration})`);
  }
  console.log(`[evio-local] ── ROUND ${match.round} START ── ${ROUND_TICKS} ticks `
    + `(${(ROUND_TICKS / 20).toFixed(0)}s), stats reset for ${sessions.size} player(s)`);
}

// Advance the match clock one tick. Call once per server tick, before building bodies.
function tickMatch(sessions) {
  if (!ROUNDS_ENABLED) return;
  const wasPlaying = match.gameMode === 0;
  match.timer -= 1;
  if (match.timer <= 0 && wasPlaying) {
    // Round over: switch to the scoreboard phase. The client hides weapons and shows
    // "Next round in X" derived from (400 + Qpm8qez) / matchDuration.
    match.gameMode = ROUND_END_GAMEMODE;
    const board = [...sessions.values()]
      .filter((s) => s && s.accepted && s.playerState)
      .map((s) => `${s.displayName}=${s.playerState.kills || 0}/${s.playerState.deaths || 0}`)
      .join(" ");
    console.log(`[evio-local] ── ROUND ${match.round} OVER ── ${board}`);
  }
  if (match.timer <= -INTERMISSION_TICKS) startNewRound(sessions);

  // ── Peer re-introduction after a map reload ────────────────────────────────────────────────
  // A map reload tears down the client's world, so peers must be re-introduced or they come back
  // as bare objects with no name/weapon/skin (the invisible-peer bug). This used to SPRAY the
  // re-introduction — every player, every 20 ticks, six times — because a loading client ignores
  // state and we could not tell when it finished.
  //
  // Spraying is what produced the health-bar tail: the client appears to build a fresh bar sprite
  // per introduction without disposing the previous one, so up to six overlapping bars piled up.
  // The newest tracks damage; the stale ones sit frozen at the HP they were created with, which
  // reads as a bar that is too long with a red tail that never reduces. It only ever happened
  // after a live map change, which is exactly when this ran.
  //
  // We do not have to guess when a client has finished loading: it tells us by sending input
  // again. So re-introduce EXACTLY ONCE, on the first tick after its input stream resumes.
  if (match.reintroTicks > 0) match.reintroTicks -= 1;
  for (const s of sessions.values()) {
    if (!s || !s.accepted || !s._needsPeerReintro) continue;
    if (!Number.isFinite(s._lastDrainTick)) continue;   // still loading — wait for it
    s._needsPeerReintro = false;
    broadcastPeerSpawn(sessions, s);
  }
}

// ── Scoring (the client's own medal system) ─────────────────────────────────────────────
// Score is awarded by MEDALS, not by a flat per-kill number. `Qmblb53` is the award function:
//
//   var u = medal.Qcqgb7h;                                   // medal base score
//   if (victim.Qcvoys2)              u = round(u * Qtviydn); // victim is a BOT      -> x0.3
//   if (victim.Qqg4dvl === Q4ub80q)  u = round(u * Qeoxvpg); // victim is a GUEST    -> x0.3
//   killer.Qty774u.score += u;
//
// and a suicide is `killStats.score = Math.max(score - 100, 0)` (Qtof6zw).
//
// Extracted medal base scores (Qcqgb7h): kill 100 · headshot 10 · doublekill 20 · multikill 45 ·
// ultrakill 80 · monsterkill 130 · killingspree 40 · rampage 80 · dominating 120 · unstoppable 160 ·
// godlike 220 · sword 20 · longshot 10 · grave 15 · usurper 25 · frag/mine/tripmine/sticky 10.
// We implement the ones our combat model can attribute today: the base kill, the headshot bonus,
// and the sword/grenade weapon medals. Streaks/multikills need kill-time bookkeeping and are left
// out rather than approximated wrongly.
const MEDAL_SCORE = {
  kill: 100, headshot: 10, sword: 20, sticky: 10, frag: 10, mine: 10, tripmine: 10, longshot: 10,
  assist: 10,   // Qkkc81w.Qn4okig.Qcqgb7h
  grave: 15, noscope: 20, usurper: 25,
  // Multikill: consecutive kills inside MULTIKILL_WINDOW (Qr5ahev = 2/3/4/5).
  double: 20, multi: 45, ultra: 80, monster: 130,
  // Killstreak: kills without dying (Qcgghzr = 5/10/15/20/25).
  spree: 40, rampage: 80, dominating: 120, unstoppable: 160, godlike: 220,
};

// Multikill counts consecutive kills closer together than this. Bundle Vh.Qph2e3n = 120 ticks (6s).
const MULTIKILL_WINDOW = 120;
// Longshot distance, Qkkc81w.Qwuvmcb.Qyz05ae.
const LONGSHOT_DISTANCE = 65;
// Below this impact speed (client units, u/tick) a grenade is resting, not bouncing. Matches the
// client's own ring threshold (bundle :50831 requires Qxxwo42 > 0.5), so anything that would not
// have rung is treated as a settle rather than inflating the bounce counter.
const GRENADE_SETTLE_SPEED = 0.5;
// Kill count -> multikill / killstreak medal, from Qr5ahev / Qcgghzr in the table.
const MULTIKILL_MEDAL = { 2: "double", 3: "multi", 4: "ultra", 5: "monster" };
const STREAK_MEDAL = { 5: "spree", 10: "rampage", 15: "dominating", 20: "unstoppable", 25: "godlike" };

// Our medal names -> the client's Qkkc81w keys. The client identifies a medal by this STRING
// (Qwhr325), and uses it to pick the popup text and icon; every score below was cross-checked
// against Qkkc81w.<key>.Qcqgb7h and matches MEDAL_SCORE exactly.
const MEDAL_KEY = {
  kill:     "Qwhr33n",   // + 1 Kill            100
  headshot: "Qh04ltj",   // Headshot             10
  sword:    "Qcq3jgy",   // Sword Kill           20
  sticky:   "Qvnv1p4",   // Sticky Grenade Kill  10
  frag:     "Qwhu3mn",   // Frag Grenade Kill    10
  mine:     "Qwhpt32",   // Mine Kill            10
  tripmine: "Qqfl31j",   // Trip Mine Kill       10
  longshot: "Qwuvmcb",   // Longshot             10
  assist:   "Qn4okig",   // Assist               10
  grave:    "Qcwsjt6",   // Kill From The Grave  15
  noscope:  "Ql8t342",   // Noscope Kill         20
  usurper:  "Qc74s4x",   // Usurper              25
  double:   "Qlnn3me",   // Double Kill          20
  multi:    "Qlnn3md",   // Multi Kill           45
  ultra:    "Qlnn3mc",   // Ultra Kill           80
  monster:  "Qlnn3mb",   // Monster Kill        130
  spree:    "Qvltnhr",   // Killing Spree        40
  rampage:  "Qen1jff",   // Rampage              80
  dominating: "Qen1jfa", // Dominating          120
  unstoppable: "Qen1jek",// Unstoppable         160
  godlike:  "Qen1jef",   // Godlike             220
};

// Medals awarded this tick, drained into the playerMap block by buildPlayerMapBlock.
// Scoring alone was never enough: the client shows a medal only when it receives the EVENT, which
// is why score was counting up while nothing popped on screen.
const _pendingMedals = [];
let _medalSeq = 0;

// Queue one medal for `recipient`. `points` is the already-multiplied score so the popup shows the
// same number that was added to the scoreboard.
function awardMedal(recipient, medalName, points) {
  const key = MEDAL_KEY[medalName];
  if (!recipient || !key) return;
  // The recipient MUST be the id the client keys players by — the same value used for the 244
  // player block. That is `_ownerSid`; playerState has no `.id`, and sending undefined here made
  // every medal unmatched, so nothing ever rendered while the score still went up.
  const rid = recipient._ownerSid;
  if (rid == null) return;
  // Capped like _pendingBullets. Medals are cleared every tick after the broadcast, so this is only
  // reachable if the broadcast stops happening — but that is exactly when an uncapped array grows
  // without limit, and the oldest medals are the least worth keeping.
  if (_pendingMedals.length > 256) _pendingMedals.splice(0, _pendingMedals.length - 256);
  _pendingMedals.push({
    id: "m" + (_medalSeq++),
    recipient: rid,
    medal: key,
    points: Math.round(points) | 0,
  });
}
const GUEST_UID = 17;              // Mh.Q4b9iia.Q4ub80q
const SUICIDE_PENALTY = 100;

// Official ev.io pays 0.3x for killing a BOT (Qtviydn) and 0.3x for killing a GUEST (Qeoxvpg).
//
// The guest penalty makes sense on the public game, where it exists to stop people farming score off
// throwaway accounts. On a private server among friends it just means the players who did not sign in
// are worth a third as much, which is a strange thing to ask of someone you invited — so the default
// here is 1.0 and every player is worth the same. The bot multiplier keeps the official 0.3: killing
// a bot genuinely should not pay like killing a person.
//
// This reaches the HUD as well as the scoreboard. The medal points travel on the wire (opcode 74
// field 73 = Qflcwh7) and the client's score popup sums the value WE send (bundle :63710), so the
// "+100" a player sees and the number added to their score are the same number.
let SCORE_MULT_GUEST = S.define({
  key: "guestScoreMultiplier", env: "EVIO_GUEST_SCORE_MULT", type: "number", def: 1,
  min: 0, max: 5, step: 0.05,
  category: "Gameplay", label: "Score multiplier for killing a guest",
  desc: "Official ev.io uses 0.3 to stop score farming off throwaway accounts. 1 = a guest is worth "
      + "exactly as much as a signed-in player, which is usually what you want on a private server.",
}, (v) => { SCORE_MULT_GUEST = v; });
let SCORE_MULT_BOT = S.define({
  key: "botScoreMultiplier", env: "EVIO_BOT_SCORE_MULT", type: "number", def: 0.3,
  min: 0, max: 5, step: 0.05,
  category: "Gameplay", label: "Score multiplier for killing a bot",
  desc: "Official ev.io value is 0.3 (Q4b9iia.Qtviydn). Separate from the guest multiplier — making "
      + "guests fair is not a reason to pay full price for a bot.",
}, (v) => { SCORE_MULT_BOT = v; });

// Score for one medal against `victim`. Rounds AFTER each multiply, matching Math.round in Qmblb53 —
// the two multipliers compound for a victim that is both, exactly as the client does it.
function medalScore(medalKey, victim, victimUid) {
  let u = MEDAL_SCORE[medalKey] || 0;
  if (victim && victim.isBot && SCORE_MULT_BOT !== 1) u = Math.round(u * SCORE_MULT_BOT);
  if (victimUid === GUEST_UID && SCORE_MULT_GUEST !== 1) u = Math.round(u * SCORE_MULT_GUEST);
  return u;
}

// Credit a kill. `attacker` may be null (fall damage, world kills) — then only the death counts.
// `opts` carries what the medal rules need: {headshot, weaponMedal, victimUid}.
// ── Assists (bundle Q6q147v, :33538-33547) ──────────────────────────────────────────────────
// An assist goes to every player who damaged the victim within the last ASSIST_WINDOW ticks,
// EXCLUDING the victim and whoever landed the kill:
//
//   var s = worldTick - 100, l = damageLog(victim).Qny6qak;
//   for (var u in l) if (u !== victim.id && u !== killerId && l[u] >= s) { medal(assist); assists++ }
//
// So it is purely "did you hurt them recently", with no damage threshold — one pistol shot inside
// the window counts. Each qualifying player gets one assist and the 10-point Assist medal.
let ASSIST_WINDOW = S.define({
  key: "assistWindowTicks", env: "EVIO_ASSIST_WINDOW", type: "int", def: 100, min: 0, max: 600,
  category: "Combat", label: "Assist window (ticks)",
  desc: "How long damage still counts toward an assist. Bundle uses worldTick - 100 (5s at 20Hz).",
}, (v) => { ASSIST_WINDOW = v; });

// Remember who hurt this player and when. Keyed by the attacker's playerState so the lookup needs
// no session plumbing; the tick is the server tick the damage landed on.
function recordDamager(victim, attacker) {
  if (!victim || !attacker || attacker === victim) return;
  if (!victim._damagedBy) victim._damagedBy = new Map();
  victim._damagedBy.set(attacker, _live.globalTick || 0);
}

// Award assists for a death. Called BEFORE creditKill so the killer is already known but the
// scoreboard has not been touched yet.
function awardAssists(victim, killer) {
  if (!victim || !victim._damagedBy) return 0;
  const now = _live.globalTick || 0;
  const cutoff = now - ASSIST_WINDOW;
  let n = 0;
  for (const [attacker, tick] of victim._damagedBy) {
    if (attacker === victim || attacker === killer) continue;   // the client excludes both
    if (tick < cutoff) continue;                                // damage too long ago
    attacker.assists = (attacker.assists || 0) + 1;
    const pts = medalScore("assist", victim, victim.uid);
    attacker.score = (attacker.score || 0) + pts;
    awardMedal(attacker, "assist", pts);
    n++;
  }
  victim._damagedBy.clear();   // the log is per-life
  return n;
}

function creditKill(attacker, victim, opts) {
  const o = opts || {};
  if (victim) victim.deaths = (victim.deaths || 0) + 1;
  if (!attacker) return;
  if (attacker === victim) {
    // Suicide: -100, floored at 0 (client: Math.max(score - 100, 0)). No kill credited.
    victim.score = Math.max((victim.score || 0) - SUICIDE_PENALTY, 0);
    return;
  }
  attacker.kills = (attacker.kills || 0) + 1;
  // Each medal is awarded AND announced separately — the client pops one per event, so folding
  // them into a single total would show one medal instead of "+1 Kill" followed by "Headshot".
  const killPts = medalScore("kill", victim, o.victimUid);
  let gained = killPts;
  awardMedal(attacker, "kill", killPts);
  if (o.headshot) {
    const hs = medalScore("headshot", victim, o.victimUid);
    gained += hs;
    awardMedal(attacker, "headshot", hs);
  }
  if (o.weaponMedal && MEDAL_SCORE[o.weaponMedal]) {
    const wm = medalScore(o.weaponMedal, victim, o.victimUid);
    gained += wm;
    awardMedal(attacker, o.weaponMedal, wm);
  }

  // Conditional medals, each straight from the bundle's award block.
  const add = (name) => {
    const pts = medalScore(name, victim, o.victimUid);
    gained += pts;
    awardMedal(attacker, name, pts);
  };

  // Longshot: far enough away, and not a placed explosive (mines are excluded there).
  if (o.dist >= LONGSHOT_DISTANCE && !o.placedExplosive) add("longshot");

  // Kill From The Grave: the killer was already dead when the damage landed.
  if (attacker.healthPoints <= 0) add("grave");

  // Noscope: a scoped weapon fired unscoped. Melee is excluded (the sword also sets
  // noDefaultCrosshair), as is anyone actually aiming down sights.
  if (o.noDefaultCrosshair && !o.melee && !o.zooming) add("noscope");

  // Usurper: the victim was the kill leader, and it takes more than 2 players to count.
  if (o.victimWasLeader && o.playerCount > 2) add("usurper");

  // Multikill: kills chained inside the window. Only exact counts have a medal, so a 6th kill in
  // the chain announces nothing — matching `y.Qr5ahev === i.Q5l0v64`.
  const mk = MULTIKILL_MEDAL[attacker.multiKill];
  if (mk) add(mk);

  // Killstreak: kills without dying, again only on the exact milestones.
  attacker.killStreak = (attacker.killStreak || 0) + 1;
  const sk = STREAK_MEDAL[attacker.killStreak];
  if (sk) add(sk);

  attacker.score = (attacker.score || 0) + gained;
}

// ── Live status feed for the admin UI ────────────────────────────────────────────────────
// startServer keeps `sessions` in its closure; the admin server needs a read-only window onto
// it. Rather than hoisting the map to module scope (and risking accidental writes from
// elsewhere), we publish a handle here and expose it through getStatus()/adminAction() only.
const _live = { sessions: null, startedAt: 0, globalTick: 0, tickStamps: [], draining: false };

// ── Bot count / level settings ────────────────────────────────────────────────────────────────
// Placed HERE (after _live, not up with HOST/TICK_MS near the top) on purpose: S.define invokes its
// callback once immediately to establish the initial value, and reconcileBotCount below reads
// _live.spawnBot/_live.listBots — defining these before `_live` exists would throw a
// ReferenceError on module load, since `const _live` is in the temporal dead zone until this line.
//
// Reconciliation only runs once the server has actually started (_live.spawnBot is set by
// startServer — see the "Bots" section). A value applied before that (env var, or a saved
// settings.local.json loaded at require time) is picked up by the one-time reconcileBotCount()
// call after startServer() in the require.main bootstrap at the bottom of this file — the same
// two-step pattern startupMap already uses for the same reason (nothing exists yet to apply it to).
// Recomputes the live count on EVERY iteration rather than fixing a loop bound up front —
// required for reentrancy, not just defensive: spawnBot() itself calls maybeStartGameLoop(),
// which (see that function's own comment) calls this same reconciler again to re-apply the
// configured count whenever the loop (re)starts. The FIRST bot this function spawns, starting
// from a stopped loop, triggers exactly that nested call mid-loop — confirmed live as 3 bots
// spawned for a target of 2 before this fix, because a fixed "spawn want-have times" bound has
// no way to notice a nested call already reached the target.
function reconcileBotCount() {
  if (!_live.spawnBot) return;
  // Only the plain gun-bot pool — sword bots are a SEPARATE count (reconcileSwordBotCount), each
  // reconciler must only ever spawn/remove from its own kind or the two counts fight each other.
  const liveBots = () => _live.listBots().filter((b) => !b.isSwordBot);
  while (liveBots().length < BOT_COUNT) _live.spawnBot({ level: BOT_LEVEL });
  const excess = liveBots().length - BOT_COUNT;
  if (excess > 0) {
    // Map iteration order is insertion order, so slice(want) is the MOST RECENTLY added bots —
    // removing those (not an arbitrary or oldest pick) leaves the longest-running bots undisturbed
    // when an admin dials the count down.
    for (const b of liveBots().slice(BOT_COUNT)) _live.removeBot(b.playerId);
  }
}

// Same reconciliation shape as reconcileBotCount, filtered to the sword-only pool instead — and its
// OWN difficulty level (SWORD_BOT_LEVEL), independent of the plain gun-bot pool's BOT_LEVEL.
function reconcileSwordBotCount() {
  if (!_live.spawnBot) return;
  const liveBots = () => _live.listBots().filter((b) => b.isSwordBot);
  while (liveBots().length < SWORD_BOT_COUNT) _live.spawnBot({ level: SWORD_BOT_LEVEL, swordOnly: true });
  const excess = liveBots().length - SWORD_BOT_COUNT;
  if (excess > 0) {
    for (const b of liveBots().slice(SWORD_BOT_COUNT)) _live.removeBot(b.playerId);
  }
}

let BOT_COUNT = S.define({
  key: "botCount", env: "EVIO_BOT_COUNT", type: "int", def: 0, min: 0, max: 24,
  category: "Bots", label: "Bot count",
  desc: "Target number of bots kept in the lobby. Raising it spawns the difference immediately; "
      + "lowering it removes the most-recently-added bots first. Applied live — no restart needed. "
      + "Independent of swordBotCount below — the two pools never touch each other.",
}, (v) => { BOT_COUNT = v; reconcileBotCount(); });

let SWORD_BOT_COUNT = S.define({
  key: "swordBotCount", env: "EVIO_SWORD_BOT_COUNT", type: "int", def: 0, min: 0, max: 24,
  category: "Bots", label: "Sword bot count",
  desc: "Target number of SWORD-ONLY bots kept in the lobby, independent of botCount. These bots "
      + "carry nothing but the sword, rush their target instead of planting and shooting from range, "
      + "and use the real Teleport ability (3 charges) plus the Impulse ability once wounded — see "
      + "_swordCombatFrame. Raising/lowering applies live, same as botCount.",
}, (v) => { SWORD_BOT_COUNT = v; reconcileSwordBotCount(); });

let BOT_LEVEL = S.define({
  key: "botLevel", env: "EVIO_BOT_LEVEL", type: "int", def: 5, min: 1, max: 10,
  category: "Bots", label: "Gun bot level (1-10)",
  desc: "Difficulty for PLAIN GUN bots spawned by botCount, matching the official Bot Level slider — "
      + "independent of swordBotLevel below. Applied live to every EXISTING gun bot too, not just "
      + "future spawns. Scales combat SKILL only (reaction time, aim cone, turn rate, fire "
      + "discipline) — never HP, damage, or movement speed.",
}, (v) => {
  BOT_LEVEL = v;
  if (_live.listBots) for (const b of _live.listBots()) if (!b.isSwordBot) b.botLevel = v;
});

let SWORD_BOT_LEVEL = S.define({
  key: "swordBotLevel", env: "EVIO_SWORD_BOT_LEVEL", type: "int", def: 5, min: 1, max: 10,
  category: "Bots", label: "Sword bot level (1-10)",
  desc: "Difficulty for SWORD-ONLY bots spawned by swordBotCount, independent of botLevel above (a "
      + "lobby can run easy gun bots alongside sharp sword bots, or vice versa). Applied live to "
      + "every EXISTING sword bot too, not just future spawns. Scales the same combat SKILL axes as "
      + "botLevel (reaction time, aim cone, turn rate, fire discipline) — a sword bot's teleport/"
      + "impulse/grenade TACTICS are not level-gated (see _swordCombatFrame and the separate "
      + "swordBotImpulseEnabled/swordBotGrenadesEnabled toggles) — only how sharply it aims and "
      + "reacts is.",
}, (v) => {
  SWORD_BOT_LEVEL = v;
  if (_live.listBots) for (const b of _live.listBots()) if (b.isSwordBot) b.botLevel = v;
});

// ── Rolling metrics history (for the dashboard's graphs) ─────────────────────
// getStatus() is an instantaneous snapshot, so the dashboard could only ever show "now" — useless
// for the things that actually go wrong here, which are all TRENDS: a tick rate that sags to 16Hz
// under load (the Windows timer-granularity fault), jitter spikes, a reconcile lag that creeps up
// over a session, an input queue that grows. One sample per second for 5 minutes is enough to see
// all of those and costs a few KB.
const METRICS_HZ = 1;
const METRICS_KEEP = 300;                    // 5 minutes at 1 Hz
const _metrics = { hist: [], lastAt: 0, lastSim: 0, lastTick: 0 };

function sampleMetrics(now) {
  if (now - _metrics.lastAt < 1000 / METRICS_HZ) return;
  _metrics.lastAt = now;

  // Tick rate + jitter from the retained stamps. Jitter is the worst deviation from the target
  // period in the window — a mean would hide exactly the intermittent stalls we care about.
  const st = _live.tickStamps;
  let rate = 0, jitter = 0;
  if (st.length >= 2) {
    const span = (st[st.length - 1] - st[0]) / 1000;
    if (span > 0) rate = (st.length - 1) / span;
    for (let i = 1; i < st.length; i++) {
      const d = Math.abs((st[i] - st[i - 1]) - TICK_MS);
      if (d > jitter) jitter = d;
    }
  }

  // Worst reconcile lag and deepest input queue across players: one bad client is the interesting
  // case, so take the max rather than an average that would dilute it away.
  let lag = 0, queued = 0, players = 0;
  for (const [, s] of _live.sessions || []) {
    if (!s || !s.playerState) continue;
    players++;
    if (Number.isFinite(s.lastClientTick) && Number.isFinite(s.lastProcessedClientTick)) {
      const d = s.lastClientTick - s.lastProcessedClientTick;
      if (d > lag) lag = d;
    }
    const q = Array.isArray(s.inputQueue) ? s.inputQueue.length : 0;
    if (q > queued) queued = q;
  }

  // Errors as PER-SAMPLE deltas: a cumulative counter drawn as a graph is a staircase that never
  // comes down, so a burst two minutes ago looks identical to one happening right now.
  const simTotal = _live.simErrors || 0, tickTotal = _live.tickErrors || 0;
  const errs = (simTotal - _metrics.lastSim) + (tickTotal - _metrics.lastTick);
  _metrics.lastSim = simTotal; _metrics.lastTick = tickTotal;

  _metrics.hist.push({
    t: now,
    rate: +rate.toFixed(2),
    jitter: +jitter.toFixed(1),
    players,
    lag,
    queued,
    errs: Math.max(0, errs),
  });
  if (_metrics.hist.length > METRICS_KEEP) _metrics.hist.shift();
}

/** Snapshot of everything the dashboard shows. Read-only — never hands out live objects. */
function getStatus() {
  const now = Date.now();
  // Measured tick rate over the retained window (up to 120 ticks ≈ 6s at 20Hz).
  let tickRate = 0;
  const st = _live.tickStamps;
  if (st.length >= 2) {
    const span = (st[st.length - 1] - st[0]) / 1000;
    if (span > 0) tickRate = (st.length - 1) / span;
  }
  const players = [];
  for (const [id, s] of _live.sessions || []) {
    const p = s.playerState;
    if (!p) continue;
    players.push({
      sessionId: id,
      playerId: s.playerId ?? null,
      name: s.displayName || null,
      uid: s.uid ?? null,
      accepted: !!s.accepted,
      isBot: !!s.isBot,
      isSwordBot: !!s.isSwordBot,
      // The RESOLVED address (see _resolveRemoteIp) — behind Caddy in production this is the real
      // player's own address, not Caddy's loopback one, which is what maxConnectionsPerIp and
      // maxConnAttemptsPerMin actually key on. Useful for moderation/debugging directly from the
      // dashboard, and it's how this fix itself was verified live.
      remoteIp: s.remoteIp || null,
      connectedMs: s.connectedAt ? now - s.connectedAt : null,
      position: p.position ? { x: +p.position.x.toFixed(2), y: +p.position.y.toFixed(2), z: +p.position.z.toFixed(2) } : null,
      // What peers actually receive on the wire (see updateBroadcastPosition / _cachedPlayerBlock's
      // "peer" variant) — NOT the same as `position` above, which is the true authoritative value
      // self/lag-comp use. Exposed for diagnosing peer-smoothing live without a client capture.
      broadcastPos: p._broadcastPos ? { x: +p._broadcastPos.x.toFixed(2), y: +p._broadcastPos.y.toFixed(2), z: +p._broadcastPos.z.toFixed(2) } : null,
      // Adaptive peer-smoothing signal (see peerSmoothCapFor): 1 = perfectly smooth uplink, higher =
      // recently bursty. effectiveSmoothCap is what THIS player's peers are currently being smoothed at.
      burstLevel: Number.isFinite(s._burstLevel) ? +s._burstLevel.toFixed(2) : 1,
      effectiveSmoothCap: +peerSmoothCapFor(s).toFixed(1),
      // Depth of the peer-replay backlog (see popReplayTarget) — how many real ticks' worth of this
      // player's true-speed motion peers are currently that many ticks behind on. Should hover near 0
      // for a stable connection and only grow during an actual burst.
      peerReplayQueueDepth: Array.isArray(s._peerReplayQueue) ? s._peerReplayQueue.length : 0,
      velocity: p.velocity ? { x: +p.velocity.x.toFixed(2), y: +p.velocity.y.toFixed(2), z: +p.velocity.z.toFixed(2) } : null,
      speed: p.velocity ? +Math.hypot(p.velocity.x, p.velocity.z).toFixed(2) : null,
      yaw: Number.isFinite(p.yaw) ? +p.yaw.toFixed(3) : null,
      pitch: Number.isFinite(p.pitch) ? +p.pitch.toFixed(3) : null,
      grounded: !!p.grounded,
      sprinting: !!p.sprinting,
      crouching: !!p.crouching,
      health: Number.isFinite(p.healthPoints) ? +p.healthPoints.toFixed(3) : null,
      armor: Number.isFinite(p.armorPoints) ? +p.armorPoints.toFixed(3) : null,
      dead: (p.deathStateTimer > 0 || p.healthPoints <= 0),
      weapon: p.equippedWeaponId ?? null,
      weaponList: Array.isArray(p.weaponList) ? p.weaponList.slice() : [],
      ammo: Number.isFinite(p.gunAmmo) ? p.gunAmmo : null,
      reloadTicks: p.reloadTicks || 0,
      actionTickCounter: p.actionTickCounter ?? null,
      kills: p.kills | 0,
      deaths: p.deaths | 0,
      score: p.score | 0,
      // "extracted" = the bundle's own g(). "legacy" = the hand-rolled fallback, which ground-snaps
      // to the heightmap and will diverge from the client on slopes.
      physicsPath: p._physicsPath || "(not yet ticked)",
      lastClientTick: s.lastClientTick ?? null,
      // What we echo back — the gap between this and lastClientTick IS the reconcile lag.
      processedClientTick: s.lastProcessedClientTick ?? null,
      queuedInputs: Array.isArray(s.inputQueue) ? s.inputQueue.length : null,
      // Outbound health. bufferedAmount is the direct read on whether a client is DRAINING what we
      // send; a number that climbs and stays up is the signature of a connection that looks fine (it
      // answers pings) while receiving state that is seconds stale. skips/sendErrors say whether we
      // acted on it.
      sendBuffered: s.ws ? (s.ws.bufferedAmount || 0) : null,
      sendSkips: s._backpressureSkips || 0,
      sendErrors: s._sendErrors || 0,
      idleTicks: s._idleTicks || 0,
      // Non-zero means THIS player's sim threw and was contained. Their physics lost a tick, so a
      // desync that affects one player while everyone else is fine will show up here.
      simErrors: s._simErrors || 0,
      // Input accounting: how much of the client's rotation actually reached the sim. lookKept
      // well under 1.0 means the server is turning less far than the client, and lostBy names the
      // discard path responsible.
      lookKept: s._lookRecv ? +(1 - (s._lookLost || 0) / s._lookRecv).toFixed(4) : null,
      // Fraction of RECEIVED rotation that actually reached the simulation. lookKept can be 1.0
      // (nothing discarded on ingest) while this is well below 1.0 — that means sub-frames are
      // being queued and then never folded, which is a completely different fault.
      lookApplied: s._lookRecv && s.playerState
        ? +((s.playerState._lookApplied || 0) / s._lookRecv).toFixed(4) : null,
      lookLost: +(s._lookLost || 0).toFixed(3),
      // Rotation that arrived AFTER its tick was simulated and was carried into the next one. At
      // inputBufferDepth 0 this is the cost of dropping the buffer: the input is not lost, but it
      // lands a tick late, so with reconciliation ON each carried frame can produce a correction.
      // Near zero means depth 0 is genuinely free for this client's send pattern; climbing means
      // the client is splitting ticks across packets often enough that a depth of 1 may feel better.
      lookCarried: +(s._lookCarried || 0).toFixed(3),
      carriedPending: Array.isArray(s._carryFrames) ? s._carryFrames.length : 0,
      lostBy: s._lostBy || null,
      // Broadcasts suppressed because no client tick was drained — see the send-rate gate.
      idleSends: s._idleSends || 0,
    });
  }
  return {
    now,
    uptimeMs: _live.startedAt ? now - _live.startedAt : 0,
    listening: _live.startedAt ? `ws://${HOST}:${PORT}` : null,
    globalTick: _live.globalTick,
    tickRate: +tickRate.toFixed(2),
    targetTickRate: +(1000 / TICK_MS).toFixed(2),
    tickScheduler: TICK_SCHEDULER,
    playerCount: players.length,
    swordOnly: SWORD_ONLY,
    // Round state for the dashboard: seconds remaining (negative = intermission).
    round: match.round,
    map: bpw.activeMapName,
    mapGeneration: match.mapGeneration,
    roundPhase: match.gameMode === 0 ? "playing" : "intermission",
    roundSecondsLeft: +(match.timer / Math.max(1, Math.round(1000 / TICK_MS))).toFixed(1),
    tickModel: TICK_MODEL,
    echoLagTicks: ECHO_LAG_TICKS,
    // Fault counters. A non-zero value here means a tick or a player's sim threw and was contained
    // — the server keeps running, but something is wrong and the message says what.
    // Refusing new joins ahead of a SIGTERM-triggered exit (see beginGracefulShutdown) — surfaced
    // here so external monitoring (health_server.js) can report "degraded, restarting" rather than
    // "down" during a normal deploy's drain window.
    draining: !!_live.draining,
    tickErrors: _live.tickErrors || 0,
    // Tick-budget health. tickOverruns rising is the earliest warning of overload — it climbs before
    // the measured tickRate visibly falls, because a few slow ticks are absorbed by the scheduler.
    tickOverruns: _live.tickOverruns || 0,
    tickMsLast: _live.tickMsLast || 0,
    tickMsWorst: _live.tickMsWorst || 0,
    tickBudgetMs: TICK_MS,
    // Per-tick player-block cache health (see _cachedPlayerBlock). For N accepted players sharing
    // one tick, misses should trend toward N (one build per player) and hits toward the rest of the
    // N*(N-1) total lookups — a rising miss-per-tick figure with players otherwise stable would mean
    // the cache is being invalidated more than once a tick somewhere, which would silently undo the
    // optimisation without breaking anything visibly.
    playerBlockCacheHits: _live.playerBlockCacheHits || 0,
    playerBlockCacheMisses: _live.playerBlockCacheMisses || 0,
    lastTickError: _live.lastTickError || null,
    // Per-phase fault counts, e.g. { deathRespawn: 3 }. A contained fault must still be VISIBLE — an
    // isolation guard that hides its own bug is worse than no guard, which is what happened when the
    // entity isolation masked an out-of-scope variable and silently deleted every grenade instead.
    phaseErrors: _live.phaseErrors || {},
    simErrors: _live.simErrors || 0,
    lastSimError: _live.lastSimError || null,
    // Rolling 5-minute history at 1 Hz for the dashboard graphs. The faults that matter here are
    // trends (tick rate sagging, jitter spikes, reconcile lag creeping up), which a snapshot cannot
    // show. Sent whole so a freshly-opened dashboard has history immediately instead of having to
    // sit there accumulating it.
    history: _metrics.hist,
    players,
  };
}

/** Admin operations on a live player. Returns {ok} or {ok:false, err}. */
function adminAction(sessionId, action, arg) {
  const s = _live.sessions && _live.sessions.get(sessionId);
  if (!s) return { ok: false, err: `no such session: ${sessionId}` };
  const p = s.playerState;
  switch (action) {
    case "kick":
      // A bot has no socket to close — "kicked by admin" for a bot means actually removing the
      // session, the same thing removeBot does for the dashboard's own bot controls. Without this
      // branch the button silently did nothing: s.ws is null, so the guarded close() below is a
      // no-op and the bot (which never gets a 'close' event to remove itself on) just kept fighting.
      if (s.isBot) {
        if (_live.removeBot) _live.removeBot(sessionId);
        // botCount/swordBotCount are MAINTAINED targets, not one-time spawn counts (see their
        // descriptions) — kicking one bot below its target should backfill a fresh one of the SAME
        // kind, the same as the count never having dropped. Calling both is harmless: each only ever
        // looks at its own subset, so whichever one didn't change is a no-op.
        reconcileBotCount();
        reconcileSwordBotCount();
        console.log(`[admin] kicked (removed) bot ${sessionId}`);
        return { ok: true };
      }
      try { s.ws && s.ws.close(4000, "kicked by admin"); } catch (_) {}
      console.log(`[admin] kicked ${sessionId}`);
      return { ok: true };
    case "kill":
      if (!p) return { ok: false, err: "no player state" };
      p.healthPoints = 0;
      if (p.deathStateTimer <= 0) p.deathStateTimer = 1;
      console.log(`[admin] killed ${sessionId}`);
      return { ok: true };
    case "heal":
      if (!p) return { ok: false, err: "no player state" };
      p.healthPoints = 1; p.armorPoints = 0;
      console.log(`[admin] healed ${sessionId}`);
      return { ok: true };
    case "teleport": {
      if (!p) return { ok: false, err: "no player state" };
      const spawns = activeSpawnPoints();
      const idx = Number.isFinite(Number(arg)) ? Math.abs(Math.round(Number(arg))) % spawns.length : 0;
      const sp = spawns[idx];
      if (!sp) return { ok: false, err: "no spawn points" };
      p.position.x = sp.x; p.position.y = sp.y; p.position.z = sp.z;
      p.velocity.x = 0; p.velocity.y = 0; p.velocity.z = 0;
      if (p._ps) {
        p._ps.Qdsukt4.x = sp.x; p._ps.Qdsukt4.y = sp.y; p._ps.Qdsukt4.z = sp.z;
        p._ps.Qyaswvo.x = 0; p._ps.Qyaswvo.y = 0; p._ps.Qyaswvo.z = 0;
      }
      // An admin teleport is exactly as instant as a portal or a respawn — drop both the lag-comp
      // history and the peer-broadcast smoothing state so neither bridges across it.
      s._posHistory = null;
      p._broadcastPos = null;
      if (s._peerReplayQueue) s._peerReplayQueue.length = 0;
      console.log(`[admin] teleported ${sessionId} to spawn ${idx}`);
      return { ok: true, spawn: idx };
    }
    case "respawn":
      if (!p) return { ok: false, err: "no player state" };
      p.deathStateTimer = 0;
      respawnPlayerNow(p);
      console.log(`[admin] respawned ${sessionId}`);
      return { ok: true };
    case "slap": {
      // A shove, not a kill — the same impulse path a grenade uses, so the client reconciles it the
      // way it reconciles any other knockback rather than snapping.
      if (!p) return { ok: false, err: "no player state" };
      const power = Math.min(60, Math.max(1, Number(arg) || 18));
      const ang = Math.random() * Math.PI * 2;
      const vx = Math.cos(ang) * power * 0.35, vz = Math.sin(ang) * power * 0.35;
      p.velocity.x += vx; p.velocity.y += power; p.velocity.z += vz;
      if (p._ps && p._ps.Qyaswvo) {
        p._ps.Qyaswvo.x += vx; p._ps.Qyaswvo.y += power; p._ps.Qyaswvo.z += vz;
        p._ps.Q9t2fit = false;   // airborne, or the ground check cancels it on the same tick
      }
      requestReconcile(p, 2);
      console.log(`[admin] slapped ${sessionId} (${power})`);
      return { ok: true, power };
    }
    case "sethealth": {
      if (!p) return { ok: false, err: "no player state" };
      const hp = Math.min(1, Math.max(0.01, Number(arg) || 1));   // normalised 0..1
      p.healthPoints = hp;
      if (p._ps) p._ps.Qq7zdfv = hp * ((p._ps.Qz8l93a && p._ps.Qz8l93a.Qtgt1xt) || 1);
      return { ok: true, health: hp };
    }
    default:
      return { ok: false, err: `unknown action: ${action}` };
  }
}

/**
 * Server-wide admin operations — the things that act on the match rather than one player.
 * Kept beside adminAction so both share the same "return {ok} or {ok:false,err}" contract and the
 * dashboard can treat them identically.
 */
function adminServerAction(action, arg) {
  const sessions = _live.sessions || new Map();
  const players = [...sessions.values()].filter((s) => s && s.playerState);
  switch (action) {
    case "announce": {
      // Goes through the SAME escaping as player chat. The client renders chat with innerHTML, so an
      // unescaped announcement would be script injection into every connected browser — and this
      // endpoint is reachable by anyone who can reach the dashboard.
      const text = String(arg == null ? "" : arg).trim().slice(0, 200);
      if (!text) return { ok: false, err: "empty announcement" };
      broadcastChat(sessions, { from: "SERVER", msg: escapeChatHtml(text) });
      console.log(`[admin] announced: ${text}`);
      return { ok: true, sent: players.length };
    }
    case "healall":
      for (const s of players) { s.playerState.healthPoints = 1; s.playerState.armorPoints = 0; }
      return { ok: true, affected: players.length };
    case "killall":
      for (const s of players) {
        const p = s.playerState;
        p.healthPoints = 0;
        if (p.deathStateTimer <= 0) p.deathStateTimer = 1;
      }
      return { ok: true, affected: players.length };
    case "respawnall":
      for (const s of players) { s.playerState.deathStateTimer = 0; respawnPlayerNow(s.playerState); }
      return { ok: true, affected: players.length };
    case "slapall": {
      let n = 0;
      for (const s of players) { adminAction(s.sessionId, "slap", arg); n++; }
      return { ok: true, affected: n };
    }
    case "gather": {
      // Everyone to one point — the named player's position, or spawn 0. Good for starting a duel,
      // taking a screenshot, or herding everyone somewhere to try something out.
      const target = players.find((s) => s.sessionId === arg || s.displayName === arg);
      let at;
      if (target) at = { x: target.playerState.position.x, y: target.playerState.position.y, z: target.playerState.position.z };
      else { const sp = activeSpawnPoints()[0]; if (!sp) return { ok: false, err: "no spawn points" }; at = sp; }
      // Divide by the number of players actually being MOVED, not one less. With two movers the old
      // `length - 1` divisor produced angles 0 and 2π — the same direction — so they landed inside
      // one another, which is the exact thing the ring exists to prevent.
      const movers = players.filter((s) => !(target && s === target)).length;
      let n = 0;
      for (const s of players) {
        if (target && s === target) continue;
        const p = s.playerState;
        // Fan out so players do not all land inside one another.
        const a = (n / Math.max(1, movers)) * Math.PI * 2;
        p.position.x = at.x + Math.cos(a) * 3; p.position.y = at.y + 1; p.position.z = at.z + Math.sin(a) * 3;
        p.velocity.x = 0; p.velocity.y = 0; p.velocity.z = 0;
        if (p._ps) {
          p._ps.Qdsukt4.x = p.position.x; p._ps.Qdsukt4.y = p.position.y; p._ps.Qdsukt4.z = p.position.z;
          p._ps.Qyaswvo.x = 0; p._ps.Qyaswvo.y = 0; p._ps.Qyaswvo.z = 0;
        }
        requestReconcile(p, 2);
        n++;
      }
      return { ok: true, affected: n, at: { x: +at.x.toFixed(1), y: +at.y.toFixed(1), z: +at.z.toFixed(1) } };
    }
    case "restartround":
      startNewRound(sessions);
      return { ok: true, round: match.round };
    case "endround":
      match.timer = 0;      // the round-lifecycle path takes it from here (intermission, then restart)
      return { ok: true };
    case "addtime": {
      const ticks = Math.round(Number(arg) || 0);
      if (!Number.isFinite(ticks) || ticks === 0) return { ok: false, err: "addtime needs a tick count" };
      match.timer = Math.max(1, match.timer + ticks);
      return { ok: true, timer: match.timer };
    }
    default:
      return { ok: false, err: `unknown server action: ${action}` };
  }
}

function startServer() {
  // maxPayload caps a single inbound frame. `ws` defaults to 100 MiB, so without this one frame
  // from a hostile client makes the server allocate 100 MB. Real client input is a few hundred
  // bytes; 64 KiB is generous even for a join carrying identity and loadout.
  // No real TCP listening socket exists (or is possible) in a browser extension — the extension's
  // own background.js hands connections to handleConnection() directly, one per
  // chrome.runtime.Port, the exact same way netlib_adapter.js's startNetlibListener() already
  // does for WebRTC peers (see that file's own comment: "makes a netlib peer look enough like a
  // `ws` WebSocket that this function can't tell the difference"). wss itself becomes a pure
  // no-op target for the few .on() registrations below that nothing will ever actually fire.
  const wss = { on() {} };
  const sessions = new Map();
  _live.sessions = sessions;
  // spawnBot/removeBot/listBots close over this closure's `sessions`, `globalTick` and
  // maybeStartGameLoop/maybeStopGameLoop — the same reason getSessions() reaches into `_live`
  // rather than a module-level variable (there is no module-level one; startServer's closure is
  // the only place these live). Assigned here, right where `sessions` itself is exposed, so admin
  // dashboard controls (via the module.exports wrappers) reach this exact running instance.
  _live.spawnBot = null;
  _live.removeBot = null;
  _live.listBots = null;

  // ── Heartbeat sweep ─────────────────────────────────────────────────────
  // TCP does not tell you a peer vanished. A closed laptop or a phone losing signal leaves the
  // socket open from our side for ever — `close` never fires — so the session keeps its player
  // slot, its entity, and its place in every other client's scoreboard indefinitely.
  //
  // Ping each connection on a timer and terminate anything that has missed HEARTBEAT_MISSES in a row.
  // terminate() rather than close(): a dead peer will never complete a closing handshake.
  //
  // Why more than one miss is allowed: a pong is normally answered by the browser's network stack
  // rather than by page JavaScript, so a backgrounded tab keeps replying — but an aggressively frozen
  // renderer can stall it, and killing a real player's session for one late pong is a worse failure
  // than reaping a dead socket one interval later.
  const heartbeat = setInterval(() => {
    // Prune _connectionAttemptAllowed's per-IP tracker here too — piggybacking on an interval that
    // already runs on this cadence rather than adding a second timer. Tokens are only recomputed
    // LAZILY, inside _connectionAttemptAllowed, on each attempt — so an address that stopped
    // attempting entirely keeps whatever stale token count it had at its LAST attempt forever if we
    // checked that value here. Checking idle TIME instead avoids that: 5 minutes with no attempt at
    // all means the bucket would be back to full regardless of what's stored, so it is safe to
    // forget — the next attempt (if any) just starts a fresh full bucket, identical to what an
    // accurate refill would have produced anyway.
    const nowMs = Date.now();
    for (const [ip, e] of _connAttempts) {
      if (nowMs - e.lastRefillMs > 5 * 60000) _connAttempts.delete(ip);
    }
    if (!HEARTBEAT_SEC) return;
    for (const s of sessions.values()) {
      const sock = s && s.ws;
      if (!sock) continue;
      if (sock.isAlive === false) {
        sock._missedPings = (sock._missedPings || 0) + 1;
        if (sock._missedPings >= HEARTBEAT_MISSES) {
          console.warn(`[evio-local] ${s.sessionId} missed ${sock._missedPings} heartbeats `
            + `(${sock._missedPings * HEARTBEAT_SEC}s) — terminating (dead connection)`);
          try { sock.terminate(); } catch (_) {}
          continue;
        }
      } else {
        sock._missedPings = 0;
      }
      sock.isAlive = false;
      try { sock.ping(); } catch (_) {}
    }
  }, Math.max(1, HEARTBEAT_SEC) * 1000);
  heartbeat.unref?.();
  wss.on("close", () => clearInterval(heartbeat));
  _live.startedAt = Date.now();

  // ── Session sequence counter ────────────────────────────────────────────
  // Prevents collision when two tabs connect within the same millisecond.
  // Date.now().toString(36) alone repeats if both tabs connect at the same ms.
  let _sessionSeq = 0;

  // ── Global game loop ────────────────────────────────────────────────────
  // Root cause of the two-tab infinite-rejoin bug: each connection previously
  // had its OWN tick counter (starting at 1) and its own setInterval. When
  // Tab A received input, it broadcast to Tab B using Tab A's tick number
  // (e.g. 50). Tab B's own interval was also sending tick 3, 4, 5... to
  // itself. Tab B's ev.io prediction reconciler saw the tick stream jump
  // 3 → 50 → 4 → 51..., detected desync, and triggered its reconnect loop —
  // causing the rapid rejoin / stuck-at-spawn symptom.
  //
  // Fix: one shared globalTick counter + one global setInterval. All accepted
  // clients are integrated and receive state at exactly the same tick number
  // on every interval fire. No per-connection tick divergence possible.
  let globalTick = 0;
  let gameLoopInterval = null;
  let lastGlobalWallMs = Date.now();

  // ── Reconciler warmup guard ─────────────────────────────────────────────
  // The ev.io client reconciler (Qwhlcfo / Qak2r7y, bundle lines 27333-27382)
  // reads Qxo2o14[0].Qt03jhz on EVERY render frame that has a buffered server
  // packet. Qxo2o14 starts EMPTY (line 27269) and only gets its first entry
  // when Qwhlcfo runs with an EMPTY Qorty0h queue (bootstrap initializes the
  // queue but the reconciler ring-buffer only fills on render frames, ~16ms).
  //
  // If the global loop sends a tick to a newly-accepted player before their
  // first render frame, it lands in Qorty0h immediately. On the first render
  // frame, Qwhlcfo tries to read Qxo2o14[0] → undefined → Uncaught TypeError
  // → crash → crash repeats every frame because Qxo2o14 never gets populated
  // → infinite error spam + player can't join.
  //
  // Tab A is safe because it starts a fresh setInterval (first tick = 50ms later,
  // client renders ~3 frames first). Tab B crashes because the loop is ALREADY
  // running and fires within 0-49ms of Tab B's bootstrap.
  //
  // Fix: skip global-loop broadcasts to a session for TICK_WARMUP cycles after
  // it accepts. The client renders ~9 frames during 150ms → Qxo2o14 is populated
  // before the first tick arrives. Per-input self-ticks are still safe: the client
  // only sends input after the game loop has run (pointer lock + WASD), by which
  // time Qxo2o14 has many entries.
  const TICK_WARMUP = 3; // skip first N global ticks (N × TICK_MS ms grace period)

  // Wrapper: a tick that throws must never take the loop (or the process) with it.
  //
  // The scheduler below runs `runGlobalTick(); loop();` — so an exception anywhere in a tick skipped
  // the reschedule and killed the game loop PERMANENTLY, and with no process-level handler Node
  // then tore the process down. Players kept moving server-side (integratePlayerSim also runs from
  // the per-input message handler) while the BROADCAST stopped, which presents exactly as "the
  // server moved me but every client is frozen".
  //
  // One bad tick is recoverable; a dead loop is not. Log it and keep ticking.
  let _tickErrors = 0;
  // Run one named phase of the tick, containing a fault to that phase. Deliberately NOT a blanket
  // try/catch over everything: the point is that the phases are independent, so one failing must not
  // cost the others. Errors are counted and named in the telemetry (_live.phaseErrors) so a contained
  // fault is loud rather than silently swallowed — a guard that hides its own bug is worse than none,
  // which is exactly what happened when the entity isolation masked an out-of-scope variable.
  const _phaseErrors = new Map();
  // Per-tick timing breakdown — reset at the top of runGlobalTickInner, read back by the overrun
  // logger in runGlobalTick so a slow tick names WHICH part was slow instead of just "the tick was
  // slow". Temporary, targeted diagnostic for a live "feels laggy despite good ping" report:
  // tickOverruns was climbing steadily (up to 302ms against a 50ms budget) with only 1 bot and 2
  // real players connected — too small a lobby for the usual "N players" explanation, so the actual
  // culprit needs naming rather than guessing.
  let _tickTimings = {};
  function _timed(name, fn) {
    const t0 = Date.now();
    try { fn(); } finally { _tickTimings[name] = (_tickTimings[name] || 0) + (Date.now() - t0); }
  }
  function _phase(name, fn) {
    const t0 = Date.now();
    try {
      fn();
    } catch (err) {
      const n = (_phaseErrors.get(name) || 0) + 1;
      _phaseErrors.set(name, n);
      _live.phaseErrors = Object.fromEntries(_phaseErrors);
      _live.lastTickError = `${name}: ${(err && err.message) || err}`;
      if (n <= 5 || n % 200 === 0) {
        console.error(`[evio-local] TICK PHASE "${name}" FAILED #${n} at tick ${globalTick} `
          + `(other phases continue):`, (err && err.stack) || err);
      }
    } finally {
      _tickTimings[name] = (_tickTimings[name] || 0) + (Date.now() - t0);
    }
  }

  function runGlobalTick() {
    // ── Tick-budget watchdog ────────────────────────────────────────────────────────────────────
    // The tick RATE is the canary for every load problem, and nothing was watching it. Measured on
    // the live VPS: the rate holds a flat 20.00 all the way up to saturation and then falls off a
    // cliff — 48 players ran at 20.00 on 85% of one core, 64 players pegged the core and collapsed to
    // 16.59. A slow tick is exactly the desync we spent so long eliminating, so it must be loud
    // rather than something an operator happens to notice on a dashboard.
    //
    // One core is the ceiling per lobby regardless of how many the machine has (Node is
    // single-threaded), so "the box has spare CPU" is not reassurance here.
    const _tickStart = Date.now();
    try {
      runGlobalTickInner();
    } catch (err) {
      _tickErrors++;
      _live.tickErrors = _tickErrors;
      _live.lastTickError = String((err && err.message) || err);
      if (_tickErrors <= 10 || _tickErrors % 100 === 0) {
        console.error(`[evio-local] TICK ERROR #${_tickErrors} at tick ${globalTick}:`,
          (err && err.stack) || err);
      }
    }
    // Measured AFTER the catch so a faulting tick still counts against the budget.
    const _took = Date.now() - _tickStart;
    _live.tickMsLast = _took;
    if (_took > _live.tickMsWorst || !_live.tickMsWorst) _live.tickMsWorst = _took;
    if (_took > TICK_MS) {
      _live.tickOverruns = (_live.tickOverruns || 0) + 1;
      // Thinned: a server that is genuinely overloaded overruns every tick, and 20 lines a second
      // of that would bury the errors worth reading.
      if (_live.tickOverruns <= 5 || _live.tickOverruns % 200 === 0) {
        console.warn(`[evio-local] TICK OVERRUN #${_live.tickOverruns}: ${_took}ms > ${TICK_MS}ms `
          + `budget at tick ${globalTick} with ${(_live.sessions && _live.sessions.size) || 0} `
          + `player(s). The tick rate is about to drop, which desyncs everyone — reduce maxPlayers `
          + `or the load. One lobby is capped at ONE core (Node is single-threaded).`);
      }
      // Temporary diagnostic (see _tickTimings' own comment) — logged on EVERY overrun regardless
      // of the thinning above, since a per-phase breakdown is exactly the thing worth NOT losing.
      console.warn(`[evio-local] TICK OVERRUN #${_live.tickOverruns} breakdown: `
        + `${JSON.stringify(_tickTimings)} sim: ${JSON.stringify(_simSubTimings)} `
        + `grenade: ${JSON.stringify(_grenadeSubTimings)}`);
    }
  }

  function runGlobalTickInner() {
    _tickTimings = {};
    _resetSimSubTimings();
    _resetGrenadeSubTimings();
    globalTick++;
    // Live status feed for the admin UI (see getStatus / admin_server.js). Cheap: one push
    // into a small ring per tick, so the dashboard can show the ACTUAL tick rate rather than
    // the configured one — a loop falling behind is exactly the kind of thing you want to see.
    _live.globalTick = globalTick;
    _live.tickStamps.push(Date.now());
    sampleMetrics(Date.now());
    if (_live.tickStamps.length > 120) _live.tickStamps.shift();
    const dtSeconds = REALTIME_SIM_DT
      ? (() => {
          const now = Date.now();
          const dt = Math.max(0, Math.min(MAX_REALTIME_DT, (now - lastGlobalWallMs) / 1000));
          lastGlobalWallMs = now;
          return dt || TICK_MS / 1000;
        })()
      : TICK_MS / 1000;

    // Bots have no network connection to receive input from, so they get one manufactured batch
    // per tick, in the SAME { clientTick, frames } shape a real packet decodes into. This must run
    // BEFORE the physics loop below — processBufferedTick only advances a session whose queue
    // already has something in it, exactly like a real session waiting on its next packet.
    _timed("driveBots", () => driveBots(sessions));

    // Integrate physics for every accepted player.
    // Players who already received an input-paced tick this cycle (lastInputTick ===
    // globalTick) are skipped — their physics was already advanced by the per-input
    // immediate-response path in the message handler.
    //
    // NOTE: the hasPendingFrames exception was removed.
    // Old code: if (lastInputTick !== globalTick || hasPendingFrames) { integrate }
    // Problem: a 60fps client sends ~3 packets/50ms.  Packet 1 fires input-paced
    // physics (1 step).  Packets 2–3 land in _pendingRawFrames.  The global tick
    // then saw hasPendingFrames=true and ran a SECOND physics step.  Combined with
    // the old multi-sub-frame loop (N steps per call), this produced 3 physics
    // advances per 50ms = 3× speed bug.
    //
    // Fix: the global tick NEVER fires for a player that already had an input-paced
    // tick this cycle.  Frames from packets 2–3 remain in _pendingRawFrames and are
    // drained on the NEXT tick (either by the next input-paced call or by the global
    // tick once lastInputTick is behind again).  The player's held-key state is
    // already reflected in playerState.heldActions (foldInputFrameIntoSim ran), so
    // direction is up to date even before those frames are physics-integrated.
    const _bufferedTickStart = Date.now();
    for (const s of sessions.values()) {
      if (!s.accepted) continue;
      s.tick = globalTick;
      // Per-player isolation: one player's bad state must not cost everyone else their tick.
      try {
        if (TICK_MODEL === "buffer") {
          // Tick-index buffer model: advance by draining this player's input queue
          // (one client tick per buffered batch) through the same g() the client runs.
          processBufferedTick(s, globalTick, sessions);
        } else if (s.lastInputTick !== globalTick) {
          integratePlayerSim(s.playerState, dtSeconds, globalTick);
        }
      } catch (err) {
        console.error(`[evio-local] sim error for ${s.sessionId} at tick ${globalTick}:`,
          (err && err.stack) || err);
      }
    }
    _tickTimings.bufferedTick = (_tickTimings.bufferedTick || 0) + (Date.now() - _bufferedTickStart);

    if (PACING_DEBUG && globalTick % 40 === 0) {            // every ~2s at 20Hz
      for (const s of sessions.values()) {
        if (!s.accepted) continue;
        const enq = s._enqCount || 0, proc = s._procCount || 0, drop = s._dropCount || 0;
        const dEnq = enq - (s._lastEnq || 0), dProc = proc - (s._lastProc || 0), dDrop = drop - (s._lastDrop || 0);
        s._lastEnq = enq; s._lastProc = proc; s._lastDrop = drop;
        const lag = (s.lastClientTick || 0) - (s.lastProcessedClientTick || 0);
        const q = s.inputQueue ? s.inputQueue.length : 0;
        const line = `[pacing] t=${globalTick} ${String(s.playerState && s.playerState.Q7q6byi).slice(0,6)} last2s: recv=${dEnq} proc=${dProc} drop=${dDrop} | queue=${q} lag=${lag} | totals enq=${enq} proc=${proc} drop=${drop} (proc-enq=${proc-enq})`;
        try { fs.appendFileSync(PACING_LOG, line + "\n"); } catch (e) {}   // isolated from [evio-local] spam
      }
    }

    // Advance thrown grenades once per tick (before the broadcast loop) so every client
    // receives the same updated activeEntities state.
    // Fade existing flash-blind first (so a blind applied THIS tick starts at full), then
    // advance grenades (which may set a fresh blind on flash detonation). The blind fades by
    // incrementing Qwv47ix (client renders 0.5*max(energyCharge - 0.01*Qwv47ix, 0)^2); once it
    // hits 0 we clear both so a later flash starts clean.
    for (const s of sessions.values()) {
      const p = s.accepted && s.playerState;
      if (p && p.energyCharge > 0) {
        p.qwv47ix = (p.qwv47ix || 0) + 1;
        if (p.energyCharge - 0.01 * p.qwv47ix <= 0) { p.energyCharge = 0; p.qwv47ix = 0; }
      }
    }
    // ── Phase isolation ─────────────────────────────────────────────────────────────────────────
    // These ran as bare statements. runGlobalTick's outer catch keeps the SERVER alive, but a throw
    // anywhere here abandons every LATER phase of the tick — and a deterministic throw abandons them
    // on every tick from then on. Not hypothetical: the grenade loop's fault took firing, respawns and
    // the whole broadcast with it, which is why grenades "never exploded" AND the symptoms spread
    // beyond grenades.
    //
    // The phases are independent enough that losing one is survivable while losing the rest is not:
    // if death/respawn throws, nobody respawns ever again; if the broadcast throws, the server looks
    // frozen to everyone. Each phase is named, so the log says which one failed rather than giving one
    // stack trace from the top of the tick.
    _phase("grenades", () => simulateGrenades(dtSeconds, sessions));
    _phase("pickups", () => processWeaponPickups(sessions, globalTick));

    // ── Combat loop (server-authoritative): fire → hitscan damage, then advance death/respawn.
    // Buffer mode fires inside processBufferedTick (once per drained CLIENT tick, at that tick's
    // position).  Hybrid mode has no per-tick drain, so it fires here once per global tick.
    if (TICK_MODEL !== "buffer") _phase("firing", () => processFiring(sessions));
    _phase("regen", () => {
      for (const s of sessions.values()) if (s.accepted && s.playerState) tickHealthRegen(s.playerState);
    });
    _phase("deathRespawn", () => processDeathRespawn(sessions));
    // Advance the round clock AFTER deaths/respawns so a kill in the final tick still scores,
    // and BEFORE the tick bodies are built so opcode 7/280 carry this tick's value.
    _phase("match", () => tickMatch(sessions));

    // Advance every accepted player's PEER-broadcast position (see updateBroadcastPosition) — AFTER
    // physics/respawn/teleport for this tick (so a respawn this tick is already reflected in the
    // true position being eased/snapped toward) and BEFORE any tick body is built, so every
    // recipient who sees this player as a peer this tick reads the same already-advanced value.
    _phase("peerSmoothing", () => {
      for (const s of sessions.values()) {
        if (!s.accepted || !s.playerState) continue;
        updateBroadcastPosition(s.playerState, dtSeconds, peerSmoothCapFor(s), popReplayTarget(s), !s._drainedThisTick);
      }
    });

    // Broadcast authoritative state to each accepted client.
    // Each recipient gets a packet stamped with globalTick so all clients
    // share the same authoritative tick timeline.
    //
    // Wholesale clear of the per-tick player-block cache (see _cachedPlayerBlock). Every entry is
    // tagged with the tick it was built for, so this clear is a memory bound, not a correctness
    // requirement — but without it a departed player's block would sit in the map forever, one
    // stale entry per playerId ever connected. Clearing here (once, before the N per-recipient
    // buildTickBody calls that will repopulate it this tick) keeps the map's size bounded by the
    // CURRENT player count rather than growing with the server's total lifetime connection count.
    _tickPlayerBlockCache.clear();
    let totalBytes = 0;
    let recipients = 0;
    const _broadcastStart = Date.now();
    for (const s of sessions.values()) {
      if (!s.accepted) continue;
      // A bot has no socket to send a packet to. It is still fully visible to every REAL
      // recipient — buildTickBody's peer loop reads any session with `accepted` true off this
      // same map, straight through the per-tick player-block cache, regardless of whether that
      // session has a `ws`. Nothing below this line (echo computation, backpressure, sendState)
      // applies to a connection that does not exist.
      if (s.isBot) continue;
      // ── Reconciler warmup guard ────────────────────────────────────────
      // Skip this player if they joined too recently. If a tick arrives in
      // Qorty0h before their first render frame (which populates Qxo2o14),
      // Qak2r7y crashes with "Cannot read properties of undefined (reading
      // 'Qt03jhz')". TICK_WARMUP cycles (~150ms) gives the client enough
      // time to render its first frame and init the reconciler ring-buffer.
      if (s.joinedAtTick >= 0 && globalTick - s.joinedAtTick < TICK_WARMUP) continue;
      // Skip if this player already got a self-tick this cycle (input-paced).
      // Exception: if they have pending peer bootstraps, we still need to send
      // so those queued introductions reach the client on the next tick.
      const hasPending = s.pendingPeerBootstraps && s.pendingPeerBootstraps.length > 0;
      // Hybrid only: skip players already self-ticked this cycle (input-paced).
      // Buffer mode has no input-paced path, so it always broadcasts here.
      if (TICK_MODEL !== "buffer" && s.lastInputTick === globalTick && !hasPending) continue;

      // ── Backpressure ────────────────────────────────────────────────────────────────────────────
      // ws.bufferedAmount was never consulted. A client that stops READING — a throttled tab, a
      // saturated uplink, a phone on a dying signal — still has a healthy TCP connection that answers
      // pings, so the heartbeat keeps it. Meanwhile we queue a state packet 20x a second into a buffer
      // it never drains: server memory grows without limit, and every packet it eventually reads is
      // older than the last, so it falls further behind for as long as it stays connected.
      //
      // Skipping a state packet is safe — each tick carries a full snapshot, so a skipped one behaves
      // exactly like a dropped packet, which the protocol already tolerates. This check sits BEFORE the
      // body is built precisely so nothing is CONSUMED: the one-shot payloads (peer bootstraps, peer
      // removals, loadout deltas) stay queued rather than being flushed into a body that is not sent,
      // which is the trap the comment further down warns about.
      if (SEND_BUFFER_SKIP_BYTES > 0 && s.ws && s.ws.bufferedAmount > SEND_BUFFER_SKIP_BYTES) {
        s._backpressureTicks = (s._backpressureTicks || 0) + 1;
        s._backpressureSkips = (s._backpressureSkips || 0) + 1;
        if (s._backpressureTicks > SEND_BUFFER_MAX_TICKS) {
          console.warn(`[evio-local] ${s.sessionId} not draining: ${s.ws.bufferedAmount} bytes buffered `
            + `for ${s._backpressureTicks} ticks — closing`);
          try { s.ws.close(4005, "send buffer overflow"); } catch (_) {}
        }
        continue;
      }
      s._backpressureTicks = 0;

      // ── One recipient's whole packet, isolated ───────────────────────────────────────────────────
      // The try starts HERE, not at the send. Assembling the body is where the work — and the risk —
      // actually is: buildTickBody walks this player's state and every peer's. My first version wrapped
      // only sendState, and a fault while BUILDING still escaped and abandoned every player later in
      // the map. Found by poisoning one player's health and watching the others get nothing.
      //
      // `body` is declared OUTSIDE the try on purpose: both the catch handler and the debug log below
      // read it, and a `let` inside the try is not in scope in either — which would have turned any
      // contained fault into a ReferenceError from inside the error handler itself.
      let body;
      try {

      // ── Full re-bootstrap after a map reload ────────────────────────────
      // A map reload REBUILDS the client's world state. The 244 tick loop then recreates every
      // entity as an EMPTY object (`w in playerList || (playerList[w] = {})`), and the tick body
      // only carries the movement subset — no weapon (127/135), no stats (95-123), no identity
      // (210/212/231). So after a round restart the LOCAL player has no weapon (attacks and
      // grenades do nothing) and peers have no model (invisible). Movement deltas cannot rebuild
      // an entity; only a first-spawn body can.
      //
      // We therefore send a COMPLETE first-spawn body — self + all peers — as this tick's payload.
      // It goes through the normal tick path so it carries a monotonically increasing serverTick;
      // sending it as an extra packet would reuse a tick and exhaust the client's reconciler ring
      // (the historical duplicate-tick crash).
      if (s.pendingFullBootstrap) {
        s.pendingFullBootstrap = false;
        body = buildFirstSpawnBody({
          tick: globalTick,
          playerId: s.playerId,
          displayName: s.displayName,
          uid: s.uid,
          clan: s.clanImgUrl,
          weaponId: s.weaponId,
          abilitySeed: s.abilitySeed,
          teamId: s.teamId || 0,
          spawnProtectTicks: _psOf(s.playerState).Qalaptp,
          // The bootstrap is the first state the client decodes, and its lobby UI is built from it — a
          // held player must arrive already marked as not-in-the-match or the menu is torn down at once.
          playerState: s.playerState && s.playerState._holdForPlay ? PLAYER_STATE_HELD : 1,
          // A held player is bootstrapped at the ORIGIN with zero yaw, matching the official capture.
          // This is a SEPARATE field from opcode 136 — zeroing only the tick body left the very first
          // packet carrying a real spawn (measured: pos 19.2,6.05,54.4 at t=1427ms, then 0,0,0 at
          // t=1686ms). In that ~260ms the client saw a normal player, created its local player, showed
          // the first-person weapon and anchored the camera. State 0 then arrived, the client nulled
          // its prediction, and every update is guarded on that being non-null — so the weapon and the
          // camera stayed frozen exactly where the first packet had put them.
          spawn: (s.playerState && s.playerState._holdForPlay)
            ? { x: 0, y: 0, z: 0, yaw: 0 }
            : {
              x: s.playerState.position.x, y: s.playerState.position.y,
              z: s.playerState.position.z, yaw: s.playerState.yaw,
            },
          emitPositionYOffset: EMIT_POSITION_Y_OFFSET,
          gamePhase: ROUNDS_ENABLED ? match.gameMode : GAME_PHASE,
          officialBootstrapFields: OFFICIAL_BOOTSTRAP_FIELDS,
          customMap: true,
          matchTimer: match.timer,
          matchDuration: Math.max(1, Math.round(1000 / TICK_MS)),
          mapUrl: ROUNDS_ENABLED ? currentMapUrl() : undefined,
          mapName: ROUNDS_ENABLED ? currentMapName() : undefined,
          mapImageUrl: ROUNDS_ENABLED ? currentMapThumb() : undefined,
          mapGeneration: ROUNDS_ENABLED ? match.mapGeneration : undefined,
        });
        appendPeerBootstraps(body, sessions, s.playerId);
        console.log(`[evio-local] full re-bootstrap -> ${s.playerId} (round ${match.round}, `
          + `map generation ${match.mapGeneration})`);
      } else {
        body = buildTickBody(s.playerId, globalTick, s.playerState, sessions);
      }

      // ── Flush queued peer bootstrap deltas + departures ───────────────────
      // Peer introductions/removals are delivered inside this tick body so they
      // travel with a monotonically-increasing serverTick (no duplicate-tick crash).
      //
      // Record whether anything ONE-SHOT is going into this body BEFORE flushing, because the
      // flush empties the queues. The send-rate gate further down can `continue` past sendState,
      // and a one-shot payload that was flushed into a body that is never sent is gone for good:
      // the recipient then only ever meets that peer through the regular 244 loop, which creates a
      // bare `{}` — no name (renders as "undefined"), no weapon model, no skin. Whether a given
      // recipient was idle on the exact tick a peer joined is luck, which is why it was
      // intermittent. Anything queued here therefore forces the send.
      const _hasOneShot = (s.pendingPeerBootstraps && s.pendingPeerBootstraps.length > 0)
        || (s.pendingPeerRemovals && s.pendingPeerRemovals.length > 0)
        || (s.loadoutDeltaSendCount > 0);
      flushPendingPeerBootstraps(s, body);
      flushPendingPeerRemovals(s, body);
      flushLoadoutDelta(s, s.playerState, body);
      flushActiveEntities(body);   // thrown grenades (268 block) — after the 244 loadout delta
      flushWeaponPickups(body);    // weapon pickup spawn points (278 block)

      // Echo the latest known clientTick on every tick.
      // The reconciler tolerates repeated echoes — when the ring entry for ct=N
      // is already consumed, the client-side ring[0].ct won't match and it simply
      // skips reconciliation (no crash, no snap).  The official ev.io server always
      // re-echoes lastClientTick; we must too.
      //
      // Use -1 (not 0) as the "no client tick yet" sentinel.
      // Official server evidence: EVERY packet from official server has echoClientTick=-1
      // (observed in official_capture_summary_*.json: "tick=-1" on all sampled frames).
      //
      // Why -1, not 0:
      //   The reconciler (Qak2r7y) reads Qxo2o14[echoClientTick % RING_SIZE].Qt03jhz.
      //   Qxo2o14 starts EMPTY; Qxo2o14[0] is only populated after the client runs
      //   Qwhlcfo with an empty Qorty0h (needs at least one render frame with no
      //   pending server packets). On localhost the bootstrap arrives before the first
      //   render frame, so Qxo2o14[0] is never set → Qak2r7y reads undefined →
      //   "Cannot read properties of undefined (reading 'Qt03jhz')" → lobby crash.
      //
      //   The client guards against echoClientTick < 0 and skips reconciliation,
      //   so -1 is completely safe.  0 is NOT safe unless Qxo2o14[0] is guaranteed
      //   to be pre-populated — which it isn't on localhost.
      // Echo the client tick we ACTUALLY simulated to this point.  In buffer mode
      // that is lastProcessedClientTick — it inherently lags the newest received
      // tick by the buffer depth (jitter buffer), so it sits inside the client's
      // prediction ring and the reconciler matches it with tiny corrections.  In
      // hybrid mode fall back to the synthetic lagged echo.  -1 = no tick yet.
      let echoTick;
      if (TICK_MODEL === "buffer") {
        echoTick = s.lastProcessedClientTick > 0 ? s.lastProcessedClientTick : -1;
        // Idle simulation: the body is the server's continuation past their last real tick, so no
        // client tick describes it. Same reason as computeEchoTick — and this path has to repeat the
        // check because it computes the echo inline rather than calling it, which is precisely how
        // selective reconciliation silently failed for real players the first time.
        // Same for the inline buffer path — it computes the echo itself rather than calling
        // computeEchoTick, which is exactly how selective reconciliation silently failed once before.
        if (s.playerState && s.playerState._holdForPlay) echoTick = -1;
        else if (s._idleTicks > 0) echoTick = -1;
        else if (ECHO_LAG_TICKS < 0) {
          // Client-authoritative, EXCEPT while a reconcile burst is pending. The client cannot
          // predict an impulse or explosion knockback, so those ticks must carry a real client
          // tick or the push never reaches it — peers see the player fly while their own screen
          // stays put. Keep the already-computed lastProcessedClientTick during the burst.
          maybeAnchorReconcile(s);   // THIS is the path real players take (tickModel=buffer)
          if (consumeReconcileBurst(s)) {
            const bt = burstEchoTick(s);
            echoTick = bt > 0 ? bt : -1;
          } else echoTick = -1;
        } else if (ECHO_LAG_TICKS > 0 && echoTick > 0) {
          // Push the echo further behind the newest client tick. Buffer mode used to IGNORE a
          // positive value entirely, so the documented "jitter margin" knob did nothing here and
          // the only way to move the echo was inputBufferDepth (which also adds real input
          // latency). They are not interchangeable: depth delays SIMULATION, this delays only
          // the ACKNOWLEDGEMENT. Useful when the echo lands too close to the client's newest
          // ring entry and trips the `clientTick > frameBuffer[0].tickIndex` guard.
          echoTick = echoTick - ECHO_LAG_TICKS;
          if (echoTick <= 0) echoTick = -1;
        }
      } else {
        echoTick = computeEchoTick(s.lastClientTick, s);
      }

      // ── Send-rate gate: one state per CLIENT tick, not per SERVER tick ──────────────────────
      //
      // The client consumes EXACTLY ONE buffered state per client tick (Qorty0h.shift() in
      // Qwhlcfo) but ingests every packet that arrived since the last one. So the only stable
      // send rate is the client's own tick rate. When jitter means a player's input has not
      // arrived yet, processBufferedTick drains nothing — no physics, echo unchanged — and a
      // packet sent anyway carries a DUPLICATE clientTick while the client's own tick has not
      // advanced. Their queue grows by one, permanently.
      //
      // Once it passes 2 the client starts discarding states to catch up ("Skipping a server
      // state to keep up", bundle :27348, thresholds i=5 / a=2) and never stops. Every discarded
      // state is a correction the reconciler never sees, and none of it is visible from here —
      // which is why this presented as a silent, long-lived, per-player desync with a completely
      // clean server console.
      //
      // Suppressing the duplicate is safe: entries in the client's buffer are FULL merged states,
      // so the next packet carries everything this one would have (including peer positions).
      //
      // BUT ONLY FOR AN ESTABLISHED INPUT STREAM. The client needs a run of authoritative ticks to
      // finish loading a map, and it cannot send input until that load completes — so gating purely
      // on "drained nothing this tick" deadlocks at join and at every map change: we wait for input
      // the client cannot produce until it gets the ticks we are withholding.
      //
      // So the gate engages only while the client is DEMONSTRABLY ticking (it drained input within
      // the last IDLE_GRACE ticks). A client that has gone quiet for longer is loading, paused or
      // backgrounded — it is not consuming states either, so there is no surplus to prevent, and it
      // may well be waiting on exactly these packets.
      const recentlyActive = Number.isFinite(s._lastDrainTick)
        && (globalTick - s._lastDrainTick) <= SEND_GATE_GRACE_TICKS;
      // The gate now spends CREDIT rather than asking "did this exact tick drain anything". Credit is
      // earned per client tick consumed, so the total still cannot exceed what the client produces —
      // which is the whole point of rate matching — but a tick that drained two client ticks now funds
      // two sends instead of silently forfeiting one. That forfeit was 20% of all packets, arriving as
      // a doubled gap the client had to interpolate across.
      const nothingOwed = RATE_MATCH_MODE === "credit"
        ? (s._sendCredit || 0) <= 0
        : !s._drainedThisTick;
      // ── DO NOT starve a recipient of PEER updates ───────────────────────────────────────────────
      // Rate matching exists so a client is not sent more states of ITSELF than it produced input
      // for. But the packet it withholds also carries every OTHER player's position, and the gate is
      // keyed on the RECIPIENT's own input. So one late input packet of mine costs me that tick's
      // update for everyone else — they freeze for a tick, then jump a double step. Each player's
      // gaps are independent, so with several players everyone sees everyone else stutter.
      //
      // Measured on the live server: 12 gaps >= 90ms in 881 packets (1.4%, worst 167ms) for a client
      // sending a metronomic 20Hz — roughly one visible hitch every 3.7 seconds, which is exactly the
      // reported "choppy and snapping" peer movement. The client interpolates between the last two
      // states it received, so a doubled gap is a doubled step to cover.
      //
      // With peers present the packet is their transport, not just mine, and must not be withheld.
      // Alone, there is nothing to starve and the original rate-matching still applies.
      const peersPresent = sessions.size > 1;
      const idle = TICK_MODEL === "buffer" && nothingOwed && recentlyActive
        && !hasPending && s.joinedAtTick >= 0 && !s.pendingFullBootstrap
        && !(peersPresent && RATE_MATCH_KEEP_PEERS);
      if (idle && RATE_MATCH_SENDS && !_hasOneShot) { s._idleSends = (s._idleSends || 0) + 1; continue; }

      // sync is the clock-sync channel, NOT the server tick — see computeSyncValue.
      s._legacySyncTick = globalTick;
      // The write itself can no longer throw (safeSend catches), but encode() still can — msgpack
      // rejects values it cannot represent. This closes the try opened before the body build.
      {
        totalBytes += sendState(s.ws, [computeSyncValue(s), echoTick, body]);
        recipients++;
        // Spend one credit per packet, so sends can never outpace the client ticks that funded them.
        if (s._sendCredit > 0) s._sendCredit -= 1;
      }
      } catch (err) {
        s._sendErrors = (s._sendErrors || 0) + 1;
        _live.simErrors = (_live.simErrors || 0) + 1;
        _live.lastSimError = `send to ${s.sessionId}: ${(err && err.message) || err}`;
        if (s._sendErrors <= 3 || s._sendErrors % 100 === 0) {
          console.error(`[evio-local] SEND ERROR #${s._sendErrors} player=${s.playerId} `
            + `tick=${globalTick} bodyOps=${body && body.length}:`, (err && err.stack) || err);
        }
        // A socket that keeps failing is not coming back; free the slot rather than log for ever.
        if (s._sendErrors > 20) {
          console.warn(`[evio-local] ${s.sessionId} failed ${s._sendErrors} sends — closing`);
          try { s.ws.close(4006, "send failures"); } catch (_) {}
        }
        continue;
      }

      const p = s.playerState;
      const moving = Math.abs(p.velocity.x) > 0.001
        || Math.abs(p.velocity.y) > 0.001
        || Math.abs(p.velocity.z) > 0.001;
      // The full per-tick state line. Entirely opt-in: it printed every tick while moving (20/s per
      // player) AND on a periodic heartbeat, which buried everything else. "global game loop started"
      // and the join/kill/hit lines already show the server is alive, so nothing here is needed for
      // normal play. Toggle live from the admin dashboard (Debug -> "Log per-tick player state").
      if (TICK_DEBUG && (moving || globalTick <= 5 || globalTick % TICK_LOG_EVERY === 0)) {
        const hspeed = round(Math.hypot(p.velocity.x, p.velocity.z));
        const drift = Number.isFinite(s.lastClientCurrentServerTick) && s.lastClientCurrentServerTick >= 0
          ? globalTick - s.lastClientCurrentServerTick : null;
        console.log(
          `[evio-local] sent tick=${globalTick} player=${s.playerId} echoTick=${echoTick} ` +
          `drift=${drift} dt=${round(dtSeconds, 4)} ` +
          `pos=(${round(p.position.x)},${round(p.position.y)},${round(p.position.z)}) ` +
          `vel=(${round(p.velocity.x)},${round(p.velocity.y)},${round(p.velocity.z)}) ` +
          `hspeed=${hspeed} grounded=${p.grounded} sprinting=${p.heldActions.has(7) && !p.crouching} ` +
          `crouching=${p.crouching} sliding=${p.sliding} prevCrouch=${p.prevCrouching} ` +
          `cooldown=${p.slideCooldownTicks} slideThresh=${round(WALK_SPEED * SLIDE_THRESHOLD)} ` +
          `airJumps=${p.airJumps} bodyOps=${body.length}`
        );
      }
    }
    _tickTimings.broadcast = (_tickTimings.broadcast || 0) + (Date.now() - _broadcastStart);

    // Clear per-tick hit events AFTER they've been broadcast to every recipient, so each hit's
    // lastHitInfo (170-176) is emitted exactly once. The client then fades it via Qpgzeeg++ (174
    // absent → auto-increment), matching the official behaviour.
    // Isolated per player: this sweep advances the markers that make weapon switching work, so a throw
    // partway through would leave the remaining players' weapon deltas and switch timers frozen — the
    // "holding a rifle but the model is a sword" class of bug — while everything else looked fine.
    for (const s of sessions.values()) {
      try {
        if (s.playerState && s.playerState._pendingHit) s.playerState._pendingHit = null;
        // Advance the weapon-slot snapshot now that EVERY recipient's body has been built, so a
        // weapon actually LEAVING weaponList emits its (135,-1,oldId) delete to all of them and not
        // just the first. Same reason the 127/128 repeat budget is drained here rather than inside
        // the per-recipient builder.
        if (s.playerState) {
          // See _advanceWeaponSlotTracking's header comment for why this must run HERE
          // (unconditionally, once per tick) rather than inside appendPlayerTickBody.
          _advanceWeaponSlotTracking(s.playerState);
          if (s.playerState.weaponSendCount > 0) s.playerState.weaponSendCount -= 1;
          if (s.playerState._statsSendCount > 0) s.playerState._statsSendCount -= 1;
          // The switch timer runs down once per tick, mirroring the client's own Qvtrxln decrement.
          if (s.playerState.switchTimer > 0) {
            s.playerState.switchTimer -= 1;
            if (s.playerState._ps) s.playerState._ps.Q3igok2 = s.playerState.switchTimer;
          }
        }
      } catch (err) {
        console.error(`[evio-local] post-broadcast sweep failed for ${s.sessionId}:`,
          (err && err.stack) || err);
      }
    }
    // Bullets + hit events were emitted to every recipient this tick; drop them so each is sent once.
    if (_pendingBullets.length) _pendingBullets.length = 0;
    if (_pendingHitEvents.length) _pendingHitEvents.length = 0;
  _pendingMedals.length = 0;
    // Entity removals (grenade detonations, shot mines, owner-death cleanup) were emitted as 268,-1,key
    // to every recipient this tick — clear AFTER the broadcast so firing-time + sim-time removals both go.
    // Roll this tick's removals into the re-announce window, then age the window by one tick. Done
    // AFTER the broadcast loop so every recipient saw the same block, and so a removal is announced
    // on its own tick plus ENTITY_REMOVAL_REPEAT more.
    if (removedEntityKeys.length) {
      for (const key of removedEntityKeys) _entityRemovalRepeat.set(key, ENTITY_REMOVAL_REPEAT);
      removedEntityKeys.length = 0;
    }
    if (_entityRemovalRepeat.size) {
      for (const [key, left] of _entityRemovalRepeat) {
        if (left <= 1) _entityRemovalRepeat.delete(key);
        else _entityRemovalRepeat.set(key, left - 1);
      }
    }
  }

  // ── Tick scheduler ──────────────────────────────────────────────────────
  // `setInterval(fn, 50)` does NOT give 20Hz on Windows. The default OS timer granularity is
  // 15.625ms, and a 50ms request rounds UP to the next multiple — 62.5ms, i.e. 16Hz. The server
  // then runs 20% slower than the client's fixed 20Hz sim, so client input ticks arrive faster
  // than they are drained: the queue grows, the catch-up path processes them in lumps, and the
  // echoed tick oscillates instead of advancing 1:1. Measured on this machine: an EMPTY
  // setInterval(50) ticks at 15.95Hz.
  //
  // Fix: target ABSOLUTE deadlines (next += TICK_MS) instead of "sleep 50ms after the callback".
  // Each overshoot is subtracted from the following wait, so the mean rate is exactly 20Hz even
  // though individual ticks still land on the OS's 15.6ms grid. Measured: 20.04Hz, ~0% CPU.
  //
  // `precise` additionally hands the last 16ms to setImmediate, which pins jitter to ±0.03ms —
  // but that is a busy-wait: it costs ~2 full cores. Only worth it for parity captures where
  // tick timing is the thing being measured. `interval` restores the old (slow) behaviour.
  function startTickScheduler() {
    const mode = TICK_SCHEDULER;
    if (mode === "interval") {
      const h = setInterval(runGlobalTick, TICK_MS);
      return () => clearInterval(h);
    }
    const SPIN_MS = mode === "precise" ? 16 : 0;
    let stopped = false;
    let timer = null;
    // process.hrtime.bigint() has no browser/service-worker equivalent; performance.now() is the
    // standard replacement and is already millisecond-scale float, so no /1e6 conversion needed.
    // setImmediate is likewise Node-only ("precise" mode's last-16ms spin — not the "drift"
    // default this extension uses) — setTimeout(fn, 0) is the closest browser equivalent.
    const nowMs = () => performance.now();
    const runSoon = typeof setImmediate === "function" ? setImmediate : (fn) => setTimeout(fn, 0);
    let next = nowMs() + TICK_MS;
    (function loop() {
      if (stopped) return;
      const now = nowMs();
      const wait = next - now;
      if (wait > SPIN_MS) { timer = setTimeout(loop, wait - SPIN_MS); return; }
      if (wait > 0) { runSoon(loop); return; }
      // Deadline reached. If we fell a long way behind (process suspended, debugger, a very
      // slow tick), resync rather than trying to replay every missed tick in a burst.
      next += TICK_MS;
      if (next < now - 10 * TICK_MS) next = now + TICK_MS;
      runGlobalTick();
      loop();
    })();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }

  function maybeStartGameLoop() {
    if (gameLoopInterval) return;
    lastGlobalWallMs = Date.now();
    gameLoopInterval = startTickScheduler();
    console.log(`[evio-local] global game loop started tickMs=${TICK_MS} scheduler=${TICK_SCHEDULER} realtimeDt=${REALTIME_SIM_DT} tickLogEvery=${TICK_LOG_EVERY} sessions=${sessions.size}`);
    // Re-applies the configured bot counts every time the loop (re)starts, not just once at
    // server boot. Needed on the extension host specifically: resetServerState() (see
    // maybeStopGameLoop) removes every bot when the lobby empties, so without this, a
    // configured botCount/swordBotCount would only ever be honored the FIRST time hosting
    // started in a given browser session — stopping and starting again would come back with
    // zero bots, silently dropping the setting. Both reconcile functions are idempotent no-ops
    // when the current count already matches, so this is free on the VPS's own first-boot call
    // from the bpw.ready chain (same two functions, same place they've always been called from).
    reconcileBotCount();
    reconcileSwordBotCount();
  }

  // Only ever runs right after the tick loop itself has already stopped (see maybeStopGameLoop
  // below) — i.e. only on the extension host, never on a deployment with ALWAYS_RUN_TICK on,
  // since that branch never reaches here at all. Exists because this extension's own
  // sessions/match/activeEntities/pickup state all live for the lifetime of the SERVICE WORKER,
  // not per hosting session — bootServer() only ever runs once (see its own comment), so without
  // an explicit reset here, stopping and starting hosting again in the same browser session
  // would resume with whatever bots/entities/pickups/round state happened to be left over from
  // the PREVIOUS hosting session, not a clean slate. The VPS never needs this: a real process
  // restart (or simply never stopping) already guarantees a clean start every time.
  function resetServerState() {
    for (const [playerId, session] of [...sessions.entries()]) {
      if (!session) { sessions.delete(playerId); continue; }
      const ps = session.playerState && session.playerState._ps;
      if (session.isBot) {
        removeBot(playerId); // own peer-departure bookkeeping; deletes from `sessions` itself
      } else {
        // Defensive: a non-bot entry surviving to this point would mean .accepted was false
        // (otherwise anyRealPlayer in maybeStopGameLoop would have been true) — a half-joined
        // straggler, not a real player to preserve.
        sessions.delete(playerId);
      }
      if (ps) { try { _physWorldPlayers.delete(ps.Q7q6byi); } catch (e) { /* ignore */ } }
    }
    _syncPhysWorldCapsules(null);
    clearAllEntities("server reset — no real players left");
    _resetPickupState();
    match.round = 1;
    resetMatchTimer();
    console.log("[evio-local] server state reset (sessions cleared, bots removed, entities/pickups/match reset)");
  }

  function maybeStopGameLoop() {
    if (!gameLoopInterval) return;
    if (ALWAYS_RUN_TICK) return;
    // Bots live in this same sessions Map with accepted=true (they never go through a real
    // handshake, but are seeded in as already-accepted) — a bare .accepted check never goes
    // false while any bot is still around, so the extension host's CPU-saving stop here would
    // never actually fire once a bot had ever been added, real player or not. isBot excludes
    // them from counting as "someone's actually playing."
    const anyRealPlayer = Array.from(sessions.values()).some(s => s.accepted && !s.isBot);
    if (!anyRealPlayer) {
      gameLoopInterval();          // stop handle returned by startTickScheduler
      gameLoopInterval = null;
      globalTick = 0;
      _live.tickStamps.length = 0; // don't average the stopped period into the next run's rate
      console.log("[evio-local] global game loop stopped (no real players — bots alone don't keep it running)");
      resetServerState();
    }
  }

  // ── Bots ────────────────────────────────────────────────────────────────────────────────────
  // A bot is a session exactly like a real player's, except it has no `ws` and its input queue is
  // fed locally every tick instead of arriving over the network. It goes through the IDENTICAL
  // processBufferedTick -> foldInputFrameIntoSim -> preTickFire -> integratePlayerSim -> postTickFire
  // pipeline real players use (see driveBots below and the physics loop in runGlobalTickInner) —
  // there is no parallel bot physics or combat path, so a bot's movement and hit registration cannot
  // silently drift from a real player's the way a hand-rolled bot sim would risk.
  //
  // driveBotFrame (below) holds the actual decision-making (vision/target-selection/aim/fire/
  // navigation — see the "Bot AI" section near processFiring). Nothing else in this section needed
  // to change when that logic was added; it only ever writes to the wire-format frame this returns.
  let _botSeq = 0;
  const BOT_NAMES = ["Ash", "Byte", "Cinder", "Drift", "Ember", "Flux", "Grit", "Haze", "Iris", "Jinx",
    "Kilo", "Lynx", "Marrow", "Nyx", "Onyx", "Pyre", "Quill", "Rune", "Slate", "Talon"];

  // The REAL official bot skin + scoreboard/kill-feed thumbnail — captured from a live official
  // deathmatch session (work/headless-runs/2026-05-25T02-13-12-372Z/events.json:753-754, a genuine
  // server-pushed '~2' prop event for a bot entity, id 9900000): official bots carry this exact
  // pair, not the account's own equipped skin. `zombiebot_0.evskin` is the DIFFERENT skin used only
  // for infected bots in the Infection game mode (bundle Qnczo5l) — not applicable here.
  //
  // This is what actually differentiates a bot from a player visually now that the name no longer
  // does (see the "Bot " prefix removal below) — same as official ev.io, where a bot is identified
  // by its distinct skin/avatar, not by a name convention.
  const BOT_SKIN_URL = "https://ev.io/sites/default/files/skins/bot_2.evskin";
  const BOT_THUMB_URL = "https://ev.io/sites/default/files/skin_profile_thumbs/botred110x110.png";

  // A flat, uniform loadout applied to every bot regardless of level — this is EQUIPMENT, not
  // skill, so it does not scale with botLevel (see bot_difficulty.js's header: skill scales,
  // stats/equipment do not). Index = ability id (ABILITY_TABLES in ability_stats.js), value = the
  // level taken (0 = not taken). Jump level 2 and Sprint level 2 are what make the "sprint and jump
  // while moving" behaviour (driveBotFrame/_navigate) actually feel like an upgrade over the bare
  // default stats every player already has, the same way a real player would pick these two common
  // mobility abilities. Applied through the identical computeWeaponStats path a real join uses.
  const BOT_ABILITY_SEED = [
    0,   // 0  Teleport
    2,   // 1  Jump (of 4)
    2,   // 2  Sprint (of 4)
    0,   // 3  Quick Draw
    0,   // 4  Quick Load
    0,   // 5  Extra Ammo Pickup
    0,   // 6  Extra Clip Size
    0,   // 7  Melee Damage
    0,   // 8  HE Grenade
    0,   // 9  Smoke Grenade
    0,   // 10 Flash Grenade
    0,   // 11 Wall Hanging
    0,   // 12 Hide Foot Trail
    0,   // 13 Sticky Grenade
    0,   // 14 Mine
    0,   // 15 Trip Mine
    0,   // 16 Impulse Grenade
  ];

  // Sword bots get a boosted mobility loadout, plus real abilities _swordCombatFrame actually uses:
  //   Teleport level 5 -> ABILITY_COST[0][4]=0.2 -> floor(1/0.2) = 5 charges, AND the ability
  //   table's distance (Qkrh1tv) scales WITH level: 14 at level 1-3, 18 at level 4, 25 at level 5 —
  //   so maxing it is strictly better on every axis (more charges, longer blink, and a SHORTER
  //   recharge time per charge: cost/rate = 0.2/0.0018 ≈ 111 ticks vs level 3's 0.333/0.0024 ≈ 139).
  //   This is what makes closing a 60-unit engage distance against a sharpshooting gun bot survivable
  //   at all: one blink now covers nearly half the sword's entire engage range. All through the REAL
  //   client ability system (ability_stats.js) — physics_extracted.js already fully implements cast
  //   (pressed action 9), charge drain, recharge (Qn97q6u) and justTeleported, because it's the
  //   identical code path a real player's Teleport ability runs through.
  //   Sprint level 4 (of 4 — same real ceiling as Jump above; the table technically carries a 5th
  //   entry but the real client's UI never offers it, so 4 is what a genuine loadout can reach) ->
  //   Q8i9f3s 0.48 vs level 2's 0.2 — noticeably faster sustained sprint while closing the gap on
  //   foot between teleport charges.
  //   Impulse level 1 -> ABILITY_COST[16][0]=0.5 -> 2 charges, thrown at low HP (see swordAtLowHp
  //   below) — ABILITY_COST[16] only defines index 0, so level 1 is the only valid setting.
  //   HE level 1 -> ABILITY_COST[8][0]=0.5 -> 2 charges; Sticky level 1 -> ABILITY_COST[13][0]=1 ->
  //   1 charge — both thrown at mid-range as offense (see the HE_ACTION/STICKY_ACTION branch in
  //   _swordCombatFrame). Mine and Trip Mine are deliberately NOT allocated: both are
  //   place-and-wait weapons (arm, then wait for a proximity trigger) that don't fit a bot that is
  //   always actively closing on a target rather than defending a fixed position. Melee Damage
  //   (index 7) is deliberately NOT allocated either — test_ability_seed.js already confirmed its
  //   stat field is never read anywhere in our damage path, so spending points there would be a
  //   dead stat (and would break that test's own source scan if this comment named the field).
  const SWORD_BOT_ABILITY_SEED = [
    5,   // 0  Teleport (level 5 = 5 charges, 25u blink — the max the table defines)
    2,   // 1  Jump (of 4)
    4,   // 2  Sprint (level 4 = the real max — faster gap-closing on foot)
    0,   // 3  Quick Draw
    0,   // 4  Quick Load
    0,   // 5  Extra Ammo Pickup
    0,   // 6  Extra Clip Size
    0,   // 7  Melee Damage
    1,   // 8  HE Grenade (level 1 = 2 charges)
    0,   // 9  Smoke Grenade
    0,   // 10 Flash Grenade
    0,   // 11 Wall Hanging
    0,   // 12 Hide Foot Trail
    1,   // 13 Sticky Grenade (level 1 = 1 charge)
    0,   // 14 Mine
    0,   // 15 Trip Mine
    1,   // 16 Impulse Grenade (level 1 = 2 charges)
  ];

  function spawnBot(opts = {}) {
    const spawnPoints = activeSpawnPoints();
    const spawnIndex = sessions.size;
    const sp = spawnPoints[spawnIndex % spawnPoints.length];
    _botSeq++;
    const sessionId = `bot-${Date.now().toString(36)}-${_botSeq.toString(36)}`;
    const playerId = sessionId;
    const playerState = createPlayerSimState({
      x: sp.x, y: sp.y, z: sp.z,
      yaw: (sp.yaw * Math.PI) / 180,
    }, sessionId);
    // createPlayerSimState unconditionally holds every NEW player state out of the match when
    // CLICK_TO_PLAY is on (see its own "Held out of the match until they choose to play" comment)
    // — correct for a real join (there's a menu + a click), meaningless for a bot (no UI, no RPC
    // ever arrives to clear it). Left on, a bot spawned under this setting sat in spectator state
    // forever: no spawn, no combat, nothing — reported live as "new bot can't join my lobby" the
    // moment this was made the default. Bots always start in play, regardless of the setting.
    playerState._holdForPlay = false;

    // A sword bot ALWAYS carries the sword and nothing else — opts.weaponId is ignored for it, the
    // same way SWORD_ONLY overrides everyone's loadout server-wide (this is just that override
    // applied to one bot instead of the whole lobby).
    const weaponId = opts.swordOnly ? SWORD_WEAPON_ID
      : (Number.isFinite(opts.weaponId) ? opts.weaponId : (SWORD_ONLY ? SWORD_WEAPON_ID : 4));
    // Mirrors the real join's weapon-equip block (see the join handler) — createPlayerSimState
    // itself sets none of this, so a bot skipping it would carry no weapon at all.
    playerState.equippedWeaponId = weaponId;
    playerState.backupWeaponId = -1;
    playerState.weaponList = weaponId === 262 ? [262] : [weaponId, 262];
    playerState.weaponSendCount = 0;
    playerState._ammoGunId = weaponId;
    playerState.gunAmmo = weaponClip(weaponId, playerState);
    playerState.reloadTicks = 0;

    // Mirrors the real join's ability-loadout block (see "applied loadout stats" in the join
    // handler): computes real weaponStats from the seed so the bot's jump/sprint (and, for a sword
    // bot, Teleport/Impulse) are ACTUALLY functional, not just cosmetically labelled as such.
    const abilitySeed = _sanitizeAbilitySeed(opts.swordOnly ? SWORD_BOT_ABILITY_SEED : BOT_ABILITY_SEED);
    if (playerState._ps && playerState._ps.Qz8l93a) {
      Object.assign(playerState._ps.Qz8l93a, computeWeaponStats(abilitySeed));
      refreshMagazineCapacity(playerState);
      playerState._ps.weaponStateArray = abilitySeed;
    }

    const session = {
      ws: null,
      isBot: true,
      // Drives which combat branch driveBotFrame uses (_swordCombatFrame vs the plant-and-shoot gun
      // branch) and which reconciler (reconcileBotCount vs reconcileSwordBotCount) owns this bot.
      isSwordBot: !!opts.swordOnly,
      // 1-10, matching the official Bot Level UI.
      botLevel: Math.max(1, Math.min(10, Number.isFinite(opts.level) ? opts.level : 5)),
      sessionId, playerId, playerState,
      connectedAt: Date.now(),
      remoteIp: "bot",
      _idleTicks: 0,
      _idleSimStartTick: 0,
      // No "Bot " prefix: the skin + avatar below are what mark this as a bot now, the same way
      // official ev.io differentiates bots from players (a distinct look, not a name convention).
      displayName: opts.name || BOT_NAMES[(_botSeq - 1) % BOT_NAMES.length],
      // A dedicated, clearly-out-of-range uid: never collides with a real account uid or with the
      // shared guest uid (17, which drives the numbered "Guest####" name allocator — a bot going
      // through that path would get renamed to a Guest#### and lose its bot name).
      uid: -1000 - _botSeq,
      weaponId,
      skinTargetId: null,
      skinUrl: BOT_SKIN_URL,
      thumbUrl: BOT_THUMB_URL,
      skinRarity: null,
      clanImgUrl: null,
      clanLink: null,
      weaponSkins: null,
      abilitySeed,
      loadoutDeltaSendCount: 0,
      teamId: 0,
      tick: globalTick,
      accepted: true,
      lastClientTick: 0,
      lastClientPreviousServerTick: -1,
      lastClientCurrentServerTick: -1,
      inputQueue: [],
      lastProcessedClientTick: -1,
      lastInputTick: -1,
      joinedAtTick: globalTick,
      pendingFullBootstrap: false,
      pendingPeerBootstraps: [],
      pendingPeerRemovals: new Map(),
      // The bot's own client-tick counter — plays the role a real client's tick index does,
      // generated locally instead of arriving over the wire (see driveBots).
      _botClientTick: 0,
    };
    sessions.set(sessionId, session);
    console.log(`[evio-local] bot spawned: ${session.displayName} (${playerId}) `
      + `level=${session.botLevel} weapon=${weaponId}${session.isSwordBot ? " [SWORD]" : ""}`);
    // Same introduction path a real join uses — this is what gives the bot a name, weapon model
    // and (once assigned) a skin on every real client, instead of the bare-entity fallback the 244
    // loop creates for an unintroduced player.
    broadcastPeerSpawn(sessions, session);
    broadcastProfiles(sessions);
    maybeStartGameLoop();
    return session;
  }

  function removeBot(playerId) {
    const session = sessions.get(playerId);
    if (!session || !session.isBot) return false;
    sessions.delete(playerId);
    // Same departure bookkeeping a disconnecting real player gets, so peers see them vanish
    // (244,-1,id markers) instead of freezing forever on their last known position.
    for (const recipient of sessions.values()) {
      if (!recipient || !recipient.accepted) continue;
      if (!(recipient.pendingPeerRemovals instanceof Map)) recipient.pendingPeerRemovals = new Map();
      recipient.pendingPeerRemovals.set(playerId, ENTITY_REMOVAL_REPEAT || 20);
    }
    console.log(`[evio-local] bot removed: ${session.displayName} (${playerId})`);
    maybeStopGameLoop();
    return true;
  }

  function listBots() {
    return [...sessions.values()].filter((s) => s && s.isBot);
  }
  _live.spawnBot = spawnBot;
  _live.removeBot = removeBot;
  _live.listBots = listBots;
  // driveBotFrame is closure-scoped (spawnBot's `sessions` etc.) rather than module-level like
  // _aimAndFire/_navigate/_updateBotTarget/_swordCombatFrame — exposed the same thin-wrapper way as
  // spawnBot above, for direct unit testing without needing a running tick loop.
  _live.driveBotFrame = driveBotFrame;

  // Combat OVERRIDES navigation intent rather than replacing it structurally: while a target is
  // being engaged the bot holds ground and strafes (movement-under-fire, scaled by botLevel);
  // once nothing is visible, control reverts to path-following patrol. Aim/fire and navigation
  // never run in the same tick against the same held-keys array by accident — this function is the
  // only place they are merged.
  function driveBotFrame(session, liveSessions, tick) {
    if (!session._ai) {
      session._ai = {
        targetId: null, targetLockTicks: 0, lastSeenTick: tick, acquiredTick: tick,
        aimNoiseYaw: 0, aimNoisePitch: 0,
        path: null, nextRepathTick: 0,
        strafeDir: 0, strafeUntilTick: 0,
        lastTeleportTick: -1e9, lastImpulseTick: -1e9,
      };
    }
    const ai = session._ai;
    const dtSeconds = TICK_MS / 1000;
    const curve = botDifficulty.curveForLevel(session.botLevel);

    // Simulated network delay for HITSCAN resolution (see BOT_SIM_LATENCY_MS) — the actual gun/melee
    // lag-comp rewind (withLagComp) is keyed off these two fields for every shooter, real or bot; a
    // real client sets them from its own reported previousServerTick/currentServerTick on every
    // packet (see the WS message handler), which a bot's manufactured input never goes through. Set
    // every tick, not only when about to fire, so they are always fresh the moment a shot does land —
    // matching a real client, which reports its view continuously regardless of whether it's firing.
    if (BOT_SIM_LATENCY_MS > 0) {
      const latencyTicks = _botSimLatencyTicks();
      session.playerState._viewServerTick = tick - latencyTicks;
      session.playerState._viewPrevServerTick = tick - latencyTicks - 1;
    }

    const { current } = _updateBotTarget(session, liveSessions, curve, tick);

    // Sword bots run their own combat frame (rush/melee/teleport/impulse — see _swordCombatFrame)
    // instead of the gun bots' plant-and-strafe branch below. It computes aim internally, so the
    // shared _aimAndFire call further down must be SKIPPED here — calling it twice in the same tick
    // would advance the aim-noise random walk twice, silently doubling its drift rate.
    if (session.isSwordBot && ai.targetId) {
      const sw = _swordCombatFrame(session, curve, current, tick, liveSessions);
      return [dtSeconds, [sw.held, sw.pressed, sw.released, sw.lookDelta]];
    }

    const { lookDelta: aimLook, fire } = _aimAndFire(session, curve, current, dtSeconds, tick);

    let held = [];
    let pressed = [];
    let lookDelta = aimLook;
    // Gated on ai.targetId (ENGAGED), not `current` (visible THIS tick): a target that just ducked
    // behind cover for a moment is still being engaged during its drop-grace window (see
    // _updateBotTarget's targetDropMs), and the bot should hold its ground waiting to reacquire, not
    // immediately resume patrol navigation. Falling through to _navigate here was an actual bug found
    // by watching two live bots fight — one wandered away mid-engagement during a brief LOS gap and
    // never came back, which _aimAndFire's graceful "no target this tick" null-handling was masking.
    if (ai.targetId) {
      if (tick >= (ai.strafeUntilTick || 0)) {
        ai.strafeDir = Math.random() < curve.strafeProbability ? (Math.random() < 0.5 ? -1 : 1) : 0;
        ai.strafeUntilTick = tick + 20 + Math.floor(Math.random() * 20);   // re-roll every 1-2s
      }
      if (ai.strafeDir > 0) held.push(3);
      else if (ai.strafeDir < 0) held.push(2);
      // Strafe-jumping while shooting: a LEVEL 5+ trait, not a stat — low levels plant their feet
      // and spray (the "movement under fire" axis bottoming out at strafeProbability alone), while a
      // sharp bot adds sprint (faster lateral movement) and the occasional jump on top of the SAME
      // strafe key, making it a genuinely harder target without touching HP/damage/speed stats.
      // Only while actually strafing (not standing dead still) and only while grounded. Jump (4)
      // goes in the wire's `pressed` slot — see _navigate's identical jump line for why (the
      // extracted physics's entire jump gate is `Qkovvb8.has(4)`, built straight from this array).
      if (curve.level >= 5 && ai.strafeDir !== 0) {
        held.push(7);   // sprint
        if (session.playerState.grounded && Math.random() < COMBAT_JUMP_CHANCE) pressed.push(4);
      }
    } else {
      const nav = _navigate(session, tick);
      held = nav.held;
      pressed = nav.pressed;
      lookDelta = nav.lookDelta;
    }
    if (fire) held.push(5);

    return [dtSeconds, [held, pressed, [], lookDelta]];
  }

  // Feeds every bot session exactly one input batch per server tick, in the SAME
  // { clientTick, frames } shape enqueueClientInput builds from a real network packet — so
  // processBufferedTick cannot tell a bot's input from a real client's. Called once per global
  // tick, before the physics-integration loop drains every session's queue.
  function driveBots(liveSessions) {
    for (const s of liveSessions.values()) {
      if (!s || !s.accepted || !s.isBot) continue;
      s.inputQueue.push({ clientTick: ++s._botClientTick, frames: [driveBotFrame(s, liveSessions, globalTick)] });
      s.lastClientTick = s._botClientTick;
      s._lastInputMs = Date.now();
    }
  }

  // Resolves the REAL client address for every per-IP protection (maxConnectionsPerIp,
  // maxConnAttemptsPerMin). Production runs Caddy in front (deploy/README.md: `reverse_proxy
  // 127.0.0.1:8080` for TLS termination) — so req.socket.remoteAddress is ALWAYS Caddy's own
  // loopback address for every real player, and without this every per-IP limit silently degrades
  // into one shared bucket for the ENTIRE server (maxConnectionsPerIp=6 becomes a 6-PLAYER-TOTAL
  // cap, not 6-per-address; maxConnAttemptsPerMin=30 becomes 30 CONNECTIONS TOTAL per minute for
  // every player combined). Found live: every session in a real test session logged
  // "connection from 127.0.0.1:port" regardless of the player's actual origin.
  //
  // Only trusted when the IMMEDIATE TCP peer is loopback — i.e. the connection genuinely came
  // through our own local Caddy, not directly from the internet. Port 8080 is ALSO reachable
  // directly (deploy/provision.sh exposes it publicly, for clients that can't use wss://), and a
  // connection made that way could set X-Forwarded-For to anything it likes to spoof its way past
  // a per-IP limit — a direct connection's own remoteAddress is unspoofable at the TCP level, so
  // that path never even looks at the header.
  function _resolveRemoteIp(req) {
    const direct = req.socket.remoteAddress || "unknown";
    const isLoopback = direct === "127.0.0.1" || direct === "::1" || direct === "::ffff:127.0.0.1";
    if (isLoopback) {
      const xff = req.headers["x-forwarded-for"];
      if (typeof xff === "string" && xff.trim()) {
        const first = xff.split(",")[0].trim();
        if (first) return first;
      }
    }
    return direct;
  }

  wss.on("listening", () => {
    console.log(`[evio-local] listening on ws://${HOST}:${PORT}`);
    console.log(`[evio-local] movement config walk=${WALK_SPEED.toFixed(3)} run=${RUN_SPEED.toFixed(3)} scale=${SPEED_SCALE} tickMs=${TICK_MS}`);
    console.log(`[evio-local] protocol compat customSlide=v3 opcodes=142(Q2r3ysn),151(Qkm4yk4) globalGameLoop=1`);
    console.log(`[evio-local] netcode tickModel=${TICK_MODEL} inputBufferDepth=${INPUT_BUFFER_DEPTH} maxCatchup=${INPUT_BUFFER_MAX_CATCHUP} echoLag=${ECHO_LAG_TICKS} lagComp=${LAGCOMP ? "on(shift=" + LAGCOMP_INTERP + ")" : "off"} subframeShot=${SUBFRAME_SHOT ? "on" : "off"} clientRay=${CLIENT_RAY ? "on" : "off"} lastHitInfo=${LASTHITINFO_EVENTS ? "on" : "off"} playerMap=${PLAYERMAP_EVENTS ? "on" : "off"} fireRate=per-weapon×${FIRE_COOLDOWN_SCALE}`);
    console.log("[evio-local] local-only research server; do not point production clients/services at this");
  });

  // Named (rather than inline in wss.on) so the netlib transport adapter can feed it peer
  // connections through the exact same admission/session/physics-registration path as a real
  // WebSocket connection — see startNetlibListener's onConnection callback below. Nothing in this
  // function's body changed; only its declaration form did.
  function handleConnection(ws, req) {
    // Connection-RATE admission, before anything else — including setNoDelay — so a flood of
    // attempts pays for as little as possible before being refused. This is independent of
    // maxConnectionsPerIp (concurrent count): see the setting's own comment for why both are needed.
    const attemptIp = _resolveRemoteIp(req);
    if (!_connectionAttemptAllowed(attemptIp)) {
      try { ws.close(4007, "connection rate exceeded"); } catch (_) {}
      return;
    }
    // Graceful shutdown in progress (see beginGracefulShutdown) — refuse new joins so the player
    // count can actually reach zero instead of the drain window being refilled by new arrivals.
    if (_live.draining) {
      try { ws.close(4008, "server restarting, please rejoin shortly"); } catch (_) {}
      return;
    }

    // Disable Nagle. TCP defaults to coalescing small writes: it holds a small packet until the
    // previous one is ACKed, so with a 20Hz stream of small msgpack frames a tick can sit in the
    // send buffer waiting for an ACK that is itself delayed by the receiver's delayed-ACK timer.
    // The classic Nagle + delayed-ACK interaction adds up to ~40ms to affected packets — on a 50ms
    // tick that is close to a whole tick of latency, and it lands unevenly, which reads as jitter
    // rather than lag. Every real-time game over TCP turns this off.
    try { req.socket.setNoDelay(true); } catch (_) {}
    const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;

    // ── Admission control ───────────────────────────────────────────────────
    // Refuse before allocating a session, a physics state and a place in the tick loop. Closing
    // with a 4xxx application code (rather than dropping the socket) lets the client report it.
    const remoteIp = attemptIp;
    if (sessions.size >= MAX_PLAYERS) {
      console.warn(`[evio-local] refusing ${remote}: server full (${sessions.size}/${MAX_PLAYERS})`);
      try { ws.close(4001, "server full"); } catch (_) {}
      return;
    }
    let fromThisIp = 0;
    for (const s of sessions.values()) if (s && s.remoteIp === remoteIp) fromThisIp++;
    if (fromThisIp >= MAX_CONN_PER_IP) {
      console.warn(`[evio-local] refusing ${remote}: ${fromThisIp} connections already from this address`);
      try { ws.close(4002, "too many connections from this address"); } catch (_) {}
      return;
    }

    // Heartbeat liveness. `pong` arrives automatically in reply to our ping; the sweep below drops
    // anything that missed the previous round.
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    // Join deadline (see joinDeadlineSeconds). Cleared when the join arrives and on close.
    let joinTimer = null;
    if (JOIN_DEADLINE_SEC > 0) {
      joinTimer = setTimeout(() => {
        if (!ws._evioAccepted) {
          console.warn(`[evio-local] refusing ${remote}: no join within ${JOIN_DEADLINE_SEC}s `
            + `— closing (held a player slot without playing)`);
          try { ws.close(4004, "join timeout"); } catch (_) {}
        }
      }, JOIN_DEADLINE_SEC * 1000);
      joinTimer.unref?.();
    }
    const clearJoinTimer = () => { if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; } };
    // Include sequence suffix to prevent same-ms collision when two tabs connect
    // simultaneously — Date.now() alone returns the same value within 1ms.
    const sessionId = `local-${Date.now().toString(36)}-${(++_sessionSeq).toString(36)}`;
    let accepted = false;
    // Must match the ID assigned by the WebSocket wrapper. The ev.io client
    // constructs the game adapter with d.Qgggv79, which is parsed from the
    // server's initial "ID..." string (bundle.pretty.js:17179-17185 and
    // 68199-68207). If player entities are keyed by join.uid instead, the
    // local-player lookup fails and HUD/gameplay state never becomes active.
    let playerId = sessionId;
    let lastClientTick = -1;
    let lastClientPreviousServerTick = -1;
    let lastClientCurrentServerTick = -1;
    let inputFrameCount = 0;
    const spawnIndex = sessions.size;
    // Spawns of the map that is actually loaded (see activeSpawnPoints), cycled so two players
    // get spawn[0] and spawn[1], etc.
    const spawnPoints = activeSpawnPoints();
    const sp = spawnPoints[spawnIndex % spawnPoints.length];
    const playerState = createPlayerSimState({
      x: sp.x, y: sp.y, z: sp.z,
      yaw: (sp.yaw * Math.PI / 180),  // convert degrees → radians
    }, sessionId);
    const session = {
      ws,
      sessionId,
      playerId,
      playerState,
      connectedAt: Date.now(),   // admin dashboard: connection age
      remoteIp,                  // per-IP connection cap
      _msgWindowStart: 0,        // inbound rate limiter (token bucket — see the message handler)
      _msgTokens: 0,
      _msgCount: 0,              // lifetime count, for diagnostics only
      // Ticks this player's input queue has been empty. Past IDLE_SIM_GRACE_TICKS the server
      // simulates them with no input so a backgrounded tab does not freeze them in the world.
      _idleTicks: 0,
      _idleSimStartTick: 0,
      displayName: `local-${playerId}`,
      // Real ev.io uid bridged from the client join (defaults to guest 17 until the
      // join arrives). Used for opcode 231 so peers/self carry a real identity.
      uid: 17,
      // Selected primary weapon (= abilityLoadoutId, opcodes 125/126/127/135). Bridged
      // from the join; default 4 (Auto Rifle, = client defaultPrimaryWeapon) — or the sword
      // in sword-only mode, where the bridged loadout is overridden anyway.
      weaponId: SWORD_ONLY ? SWORD_WEAPON_ID : 4,
      // Equipped body-skin nid + its resolved .evskin URL. There is NO player opcode
      // for skins; the URL (resolved client-side from the account + skins catalogue) is
      // bridged in the join and relayed via the client's native '~3' prop-roster event
      // so every client populates its own getPlayerProps store for self + peers.
      skinTargetId: null,
      skinUrl: null,
      // Scoreboard / kill-feed cosmetics, bridged from the account by the userscript.
      //   thumbUrl   -> prop Qaalbed  (avatar image in BOTH the scoreboard and the kill feed)
      //   skinRarity -> prop Qy58vo2  (CSS class on the avatar frame)
      //   clanImgUrl -> opcode 235    (clan insignia image)
      //   clanLink   -> prop Q3ap9pp  (clan insignia link; the insignia needs BOTH)
      thumbUrl: null,
      skinRarity: null,
      clanImgUrl: null,
      clanLink: null,
      // Equipped weapon-skin model URLs, keyed by the OBFUSCATED getPlayerProps field the
      // renderer reads per weapon (Qcdgi7s/Qy8jpjd/Qclpb4q/Qb9vw3f/Ql3d4qw/Q53m0bo). Resolved
      // client-side (account field_<weapon>_skin -> catalogue field_model) and relayed via '~3'.
      weaponSkins: null,
      // Ability loadout array (weaponStateArray / field_abilities_loadout). Bridged from
      // the join; drives the computed weaponStats (jump/sprint/teleport/switch/reload) and
      // is emitted as opcode 93 so the client sees which active abilities are equipped.
      abilitySeed: null,
      // Ticks remaining to re-splice a live loadout-change delta (RPC 6/7) into this
      // player's tick body, so a mid-match weapon/ability swap applies without respawn.
      loadoutDeltaSendCount: 0,
      teamId: 0,
      tick: globalTick,
      accepted: false,
      lastClientTick: 0,
      lastClientPreviousServerTick: -1,
      lastClientCurrentServerTick: -1,
      // ── Buffer tick model ───────────────────────────────────────────────
      // FIFO of pending client-tick input batches: { clientTick, frames }.
      // The server tick drains this toward INPUT_BUFFER_DEPTH, advancing the
      // authoritative sim one client tick per batch.  lastProcessedClientTick is
      // what we echo (it lags the newest received tick by ~buffer depth, keeping
      // it inside the client's prediction ring).
      inputQueue: [],
      lastProcessedClientTick: -1,
      // Tracks which globalTick value this player last received via an input-paced
      // immediate-response tick. Set to globalTick+1 (the upcoming tick) when the
      // message handler integrates + sends immediately after receiving input.
      // runGlobalTick skips re-integrating this player when lastInputTick === globalTick.
      lastInputTick: -1,
      // Global tick when this session was accepted. The global loop skips sending
      // to this player until globalTick - joinedAtTick >= TICK_WARMUP (reconciler
      // warmup guard — see comment near TICK_WARMUP above).
      joinedAtTick: -1,
      // ── Queued peer bootstrap deltas ───────────────────────────────────────
      // broadcastPeerSpawn previously sent a SEPARATE packet with the same
      // serverTick the recipient just received (recipient.tick == globalTick).
      // Two packets sharing the same serverTick arrived within one render frame
      // (<16 ms) — the second one exhausted the reconciler ring → crash →
      // teleport + frozen peers.
      //
      // Fix: instead of sending immediately, we queue the peer bootstrap opcode
      // delta here.  The next regular tick (global-loop or input-paced) splices
      // it into the body before the 280 gamePhase marker, so the introduction
      // travels inside a packet with a monotonically advancing serverTick.
      // Set at round start: the next global tick sends a COMPLETE first-spawn body instead of a
      // movement tick, because a map reload wipes the client's entities (see the send path).
      pendingFullBootstrap: false,
      pendingPeerBootstraps: [],
      // Departed peers to delete on this client (playerId → ticksRemaining). Drained by
      // flushPendingPeerRemovals into `244, -1, <playerId>` markers for a few ticks.
      pendingPeerRemovals: new Map(),
    };
    sessions.set(sessionId, session);

    console.log(`[evio-local] connection from ${remote}; session=${sessionId}`);
    safeSend(ws, `ID${sessionId}`);

    ws.on("message", (data, isBinary) => {
      // Inbound rate limit as a TOKEN BUCKET, not a fixed one-second window.
      //
      // The window version disconnected real players. A browser throttles a background tab's timers
      // and then, on return, the client catches up — flushing everything it buffered while hidden in
      // one burst. That is a legitimate client doing a legitimate thing, and a hard per-second cap
      // counts it as a flood: background the tab for a few seconds, come back, get kicked.
      //
      // A bucket separates the two cases properly. Tokens refill at MAX_MSG_PER_SEC and the bucket
      // holds MSG_BURST_SECONDS worth, so a catch-up burst spends saved capacity and is fine, while a
      // client that sustains an over-rate has nothing left to spend and is closed. Disconnect rather
      // than silently drop: quietly discarding input presents as an unexplained desync, which is much
      // harder to diagnose than a close code.
      const nowMs = Date.now();
      if (!session._msgWindowStart) {
        session._msgWindowStart = nowMs;
        session._msgTokens = MAX_MSG_PER_SEC * MSG_BURST_SECONDS;
      }
      const elapsedS = (nowMs - session._msgWindowStart) / 1000;
      if (elapsedS > 0) {
        session._msgWindowStart = nowMs;
        session._msgTokens = Math.min(MAX_MSG_PER_SEC * MSG_BURST_SECONDS,
          (session._msgTokens || 0) + elapsedS * MAX_MSG_PER_SEC);
      }
      if (session._msgTokens < 1) {
        console.warn(`[evio-local] ${sessionId} sustained over ${MAX_MSG_PER_SEC} msg/s `
          + `(burst allowance ${MSG_BURST_SECONDS}s spent) — disconnecting`);
        try { ws.close(4003, "message rate exceeded"); } catch (_) {}
        return;
      }
      session._msgTokens -= 1;
      session._msgCount = (session._msgCount || 0) + 1;
      if (!isBinary) {
        const text = data.toString("utf8");
        logHeldFrame(session, "text", describeTextFrame(text));
        // Live loadout/skin change pushed by the userscript when the player edits their
        // loadout in-game (the client re-fetches /me; the userscript forwards the new one).
        if (text.lastIndexOf("#EVL#", 0) === 0) {
          applyLiveLoadout(session, playerState, text.slice(5), sessions);
          return;
        }
        // Client-supplied shot ray: "#SHOT#ox,oy,oz,dx,dy,dz" — the EXACT ray the client fired,
        // queued and consumed FIFO when the server fires this player's shot (see fireWeapon).
        if (text.lastIndexOf("#SHOT#", 0) === 0) {
          enqueueClientRay(playerState, text.slice(6));
          return;
        }
        // ── Client signals ('!' + code) ──────────────────────────────────────
        // Signal 4 is the client telling us it has TORN DOWN its game state and needs a full
        // resend. It fires from sendInputFrame when predictState returns null:
        //     if (null === l) return canSendInput = false, isGameActive = false, sendSignal(4)
        // which is exactly what a map-generation change causes (Qrn6ykl -> predictState null).
        // Until we answered this the client sat inactive: no input, empty entities, so peers were
        // invisible and the local player could not shoot. Answer it with a full re-bootstrap.
        if (text.startsWith("!")) {
          handleClientSignal(session, parseInt(text.slice(1), 10));
          return;
        }

        // ── Lobby intent bridge ('@' + verb) ─────────────────────────────────
        // The official protocol does NOT carry the play/spectate click: the client's handler
        // (Qxobfsk) tears down its menu and locks the pointer, and sends nothing. Inferring it from
        // input was tried and failed in both directions — releasing on any packet let the client's own
        // menu traffic force players in after half a second, and requiring "intent" left players stuck
        // on the arrival screen because a click alone produces no input.
        //
        // So the userscript reports the click explicitly, the same way it already bridges identity and
        // loadout. This is a signal the protocol genuinely lacks, not a workaround for one we mishandle.
        if (text.startsWith("@")) {
          handleLobbyIntent(session, text.slice(1).trim().toLowerCase());
          return;
        }

        if (text.startsWith("`")) {
          // EVERY backtick request MUST get exactly one backtick response.
          //
          // The client's real sendEvent (NetSyncClient.sendEvent, bundle :27531) is a SERIAL
          // promise queue:
          //   this.eventQueue = this.eventQueue.then(() => new Promise((resolve) => {
          //       socketApi.onEventResponse = resolve;   // resolves ONLY on a server reply
          //       socketApi.sendEvent(code, arg);
          //   }));
          // An unanswered request therefore never resolves AND blocks every later sendEvent
          // behind it — permanently. That is why the HUD ping froze: measureLatency() awaits
          // sendEvent('8'), so once the queue stalls `#ping_span` is never written again and
          // keeps ev.io's static placeholder.
          //
          // handleLoadoutRpc used to consume codes 6/7 and `return` without replying, which
          // stalled the queue for the rest of the session. It now runs for its side effects
          // only, and handleBacktickRpc always sends the response.
          handleLoadoutRpc(session, playerState, text);
          // Chat / emotes (event code 4). Handled here rather than in handleBacktickRpc because it
          // needs the session + the full session map to broadcast. handleBacktickRpc still ACKs so
          // the client's serial event queue advances (see the invariant above).
          const _ct = text.indexOf("`", 1);
          if (_ct > 0 && text.slice(1, _ct) === "4") {
            let _arg = null;
            try { _arg = JSON.parse(text.slice(_ct + 1) || "0"); } catch (_) { _arg = null; }
            try { handleChatEvent(session, sessions, _arg); } catch (e) { console.error("[evio-local] chat error:", e && e.message); }
          }
          handleBacktickRpc(ws, text);
          return;
        }

        const join = parseJoinMessage(text);
        if (join) {
          const redacted = redact(join);
          console.log(`[evio-local] join/control: ${JSON.stringify(redacted)}`);

          if (!accepted) {
            accepted = true;
            session.accepted = true;
            ws._evioAccepted = true;
            clearJoinTimer();
            session.joinedAtTick = globalTick; // warmup guard: skip ticks until globalTick - joinedAtTick >= TICK_WARMUP
            // The new joiner's own bootstrap (buildPeerBootstrapDelta -> buildFirstSpawnBody,
            // state_builder.js) hardcodes every EXISTING peer's kills/deaths/score/assists/streak to
            // 0 — today that self-corrects within one tick because appendPlayerTickBody sends those
            // fields unconditionally every tick. Once they are send-on-change (see _statsSendCount),
            // an existing player whose stats simply haven't changed recently would otherwise leave
            // the new joiner stuck seeing 0 for them until their next kill/death. Force everyone's
            // reliability window open for a few ticks so the new joiner gets caught up promptly,
            // same cost as the existing weaponSendCount pattern this mirrors.
            for (const s of sessions.values()) {
              if (s && s.playerState) s.playerState._statsSendCount = STATS_SEND_RELIABILITY_TICKS;
            }
            // Adopt the client's real ev.io identity from the join payload. The official
            // join always carries `uid` (l.Qwhs9ib.uid[0].value); the userscript bridge
            // augments it with the real account `name` (and later loadout/skin). The
            // `token`/`adminPass` are secrets — never read, stored, or echoed (redact()).
            if (join && typeof join.name === "string" && join.name.trim()) {
              session.displayName = join.name.trim().slice(0, 32);
            }
            if (join && Number.isFinite(join.uid)) {
              session.uid = join.uid;
            }
            // Guests get a numbered name, the way the official server does: every guest shares the
            // one account (uid 17) and would otherwise appear as an indistinguishable row of
            // "Guest" on the scoreboard and in the kill feed. The number is assigned HERE rather
            // than by the client because it has to be unique across the lobby, which only the
            // server can see — and a client-chosen name could collide or be spoofed.
            if (session.uid === GUEST_UID && isGuestName(session.displayName)) {
              session.displayName = allocateGuestName(sessions);
            }
            if (join && Number.isFinite(join.abilityLoadoutId) && join.abilityLoadoutId > 0) {
              session.weaponId = resolveLoadoutWeapon(join.abilityLoadoutId);
              // Point the magazine at the joined primary gun so the per-tick weaponSlots stream emits
              // the right weapon + a full clip from the first tick (default was 4 / Auto Rifle).
              if (session.weaponId !== 262) {
                playerState.equippedWeaponId = session.weaponId;
                playerState.weaponList = [session.weaponId, 262];
                playerState._ammoGunId = session.weaponId;
                playerState.gunAmmo = weaponClip(session.weaponId, playerState);
                playerState.reloadTicks = 0;
              }
            }
            if (join && Array.isArray(join.abilitySeed) && join.abilitySeed.length) {
              // Sanitise: integer point-counts only (defends the stat computation), and LENGTH-capped
              // before mapping — the array is retained on the session and copied onto the physics
              // state, so an oversized one is per-player memory held for the life of the connection.
              // Out-of-range VALUES are already harmless (the stat table misses and falls back to the
              // base value, verified), so only the length needed bounding.
              //
              session.abilitySeed = _sanitizeAbilitySeed(join.abilitySeed);
              // Apply the loadout to the SERVER's authoritative physics so jump/sprint/
              // teleport-recharge match what we send the client (ps.Qz8l93a = weaponStats).
              // Object.assign keeps any physics-only stat keys not produced by the port.
              if (playerState._ps && playerState._ps.Qz8l93a) {
                Object.assign(playerState._ps.Qz8l93a, computeWeaponStats(session.abilitySeed));
      refreshMagazineCapacity(playerState);   // capacity depends on the stats just applied
                // The teleport cost/charge logic (Qai8iwi/Q94ze8t) reads the loadout array
                // off the physics state to know the teleport level (charges).
                playerState._ps.weaponStateArray = session.abilitySeed;
                console.log(`[evio-local] applied loadout stats: array=[${session.abilitySeed.join(",")}]`);
                console.log(`[evio-local]   sprintLvl=${session.abilitySeed[2] || 0} -> staminaDrain Qbypopp=${playerState._ps.Qz8l93a.Qbypopp} (base .006); jumpPwr=${playerState._ps.Qz8l93a.Qfh4lso} maxJumps=${playerState._ps.Qz8l93a.Q7v2lyo} switchDelay=${playerState._ps.Qz8l93a.Qhswtsz} teleLvl=${session.abilitySeed[0] || 0}`);
              }
            }
            // Initialise the sim weapon state from the real loadout: the player carries
            // the primary gun + the sword (262, matching state_builder's weaponSlots),
            // starting on the primary. Enables server-authoritative weapon switching.
            playerState.equippedWeaponId = session.weaponId;
            playerState.backupWeaponId = -1;
            playerState.weaponList = session.weaponId === 262 ? [262] : [session.weaponId, 262];
            playerState.weaponSendCount = 0;
            if (join && (Number.isFinite(join.skinTargetId) || typeof join.skinTargetId === "string")) {
              session.skinTargetId = join.skinTargetId;
            }
            if (join && typeof join.skinUrl === "string" && join.skinUrl) {
              session.skinUrl = _boundedUrl(join.skinUrl);
            }
            // Avatar + clan cosmetics (see the session-field comments). All optional: a missing
            // value just leaves that prop unsent, which is how the client treats an absent field.
            if (join && typeof join.thumbUrl === "string" && join.thumbUrl) session.thumbUrl = _boundedUrl(join.thumbUrl);
            if (join && typeof join.skinRarity === "string" && join.skinRarity) session.skinRarity = join.skinRarity;
            if (join && typeof join.clanImgUrl === "string" && join.clanImgUrl) session.clanImgUrl = _boundedUrl(join.clanImgUrl);
            if (join && typeof join.clanLink === "string" && join.clanLink) session.clanLink = join.clanLink;
            if (join && join.weaponSkins && typeof join.weaponSkins === "object") {
              // Keep only string URL values keyed by the known obfuscated prop fields.
              const allowed = new Set(["Qcdgi7s", "Qy8jpjd", "Qclpb4q", "Qb9vw3f", "Ql3d4qw", "Q53m0bo"]);
              const ws2 = {};
              for (const [k, v] of Object.entries(join.weaponSkins)) {
                if (allowed.has(k) && typeof v === "string" && v) ws2[k] = v;
              }
              session.weaponSkins = Object.keys(ws2).length ? ws2 : null;
            }
            console.log(`[evio-local] identity: uid=${session.uid} name=${JSON.stringify(session.displayName)} weapon=${session.weaponId} skin=${session.skinTargetId} skinUrl=${session.skinUrl || "(default)"} weaponSkins=${session.weaponSkins ? Object.keys(session.weaponSkins).join(",") : "(none)"}`);
            safeSend(ws, ";1");
            const packet = buildStatePacket({
              tick: globalTick,
              // Bootstrap carries the clock-sync value too — official sends 0 here as well, and
              // a large value would set the client's tick period wrong from its very first frame.
              sync: computeSyncValue(session),
              // Join mid-round: the newcomer's clock must match everyone else's, not restart at 4:00.
              matchTimer: match.timer,
              matchDuration: Math.max(1, Math.round(1000 / TICK_MS)),
              // Join mid-rotation: hand the joiner the CURRENT map + generation, or their loader
              // would fetch a stale map and then reload on the next tick.
              mapUrl: ROUNDS_ENABLED ? currentMapUrl() : undefined,
              mapName: ROUNDS_ENABLED ? currentMapName() : undefined,
              mapImageUrl: ROUNDS_ENABLED ? currentMapThumb() : undefined,
              mapGeneration: ROUNDS_ENABLED ? match.mapGeneration : undefined,
              playerId,
              displayName: session.displayName,
              uid: session.uid,
              // Opcode 235 — the clan insignia IMAGE. The scoreboard renders the insignia only
              // when this AND the Q3ap9pp clan-link prop are both non-null.
              clan: session.clanImgUrl,
              weaponId: session.weaponId,
              abilitySeed: session.abilitySeed,   // opcode 93 + drives computed weaponStats
              teamId: 0,
              // THE FIRST PACKET DECIDES THE CLIENT'S STATE FOR THE WHOLE ARRIVAL. At :66963 the
              // client builds its local-player clone as cloneDeep(x) the first time it has one, and
              // the sync that would later correct it sits inside `if (Qgwgj8p.has(x.Qyxhj60))` — and
              // Qgwgj8p is Set([1,2,3,4]), which excludes 0. So while a player is held, the clone is
              // NEVER re-synced: whatever this packet says, the client believes until it is nulled.
              //
              // This site was missed when the other two bootstraps were gated, and it is the earliest
              // of the three. It sent 1, so the client locked itself to "playing" — first-person
              // camera at the held position, weapon in hand, flyover never selected — and then read
              // and discarded every subsequent 0. Measured as `1 0 0 0 0 …` by diag:joinstate, and as
              // `0×837 1×5` by the browser probe.
              playerState: playerState && playerState._holdForPlay ? PLAYER_STATE_HELD : 1,
              spawn: (playerState && playerState._holdForPlay)
                ? { x: 0, y: 0, z: 0, yaw: 0 }
                : { x: playerState.position.x, y: playerState.position.y, z: playerState.position.z, yaw: playerState.yaw },
              emitPositionYOffset: EMIT_POSITION_Y_OFFSET,
              gamePhase: GAME_PHASE,
              // Optional passive-official structural parity fields. Disabled by
              // default; enable with EVIO_OFFICIAL_BOOTSTRAP_FIELDS=1 for a
              // one-variable experiment.
              officialBootstrapFields: OFFICIAL_BOOTSTRAP_FIELDS,
              // Qaol467.Qsvkg5s.Qcu3hix. The renderer uses this as the
              // custom-map/load-complete fast path: clear the map loading
              // overlay after >50 rendered authoritative ticks instead of
              // the default >150. Keep it in the first spawn packet so the
              // client has the flag before map/scene bootstrap begins.
              // Gravity from the very first packet — see the note at opcode 26 in state_builder.
              gravityPerFrame: (bpw.gameSettings && bpw.gameSettings.Qn0kxxb),
              damageScale: (bpw.gameSettings && bpw.gameSettings.Qbb5ka8),
              customMap: true,
            });
            appendPeerBootstraps(packet[2], sessions, playerId);
            const bytes = sendState(ws, packet);
            const peerCount = Math.max(0, sessions.size - 1);
            console.log(`[evio-local] sent first-spawn packet: bodyOps=${packet[2].length} peers=${peerCount} bytes=${bytes}`);
            broadcastPeerSpawn(sessions, session);
            // Sync the player-prop roster (skins) to everyone via the client's native '~3'
            // event. Resent shortly after to cover the window where the just-accepted
            // client hasn't finished wiring its notification handler (onNotification=y).
            broadcastProfiles(sessions);
            setTimeout(() => broadcastProfiles(sessions), 600);
            setTimeout(() => broadcastProfiles(sessions), 2000);
            // Start (or keep running) the single global game loop now that at
            // least one player is accepted.
            maybeStartGameLoop();
          }
          return;
        }

        console.log(`[evio-local] text: ${text.slice(0, 200)}`);
        return;
      }

      try {
        const decoded = decode(new Uint8Array(data));
        const summary = summarizeClientInputPacket(decoded);
        if (Number.isFinite(summary.clientTick)) {
          lastClientTick = summary.clientTick;
          session.lastClientTick = summary.clientTick;
          playerState._lastClientTick = summary.clientTick;  // grenade Q7k6kqw spawn frame
        }
        if (Number.isFinite(summary.previousServerTick)) {
          lastClientPreviousServerTick = summary.previousServerTick;
          session.lastClientPreviousServerTick = summary.previousServerTick;
          // The OLDER of the two server snapshots the client interpolates between (lag-comp rewind A).
          playerState._viewPrevServerTick = summary.previousServerTick;
        }
        if (Number.isFinite(summary.currentServerTick)) {
          lastClientCurrentServerTick = summary.currentServerTick;
          session.lastClientCurrentServerTick = summary.currentServerTick;
          // The NEWER of the two snapshots the client renders targets between when it fired; lag
          // comp rewinds each victim to lerp(prev, curr, alpha) — see withLagComp / positionAtTickInterp.
          playerState._viewServerTick = summary.currentServerTick;
        }
        inputFrameCount += 1;
        if (shouldLogInputFrame(inputFrameCount, summary)) {
          console.log(`[evio-local] input#${inputFrameCount}: ${JSON.stringify(summary)}`);
        }

        if (TICK_MODEL === "buffer") {
          // Tick-index buffer model: just enqueue this client tick's inputs.  The
          // server tick loop drains the queue and advances the authoritative sim
          // one client tick at a time.  No per-message integrate, no input-paced
          // send — all advancement + broadcast happens at the fixed server tick.
          enqueueClientInput(session, decoded);
          return;
        }

        foldClientInputIntoSim(playerState, decoded);
        // ── Input-paced self tick (hybrid model only) ──────────────────────────
        // Immediately integrate THIS player's physics and send the result back
        // to ONLY this connection. This gives the ev.io client a fast server-ack
        // for its input, which is essential for the prediction reconciler: without
        // it the reconciler never sees its input acknowledged and overrides local
        // prediction with a stale authoritative position → player appears frozen.
        //
        // We do NOT broadcast to other clients here. Peer sync is handled by the
        // global game loop.
        //
        // Why only ONE response per global-tick cycle (lastInputTick !== nextTick):
        //   The ev.io reconciler ring (Qxo2o14) is populated only when Qwhlcfo runs
        //   with an EMPTY Qorty0h queue (the first render frame after bootstrap).
        //   If multiple tick packets arrive in Qorty0h BEFORE that first render
        //   frame, the ring is never initialized → Qak2r7y reads Qxo2o14[0] →
        //   undefined → TypeError → lobby crash / infinite error spam.
        //
        //   Sending only ONE input-paced response per 50ms window is safe because
        //   human players can't produce input that fast AND the TICK_WARMUP guard
        //   for the global loop already provides 150ms of silence after join.
        //   Sub-frames from 60fps clients that arrive within the same 50ms window
        //   are accumulated in _pendingRawFrames and processed by the GLOBAL TICK
        //   (via the hasPendingFrames guard in runGlobalTick), so no physics steps
        //   are lost — they just have up to one global-tick period of additional
        //   latency before the authoritative position is echoed.
        //
        // To avoid double-integration, we mark lastInputTick = globalTick + 1. The
        // global loop's first action is globalTick++, so when it fires it will see
        // lastInputTick === globalTick and skip re-integrating this player.
        if (accepted) {
          const nextTick = globalTick + 1;
          if (session.lastInputTick !== nextTick) {
            session.lastInputTick = nextTick;
            session.tick = nextTick;
            integratePlayerSim(playerState, TICK_MS / 1000, nextTick);
            const body = buildTickBody(playerId, nextTick, playerState, sessions);

            // Flush any pending peer bootstrap deltas + departures into this tick body.
            flushPendingPeerBootstraps(session, body);
            flushPendingPeerRemovals(session, body);
            flushLoadoutDelta(session, playerState, body);

            // Lagged client-tick echo — see global-loop echo + ECHO_LAG_TICKS.
            const echoTick = computeEchoTick(lastClientTick, session);

            session._legacySyncTick = nextTick;
            sendState(ws, [computeSyncValue(session), echoTick, body]);
          }
        }
      } catch (err) {
        console.log(`[evio-local] binary client frame ${data.length} bytes; msgpack decode failed: ${err.message}`);
      }
    });

    ws.on("close", (code, reason) => {
      clearJoinTimer();
      sessions.delete(sessionId);
      // Tell every remaining client to delete this departed player: queue a
      // `244, -1, <playerId>` removal marker (resent a few ticks for reliability).
      // Without this the client keeps the stale peer model + scoreboard entry.
      for (const other of sessions.values()) {
        if (!other || other.playerId === playerId || !other.accepted) continue;
        if (!(other.pendingPeerRemovals instanceof Map)) other.pendingPeerRemovals = new Map();
        other.pendingPeerRemovals.set(playerId, 5);
      }
      // Remove the disconnected player's capsule from the physics world.
      // Must happen AFTER sessions.delete so subsequent _syncPhysWorldCapsules
      // calls don't include this session's stale state.
      if (session.playerState._ps) {
        _physWorldPlayers.delete(session.playerState._ps.Q7q6byi);
        _syncPhysWorldCapsules(null);  // rebuild world capsules without this player
      }
      maybeStopGameLoop();
      console.log(`[evio-local] closed session=${sessionId} remainingSessions=${sessions.size} code=${code} reason=${reason.toString()}`);
    });

    ws.on("error", (err) => {
      console.error(`[evio-local] websocket error session=${sessionId}: ${err.stack || err.message}`);
    });
  }

  // Extension host entry point: background.js reaches a running startServer() instance's
  // handleConnection through this, the same established pattern as _live.spawnBot/.sessions
  // above (there is no module-level handleConnection — startServer()'s closure is the only place
  // it lives).
  _live.handleConnection = handleConnection;
  wss.on("connection", handleConnection);

  // See ALWAYS_RUN_TICK's own comment — defaults off here (NODE_ENV is never "production" in
  // the extension's shimmed process.env), but settable via the admin dashboard if ever wanted.
  if (ALWAYS_RUN_TICK) maybeStartGameLoop();

  // The Node server's own netlib/WebRTC transport (netlib_adapter.js, gated by NETLIB_ENABLED) is
  // not ported here: it exists to let REMOTE browsers reach a server process over the network,
  // which has no meaning inside a browser extension's own service worker — background.js already
  // IS the transport for same-browser-tab hosting (see its chrome.runtime.Port relay), handing
  // connections to handleConnection() directly, one per Port, the identical shape netlib_adapter's
  // wrapPeer() already established (see that file's own comment: "makes a netlib peer look enough
  // like a `ws` WebSocket that this function can't tell the difference").

  // Nothing was catching process-level faults, so any stray throw outside a handler killed the
  // whole server — every player dropped at once with no diagnostic. For a local research server,
  // staying up with a loud log beats dying silently; the tick loop is independently guarded above.
  process.on("uncaughtException", (err) => {
    console.error("[evio-local] UNCAUGHT EXCEPTION (server kept alive):", (err && err.stack) || err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[evio-local] UNHANDLED REJECTION (server kept alive):", (reason && reason.stack) || reason);
  });

  wss.on("error", (err) => {
    console.error(`[evio-local] server error: ${err.stack || err.message}`);
    process.exitCode = 1;
  });

  return wss;
}

// Admin dashboard — on by default, loopback only (see admin_server.js). EVIO_ADMIN=0 disables it.
// Node-only: admin_server.js itself requires http/other Node built-ins esbuild can't bundle for
// the browser, so a bundled require("./admin_server") doesn't fail "module not found" — it throws
// esbuild's own "Dynamic require ... is not supported" at the call site every time bootServer()
// runs, which the try/catch below silently swallowed but still logged as a scary-looking error in
// the extension's console. The extension has its own admin surface entirely (content.js's quick-
// admin panel + admin.html, both hitting background.js's handleAdminRequest directly — no HTTP
// server involved), so this Node-only dashboard has nothing to do there. Real Node always sets
// process.version to a non-empty string; our extension-side shim (background.js) deliberately
// doesn't, so this is a cheap, reliable way to skip the require entirely in the browser.
function _maybeStartAdmin() {
  if (typeof process.version !== "string") return;
  if (process.env.EVIO_ADMIN === "0" || process.argv.includes("--no-admin")) return;
  try {
    require("./admin_server").startAdminServer(module.exports);
  } catch (err) {
    console.error("[evio-admin] failed to start:", err && err.message);
  }
}

// Public liveness endpoint (see health_server.js) — OFF by default so no existing test/local run is
// affected; EVIO_HEALTH=1 opts in. provision.sh sets it for real deploys.
function _maybeStartHealth() {
  if (process.env.EVIO_HEALTH !== "1") return;
  try {
    require("./health_server").startHealthServer(module.exports);
  } catch (err) {
    console.error("[evio-health] failed to start:", err && err.message);
  }
}

// Indirected so tests can exercise beginGracefulShutdown/finishShutdown in-process (same pattern as
// every other test in this file — a real srv.startServer() + real ws clients, not mocks) without a
// real process.exit(0) tearing down the test runner itself. Production never overrides this.
let _exitImpl = (code) => process.exit(code);
function _setExitImplForTest(fn) { _exitImpl = fn || ((code) => process.exit(code)); }

// Settings are written 400ms after a change to coalesce slider drags; an exit inside that window
// would otherwise lose the change that prompted it — both shutdown paths flush first.
function finishShutdown() {
  try { S.flush(); } catch (_) {}
  _exitImpl(0);
}

// SIGTERM is what `systemctl restart`/`stop` sends — the path every real deploy takes. Instead of
// exiting immediately (dropping every connected player mid-match with zero warning, which is what
// happened on every single deploy before this existed), refuse new joins and give whoever's already
// in a real chance to finish naturally.
function beginGracefulShutdown() {
  if (_live.draining) return; // a second SIGTERM while already draining — ignore, keep waiting
  _live.draining = true;
  const activePlayers = () => [...(_live.sessions || new Map()).values()]
    .filter((s) => s && s.playerState);
  const remaining = activePlayers().length;
  if (remaining === 0 || DRAIN_GRACE_SEC <= 0) {
    console.log("[evio-local] graceful shutdown: no grace period needed, exiting now");
    finishShutdown();
    return;
  }
  console.log(`[evio-local] graceful shutdown: draining ${remaining} player(s), `
    + `up to ${DRAIN_GRACE_SEC}s`);
  try {
    adminServerAction("announce",
      `Server restarting in ${DRAIN_GRACE_SEC}s for an update — you'll need to rejoin after.`);
  } catch (err) {
    console.error("[evio-local] graceful shutdown: announce failed:", err && err.message);
  }
  const pollMs = 1000;
  const poll = setInterval(() => {
    if (activePlayers().length === 0) {
      clearInterval(poll);
      clearTimeout(deadline);
      console.log("[evio-local] graceful shutdown: all players left, exiting");
      finishShutdown();
    }
  }, pollMs);
  poll.unref?.();
  const deadline = setTimeout(() => {
    clearInterval(poll);
    console.log(`[evio-local] graceful shutdown: grace period elapsed with `
      + `${activePlayers().length} player(s) still connected, exiting anyway`);
    finishShutdown();
  }, DRAIN_GRACE_SEC * 1000);
  deadline.unref?.();
}
// Test-only reset — _live.draining latches on and beginGracefulShutdown() is a no-op on a second
// call while it's set, which is correct for real SIGTERM handling but would make every test after
// the first one in a shared process see a permanently-draining server.
function _resetDrainStateForTest() { _live.draining = false; }

// Node's require.main === module boots this unconditionally, the instant the file loads — correct
// there (it's a dedicated process whose only job is running the server). WRONG for the extension
// host: game_server.js is reached via the SAME classic-script bundle every importScripts() call
// loads (importScripts() can only run during a service worker's initial top-level evaluation —
// Chrome throws NetworkError on any later/lazy call — so the import itself can't be deferred).
// Auto-starting here would mean the tick scheduler + heartbeat sweep boot on every service-worker
// wake, including a player who only ever browses the lobby list and never hosts. So this is a
// function, exported as bootServer below, instead of self-running — background.js calls it
// exactly once, only when hosting actually starts (see ensureGameServerStarted() there).
let _bootServerCalled = false;
function bootServer() {
  if (_bootServerCalled) return _live.readyPromise;
  _bootServerCalled = true;
  // Wait for the bishop physics world (evmap geometry → capsule world) to finish
  // loading before accepting connections.  bpw.ready resolves in < 1 s (evmap parse
  // + Qart4qz build).  Players that connect while the world is still loading would
  // fall back to the hand-rolled sim, but waiting avoids that edge case entirely.
  // Restore the remembered map BEFORE the socket opens. Doing it after would mean the first players
  // to connect get bootstrapped onto default_map.evmap and then yanked through a generation bump.
  // There are no sessions yet, so switchMap's respawn/re-bootstrap pass is a no-op over an empty map.
  async function loadStartupMap() {
    const want = S.get("startupMap");
    if (!want || want === bpw.activeMapName) return;
    try {
      await switchMap(new Map(), want);
    } catch (err) {
      // A renamed or delisted map must not stop the server booting — fall back to the bootstrap map
      // and say so, rather than dying in a restart loop on a bad saved value.
      console.error(`[evio-local] could not restore saved map "${want}": ${err.message}`);
      console.error(`[evio-local] starting on ${bpw.activeMapName} instead`);
    }
  }

  // SIGINT (Ctrl+C) stays immediate — draining on every local dev restart would make fast
  // iteration painful, and an interactively-killed server has no real players depending on it.
  // SIGTERM (what `systemctl restart`/`stop` sends) goes through the graceful path instead —
  // see beginGracefulShutdown, defined above module scope so tests can call it directly.
  process.on("SIGINT", finishShutdown);
  process.on("SIGTERM", beginGracefulShutdown);

  // Temporary, targeted diagnostic — confirming or ruling out GC as the cause of the tick-overrun
  // breakdowns (see _simSubTimings/_grenadeSubTimings) that showed cost landing in a DIFFERENT phase
  // each time despite identical work, the classic GC-pause signature. Using perf_hooks' GC observer
  // instead of the --trace-gc CLI flag: that flag needs a systemd unit edit (ExecStart or
  // NODE_OPTIONS), which needs sudo beyond the 4 scoped systemctl verbs this deploy user has — the
  // observer needs only a normal code deploy through the existing pipeline, and gives structured,
  // timestamped, journald-visible pause durations directly comparable to the TICK OVERRUN log lines.
  // perf_hooks is a real Node built-in — esbuild can't bundle it for the browser target at all,
  // so a bundled require("perf_hooks") doesn't throw a normal "module not found", it throws
  // esbuild's own "Dynamic require ... is not supported" at the call site every time bootServer()
  // runs, which the try/catch below silently swallowed but still logged as a scary-looking error
  // in the extension's console. Real Node always sets process.version to a non-empty string; our
  // extension-side shim (background.js) deliberately doesn't, so this is a cheap, reliable way to
  // skip the require entirely in the browser instead of attempting and catching it every time.
  if (typeof process.version === "string") {
    try {
      const { PerformanceObserver, constants } = require("perf_hooks");
      const KIND_NAMES = { 1: "scavenge", 2: "markSweepCompact", 4: "incrementalMarking", 8: "weakCB" };
      const gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 10) {
            console.warn(`[evio-gc] kind=${KIND_NAMES[entry.kind] || entry.kind} `
              + `duration=${entry.duration.toFixed(1)}ms at ${new Date().toISOString()}`);
          }
        }
      });
      gcObserver.observe({ entryTypes: ["gc"] });
    } catch (err) {
      console.error(`[evio-local] GC observer failed to start (diagnostic only, non-fatal): ${err.message}`);
    }
  }

  // Captured (rather than left as a floating chain) and exported as `serverReady` below —
  // background.js can't just await physicsWorld.ready itself and assume startServer() has run by
  // then: that promise has TWO .then()s attached to it (this one and background.js's own
  // "physics world ready" log), and per-microtask ordering the SECOND one attached can run before
  // this chain's own .then(loadStartupMap) continuation reaches startServer(). Awaiting this
  // specific promise instead is the only correct way to know _live.handleConnection exists yet.
  _live.readyPromise = bpw.ready
    .then(loadStartupMap)
    .then(() => {
      console.log("[evio-local] extracted physics world ready — starting server");
      startServer();
      // Applies a nonzero botCount from an env var or a saved settings.local.json — the setting's
      // own onChange fired before _live.spawnBot existed (see the "Bot count / level settings"
      // section) and no-opped for exactly that reason, same as loadStartupMap above needing an
      // explicit call rather than relying on startupMap's onChange.
      reconcileBotCount();
      reconcileSwordBotCount();
      _maybeStartAdmin();
      _maybeStartHealth();
    })
    .catch((err) => {
      console.error("[evio-local] bishop physics world failed to load:", err);
      console.error("[evio-local] falling back to hand-rolled sim — starting server anyway");
      startServer();
      reconcileBotCount();
      reconcileSwordBotCount();
      _maybeStartAdmin();
      _maybeStartHealth();
    });
  return _live.readyPromise;
}

const serverExports = {
  // Extension host entry points (sim/entry.js / background.js) — see the _live.readyPromise /
  // _live.handleConnection comments above for why these specifically, not bpw.ready directly.
  // bootServer() must be called once (idempotent — see _bootServerCalled above) before
  // getHandleConnection()/serverReady() mean anything; background.js's ensureGameServerStarted()
  // is the one place that does.
  bootServer,
  // Settings registry (settings.js) — not re-exported by the Node server's own module.exports
  // (admin_server.js requires it directly there), but there IS no "require settings.js directly"
  // option for a browser extension reaching into an already-bundled classic script, so it's
  // exposed here instead for background.js's admin-dashboard message handler.
  settings: S,
  getHandleConnection: () => _live.handleConnection,
  serverReady: () => _live.readyPromise,
  // Graceful shutdown (SIGTERM drain) — exported for test_graceful_shutdown.js.
  beginGracefulShutdown,
  finishShutdown,
  _setExitImplForTest,
  _resetDrainStateForTest,
  // Peer-broadcast position smoothing — exported for test_peer_smoothing.js.
  updateBroadcastPosition,
  peerSmoothCapFor,
  pushReplaySnapshot,
  popReplayTarget,
  // Bot AI internals — exported for test_bot_ai.js so the decision logic can be unit-tested with
  // synthetic sessions, without a running WebSocket/tick loop.
  _yawPitchToward,
  _wrapAngle,
  _botNavGraph,
  _pickWanderGoal,
  _visibleEnemies,
  _visibleEnemiesThrottled,
  _updateBotTarget,
  _aimAndFire,
  _navigate,
  _swordCombatFrame,
  _findGunLineThreat,
  _findExplosiveThreat,
  _bodyRelativeEscapeKeys,
  BOT_ENGAGE_DIST,
  buildFirstSpawnBody,
  buildStatePacket,
  buildTickBody,
  appendPlayerTickBody,
  appendPeerBootstraps,
  buildPeerBootstrapDelta,
  buildPeerSpawnPacketForRecipient,
  broadcastPeerSpawn,
  flushPendingPeerBootstraps,
  createPlayerSimState,
  foldClientInputIntoSim,
  integratePlayerSim,
  parseJoinMessage,
  redact,
  sprintRampSpeed,
  startServer,
  summarizeClientInputPacket,
  summarizeInputFrame,
  // Combat internals — exported for test_combat.js (server-authoritative hitscan loop).
  rayVsPlayerBox,
  applyDamage,
  applyHit,
  tickHealthRegen,
  _pendingMedals,
  MEDAL_KEY,
  awardMedal,
  recordDamager,
  awardAssists,
  processDeathRespawn,
  activeSpawnPoints,
  activeSpawnPoints,
  bounceVelocity,
  grenadeSpeed,
  grenadeFuse,
  grenadeGravity,
  processBufferedTick,
  enqueueClientInput,
  computeEchoTick,
  requestReconcile,
  syncMirrorFromPhysics,
  WEAPON_DMG,
  WEAPON_COOLDOWN,
  WEAPON_KNOCKBACK,
  weaponCooldownTicks,
  armRecoil,
  recordPositionSnapshot,
  positionAtTick,
  positionAtTickInterp,
  firingAlphaFromFrames,
  spawnBullet,
  buildBulletBlock,
  spawnHitEvent,
  buildPlayerMapBlock,
  WEAPON_MELEE,
  // Section 4: damage grenades
  GRENADE_COMBAT,
  GRENADE_ACTIONS,
  GRENADE_TYPE,
  applyExplosionDamage,
  applyExplosionKnockback,
  applyImpulse,
  nearestEnemyWithin,
  enemyCrossingRay,
  dealGrenadeHit,
  destroyMineInLineOfFire,
  disableNearbyGrenades,
  // Fire-mode dispatch (hitscan / multi-pellet / projectile)
  isProjectileWeapon,
  weaponPelletCount,
  fireHitscan,
  fireMelee,
  fireProjectileShot,
  fireShotgunPellets,
  _syncPhysWorldCapsules,
  fireWeapon,
  spawnFiredProjectile,
  pelletDirections,
  // Weapon pickup spawn points
  PICKUP_WEAPON_IDS,
  WEAPON_PICKUP_SIZE,
  processWeaponPickups,
  buildWeaponPickupBlock,
  flushWeaponPickups,
  _grantPickupWeapon,
  _clearPickupSlot,
  _advanceWeaponSlotTracking,
  _clearAllPickupWeapons,
  _resetPickupState,
  PICKUP_HIDE_SENTINEL,
  getPickupState: () => _pickupState,
  // admin dashboard (admin_server.js)
  getStatus,
  adminAction,
  adminServerAction,
  applyAbilityCooldownScales,
  getParityRings: () => {
    const out = {};
    const ss = _live.sessions || new Map();
    for (const s of ss.values()) if (s && s._parityRing && s._parityRing.length) {
      out[s.playerId || s.sessionId] = { name: s.displayName, samples: s._parityRing.slice() };
    }
    return out;
  },
  getActiveEntities: () => activeEntities,
  // clock-sync channel (envelope sync field)
  computeSyncValue,
  // map loading / switching
  switchMap,
  applySpawnCounters,
  handleLobbyIntent,
  lobbyEventInFrames,
  framesHaveEventMap,
  framesShowIntent,
  isIntermission,
  intermissionFreezeTicks,
  _sanitizeAbilitySeed,
  refreshMagazineCapacity,
  MAX_ABILITY_SEED_LEN,
  getSessions: () => _live.sessions || new Map(),
  // Bots — thin wrappers into whichever running startServer() instance is live, same reasoning as
  // getSessions() above. A call before the server has started (no accepted session ever existed)
  // is a caller error, not a state this should silently swallow.
  spawnBot: (opts) => {
    if (!_live.spawnBot) throw new Error("spawnBot: server not started");
    return _live.spawnBot(opts);
  },
  removeBot: (playerId) => {
    if (!_live.removeBot) throw new Error("removeBot: server not started");
    return _live.removeBot(playerId);
  },
  listBots: () => (_live.listBots ? _live.listBots() : []),
  driveBotFrame: (session, liveSessions, tick) => {
    if (!_live.driveBotFrame) throw new Error("driveBotFrame: server not started");
    return _live.driveBotFrame(session, liveSessions, tick);
  },
  mapLoader,
  // round / match lifecycle
  match,
  respawnAll,
  respawnPlayerNow,
  resetSessionInputStream,
  tickMatch,
  startNewRound,
  handleClientSignal,
  creditKill,
  // live loadout/cosmetics push ('#EVL#')
  applyLiveLoadout,
  // in-game chat + emotes (event 4 -> notification 0)
  handleChatEvent,
  broadcastChat,
  escapeChatHtml,
  isGuestName,
  allocateGuestName,
  // scoreboard / kill-feed cosmetics (~3 prop roster)
  buildPropRoster,
  // real weapon DB handed to the extracted sim (client's weaponDb.getSettings() equivalent)
  WEAPON_DB,
  weaponHasZoom,
  // sword-only mode (EVIO_SWORD_ONLY=1)
  SWORD_ONLY,
  SWORD_WEAPON_ID,
  resolveLoadoutWeapon,
  processWeaponSwitch,
  // ammo / reload
  weaponClip,
  weaponReloadTicks,
  preTickFire,
  buildActiveEntityBlock,
  activeEntities,
  clearAllEntities,
  simulateGrenades,
  _entityRemovalRepeat,
  buildActiveEntityBlock,
  simulateGrenades,
  combatConstants: {
    FIRE_COOLDOWN_TICKS,
    DMG_GLOBAL_MULT,
    HEADSHOT_MULT,
    LOBBY_DAMAGE_MULT,
    RESPAWN_TICKS,
    PLAYER_HALF_WIDTH,
    PLAYER_HEIGHT,
    HEAD_Y,
    STAND_EYE_Y,
    CROUCH_EYE_Y,
    INPUT_BUFFER_DEPTH,
    INPUT_BUFFER_MAX_CATCHUP,
    LAGCOMP,
    LAGCOMP_ALPHA,
    LAGCOMP_INTERP,
    FIRE_COOLDOWN_SCALE,
  },
};

export default serverExports;
