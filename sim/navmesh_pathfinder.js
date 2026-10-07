'use strict';

/**
 * navmesh_pathfinder.js — waypoint-graph pathfinding for bots.
 *
 * The evmap navmesh (physics_world.js, flags2&1) is already a symmetrised graph — position + link
 * indices, one array per map. Bots need two things on top of that raw graph:
 *   1. Teleporters treated as extra edges. ~6 of the 20 maps have a navmesh split across multiple
 *      disconnected islands that are only actually joined in-game by a portal pad — without this, a
 *      bot on one island could never path to a target on another even though a human player could
 *      just walk through the teleporter.
 *   2. A* search from an arbitrary world position to another, snapping to the nearest graph nodes.
 *
 * This module is pure: it takes the navmesh + teleporters physics_world.js already parses and
 * returns a graph plus a search function. It has no knowledge of bots, sessions, or physics state —
 * kept standalone and unit-testable before anything drives it (see scripts/test_navmesh.js).
 */

// A portal pad only counts as "at" a navmesh node within this range — teleporters are physical
// objects with their own trigger radius, not navmesh nodes themselves, so we snap to whichever
// node is close enough to stand on the pad.
const TELEPORT_SNAP_DIST = 12;
// Small flat cost, not zero: a teleport is instant in-game, but giving it truly zero cost would let
// A* prefer a teleport edge over a barely-shorter walk between two nodes that are already close by
// foot, which reads as a bot needlessly detouring onto a pad. Costed as "roughly as far as a short
// walk" so it only wins when it is a genuine shortcut.
const TELEPORT_EDGE_COST = 2;

function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Nearest graph node index to a world position, or -1 if the graph is empty or nothing is within maxDist. */
function nearestNodeIndex(nodes, pos, maxDist = Infinity) {
  let best = -1, bestD = maxDist;
  for (let i = 0; i < nodes.length; i++) {
    const d = dist3(nodes[i], pos);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Build a searchable graph from the raw navmesh nodes (already edge-symmetrised by physics_world)
 * and the map's teleporters. Returns { nodes, adjacency }, where adjacency[i] is an array of
 * { to, cost, teleport }. Teleport edges are ADDED on top of the raw navmesh links, never replacing
 * them — a map with no usable teleport destinations degrades to exactly the raw navmesh graph.
 */
function buildGraph(navmeshNodes, teleporters) {
  const nodes = Array.isArray(navmeshNodes) ? navmeshNodes : [];
  const adjacency = nodes.map((n) =>
    (n.links || [])
      .filter((to) => nodes[to])
      .map((to) => ({ to, cost: dist3(n, nodes[to]), teleport: false })));

  const tps = teleporters || [];
  for (const tp of tps) {
    const dests = tp.Qcnqzx4 || [];
    // An exit-only pad (no destinations) and a hub/game-mode portal (Qrtt124 set — switches lobby,
    // does not move you within this match) are both not a normal in-match teleport edge.
    if (!dests.length || tp.Qrtt124) continue;
    const fromIdx = nearestNodeIndex(nodes, tp.Qdsukt4, TELEPORT_SNAP_DIST);
    if (fromIdx < 0) continue;
    for (const destId of dests) {
      const destTp = tps[destId];
      if (!destTp) continue;
      const toIdx = nearestNodeIndex(nodes, destTp.Qdsukt4, TELEPORT_SNAP_DIST);
      if (toIdx < 0 || toIdx === fromIdx) continue;
      adjacency[fromIdx].push({ to: toIdx, cost: TELEPORT_EDGE_COST, teleport: true });
    }
  }
  return { nodes, adjacency };
}

/**
 * A* from `fromPos` to `toPos` over the graph. Returns an array of waypoints
 * [{x,y,z,tag,teleport}, ...] starting at the snapped START node and ending at the snapped GOAL
 * node — not `toPos` itself. The caller is expected to walk the last stretch directly once close to
 * the true target, same as the client never needs sub-node precision from this graph. Returns null
 * if the graph is empty, nothing is within `opts.snapDist` of either endpoint, or the goal is
 * unreachable (e.g. two disconnected islands with no linking portal).
 */
function findPath(graph, fromPos, toPos, opts = {}) {
  const { nodes, adjacency } = graph;
  if (!nodes.length) return null;
  const snapDist = opts.snapDist != null ? opts.snapDist : Infinity;
  const startIdx = nearestNodeIndex(nodes, fromPos, snapDist);
  const goalIdx = nearestNodeIndex(nodes, toPos, snapDist);
  if (startIdx < 0 || goalIdx < 0) return null;
  if (startIdx === goalIdx) return [{ ...nodes[goalIdx], teleport: false }];

  const goal = nodes[goalIdx];
  const open = new Set([startIdx]);
  const cameFrom = new Map();
  const cameVia = new Map();   // was the edge used to first reach this node a teleport?
  const gScore = new Map([[startIdx, 0]]);
  const fScore = new Map([[startIdx, dist3(nodes[startIdx], goal)]]);

  const popLowestF = () => {
    let best = -1, bestF = Infinity;
    for (const i of open) { const f = fScore.get(i) ?? Infinity; if (f < bestF) { bestF = f; best = i; } }
    return best;
  };

  while (open.size) {
    const current = popLowestF();
    if (current === goalIdx) {
      const path = [];
      let cur = current;
      while (cur !== undefined) {
        path.unshift({ ...nodes[cur], teleport: cameVia.get(cur) || false });
        cur = cameFrom.get(cur);
      }
      return path;
    }
    open.delete(current);
    for (const edge of adjacency[current] || []) {
      const tentative = (gScore.get(current) ?? Infinity) + edge.cost;
      if (tentative < (gScore.get(edge.to) ?? Infinity)) {
        cameFrom.set(edge.to, current);
        cameVia.set(edge.to, edge.teleport);
        gScore.set(edge.to, tentative);
        fScore.set(edge.to, tentative + dist3(nodes[edge.to], goal));
        open.add(edge.to);
      }
    }
  }
  return null;
}

export { buildGraph, nearestNodeIndex, findPath, dist3 };
