# sim/ — the match simulation, ported for the extension's service worker

`physics_extracted.js`, `physics_world.js`, `state_builder.js`, `ability_stats.js`,
`map_teleporters.js`, `navmesh_pathfinder.js`, `bot_difficulty.js`, `settings.js` and
`game_server.js` are ported copies of the Node custom server's own files of the same names — same
logic, just with `require`/`module.exports` swapped for ES `import`/`export`.

`game_server.js` (a port of `local_ws_server.js`) is the big one: the REAL join/accept/first-spawn/
tick-loop protocol, not a hand-rolled reduced version of it — reusing it instead of re-deriving the
protocol from scratch is the whole point (see the git history/session notes on why: a from-scratch
reimplementation kept re-hitting already-solved protocol bugs). Its real Node dependencies that
have no browser equivalent are handled two ways:
- `fs`/`path`/`__dirname` are stubbed in-file (every call site was already optional/best-effort —
  debug logging, settings persistence, map-rotation catalogues — each already wrapped in its own
  try/catch upstream, so the stubs just make that dead code harmless rather than requiring dozens
  of individual call-site edits).
- `process` (env/argv/on) is **not** stubbed per-file — `background.js` sets `self.process = {...}`
  once, globally, before `importScripts('sim/bundle.js')`, which every bundled file's bare
  `process` references resolve through (same mechanism as any other global). Every env lookup
  naturally falls back to its coded default, which is exactly correct: there's nothing to read
  from an environment in a browser extension.
- The real `ws`-library `WebSocketServer`/TCP listening socket isn't ported at all — there's no
  way to open one from an extension, and no need to: `background.js` hands each
  `chrome.runtime.Port` connection to `game_server.js`'s exported `getHandleConnection()` directly,
  via `PortPeerSocket` (a small class making a Port look enough like a `ws` WebSocket that
  `handleConnection` can't tell the difference) — the exact same adapter pattern the Node server's
  own `netlib_adapter.js` already uses for WebRTC peers.
- `process.hrtime.bigint()`/`setImmediate` (the tick scheduler's timing, Node-only) are replaced
  in-file with `performance.now()` (already millisecond-scale, no conversion needed) and a
  `setTimeout(fn, 0)` fallback.
- `map_loader.js` IS ported, and supports the full ~50-map catalogue (`maps.json`, bundled
  directly rather than read from disk) — not just the one map `physics_world.js` loads by default
  at boot (Bishop). There's no filesystem to cache a downloaded `.evmap` into, so it uses the
  browser's Cache Storage API (`caches.open`/`.match`/`.put`) in place of the Node server's disk
  cache; everything else (fetch, parse, build the physics world, resolve spawns) is identical.
  Switching maps works mid-session via the admin panel's map dropdown, same as the Node server.
- `weapons.json` is bundled directly via esbuild's built-in JSON loader (`import cachedWeaponsData
  from "./weapons.json"`) instead of read from disk at runtime.

`physics_extracted.js`/`physics_world.js` additionally depend on the official three.js build
(`three.module.min.js` + `three.core.min.js`, pinned to 0.184.0 — the exact version already proven
compatible with this code by the Node server), which ships no non-module build at all. `msgpack/`
is a verbatim copy of `@msgpack/msgpack`'s own ESM dist (`node_modules/@msgpack/msgpack/dist.esm/`)
— copied rather than resolved from `node_modules` because esbuild's default resolution walks up
from the entry file's own directory, and the package only lives in the *other* projects'
`node_modules`, not this extension's.

Verified with a Node-side smoke test (`vm.createContext` + a fake `ws`-shaped `EventEmitter`,
matching the shape `netlib_adapter.js`'s own `NetlibPeerSocket` already uses) before ever touching
the browser: physics world loads, `startServer()` runs, a real join packet gets a real `;1` accept
and a real msgpack first-spawn packet, and the tick scheduler streams real per-tick state packets
afterward. Not a substitute for testing in the actual extension, but it caught several
Node-vs-browser-global gaps (`process.hrtime`, `TextEncoder`, `chrome.runtime.getURL`) for free
before a single round-trip through the browser.

## Why `bundle.js` exists, and why it's committed, not generated on install

`background.js` is a classic (non-module) service worker, and loads `bundle.js` via the same
`importScripts()` it already uses for `netlib-client.js`. It can't load the ES-module source
files directly — neither way of doing that actually works from a service worker:

- A static `import` declaration needs the whole worker declared `"type": "module"` in
  `manifest.json`. That failed service worker **registration outright** on real-world testing
  (Chrome extension module-type service workers have had genuine, version-dependent bugs).
- Dynamic `import()` is **flatly disallowed inside any `ServiceWorkerGlobalScope`** per the HTML
  spec, module-type or not — see https://github.com/w3c/ServiceWorker/issues/1356. This isn't a
  Chrome bug, it fails the same way everywhere.

So `bundle.js` is a pre-built esbuild bundle of `sim/entry.js` — physics world + packet builders
+ msgpack + three.js, all flattened into one classic-script IIFE with zero `import`/`export` of
its own, assigned to `self.EvioSim`. It's committed to the repo (not built at install/load time)
since this extension has no build step otherwise — anyone unpacking it from the Chrome Web Store
just gets working files directly.

## Rebuilding it

Whenever any file under `sim/` changes (`game_server.js` and everything it imports —
`physics_extracted.js`, `physics_world.js`, `state_builder.js`, `ability_stats.js`,
`map_loader.js`, `settings.js`, `bot_difficulty.js`, `navmesh_pathfinder.js`,
`map_teleporters.js` — e.g. pulling in an update from the Node server's own copies and
re-porting it):

```bash
npx esbuild sim/entry.js --bundle --format=iife --global-name=EvioSim --outfile=sim/bundle.js
```

One thing to know: `entry.js` only has a `default` export (an object holding everything else), and
esbuild's CJS interop puts a default-only export under `.default`, not spread onto the global
directly — so `background.js` reads it as `self.EvioSim.default`, not `self.EvioSim`.
