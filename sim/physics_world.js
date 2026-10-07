/**
 * physics_world.js — ported for the browser-extension host (see ../sim/README.md).
 *
 * Loads the bootstrap map (default_map.evmap), builds the extracted-physics
 * collision world, and exports the shared instances used by background.js.
 *
 * Ported from the Node version: fs.readFileSync -> fetch() (map loading is now async off the
 * extension's own packaged default_map.evmap, same bytes, not re-fetched from ev.io), and
 * EvReader's Node Buffer methods -> DataView (Buffer doesn't exist outside Node). Nothing about
 * the actual parsing/collision logic changed.
 *
 * Usage:
 *   import bpw from './physics_world.js';
 *   await bpw.ready;            // wait for async load (resolves once)
 *   bpw.world                   // Qa34k8v physics world
 *   bpw.gameSettings            // Qsvkg5s settings (Qq5sl76=1)
 *   bpw.spawnPoints             // [{x,y,z,yaw},...]  (from the evmap, seated on the floor)
 */

'use strict';

import phys from './physics_extracted.js';
const THREE    = phys._THREE;
const EVMAP_URL = chrome.runtime.getURL('sim/default_map.evmap');

// ── EvReader (the .evmap binary format the ev.io client parses) ────────────

class EvReader {
  // buf must be a Uint8Array (e.g. new Uint8Array(await (await fetch(...)).arrayBuffer())).
  // Node's Buffer has no equivalent outside Node, so this reads through a DataView instead —
  // same little-endian semantics as the original Buffer.readUInt32LE/readFloatLE calls, just
  // via the standard API. Simpler too: no more scratch buffer needed for the F32 read.
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  readU8()    { return this.buf[this.pos++]; }
  readI16()   { const lo=this.buf[this.pos], hi=this.buf[this.pos+1]; this.pos+=2; const v=hi<<8|lo; return v<=32767?v:v-65536; }
  readU16()   { const lo=this.buf[this.pos], hi=this.buf[this.pos+1]; this.pos+=2; return hi<<8|lo; }
  readU32()   { const v=this.view.getUint32(this.pos, true); this.pos+=4; return v; }
  readF32()   { const v=this.view.getFloat32(this.pos, true); this.pos+=4; return v; }
  readBytes(n){ const o=this.buf.slice(this.pos,this.pos+n); this.pos+=n; return o; }
  readU16ArrayPrefixed() { const n=this.readU16(); const a=new Uint16Array(n); for(let i=0;i<n;i++) a[i]=this.readU16(); return a; }
  readU16Array(n) { const a=new Uint16Array(n); for(let i=0;i<n;i++) a[i]=this.readU16(); return a; }
  readF32Array(n) { const a=new Float32Array(n); for(let i=0;i<n;i++) a[i]=this.readF32(); return a; }
  readVec3()  { return { x:this.readF32(), y:this.readF32(), z:this.readF32() }; }
  readVec4()  { return { x:this.readF32(), y:this.readF32(), z:this.readF32(), w:this.readF32() }; }
  readColor3(){ const r=this.readU8(),g=this.readU8(),b=this.readU8(); return {r:r/255,g:g/255,b:b/255}; }
  readColor4(){ const c=this.readColor3(); const a=this.readU8()/255; return [c,a]; }
  // latin1/binary is a 1:1 byte<->codepoint mapping for 0-255, which is exactly what
  // String.fromCharCode does per byte — equivalent to Buffer's .toString('latin1') for this range.
  readString(){ const len=this.readU8(); let s=''; for (let i=0;i<len;i++) s+=String.fromCharCode(this.buf[this.pos+i]); this.pos+=len; return s; }

  readQuantizedVec3Array() {
    if (this.buf[this.pos]===0) { this.pos++; return new Float32Array(0); }
    this.pos++;
    const minX=this.readF32(),minY=this.readF32(),minZ=this.readF32();
    const maxX=this.readF32(),maxY=this.readF32(),maxZ=this.readF32();
    const rX=maxX-minX, rY=maxY-minY, rZ=maxZ-minZ;
    const n=this.readU16(), total=n*3, out=new Float32Array(total);
    let axis=0;
    for (let i=0;i<total;i++) {
      const q=this.readU16()/65535;
      if (axis===0) { out[i]=rX*q+minX; axis=1; }
      else if (axis===1) { out[i]=rY*q+minY; axis=2; }
      else { out[i]=rZ*q+minZ; axis=0; }
    }
    return out;
  }
  readUV()              { const n=this.readU16(); this.pos+=Math.floor((n+1)/2); return null; }
  readQuantizedVec2Array(){ if(this.buf[this.pos]===0){this.pos++;return;} this.pos++; this.pos+=16; const n=this.readU16()*2; this.pos+=n*2; }
  readMatrix4()         { const m=new Float32Array(16); for(let i=0;i<16;i++) m[i]=this.readF32(); return m; }
}

// ── evmap sub-parsers ──────────────────────────────────────────────────────

function readArray(fn, r) { const n=r.readU16(); const a=[]; for(let i=0;i<n;i++) a.push(fn(r)); return a; }

function readIndexGroup(r) { const n=r.readU16(); return { Qosjx3x: r.readU16Array(n) }; }

function readMesh(r) {
  const f=r.readU8(); const m={Q3dfbbo:f};
  m.Qz4qvqr=r.readQuantizedVec3Array(); m.Qkvcjec=readArray(readIndexGroup,r);
  if(f&1) r.readQuantizedVec3Array(); if(f&2) r.readQuantizedVec2Array();
  if(f&4) r.readQuantizedVec2Array(); if(f&8) r.readUV();
  return m;
}
function skipTexture(r)       { r.readU8(); const l=r.readU32(); r.pos+=l; }
function skipMaterialQ(r) {
  const t=r.readU8();
  if(128&t){
    const sub=r.readU8();
    if(1&t)r.readColor4(); if(2&t)r.readU16(); if(4&t)r.readColor3(); if(8&t)r.readU16();
    if(16&t)r.readF32(); if(32&t)r.readF32(); if(64&t)r.readU16();
    if(128&t){
      if(1&sub)r.readF32(); if(2&sub)r.readI16(); if(4&sub)r.readI16(); if(8&sub)r.readF32();
      if(16&sub)r.readI16(); if(32&sub){r.readF32();r.readF32();r.readF32();r.readF32();}
    }
  } else {
    if(1&t)r.readColor4(); if(2&t)r.readU16(); if(4&t)r.readColor3(); if(8&t)r.readU16();
    if(16&t)r.readF32(); if(32&t)r.readF32(); if(64&t)r.readU16();
  }
}
function skipMaterialPnsnio(r) {
  const k=r.readU8();
  if(k===0) skipMaterialQ(r);
  else if(k===1){r.readColor4();r.readU16();r.readVec4();r.readVec4();r.readF32();r.readVec4();r.readF32();r.readF32();r.readF32();r.readColor4();}
  else if(k===2) r.readColor3();
}
function readNode(r) {
  const f=r.readU8(); const n={Q3dfbbo:f};
  n.Q95zk9v={Qdsukt4:r.readVec3(),Qrmqlp:r.readVec4(),Qcqglqd:r.readVec3()};
  n.Qsvnxri=readArray(readNode,r);
  if(f&1)  n.Qwhpc1y=r.readString();
  if(f!==0) n.Q51zvpp=r.readU16();
  if(f&2)  r.readU16ArrayPrefixed();
  n.Qti0m6q=(f&32)?r.readU32():1;
  // f&8 — the lightmap UV2 transform: an index plus scale/offset for u and v. The client reads a u16
  // and FOUR floats here (Qz4stos, Qy1zwew, Qy1zwex, Qu6v41c, Qu6v41d — bundle :46113) and applies them
  // as uv2[i] = uv[i] * scale + offset (:46446). This read only THREE floats, so any node carrying the
  // flag left the stream 4 bytes short and every byte after it would have decoded as garbage.
  //
  // Nothing in the map cache exercises it — 0 such nodes across all 20 maps — which is why it never
  // surfaced. Corrected anyway: a desync that only fires on a map added later is worse than one that
  // fires now, because nothing would connect the symptom back to this line.
  if(f&8){r.readU16();r.readF32();r.readF32();r.readF32();r.readF32();}
  return n;
}
function skipLight(r)        { r.readVec3();r.readColor3();r.readF32(); const lf=r.readU8(); if(lf!==255&&(lf&2))r.readF32(); }
function skipProbe(r)        { r.readVec3(); const n=r.readU16(); for(let i=0;i<n;i++) r.readVec3(); }
// flags&16 — the ARRIVAL FLYOVER CAMERA (Q55lq9y, bundle :46329). Long mislabelled here as a light
// probe, which is why "the arrival camera waypoints are in no map block" was wrong: they were in this
// one, parsed correctly and thrown away.
//
// Each entry is a LEG: a list of keyframes (Q1o2am8.Qcszuse), each { position, quaternion, duration }.
// The client's Q9w7oks (:52259) lerps position and slerps rotation from keyframe 0 to keyframe 1 over
// keyframe 0's duration, then advances to the next leg and wraps modulo the list. So the trajectory is
// piecewise: smooth dollies within a leg, a hard CUT between legs — which is exactly the 25-30s legs
// and 91-166u jumps in the captured trajectory.
//
// The client applies the same x-mirror as spawns and portals: pos.x *= -1, and the quaternion is
// rebuilt by mirroring its up and forward vectors' x and re-deriving via lookAt (:47052).
function readCameraPath(r){
  const n=r.readU16(); const keys=[];
  for(let i=0;i<n;i++){
    const p=r.readVec3(), q=r.readVec4(), d=r.readF32();
    keys.push({ position:{ x:-p.x, y:p.y, z:p.z }, rotation:q, duration:d });
  }
  return { keys };
}
// flags2&1 — the NAVMESH: a waypoint GRAPH, not a mesh. Each node is a position, a list of neighbour
// indices, and an optional string tag (Qs848o7, bundle :46318). The client mirrors x and then
// SYMMETRISES the graph — for every edge a->b it adds b->a if missing (:47080) — so the stored edges
// are one-directional and must be completed on load.
//
// Tags carry meaning: nodes tagged 'Bot Party' are averaged into the battle-royale glide centre
// (:32901 -> Qr2kqt4/5/6, used at :34595 to enable gliding within 120 units).
//
// Read rather than skipped now because this is the pathfinding data bots would need; nothing consumes
// it yet.
function readNavmeshNode(r)  {
  const f=r.readU8(); const p=r.readVec3(); const n=r.readU16();
  const links=Array.from(r.readU16Array(n));
  const tag=(f&1)?r.readString():'';
  return { x:p.x, y:p.y, z:p.z, links, tag };
}
// MAP TELEPORTERS (the client's Q72fuge reader, bundle :46271). This section used to be skipped as
// "dynamic objects" — the byte layout was already right, the contents were simply thrown away, so
// maps with portals had no portals on the server.
//   Qrmqlp   yaw, authored in DEGREES (converted below)
//   Quwa9s1  trigger radius
//   Qcnqzx4  ids of the teleporters this one sends you to (empty = inert, e.g. an exit-only pad)
//   Qrtt124  a GAME MODE name, not a destination: hub portals that switch lobby rather than move
//            you. Non-empty means "do not teleport" on a normal match server.
function readTeleporter(r)   {
  const f=r.readU8(); const pos=r.readVec3(); const rot=r.readF32(); const radius=r.readF32();
  const n=r.readU16(); const dests=Array.from(r.readU16Array(n));
  return { Q3dfbbo:f, Qdsukt4:pos, Qrmqlp:rot, Quwa9s1:radius, Qcnqzx4:dests,
           Qrtt124:(f&1)?r.readString():'' };
}
// flags2&32 — the CTF FLAG STANDS, not particles (which is what this was called for months, and not
// the arrival-camera path I briefly took them for). The client reads { Q3dfbbo: u8, Qdsukt4: vec3 }
// (Qxc95g9, :46281), mirrors x like every other world point, and pushes them into Qdgq26k, whose two
// entries are read as the team-1 and team-2 objective positions:
//     c = s.flag ? p(1, o) : null,  Q = s.flag ? p(2, o) : null      (:32693)
// where s.flag is set by exactly one game mode, capture_the_flag. Maps without them fall back to
// random spawns. Unused on deathmatch; required if CTF is ever added.
function readObjectivePoint(r) { const flag=r.readU8(); const p=r.readVec3(); return { flag, x:p.x, y:p.y, z:p.z }; }
// flags2&128 — BOMB PLANT SITES, not audio sources. { Qdsukt4: vec3, Quwa9s1: f32 } (Qwhz4wx), used by
// the plant logic: nearest site (Q7vf0vz, :34765), a progress counter while you hold the plant key, and
// on completion the bomb position is written into the world state (:34499). Unused on deathmatch;
// required for search_and_destroy / defuse.
function readBombSite(r)     { const p=r.readVec3(); const radius=r.readF32(); return { x:p.x, y:p.y, z:p.z, radius }; }
function readSpawnSimple(r)  { return { Qdsukt4:r.readVec4(), Qm5hhhk:true, Qcpvj6j:false, Qcpvj6i:false }; }
function readSpawnFull(r)    { const p=r.readVec4(); const f=r.readU8(); return { Qdsukt4:p, Qm5hhhk:!!(f&1), Qcpvj6j:!!(f&2), Qcpvj6i:!!(f&4) }; }
// flags&32 — WEAPON PICKUP SPAWN POINTS (the client's Ql5mslz reader, bundle :46243-46249), not a
// light array. This section used to be read-and-discarded as "lights": its byte layout is a
// flags-gated {u8, vec3, (bit1 ? u32 : u8)} struct (rich form, Q465wkq) or a bare vec3 array (simple
// form, Q6cohc3) — BYTE-FOR-BYTE IDENTICAL to skipLightLong/plain-vec3-array below, which is exactly
// why the misattribution never broke anything: the offsets were always right, only the label and the
// decision to throw the values away were wrong. Confirmed against the wire protocol (opcodes 270-278,
// `worldState.Q6cohc3`/pickupMap — see evidence/protocol/STATE_BODY_SCHEMA.md:114) and the client's
// pickup renderer (bundle :48358-48399, `Qwhyo8k.Q6cohc3[a].Qdsukt4` for position).
//
// The map only authors LOCATIONS (and, in the rich form, a per-point extra scalar Qwqxl3q whose
// exact meaning — rarity weight vs a fixed weapon override — is not yet confirmed; carried through
// unchanged so it's available once decoded). WHICH special weapon spawns at a given
// point, and when, is a runtime decision the SERVER makes (see local_ws_server.js's pickup system) —
// matching official behaviour where the same pad cycles through different weapons over a session.
function readPickupPointRich(r) {
  const f = r.readU8(); const pos = r.readVec3();
  // Qxterop (bundle) reads 4 bytes as a signed LE int32; readU32 consumes the identical 4 bytes —
  // the sign only matters if/when Qwqxl3q's meaning is decoded and actually used.
  const extra = (f & 1) ? r.readU32() : r.readU8();
  return { Q3dfbbo: f, Qdsukt4: pos, Qwqxl3q: extra };
}
function readPickupPointSimple(r) { return { Qdsukt4: r.readVec3() }; }

function parseEvmap(r) {
  const magic=r.readU8(); if(magic!==0x03) throw new Error(`evmap magic 0x${magic.toString(16)}`);
  const flags=r.readU8(); let flags2=0; if(flags&128) flags2=r.readU8();
  const meshes=readArray(readMesh,r);
  const tc=r.readU16(); for(let i=0;i<tc;i++) skipTexture(r);
  if(flags&64){ const mc=r.readU16(); for(let i=0;i<mc;i++) skipMaterialPnsnio(r); }
  else         { const mc=r.readU16(); for(let i=0;i<mc;i++) skipMaterialQ(r); }
  const sceneRoot=readNode(r);
  // See readPickupPointRich's header comment: this is weapon pickup spawn points, not lights.
  let pickupPoints=[];
  if(flags&32){ const lc=r.readU16(); for(let i=0;i<lc;i++) pickupPoints.push(readPickupPointRich(r)); }
  else         { const lc=r.readU16(); for(let i=0;i<lc;i++) pickupPoints.push(readPickupPointSimple(r)); }
  const spawnFn=(flags2&64)?readSpawnFull:readSpawnSimple;
  const spawns=readArray(spawnFn,r);
  const lc2=r.readU16(); for(let i=0;i<lc2;i++) skipLight(r);
  r.readVec3();r.readF32();r.readF32();r.readF32();
  if(flags&4){r.readU8();r.readColor3();r.readColor3();r.readColor3();}
  else{r.readU16();r.readU16();r.readU16();r.readU16();r.readU16();r.readU16();}
  r.readColor3();r.readF32();
  if(!(flags&8)){r.readColor3();r.readF32();}
  if(flags&1){r.readColor3();r.readColor3();r.readF32();}
  if(flags&2){const pc=r.readU16(); for(let i=0;i<pc;i++) skipProbe(r);}
  let cameraPaths=[];
  if(flags&16){const ac=r.readU16(); for(let i=0;i<ac;i++) cameraPaths.push(readCameraPath(r));}
  let navmesh=[];
  if(flags2&1) {const nc=r.readU16(); for(let i=0;i<nc;i++) navmesh.push(readNavmeshNode(r));}
  if(flags2&2) r.readVec4();
  let objectivePoints=[];   // CTF flag stands
  let bombSites=[];         // search-and-destroy plant sites
  if(flags2&32){const pc=r.readU16(); for(let i=0;i<pc;i++) objectivePoints.push(readObjectivePoint(r));}
  let teleporters=[];
  if(flags2&4) {const dc=r.readU16(); for(let i=0;i<dc;i++) teleporters.push(readTeleporter(r));}
  if(flags2&128){const ac=r.readU16(); for(let i=0;i<ac;i++) bombSites.push(readBombSite(r));}
  if(flags2&8) r.readF32();
  return { meshes, sceneRoot, spawns, teleporters, objectivePoints, bombSites, navmesh, cameraPaths,
            pickupPoints };
}

// ── Scene graph → flat geometry ────────────────────────────────────────────

function trsToMatrix(trs) {
  const {x:tx,y:ty,z:tz}=trs.Qdsukt4;
  const {x:qx,y:qy,z:qz,w:qw}=trs.Qrmqlp;
  const {x:sx,y:sy,z:sz}=trs.Qcqglqd;
  const x2=qx+qx,y2=qy+qy,z2=qz+qz;
  const xx=qx*x2,xy=qx*y2,xz=qx*z2;
  const yy=qy*y2,yz=qy*z2,zz=qz*z2;
  const wx=qw*x2,wy=qw*y2,wz=qw*z2;
  return [
    (1-(yy+zz))*sx, (xy+wz)*sx,  (xz-wy)*sx,  0,
    (xy-wz)*sy, (1-(xx+zz))*sy,  (yz+wx)*sy,  0,
    (xz+wy)*sz,    (yz-wx)*sz,  (1-(xx+yy))*sz, 0,
    tx, ty, tz, 1
  ];
}
function matMul(a,b) {
  const o=new Array(16).fill(0);
  for(let i=0;i<4;i++) for(let j=0;j<4;j++) { let s=0; for(let k=0;k<4;k++) s+=a[i+k*4]*b[k+j*4]; o[i+j*4]=s; }
  return o;
}
function applyMatrix(m,x,y,z) {
  return { x:m[0]*x+m[4]*y+m[8]*z+m[12], y:m[1]*x+m[5]*y+m[9]*z+m[13], z:m[2]*x+m[6]*y+m[10]*z+m[14] };
}
const IDENTITY=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];

function walkScene(evmap,node,parentMat,verts,idxs,groups) {
  const local=trsToMatrix(node.Q95zk9v);
  const world=matMul(parentMat,local);
  // EVIO_MESH_FLAG was a diagnostic override (process.env, Node-only); never actually set in
  // this extension's deployment, so just the real default it always fell back to.
  if ((node.Q3dfbbo&4) && node.Q51zvpp!==undefined) {
    const mesh=evmap.meshes[node.Q51zvpp];
    if (mesh && mesh.Qz4qvqr.length>0) {
      const vertBase=verts.length/3;
      const mv=mesh.Qz4qvqr;
      for (let i=0;i<mv.length;i+=3) {
        const wp=applyMatrix(world,mv[i],mv[i+1],mv[i+2]);
        verts.push(wp.x,wp.y,wp.z);
      }
      // Per-triangle collision group = the NODE's Qti0m6q (collision layer/mask).
      // The client does exactly this (bundle scene-walk `y`: `r.push(t.Qti0m6q)`
      // once per triangle).  The capsule sweep filters triangles by
      // (capsuleMask & groupId) !== 0, so meshes whose Qti0m6q doesn't share a bit
      // with the player capsule mask are NON-collidable.  Forcing all groups to 1
      // (the old behaviour) made the server collide with decorative meshes the
      // client passes through → wall-jump divergence.
      for (const grp of mesh.Qkvcjec)
        for (let i=0;i<grp.Qosjx3x.length;i++) {
          if (i % 3 === 0) groups.push(node.Qti0m6q);
          idxs.push(grp.Qosjx3x[i]+vertBase);
        }
    }
  }
  for (const child of node.Qsvnxri) walkScene(evmap,child,world,verts,idxs,groups);
}

// ── Main load function ─────────────────────────────────────────────────────

// Parse ANY .evmap buffer into collision geometry + spawns. The parser above is map-agnostic; only
// the file it is handed differs, so every map goes through exactly the same code path that Bishop
// has been validated on (see diag_collider / the parity work).
function parseEvmapBuffer(buf, label) {
  const name = label || 'evmap';
  const rdr = new EvReader(buf);
  const evmap = parseEvmap(rdr);
  return _geometryFromEvmap(evmap, name);
}

// Build a ready-to-use physics world from a .evmap buffer. Returns everything a map needs —
// NOTE there is no heightmap involved: spawns come from the evmap itself, and the heightmap is
// only used by the legacy hand-rolled fallback sim which never runs on the extracted path.
function buildWorldFromEvmapBuffer(buf, label) {
  const geo = parseEvmapBuffer(buf, label);
  const geom = phys.classifyGeometry(geo.vertices, geo.indices, geo.groupIds);
  // Grid resolution MUST match the client's collision world (bundle Qa14w14 = 100).
  const world = phys.buildPhysicsWorld(geom, 100);
  return { world, spawns: geo.spawns, teleporters: geo.teleporters, navmesh: geo.navmesh,
           pickupPoints: geo.pickupPoints,
           vertices: geo.vertices, indices: geo.indices, groupIds: geo.groupIds };
}

async function loadBishopGeometry() {
  console.log('[physics] Fetching default_map.evmap ...');
  const res = await fetch(EVMAP_URL);
  if (!res.ok) throw new Error('[physics] default_map.evmap not found at '+EVMAP_URL+' (http '+res.status+')');
  const buf = new Uint8Array(await res.arrayBuffer());
  console.log('[physics] Parsing default_map.evmap ...');
  const rdr=new EvReader(buf);
  const evmap=parseEvmap(rdr);
  return _geometryFromEvmap(evmap, 'default_map.evmap');
}

// Bot pathfinding needs BOTH the navmesh graph and the teleporters (portals are extra graph edges
// for maps whose navmesh has more than one connected component — see navmesh_pathfinder.js), so
// both are carried alongside the collision geometry rather than fetched separately per map.

function _geometryFromEvmap(evmap, label) {

  const vertsArr=[], idxsArr=[], groupsArr=[];
  walkScene(evmap, evmap.sceneRoot, IDENTITY, vertsArr, idxsArr, groupsArr);

  // Coordinate transform: negate X, swap first two indices of each triangle
  // (groupIds are per-triangle, unaffected by the within-triangle winding swap).
  for (let i=0;i<vertsArr.length;i+=3) vertsArr[i]*=-1;
  for (let i=0;i<idxsArr.length;i+=3) { const t=idxsArr[i]; idxsArr[i]=idxsArr[i+1]; idxsArr[i+1]=t; }

  const vertices=new Float32Array(vertsArr);
  const indices =new Uint32Array(idxsArr);
  const groupIds=new Uint32Array(groupsArr);

  // Spawns and teleporters get the SAME transform the client applies on load (bundle :47098):
  //   spawns:      x *= -1;  w = (270 - w) * PI/180
  //   teleporters: x *= -1;  Qrmqlp = (270 - Qrmqlp) * PI/180
  // i.e. X mirrored to match the geometry above, and the authored yaw (degrees) re-based to the
  // engine's frame. We keep spawn yaw in DEGREES because every caller converts on use; the
  // teleporter yaw stays in RADIANS because the teleport maths consumes it directly.
  // The three spawn flags are carried through, not dropped. The client sorts spawns into three lists
  // (bundle :47108) and picks between them by game mode (:32973):
  //   flag 1 -> Q1xdien / Qjhw1ww  the GENERAL list, used unless team spawns are enabled
  //   flag 2 -> Qdtuox0 / Qt4s4bh  team 1, used only when lobbyData.useTeamSpawns
  //   flag 4 -> Qujlb1  / Qr7xnfm  team 2, likewise
  // Flattening all three into one list meant a free-for-all could spawn someone on a team-only pad the
  // official client would never have chosen for that mode.
  const spawns=evmap.spawns.map(s=>({
    x: -s.Qdsukt4.x,
    y:  s.Qdsukt4.y,
    z:  s.Qdsukt4.z,
    yaw: 270 - s.Qdsukt4.w,
    general: !!s.Qm5hhhk,
    team1:   !!s.Qcpvj6j,
    team2:   !!s.Qcpvj6i,
  }));
  const teleporters=(evmap.teleporters||[]).map(t=>({
    ...t,
    Qdsukt4: { x: -t.Qdsukt4.x, y: t.Qdsukt4.y, z: t.Qdsukt4.z },
    Qrmqlp: (270 - t.Qrmqlp) * Math.PI / 180,
  }));

  // Diagnostic: how many triangles are NON-collidable (group & player mask == 0)?
  // Player capsule mask is 9 (bits 0 and 3) when Qa34k8v.Qknp5c4=true.
  let nonColl = 0; for (let i=0;i<groupIds.length;i++) if ((groupIds[i] & 9) === 0) nonColl++;
  console.log(`[physics] ${label}: ${vertices.length/3} vertices, ${indices.length/3} triangles, `
    + `${spawns.length} spawns; ${nonColl} non-collidable tris (group&9==0)`);
  if (teleporters.length) {
    const live = teleporters.filter(t => t.Qcnqzx4.length > 0).length;
    console.log(`[physics] ${label}: ${teleporters.length} teleporter(s), ${live} with destinations`);
  }
  if (evmap.pickupPoints && evmap.pickupPoints.length) {
    console.log(`[physics] ${label}: ${evmap.pickupPoints.length} weapon pickup spawn point(s)`);
  }
  // Objective points and bomb sites get the SAME x mirror as every other world point (:47093/:47102).
  const objectivePoints=(evmap.objectivePoints||[]).map(p=>({ flag:p.flag, x:-p.x, y:p.y, z:p.z }));
  const bombSites=(evmap.bombSites||[]).map(p=>({ x:-p.x, y:p.y, z:p.z, radius:p.radius }));
  // Weapon pickup spawn points — same x mirror as every other world point. `extra` is the rich
  // form's still-undecoded Qwqxl3q field (see readPickupPointRich); carried through unused.
  const pickupPoints=(evmap.pickupPoints||[]).map(p=>({
    x: -p.Qdsukt4.x, y: p.Qdsukt4.y, z: p.Qdsukt4.z,
    extra: Number.isFinite(p.Qwqxl3q) ? p.Qwqxl3q : null,
  }));
  // Mirror x and symmetrise the edges, exactly as the client does on load (:47080).
  const navmesh=(evmap.navmesh||[]).map(n=>({ x:-n.x, y:n.y, z:n.z, links:n.links.slice(), tag:n.tag }));
  for (let i=0;i<navmesh.length;i++) {
    for (const j of navmesh[i].links) {
      const o=navmesh[j];
      if (o && !o.links.includes(i)) o.links.push(i);
    }
  }
  return { vertices, indices, groupIds, spawns, teleporters, objectivePoints, bombSites, navmesh,
           pickupPoints, cameraPaths: evmap.cameraPaths || [] };
}

// ── Spawn resolution ──────────────────────────────────────────────────────
// Authored spawn markers are only hints: they are not floor-aligned, and some sit inside geometry
// or over a pit. Seating them on the floor is not enough on its own — a marker buried in a wall
// still "seats" onto whatever surface is below it — so every candidate is then made to prove that
// a standing player capsule actually FITS there. Spawns that cannot be made valid are dropped
// rather than kept, because one bad entry in the rotation is a guaranteed death every time it
// comes round.
const SPAWN_PROBE_UP = 6;        // start above the marker so one just under a thin floor escapes
const SPAWN_PROBE_DOWN = 80;
const SPAWN_CLEARANCE = 0.05;
const CAPSULE_RADIUS = phys.CONST.Qki4xwf;    // 0.897
const STAND_HEIGHT   = phys.CONST.Qp6aubu;    // 2.86
const FALL_DEATH_Y   = phys.CONST.Qq85ufw;    // -30: below this the player dies outright

// Is there room for a standing capsule with its feet at (x, y, z)?
function capsuleFits(world, x, y, z) {
  // Headroom: nothing directly overhead within the capsule's standing height.
  if (phys.raycastWorld(world, x, y + 0.1, z, 0, 1, 0, STAND_HEIGHT - 0.1)) return false;
  // Not embedded in a wall: probe outwards at chest height. A spawn buried in geometry is blocked
  // on every side, so require at least one open direction plus no immediate contact.
  const chest = y + STAND_HEIGHT * 0.5;
  let blocked = 0;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of dirs) {
    if (phys.raycastWorld(world, x, chest, z, dx, 0, dz, CAPSULE_RADIUS)) blocked++;
  }
  return blocked < dirs.length;
}

/**
 * Seat every spawn on the surface below it and discard the ones a player cannot stand in.
 * Returns a NEW array; never returns empty (an unusable map is worse than an imperfect one).
 */
function resolveSpawnsToFloor(world, spawns, label) {
  if (!world || !Array.isArray(spawns) || !spawns.length) return spawns;
  let moved = 0;
  const good = [], bad = [];
  for (const sp of spawns) {
    // raycastWorld returns the HIT POINT {x,y,z,nx,ny,nz} — not a distance.
    const hit = phys.raycastWorld(world, sp.x, sp.y + SPAWN_PROBE_UP, sp.z,
                                  0, -1, 0, SPAWN_PROBE_UP + SPAWN_PROBE_DOWN);
    if (!hit || !Number.isFinite(hit.y)) { bad.push([sp, 'nothing below (over a pit or off-map)']); continue; }
    // A near-vertical face is a wall, not a floor: seating a player there puts them inside it.
    if (Number.isFinite(hit.ny) && hit.ny < 0.5) { bad.push([sp, 'lands on a wall face']); continue; }
    if (hit.y <= FALL_DEATH_Y + 5) { bad.push([sp, 'below the kill plane']); continue; }
    const y = hit.y + SPAWN_CLEARANCE;
    if (!capsuleFits(world, sp.x, y, sp.z)) { bad.push([sp, 'no room to stand (inside geometry)']); continue; }
    if (Math.abs(y - sp.y) > 0.25) moved++;
    good.push({ ...sp, y });
  }
  if (!good.length) {
    console.warn(`[physics] ${label}: NO spawn passed validation — falling back to the `
      + `authored markers; expect bad spawns`);
    return spawns;
  }
  console.log(`[physics] ${label}: ${good.length}/${spawns.length} spawns usable `
    + `(${moved} seated onto the floor${bad.length ? `, ${bad.length} dropped` : ''})`);
  for (const [sp, why] of bad) {
    console.log(`[physics]   dropped spawn (${sp.x.toFixed(1)}, ${sp.y.toFixed(1)}, `
      + `${sp.z.toFixed(1)}): ${why}`);
  }
  return good;
}

// ── Build and cache physics world ─────────────────────────────────────────

let _world = null;
let _gameSettings = null;
let _spawnPoints = null;
let _teleporters = [];
let _pickupPoints = [];  // weapon pickup spawn points: { x, y, z, extra }, see readPickupPointRich
let _navmesh = [];       // waypoint graph nodes: { x, y, z, links:[nodeIdx...], tag }, edges symmetrised
let _vertices = null;   // Float32Array — raw world-space vertices (exported for test use)
let _indices  = null;   // Uint32Array  — raw triangle indices
let _groupIds = null;   // Uint32Array  — per-triangle collision group (node Qti0m6q)
let _resolveReady, _rejectReady;

/** Promise that resolves when the physics world is ready. */
const ready = new Promise((resolve, reject) => {
  _resolveReady = resolve; _rejectReady = reject;
});

async function _init() {
  try {
    // Spawns come from the EVMAP. (The old bishop_heightmap.json spawn list is deleted.) It stored
    // without the X negation the collision geometry gets, so they are MIRRORED relative to the
    // world: probing every spawn against the real collider, the negated set seats 35/35 within
    // 1.5u of its own Y (mean error 0.21u) versus 23/35 (mean 2.08u) un-negated. Gravity hid it —
    // players fell to a floor anyway — but it is why some spawns felt wrong.
    const { vertices, indices, groupIds, spawns, teleporters, navmesh, pickupPoints } = await loadBishopGeometry();
    _spawnPoints = spawns;
    _teleporters = teleporters || [];
    _navmesh = navmesh || [];
    _pickupPoints = pickupPoints || [];

    // Cache raw geometry so callers can build independent physics worlds
    // (e.g. headless client simulation that must not share capsule state with server).
    _vertices = vertices;
    _indices  = indices;
    _groupIds = groupIds;

    // Pass the REAL per-triangle collision groups (node Qti0m6q) so non-collidable
    // meshes are filtered exactly like the client (was: all triangles forced to 1).
    const geom  = phys.classifyGeometry(vertices, indices, groupIds);
    // Grid resolution MUST match the client's collision world (bundle: this.Qa14w14 = 100,
    // used as `new Qaryx4g(100, geom, …)`).  The capsule sweep walks this spatial grid
    // cell-by-cell, so a mismatched resolution tests a different triangle set per query →
    // systematic small collision divergence across the whole map (wall-jump drift).
    _world      = phys.buildPhysicsWorld(geom, 100);
    _gameSettings = phys.makeGameSettings();   // Qq5sl76 = 1 (bundle default)
    _spawnPoints = resolveSpawnsToFloor(_world, _spawnPoints, 'default_map.evmap');

    console.log('[physics] Physics world ready');
    _resolveReady({ world: _world, gameSettings: _gameSettings, spawnPoints: _spawnPoints });
  } catch (err) {
    console.error('[physics] FAILED:', err.message);
    _rejectReady(err);
  }
}

// Kick off loading. No setImmediate (Node-only, doesn't exist here) needed to defer this for
// callers to attach .then/.catch first — `ready` is already constructed above, and _init is
// async with its first real work behind an `await fetch(...)`, which yields immediately, so a
// direct call here is already safe for any .then() attached right after this module loads.
_init();

// ── Exports ──────────────────────────────────────────────────────────────

// Swap in a different map's collision world at runtime. Everything that touches the world reads it
// through the `world` getter (including the per-tick capsule sync), so the swap is picked up on the
// very next tick with no re-registration needed. The caller is responsible for respawning players
// onto the new map's spawns — their old coordinates mean nothing in the new geometry.
function setActiveWorld({ world, spawns, teleporters, navmesh, pickupPoints, vertices, indices, groupIds, name }) {
  if (!world) throw new Error('setActiveWorld: no world');
  _world = world;
  if (Array.isArray(spawns) && spawns.length) _spawnPoints = spawns;
  // Always replaced, even with an empty list: keeping the previous map's portals would teleport
  // players into coordinates that no longer exist.
  _teleporters = Array.isArray(teleporters) ? teleporters : [];
  // Same reasoning as teleporters: a stale navmesh from the OLD map would route bots through
  // coordinates that no longer exist, so it is always replaced (never left as-is on missing data).
  _navmesh = Array.isArray(navmesh) ? navmesh : [];
  // Same reasoning again: a pickup point from the OLD map is a coordinate that no longer exists —
  // always replaced, never left stale.
  _pickupPoints = Array.isArray(pickupPoints) ? pickupPoints : [];
  if (vertices) _vertices = vertices;
  if (indices) _indices = indices;
  if (groupIds) _groupIds = groupIds;
  _activeMapName = name || _activeMapName;
  console.log(`[physics] active collision world -> ${_activeMapName} `
    + `(${_indices ? _indices.length / 3 : '?'} tris, ${_spawnPoints.length} spawns)`);
  return true;
}
let _activeMapName = 'Bishop';

export default {
  ready,
  resolveSpawnsToFloor,
  buildWorldFromEvmapBuffer,
  parseEvmapBuffer,
  setActiveWorld,
  get activeMapName() { return _activeMapName; },
  get world()        { return _world; },
  get gameSettings() { return _gameSettings; },
  get spawnPoints()  { return _spawnPoints; },
  get teleporters()  { return _teleporters; },
  get pickupPoints() { return _pickupPoints; },
  get navmesh()      { return _navmesh; },
  // Raw geometry — use to build an independent physics world (e.g. headless client)
  // so capsule state does not interfere with the server's shared bpw.world.
  get vertices()     { return _vertices; },
  get indices()      { return _indices; },
  get groupIds()     { return _groupIds; },
};
