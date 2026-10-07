/**
 * map_teleporters.js — map portals, ported verbatim from the client bundle.
 *
 * WHY THIS HAS TO EXIST SERVER-SIDE
 * ─────────────────────────────────
 * The client runs this step itself, inside the same tick as movement, and `justTeleported`
 * (Qgxywsl) is one of the fields the reconciler compares (Qqx5i3b). So a server that does not
 * teleport does not merely "miss a feature" — it disagrees with the client's prediction on both
 * position and a compared boolean the moment anyone walks through a portal, which is exactly the
 * kind of divergence that produces a hard snap.
 *
 * WHERE IT RUNS
 * ─────────────
 * In the client this sits immediately after the movement call `g(...)` and before the
 * out-of-bounds check (bundle :34560). We call it from the same place for the same reason: g()
 * clears Qgxywsl at its start, so setting the flag before movement would erase it.
 *
 * THE DATA comes from the .evmap teleporter section (see physics_world.readTeleporter):
 *   Qdsukt4  position        Quwa9s1  trigger radius
 *   Qrmqlp   yaw in RADIANS  Qcnqzx4  destination teleporter ids
 *   Qrtt124  a GAME MODE name (hub portals that switch lobby instead of moving you). Non-empty
 *            means "do not move the player" — we only raise the flag, exactly like the client.
 */
'use strict';

/**
 * Qvhp9hu (bundle :32508) — the client's deterministic string hash, returning [0,1).
 *
 * This is load-bearing for parity, not a convenience: when a portal has several destinations the
 * client picks one with `hash(String(player.x))`. Math.random() here would send the server and the
 * client to DIFFERENT exits on every multi-exit portal. Ported bit-for-bit, uint32 wraparound
 * included.
 */
function hashUnit(str) {
  let t = 4022871197;
  for (let n = 0; n < str.length; n++) {
    let i = 0.02519603282416938 * (t += str.charCodeAt(n));
    i -= t = i >>> 0;
    t = (i *= t) >>> 0;
    t += 4294967296 * (i -= t);
  }
  return 2.3283064365386963e-10 * (t >>> 0);
}

/**
 * v() (bundle :34718) — index of the teleporter the player is standing in, or -1.
 *
 * The probe point is the player position plus (0,1,0) — position is at the feet, so this tests
 * roughly the player's centre — and the radius is the authored radius PLUS 1. Teleporters with no
 * destinations are skipped so an exit pad never counts as an entrance.
 */
function teleporterAt(pos, teleporters) {
  const px = pos.x, py = pos.y + 1, pz = pos.z;
  for (const key in teleporters) {
    const t = teleporters[key];
    if (!t.Qcnqzx4 || t.Qcnqzx4.length === 0) continue;
    const dx = px - t.Qdsukt4.x, dy = py - t.Qdsukt4.y, dz = pz - t.Qdsukt4.z;
    const reach = t.Quwa9s1 + 1;
    if (dx * dx + dy * dy + dz * dz <= reach * reach) return parseInt(key, 10);
  }
  return -1;
}

// Rotate a vector about +Y by `angle`, matching three.js applyQuaternion with axis (0,1,0).
function rotateY(vec, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const x = vec.x, z = vec.z;
  vec.x = x * c + z * s;
  vec.z = -x * s + z * c;
}

/**
 * The teleport step (bundle :34560-34574). Mutates `ps` in place; returns true if the player was
 * moved.
 *
 * Note it fires on ENTERING a teleporter only — `Qu5q59u` remembers which one you are inside, and
 * on arrival it is set to the DESTINATION, so you do not immediately bounce back out of the exit
 * pad you just landed on.
 *
 * @param usedTicks optional array indexed by teleporter id, stamped with the current tick for the
 *                  client's portal VFX (worldState.Qi3xpyi, opcode 308).
 */
function applyMapTeleporters(ps, teleporters, tick, usedTicks) {
  if (!teleporters || !ps) return false;
  const idx = teleporterAt(ps.Qdsukt4, teleporters);
  if (idx === ps.Qu5q59u) return false;
  ps.Qu5q59u = idx;
  if (idx < 0) return false;

  const from = teleporters[idx];
  if (from.Qrtt124 && from.Qrtt124.length > 0) {
    // A game-mode portal: the client flags it and changes lobby. Nothing to simulate.
    ps.Qgxywsl = true;
    return false;
  }

  const destId = from.Qcnqzx4[Math.floor(hashUnit(String(ps.Qdsukt4.x)) * from.Qcnqzx4.length)];
  const to = teleporters[destId];
  if (!to) return false;   // dangling destination id — the client's `V in m` guard

  ps.Qdsukt4.x = to.Qdsukt4.x;
  ps.Qdsukt4.y = to.Qdsukt4.y;
  ps.Qdsukt4.z = to.Qdsukt4.z;
  // Yaw and velocity are re-based by the portal pair's relative rotation, +180 deg so you come out
  // facing away from the exit rather than back into it.
  const delta = to.Qrmqlp - from.Qrmqlp + Math.PI;
  ps.Qqg4go0 = to.Qrmqlp + (ps.Qqg4go0 - from.Qrmqlp) + Math.PI;
  rotateY(ps.Qyaswvo, delta);
  ps.Qte59p5 = 1;
  ps.Qgxywsl = true;
  ps.Qu5q59u = destId;
  if (usedTicks) usedTicks[idx] = usedTicks[destId] = tick;
  return true;
}

export { applyMapTeleporters, teleporterAt, hashUnit };
