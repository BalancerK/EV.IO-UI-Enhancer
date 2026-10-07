# EV.IO UI Enhancer

A Chrome extension for [ev.io](https://ev.io) that adds a proper lobby browser and
player-hosted multiplayer — host a real match straight from your browser, peer-to-peer,
no separate server process required, and join other players' lobbies the same way you'd
join an official one.

This is a research/hobby project, not an official ev.io product and not affiliated with
ev.io or its operator. It's meant for private play with people you know — see
[Scope and disclaimer](#scope-and-disclaimer).

## What's actually in here

- **A lobby browser** that merges the official server list with player-hosted "Custom"
  lobbies in one UI, with live player counts and one-click join.
- **Host a Lobby**: runs a full server-authoritative simulation (ported from
  [EV.IO-Custom-Server](https://github.com/BalancerK/EV.IO-Custom-Server) — same physics,
  weapons, bots, scoring, netcode) directly in the extension's own service worker. Other
  players connect to it peer-to-peer over WebRTC — your browser *is* the server for the
  match, no VPS or Node process needed on your end.
- **Join by link**: starting a lobby gives you a direct `?evioCustom=<code>` link — share
  it and whoever opens it joins straight in, public or private, without hunting through a
  list.
- **A quick-admin panel** next to the hosting UI: live map switching, round length, damage
  multiplier, bot count/level/behavior toggles, announcements, and match controls (restart
  round, heal all, add time, etc.) — the same levers the full admin dashboard exposes, for
  the things you'd actually want to change mid-match.
- **The same bots** as the Node server: a skill-curve difficulty model, pathfinding,
  grenades/abilities, and simulated reaction time — not an instant, unfair read of the true
  game state.

## Installing

This isn't published on the Chrome Web Store, so it loads as an unpacked extension:

1. Download or clone this repo.
2. Go to `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open [ev.io](https://ev.io) — the **Lobbies** button and **Custom Lobby** button
   (next to the usual lobby controls) are added automatically.

## Hosting and joining

Click **Custom Lobby** → give your lobby a name → **Start Hosting**. A **Copy Link** and
**Join Lobby** button appear once it's live — share the link with whoever you want to
play with, or click **Join Lobby** yourself to play in your own match. Anyone who opens
the link (or finds your lobby in the **Custom** tab of the lobby browser) connects
directly to your browser over WebRTC.

The signaling server (just for the initial peer handshake — it never sees game traffic)
defaults to a server we run, configurable in the Custom tab if you'd rather self-host your
own (see EV.IO-Custom-Server's own `netlib-signaling/` for that).

## How it works

- `background.js` — the service worker. Owns the hosting/joining state, relays WebRTC
  traffic to/from an offscreen document (real `RTCPeerConnection` doesn't exist in a
  service worker, so that part has to live in a hidden page — see `offscreen.js`), and
  boots the simulation (`sim/`) when you start hosting.
- `content.js` — builds the Lobbies/Host-a-Lobby/quick-admin UI injected into the ev.io
  page itself.
- `page-socket-hook.js` — intercepts the game client's own WebSocket at the page level so
  a hosted/joined match can be routed through the extension instead of (or alongside) the
  official server, and bridges account identity/skin data into the local simulation.
- `sim/` — the actual game simulation, ported from
  [EV.IO-Custom-Server](https://github.com/BalancerK/EV.IO-Custom-Server)'s own
  `local_ws_server.js` and friends, bundled for the browser (see `sim/README.md` for the
  porting details and how to rebuild `sim/bundle.js` after a change).
- `netlib-client.js` — a vendored WebRTC/signaling client ([Poki's
  netlib](https://github.com/proofnetworks/netlib), ISC license — see
  `NETLIB-LICENSE.txt`), used for the peer-to-peer connection itself.

## Scope and disclaimer

Built by reverse-engineering the public ev.io client and porting its own extracted
movement/combat logic, the same way EV.IO-Custom-Server was. Not affiliated with, endorsed
by, or officially connected to ev.io or its operator in any way. Intended for private,
casual play with people you know, not for impersonating or disrupting the official game.

## License

MIT — see [LICENSE](LICENSE). `netlib-client.js` is separately licensed (ISC, Poki B.V.) —
see [NETLIB-LICENSE.txt](NETLIB-LICENSE.txt).
