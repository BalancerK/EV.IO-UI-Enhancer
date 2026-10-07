'use strict';

/**
 * bot_difficulty.js — maps the single 1-10 Bot Level slider to concrete combat-skill parameters.
 *
 * Design agreed before any bot code was written: scale SKILL, not stats. HP, damage, and movement
 * speed are identical at every level — only how well a bot points a gun and reacts changes. A
 * stat-boosted bot reads as cheating, because the client has no visual language for it (unlike the
 * real boss flag, opcode 239 / Qqw6dra). Navigation competence is likewise constant across levels —
 * a bot that can't find its way around isn't "easy", it's broken; difficulty lives entirely in the
 * combat layer (see driveBotFrame in local_ws_server.js, which is the only consumer of this module).
 *
 * Every axis eases along t = (level-1)/9 with an EASE-OUT curve (skill improves fast early, refines
 * slowly at the top) — matching how human proficiency actually plateaus, so level 9 and 10 don't
 * read as identical to level 5 and 6.
 */

function easeOut(t) { return 1 - Math.pow(1 - t, 2); }
function lerp(a, b, t) { return a + (b - a) * t; }

function curveForLevel(level) {
  const clamped = Math.max(1, Math.min(10, Number(level) || 5));
  const t = easeOut((clamped - 1) / 9);
  // Accuracy specifically uses a PLAIN linear ramp, not the ease-out shape below. Ease-out improves
  // fast early and refines slowly at the top, which is right for reaction time/turn rate (skill
  // plateaus) but wrong for raw aim precision: it made mid-and-low levels sharpshoot almost as well
  // as the top of the curve (e.g. level 5 landed at ~4.7° instead of the ~7.3° a straight line gives),
  // which read as "accurate even at low level" — exactly the reported complaint. Linear keeps the
  // same level-1 and level-10 endpoints but spreads the improvement evenly in between.
  const tAccuracy = (clamped - 1) / 9;

  return {
    level: clamped,
    // Time from first LOS on a target to the first aim/fire response. A bot that could instantly
    // snap its aim toward a target the moment it appears would read as robotic no matter how sloppy
    // its actual aim was afterward — reaction time is what makes low levels feel human, not just bad.
    reactionMs: lerp(700, 150, t),
    // Angular noise added to the true bearing to the target, in degrees (half-angle of a cone around
    // the true aim point). Never fully zero — see aimConeFloorDeg — so even a level-10 bot keeps a
    // small permanent wobble and never reads as laser-perfect.
    // Level-1 endpoint widened from 12° to 25° — a low-level gun bot should be genuinely SLOPPY
    // (miss a standing target from any real distance more often than not), not just "a bit worse
    // than a good bot". 12° still landed suspiciously close to a real hit most of the time at
    // typical engagement ranges; 25° is wide enough that a fresh bot actually reads as a beginner.
    // The level-10 endpoint (1.5°) is untouched — top difficulty is unchanged.
    aimConeInitialDeg: lerp(25, 1.5, tAccuracy),
    aimConeFloorDeg: 0.5,
    // The cone shrinks toward its floor the longer the SAME target has been continuously tracked,
    // as exp(-ticksTracking * tickMs / tau). Higher level locks on faster (smaller tau).
    lockOnTauMs: lerp(2000, 300, t),
    // Maximum yaw/pitch change per second — bounds how fast the aim solution can physically catch up
    // to a moving target, independently of the cone noise above (a wide-open cone still can't outrun
    // a hard strafe if the turn rate itself is slow).
    turnRateDegPerSec: lerp(90, 380, t),
    // How long a target must be lost (LOS broken, or dead) before the bot drops it and looks for
    // someone else, in ms. Short at high level — it notices a flank faster than it forgets one.
    targetDropMs: lerp(1200, 400, t),
    // Probability, re-rolled periodically while actively fighting, of juking sideways rather than
    // standing still and shooting. This is the "movement under fire" axis — raised the floor from
    // 0.15 to 0.35 (a level-1 bot used to stand dead still 85% of the time while fighting, which read
    // as inert/broken rather than "just bad at combat"; it still moves noticeably less than a high
    // level, just not near-frozen).
    strafeProbability: lerp(0.35, 0.85, t),
  };
}

export { curveForLevel };
