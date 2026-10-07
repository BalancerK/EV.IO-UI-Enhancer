"use strict";

// Ported for the browser-extension host (see sim/README.md) — require/module.exports swapped
// for ES import/export, nothing else changed. Same packet-building logic the Node server uses.
import { computeWeaponStats } from "./ability_stats.js";

// Builds local-only server->client MessagePack state packets for the ev.io
// interoperability prototype. Values here are conservative placeholders based
// on static bundle analysis; the goal is decode/render experimentation, not
// production compatibility.

// Sword weapon nid (client featureFlags.Q67s71q). The client's Qgrv502 grants this
// as a second weaponSlot on every spawn, so players dual-wield gun + sword.
const SWORD_WEAPON_ID = 262;

function defaultStats(maxHealth = 100) {
  void maxHealth;
  // Phase 12 passive official capture values from
  // evidence/protocol/phase12_stat_values_extracted.json.
  // These are the player Qz8l93a stat block encoded by opcodes 95-123.
  return {
    Qtgt1xt: 1,
    Qkrh1tv: 14,
    Q30g2w8: 0.001,
    Qpe67c9: 0,
    Qn97q6u: 0.0048,
    Qvhlqt: 0.002,
    Qli8ip8: 0,
    Qr55etv: 0.00125,
    Qcwj9qw: 1,
    Q3krbfo: 1,
    Q3dl2jp: 0,
    Qv2yox8: 1,
    Qtwdri6: 0,
    Qxjrmbn: 0,
    Qmytalm: 1,
    Q7v2lyo: 1,        // max jumps — bundle base is 1 (no double-jump unless Jump ability lvl2+); was 2
    Qfh4lso: 0.77,
    Qbypopp: 0.006,
    Qhswtsz: 12,
    Qvven1v: 3,
    Qk0k6ey: 1,
    Qe2qk8v: 1,
    Qpxm6gp: 0,
    Q8i9f3s: 0.7,
    Qc804je: 0,
    Qak7t2v: 0,
    Q6o3kdb: 0.45,
    damageMultiplier: 1,   // opcode 122 (decoded as weaponStats.damageMultiplier)
    Q3kqjty: 0
  };
}

function pushStats(body, stats) {
  body.push(
    95, stats.Qtgt1xt,
    96, stats.Qkrh1tv,
    97, stats.Q30g2w8,
    98, stats.Qpe67c9,
    99, stats.Qn97q6u,
    100, stats.Qvhlqt,
    101, stats.Qli8ip8,
    102, stats.Qr55etv,
    103, stats.Qcwj9qw,
    104, stats.Q3krbfo,
    105, stats.Q3dl2jp,
    106, stats.Qv2yox8,
    107, stats.Qtwdri6,
    108, stats.Qxjrmbn,
    109, stats.Qmytalm,
    110, stats.Q7v2lyo,
    111, stats.Qfh4lso,
    112, stats.Qbypopp,
    113, stats.Qhswtsz,
    114, stats.Qvven1v,
    115, stats.Qk0k6ey,
    116, stats.Qe2qk8v,
    117, stats.Qpxm6gp,
    118, stats.Q8i9f3s,
    119, stats.Qc804je,
    120, stats.Qak7t2v,
    121, stats.Q6o3kdb,
    122, stats.damageMultiplier,
    123, stats.Q3kqjty
  );
}

function pushVector(body, opcode, x, y, z) {
  body.push(opcode, 0, x, y, z);
}

function buildFirstSpawnBody(options = {}) {
  const playerId = String(options.playerId ?? "local-player");
  const displayName = String(options.displayName ?? playerId);
  const tick = Number.isFinite(options.tick) ? options.tick : 1;
  const teamId = Number.isFinite(options.teamId) ? options.teamId : 0;
  // Real ev.io account uid (opcode 231). 17 = GUEST_UID (all guests share it);
  // logged-in users carry their real Drupal uid. Bridged from the client's join
  // (l.Qwhs9ib.uid[0].value). Drives guest-vs-registered game logic + is the peer's
  // identity. Default 17 (guest) rather than 0 so the client treats it as a valid guest.
  const uid = Number.isFinite(options.uid) ? options.uid : 17;
  // Equipped weapon id = the weapon's drupal nid (the client keys dataById by
  // drupal_internal__nid; bundle line ~43474).  Weapons start at nid 4 — there is NO
  // weapon 0, so weaponId 0 → dataById[0] undefined → NO weapon model renders (peer
  // 3rd-person AND local 1st-person viewmodel).  Default to Auto Rifle (nid 4).
  const weaponId = Number.isFinite(options.weaponId) ? options.weaponId : 4;
  // A player still on the arrival screen gets NO weapon at all. The first-person viewmodel is built
  // from the 135 slots and is visible by DEFAULT, and the code that would hide it lives inside an
  // update chain the client short-circuits for state 0 — so a weapon granted here can never be taken
  // away again. Gating only the per-tick stream was not enough: this bootstrap re-granted it, which is
  // why withholding it there changed nothing on screen.
  const noWeapon = options.playerState === 0 || options.playerState === 2 || options.playerState === 3;
  const maxHealth = Number.isFinite(options.maxHealth) ? options.maxHealth : 100;
  // Stamina + ability timers are NORMALIZED 0..1 (max = featureFlags.Q7qmeag = 1), NOT
  // 0..100. The bootstrap stamina/timer block (158-165) is built as baseStamina × fractions
  // matching the client's spawn init (stamina=1, timer0=.25, timer1/2/4/5/6=.5, timer3=1).
  // Sending 100 made the stamina bar appear never to drain (.006/tick out of 100).
  const baseStamina = Number.isFinite(options.baseStamina) ? options.baseStamina : 1;
  // Qaol467.Qbu40n9. Constructor/default state is pre-game/waiting for several
  // modes; active gameplay branches check for 0. Emit this late in the delta,
  // matching the client encoder/decoder order for opcode 280.
  const gamePhase = Number.isFinite(options.gamePhase) ? options.gamePhase : 0;
  const spawn = options.spawn ?? { x: 0, y: 2, z: 0, yaw: 0 };
  const emitPositionYOffset = Number.isFinite(options.emitPositionYOffset) ? options.emitPositionYOffset : 0;
  const emittedSpawnY = (spawn.y ?? 2) + emitPositionYOffset;
  // weaponStats (opcodes 95-123). When the player's ability loadout array is bridged
  // (weaponStateArray / field_abilities_loadout, also emitted as opcode 93), compute the
  // real per-loadout stats — base feature-flag values + Qusynxe ability modifiers — so
  // jump/sprint/teleport/switch/reload reflect the chosen abilities instead of a fixed
  // capture. With no array we fall back to the legacy defaultStats (= the default loadout).
  const weaponStateArray = Array.isArray(options.abilitySeed) && options.abilitySeed.length
    ? options.abilitySeed
    : null;
  const stats = weaponStateArray
    ? { ...computeWeaponStats(weaponStateArray), ...(options.stats ?? {}) }
    : { ...defaultStats(maxHealth), ...(options.stats ?? {}) };
  const mapUrl = String(options.mapUrl ?? "https://ev.io/sites/default/files/maps/HUT8Bishop.evmap");
  const mapName = String(options.mapName ?? "Bishop");
  const mapImageUrl = String(options.mapImageUrl ?? "https://ev.io/sites/default/files/map_thumbs/BishopThumb.png");
  // lobbyData.gameModeId (opcode 17) — STRING key into the client's gameConfigMap.
  // CRITICAL for weapon rendering: when absent/empty the client falls back to the
  // 'social' hub mode, whose config sets dontShowFPWeapons / dontShowWeaponsOnPlayers /
  // hideWeaponUI / playersSpawnWithNoGun / noShooting all TRUE — so NO weapon model
  // renders (1st-person OR peer) and the weapon UI is hidden, by design. 'deathmatch'
  // leaves those flags at their default (false) → weapons + shooting + UI enabled.
  const gameModeId = String(options.gameModeId ?? "deathmatch");

  // ── Header (everything before the 244 player block) ──────────────────────────────────────
  // ORDER IS LOAD-BEARING AND FAILS SILENTLY. The client decodes a body with ONE forward scan in
  // strictly ASCENDING opcode order; the cursor never rewinds. A single out-of-order opcode makes
  // the scan skip every field it has already passed — AND, if the stall happens before the 244
  // loop, that loop never runs either, so NO player entity is decoded (black screen, "waiting for
  // players", client appears not to join). Two real incidents came from exactly this: putting 42
  // between 7 and 8 dropped the map URL (15), and putting 37 after 42 dropped the whole 244 block.
  //
  // So the header is assembled as an opcode->value MAP and emitted SORTED. Adding a field can no
  // longer break the packet, whatever order it is written in here.
  const header = new Map();
  header.set(1, tick);          // packet/world tick
  header.set(4, tick);          // nested game-state tick
  // 7 Qpm8qez = match time remaining in TICKS (not ms). The per-tick body streams the live value;
  // the bootstrap must agree or the HUD clock jumps on the first tick.
  header.set(7, Number.isFinite(options.matchTimer) ? options.matchTimer : 4800);
  // 8 Qy1p5xf = map GENERATION id; the loader fires when it differs from the last loaded value.
  header.set(8, Number.isFinite(options.mapGeneration) ? options.mapGeneration : 1);
  header.set(15, mapUrl);       // lobbyData.mapUrl consumed by the loading path
  header.set(17, gameModeId);   // lobbyData.gameModeId: combat mode enables weapons/shooting/UI
  header.set(18, mapImageUrl);  // loading-screen thumbnail
  header.set(19, mapName);
  // 42 Qdh8um3 = lobbyData.matchDuration = TICKS PER SECOND (20), despite the name. The HUD formats
  // Qapcs0u(Qpm8qez / matchDuration) as SECONDS. The client already DEFAULTS this to 20 and the
  // official server never sends it, so this is belt-and-braces for a non-20Hz tick rate.
  header.set(42, Number.isFinite(options.matchDuration) ? options.matchDuration : 20);
  // 26 Qsvkg5s.Qn0kxxb = player GRAVITY, per frame. The client's own sim reads this, so a joiner
  // must have it from their very first packet or they fall at a different rate than the server until
  // the next tick body arrives. Omitted when not supplied, leaving the client's own default.
  if (Number.isFinite(options.gravityPerFrame)) header.set(26, options.gravityPerFrame);
  // 27 Qsvkg5s.Qbb5ka8 = global DAMAGE multiplier. The client predicts its own health bar with this,
  // so a joiner needs it immediately or their first hits read wrong before the next tick body lands.
  if (Number.isFinite(options.damageScale)) header.set(27, options.damageScale);

  if (options.officialBootstrapFields) {
    // Optional structural parity pass from passive official-lobby captures. NOTE: opcode 17
    // (gameModeId) is deliberately NOT included — emitting 17,"" here would reset the client to the
    // weapon-less 'social' mode.
    header.set(12, false);
    header.set(13, 0);
    header.set(14, 0);
    header.set(16, 0);
    header.set(25, "");
    header.set(30, 0);
    header.set(35, 0);
    header.set(43, "");
  }

  if (options.customMap) {
    // Qsvkg5s.Qcu3hix: custom-map flag; renderer uses a lower post-load threshold (>50).
    header.set(37, true);
  }

  const body = [];
  for (const op of [...header.keys()].sort((a, b) => a - b)) body.push(op, header.get(op));

  body.push(
    244, playerId,   // Qaol467.Qa7phk3[playerId]
    90, playerId,
    // 91 Qyxhj60 — the player state enum (1 playing / 2,3 spectating / 4 dead). The caller passes it
    // because the BOOTSTRAP is the first state the client ever decodes, and the lobby UI is built from
    // what it says. Hardcoding 1 told every joining player "you are in the match", so the client tore
    // the menu down immediately and no CLICK TO PLAY overlay could ever appear — the per-tick body
    // saying 3 a moment later was too late to matter.
    91, Number.isFinite(options.playerState) ? options.playerState : 1,
    93, Array.isArray(options.abilitySeed) ? options.abilitySeed : [],
  );

  pushStats(body, stats);

  body.push(
    124, "",
    125, weaponId,
    126, weaponId,
    // -1 while held: dataById[-1] is undefined, so no first-person model is built at all.
    127, noWeapon ? -1 : weaponId,
    128, -1,
    129, -1,
    130, -1,

    // Qwf7j5k weaponSlots map: one 135 block per weapon the player carries.
    // The client's own loadout builder (Qgrv502) always grants TWO slots on spawn:
    // the primary weapon (abilityLoadoutId) + the sword (featureFlags.Q67s71q = nid 262,
    // infinite ammo). We replicate that so the player spawns dual-wielding and can switch.
  );

  // The primary (gun) slot is omitted when the loadout IS the sword (sword-only mode), otherwise
  // the sword would be granted twice and the HUD would stack two identical weapon icons.
  if (!noWeapon && weaponId !== SWORD_WEAPON_ID) {
    body.push(
      135, weaponId,        // primary (gun) slot
        132, 999999,        // reserve ammo — >999 so the HUD renders ∞ (bundle :64062); the live
        133, 50,            // magazine + reload come from the per-tick weaponSlots stream (135)
        134, 0,
    );
  }
  if (!noWeapon) body.push(
    135, SWORD_WEAPON_ID,   // sword slot — always granted, infinite ammo
      132, 999999,
      133, 999999,
      134, 0
  );

  pushVector(body, 136, spawn.x ?? 0, emittedSpawnY, spawn.z ?? 0); // position, optionally network-origin-offset
  pushVector(body, 137, 0, 0, 0); // velocity

  body.push(
    138, false,
    139, spawn.yaw ?? 0,
    140, 0,
    141, 0,
    142, false,
    143, false,
    144, false,
    145, 9999,
    // 146 actionTickCounter — 9999 is correct at BOOTSTRAP only ("has never attacked"). The
    // per-tick stream sends the live value instead (local_ws_server appendPlayerTickBody), which
    // is what drives peer slash/fire animations.
    146, 9999,
    147, 9999,
    148, 9999,
    149, 9999,
    150, 9999,
    151, -99999,
    152, -9999,
    155, 1,
    156, 1,
    157, 0,
    158, baseStamina,
    159, baseStamina / 4,
    160, baseStamina / 2,
    161, baseStamina / 2,
    162, baseStamina,
    163, baseStamina / 2,
    164, baseStamina / 2,
    165, baseStamina / 2,
    166, maxHealth,
    167, 0,
    168, 0,
    170, "",
    171, 0,
    172, null,
    173, false,
    174, 9999,
    175, false
  );

  pushVector(body, 176, 0, 0, 0);
  body.push(177, -1);
  pushVector(body, 178, 0, 0, 0);
  pushVector(body, 179, 0, 0, 0);
  pushVector(body, 180, 0, 0, 0);

  body.push(
    // 181 Qalaptp — spawn protection in ticks. The caller passes the live value because a bootstrap
    // IS a spawn: hardcoding the -1 "no protection" default told a joining player they were exposed
    // for the one frame before the first tick body corrected it, and told everyone ELSE the same
    // about them, which is what the shooter's client checks in Q2ngzid.
    181, Number.isFinite(options.spawnProtectTicks) ? options.spawnProtectTicks : -1,
    // 182 Q5vx943 — spectator join countdown. -1 = not queued, which is always true here.
    182, -1,
    185, false,
    186, false,
    187, false,
    188, false,
    189, 0,
    190, 9999,
    191, 0,
    192, 0,
    193, 0,
    194, -9999999,
    195, "",
    196, 0,
    197, 9999,
    198, 0,
    199, -1,
    200, -1,
    201, 0,
    202, -1,
    203, 0,
    204, 0,
    205, false,
    206, -1,
    207, false,
    208, false,
    209, false,
    210, displayName,
  );

  pushVector(body, 211, 0, 0, 0);

  body.push(
    212, displayName,
    214, 0,
    215, 0,
    216, 0,
    217, 0,
    218, 0,
    219, 0,
    220, 0,
    221, 0,
    222, 0,
    223, 0,
    224, 0,
    225, 0,
    226, 0,
    227, 0,
    228, 0,
    229, 0,
    230, 0,
    231, uid,        // playerList[w].uid — real ev.io uid (17=guest); identity for peers + guest/registered logic
    232, teamId,
    234, Array.isArray(options.cosmetics) ? options.cosmetics : [],
    235, options.clan ?? null,
    236, options.extraMeta ?? null,
    237, false,
    238, 1,
    239, false,
    240, false,
    241, null,
    242, 0,
    243, 1,

    // Qaol467.Qbu40n9, decoded after all player/entity blocks.
    // Keep the local bootstrap in active gameplay phase rather than a
    // waiting/intermission phase that can leave the loading/lobby overlay up.
    280, gamePhase
  );

  return body;
}

// Builds a compact 244 entity block carrying ONLY the loadout opcodes (no position),
// for a live mid-match loadout change (RPC 6 setPrimaryWeapon / RPC 7 setAbilityLoadout).
// Spliced into the player's next tick body so the client updates weapon + abilities
// instantly without a respawn/refresh. Opcode order mirrors buildFirstSpawnBody's loadout
// section (93, 95-123, 124-135) so the positional decoder reads it correctly.
function buildLoadoutDelta(options = {}) {
  const playerId = String(options.playerId ?? "local-player");
  const weaponId = Number.isFinite(options.weaponId) ? options.weaponId : 4;
  const equippedWeaponId = Number.isFinite(options.equippedWeaponId) ? options.equippedWeaponId : weaponId;
  const weaponStateArray = Array.isArray(options.abilitySeed) ? options.abilitySeed : [];
  const stats = weaponStateArray.length ? computeWeaponStats(weaponStateArray) : defaultStats();

  // 91 must carry the player's ACTUAL state, not a hardcoded 1. This delta is spliced into a normal
  // tick body, so a wrong value here is indistinguishable from the real thing — and because the client
  // freezes its local-player clone at the first state it sees while held (Qgwgj8p excludes 0, :66963),
  // a single 1 from a join-time loadout RPC locks the arrival view into first person for good. That is
  // exactly what survived gating all three bootstraps: the browser still decoded `0×379 1×7` while an
  // offline join, which sends no loadout RPC, looked perfectly clean.
  const body = [244, playerId, 90, playerId,
    91, Number.isFinite(options.playerState) ? options.playerState : 1];
  body.push(93, weaponStateArray);
  pushStats(body, stats); // 95-123
  body.push(
    124, "",
    125, weaponId,
    126, weaponId,
    127, equippedWeaponId,
    128, -1,
    129, -1,
    130, -1,
  );
  // Opcode 235 = clan insignia IMAGE. Clan data arrives on the SOCIAL socket, which connects
  // independently of (and usually later than) the game join, so it commonly is not known at
  // bootstrap. Re-emitting it here lets the insignia appear mid-match without a rejoin. Only sent
  // when known — the client's scoreboard guard treats null as "no clan" and renders nothing.
  if (typeof options.clan === "string" && options.clan) {
    body.push(235, options.clan);
  }
  if (weaponId !== SWORD_WEAPON_ID) {
    body.push(135, weaponId, 132, 999, 133, 30, 134, 0);   // primary (gun) slot
  }
  body.push(135, SWORD_WEAPON_ID, 132, 999999, 133, 999999, 134, 0); // sword slot — always carried
  return body;
}

function buildStatePacket(options = {}) {
  const tick = Number.isFinite(options.tick) ? options.tick : 1;
  // `sync` is the client's clock-sync input (it becomes lagAccumulator and sets the client's tick
  // period: 50 + sync*2 ms), NOT a tick counter. Official sends 0. Defaulting to `tick` here was
  // wrong — see the computeSyncValue comment in local_ws_server.js.
  const sync = options.sync ?? 0;
  // Use -1 (not 0) as the "no client tick to echo" sentinel.
  // Official server evidence (official_capture_summary_*.json) shows the official
  // server sends echoClientTick=-1 on EVERY packet — including the bootstrap.
  // Sending 0 crashes the client reconciler (Qak2r7y reads Qxo2o14[0] which is
  // undefined before the first render frame populates it, producing the
  // "Cannot read properties of undefined (reading 'Qt03jhz')" loop on localhost).
  const clientTick = options.clientTick ?? -1;
  const body = options.body ?? buildFirstSpawnBody(options);
  return [sync, clientTick, body];
}

export {
  buildFirstSpawnBody,
  buildLoadoutDelta,
  buildStatePacket,
  defaultStats,
};
