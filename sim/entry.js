// sim/entry.js — the single esbuild entry point for sim/bundle.js. Pulls together everything
// background.js needs from the simulation side (physics world, packet builders, msgpack) into
// one object, so the bundle only has to expose ONE global (self.EvioSim) instead of several.
import physicsWorld from './physics_world.js';
import { buildFirstSpawnBody, buildLoadoutDelta, buildStatePacket, defaultStats } from './state_builder.js';
import { encode, decode } from './msgpack/index.mjs';
import gameServer from './game_server.js';

export default {
    physicsWorld,
    buildFirstSpawnBody,
    buildLoadoutDelta,
    buildStatePacket,
    defaultStats,
    encode,
    decode,
    gameServer,
};
