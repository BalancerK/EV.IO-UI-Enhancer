"use strict";

// Ports the client's ability-stat pipeline so the server can compute a player's
// weaponStats from their loadout array (weaponStateArray / field_abilities_loadout,
// network opcode 93) instead of sending fixed defaults. Three stages, mirroring the
// bundle (work/client-readable/bundle.renamed.js):
//   1. base = Qamkr2x.Qo1ywyz(gameConfig)   — feature-flag constants × movementSpeedMod
//   2. + Qusynxe(weaponStateArray, base)     — per-level ability stat modifiers (Qumzy1)
//   3. (factory overrides — not modelled here)
// Stat keys are the obfuscated weaponStats fields (opcodes 95-123); see state_builder.

// ── Base weaponStats (Qamkr2x.Qo1ywyz) ─────────────────────────────────────────
// Feature-flag bases: Qfh4lso=.6 (Qn9xxtp), Q7v2lyo=1, Qbypopp=.006 (Qidgoj),
// Qhswtsz=20 (Qube4kk), Q8i9f3s=.7 (Qin39fw), Q6o3kdb=.45 (Q6zowar), Qtgt1xt=1.
// Teleport dist/recharge (Qkrh1tv/Qn97q6u) and all ability-timer recharge rates are 0
// until granted by an ability — that's why an un-allocated power simply never works.
function baseWeaponStats(movementSpeedMod = 1) {
  return {
    Qtgt1xt: 1,        // max health (normalized)
    Qkrh1tv: 0,        // teleport distance
    Q30g2w8: 0,        // abilityTimer1 recharge (smoke/flash)
    Qpe67c9: 0,        // abilityTimer2 recharge (trip mine)
    Qn97q6u: 0,        // abilityTimer3 recharge (teleport)
    Qvhlqt: 0,         // abilityTimer4 recharge (sticky)
    Qli8ip8: 0,        // abilityTimer5 recharge (mine)
    Qr55etv: 0,        // abilityTimer6 recharge (impulse)
    Q3dl2jp: 0,        // flash-grenade flag
    Q3krbfo: 0,        // smoke-grenade flag
    Qcwj9qw: 0,        // HE-grenade flag
    Qv2yox8: 0,        // sticky flag
    Qtwdri6: 0,        // mine flag
    Qxjrmbn: 0,        // trip-mine flag
    Qmytalm: 0,        // impulse flag
    Q7v2lyo: 1,        // max jumps (1 = ground only)
    Qfh4lso: 0.6,      // jump power
    Qbypopp: 0.006,    // stamina drain / tick while sprinting
    Qhswtsz: 20,       // weapon switch delay (ticks)
    Qvven1v: 0,        // reload speed bonus
    Qk0k6ey: 1,        // ammo pickup multiplier
    Qe2qk8v: 1,        // clip size multiplier
    Qpxm6gp: 0,        // hide-foot-trail flag
    Q8i9f3s: 0.7 * movementSpeedMod,   // sprint speed cap
    Qc804je: 0,        // bonus melee damage
    Qak7t2v: 0,        // wall-hanging flag
    Q6o3kdb: 0.45 * movementSpeedMod,  // walk speed
    damageMultiplier: 1,
    Q3kqjty: 0,
  };
}

// ── Qumzy1 ability tables ──────────────────────────────────────────────────────
// index -> { name, skip?, keys:[statKeys per level], vals:[deltas per level] }.
// `skip` (Q5wxq23) abilities are NOT applied here (Extra Ammo / Extra Clip — they act
// as multipliers at pickup/reload time, handled elsewhere). Extracted verbatim from Qumzy1.
const ABILITY_TABLES = {
  0:  { name: "Teleport",   keys: [["Qkrh1tv","Qn97q6u"],["Qkrh1tv","Qn97q6u"],["Qkrh1tv","Qn97q6u"],["Qkrh1tv","Qn97q6u"],["Qkrh1tv","Qn97q6u"]], vals: [[14,0.0048],[14,0.0036],[14,0.0024],[18,0.00205],[25,0.0018]] },
  1:  { name: "Jump",       keys: [["Qfh4lso"],["Qfh4lso","Q7v2lyo"],["Qfh4lso","Q7v2lyo"],["Qfh4lso","Q7v2lyo"],["Qfh4lso","Q7v2lyo"]], vals: [[0.17],[0.17,1],[0.17,2],[0.17,3],[0.17,4]] },
  2:  { name: "Sprint",     keys: [["Qbypopp","Q8i9f3s"],["Qbypopp","Q8i9f3s"],["Qbypopp","Q8i9f3s"],["Qbypopp","Q8i9f3s"],["Qbypopp","Q8i9f3s"]], vals: [[-0.001,0.1],[-0.002,0.2],[-0.003,0.33],[-0.0035,0.4],[-0.004,0.48]] },
  3:  { name: "Quick Draw", keys: [["Qhswtsz"],["Qhswtsz"],["Qhswtsz"]], vals: [[-4],[-8],[-12]] },
  4:  { name: "Quick Load", keys: [["Qvven1v"],["Qvven1v"],["Qvven1v"]], vals: [[3],[6],[9]] },
  // 5 and 6 were skipped as "not implemented". The client defines both (Qwdbjsr = [.25],[.5],[.75],
  // added onto a base of 1) and READS Qe2qk8v to size the magazine: ceil(clipSize * Qe2qk8v) at
  // bundle :34635. Leaving it at 1 gave a player with Extra Clip Size a smaller magazine on the
  // server than on their own screen — they would fire rounds the server did not think they had.
  //
  // Qk0k6ey (pickup size) has no effect here because reserve ammo is infinite on this server, but it
  // is computed anyway so the stats object matches the client's field for field.
  5:  { name: "Extra Ammo Pickup", keys: [["Qk0k6ey"],["Qk0k6ey"],["Qk0k6ey"]], vals: [[0.25],[0.5],[0.75]] },
  6:  { name: "Extra Clip Size",   keys: [["Qe2qk8v"],["Qe2qk8v"],["Qe2qk8v"]], vals: [[0.25],[0.5],[0.75]] },
  7:  { name: "Melee Damage", keys: [["Qc804je"],["Qc804je"],["Qc804je"]], vals: [[10],[20],[30]] },
  8:  { name: "HE Grenade",    keys: [["Qcwj9qw"]],            vals: [[1]] },
  9:  { name: "Smoke Grenade", keys: [["Q30g2w8","Q3krbfo"]], vals: [[0.001,1]] },
  10: { name: "Flash Grenade", keys: [["Q30g2w8","Q3dl2jp"]], vals: [[0.001,1]] },
  11: { name: "Wall Hanging",  keys: [["Qak7t2v"]],           vals: [[1]] },
  12: { name: "Hide Foot Trail",keys: [["Qpxm6gp"]],          vals: [[1]] },
  13: { name: "Sticky Grenade",keys: [["Qvhlqt","Qv2yox8"]],  vals: [[0.002,1]] },
  14: { name: "Mine",          keys: [["Qli8ip8","Qtwdri6"]], vals: [[0.002,1]] },
  15: { name: "Trip Mine",     keys: [["Qpe67c9","Qxjrmbn"]], vals: [[0.002,1]] },
  16: { name: "Impulse Grenade",keys: [["Qr55etv","Qmytalm"]],vals: [[0.00125,1]] },
};

// Per-ability timer (Qi9sd2n) — the abilityTimer (opcode 159+N) the active power drains.
const ABILITY_TIMER = { 0: 3, 8: 0, 9: 1, 10: 1, 13: 4, 14: 5, 15: 2, 16: 6 };
// Per-cast cost (Qoxvbp3[level-1]); timer caps at 1.0 so charges = floor(1/cost).
// VERIFIED against the Qumzy1 ability defs' Qoxvbp3 (bundle): HE & Impulse = [.5] (2 charges),
// smoke/flash/sticky/mine/trip = [1] (1 charge). The MUST match the client exactly — when the server
// drained 0.5 for sticky/mine/trip while the client drained 1.0, the server refilled to throwable in
// HALF the time the client expected → the charge "jumped to 50%" and the cooldown was halved.
const ABILITY_COST = {
  0: [1, 0.5, 0.333, 0.25, 0.2],   // teleport (timer3)
  8: [0.5],                         // HE grenade    (timer0) — 2 charges
  9: [1],                           // smoke grenade  (timer1)
  10: [1],                          // flash grenade  (timer1)
  13: [1],                          // sticky grenade (timer4) — 1 charge
  14: [1],                          // mine           (timer5) — 1 charge
  15: [1],                          // trip mine      (timer2) — 1 charge
  16: [0.5],                        // impulse grenade(timer6) — 2 charges
};

// ── Qusynxe: weaponStateArray + base -> final weaponStats ───────────────────────
function computeWeaponStats(weaponStateArray, movementSpeedMod = 1) {
  const stats = baseWeaponStats(movementSpeedMod);
  if (!Array.isArray(weaponStateArray)) return stats;
  for (const idxStr of Object.keys(ABILITY_TABLES)) {
    const def = ABILITY_TABLES[idxStr];
    if (def.skip || !def.keys || !def.vals) continue;
    const level = (weaponStateArray[Number(idxStr)] | 0) - 1; // points - 1 = level index
    if (level < 0 || level >= def.keys.length) continue;
    const keys = def.keys[level];
    const vals = def.vals[level];
    for (let l = 0; l < keys.length; l++) {
      if (keys[l] in stats) stats[keys[l]] += vals[l];
    }
  }
  return stats;
}

// abilityTimerN recharge rate from the computed stats (w() in the bundle). Timer0 is a
// fixed featureFlag (.002); the rest read their weaponStat.
const TIMER_RATE_STAT = { 1: "Q30g2w8", 2: "Qpe67c9", 3: "Qn97q6u", 4: "Qvhlqt", 5: "Qli8ip8", 6: "Qr55etv" };
function timerRechargeRate(timerIndex, weaponStats) {
  if (timerIndex === 0) return 0.002;
  const k = TIMER_RATE_STAT[timerIndex];
  return k ? (weaponStats[k] || 0) : 0;
}

export {
  baseWeaponStats,
  computeWeaponStats,
  ABILITY_TABLES,
  ABILITY_TIMER,
  ABILITY_COST,
  timerRechargeRate,
};
