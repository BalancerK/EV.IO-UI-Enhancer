// background.js — player-count fetching AND player-hosted lobby signaling (netlib/WebRTC).
//
// ── Player counts (existing) ───────────────────────────────────────────────────────────────
// This has to happen here, not in content.js: a content script's fetch() runs in the PAGE's
// security context (https://ev.io), so it's subject to the same CORS rules a page script would
// be. Each lobby's evio-XXXXXXXX.rivet.game server doesn't send an Access-Control-Allow-Origin
// header for https://ev.io, so a content-script fetch to it is blocked by the browser before any
// response is even seen — no header the extension sets on its own request can fix that, since
// it's the SERVER's response header that's missing.
//
// A background service worker's fetch is extension-privileged: for an origin covered by
// host_permissions (see manifest.json's "https://*.rivet.game/*"), it isn't subject to the page's
// CORS policy at all. So content.js sends a message here instead of fetching directly.

// Only ever fetch a *.rivet.game players endpoint — never an arbitrary URL a message might ask
// for. Without this check, any page content.js runs on could, in principle, ask this worker to
// fetch anything, using the extension's host_permissions as an open proxy.
function isAllowedPlayersUrl(raw) {
    let u;
    try { u = new URL(raw); } catch (e) { return false; }
    if (u.protocol !== 'https:') return false;
    if (!/^[a-z0-9-]+\.rivet\.game$/i.test(u.hostname)) return false;
    if (!u.pathname.endsWith('/players')) return false;
    return true;
}

// ── Player-hosted lobbies (new) ─────────────────────────────────────────────────────────────
//
// WHY THIS LIVES HERE, NOT IN content.js: two independent reasons.
//
// 1. CSP/CORS: netlib's signaling connection (and the WebRTC handshake itself) are third-party
//    network traffic. Run from a content script, that traffic executes in the PAGE's origin and
//    is subject to whatever Content-Security-Policy ev.io's own page sends — out of our control,
//    and exactly the class of problem the player-count fetch above already hit once. A service
//    worker is a separate, privileged extension context with no page CSP to contend with.
//
// 2. Lifecycle: an MV3 service worker is killed after ~30s of no activity — but an open
//    chrome.runtime.Port counts as activity that keeps it alive (see "active ports" in Chrome's
//    own idle-eviction docs). content.js opens exactly one such port for the duration of hosting
//    (see HOST_PORT_NAME below), which does double duty: it's the keep-alive, AND when the
//    user's tab closes, the port's disconnect event is how we know to tear the lobby down. No
//    separate "did the host leave" polling needed — the browser's own port lifecycle IS that
//    signal.
//
// The actual match simulation (movement, hit detection) is being ported in here too — see
// sim/physics_world.js and sim/physics_extracted.js — rather than content.js, for the same
// lifecycle reason as above: the already-open hosting Port is what's relied on to keep this
// worker (and therefore the simulation) alive for the whole session, and that mechanism is
// specific to this context, not a content script's.
//
importScripts('netlib-client.js');
const netlib = self.netlib;

// physics_world.js/state_builder.js/etc. use real ES import/export (needed for the official
// three.js ESM build physics_extracted.js depends on — modern three.js ships no non-module build
// at all). Neither option for loading ES module code from a classic service worker actually
// works here: a static `import` declaration needs "type":"module" on the whole worker, which
// failed to register at all on this build of Chrome (a real, version-dependent extension bug);
// dynamic import() is flatly disallowed inside ANY ServiceWorkerGlobalScope per the HTML spec,
// module-type or not (see https://github.com/w3c/ServiceWorker/issues/1356). So instead:
// sim/bundle.js is a pre-built esbuild bundle (three.js + physics_extracted.js +
// physics_world.js + state_builder.js + ability_stats.js + @msgpack/msgpack + game_server.js — a
// port of the Node custom server's own local_ws_server.js, see sim/README.md — all flattened into
// one classic-script IIFE with zero import/export of its own — see sim/README.md for the exact
// build command), loaded the same importScripts() way as netlib-client.js above. A default-only
// ES export comes out the other side of esbuild's CJS interop as `.default`, not spread onto the
// global directly — hence `.default` below.
//
// game_server.js's few genuine Node dependencies it couldn't do without (process.env/process.on,
// since nothing in a service worker provides a `process` global at all) are shimmed here, once,
// globally — simpler and far less error-prone than touching every scattered call site in a
// mechanically-ported 11,000-line file. Every env lookup naturally falls back to its coded
// default (empty env = "nothing was ever set"), which is exactly the right behavior: there are no
// environment variables to read in a browser extension.
//
// importScripts() CANNOT be deferred to startHosting() or any other later event — Chrome only
// allows it during a service worker's initial, synchronous top-level evaluation; calling it later
// throws "NetworkError: ... failed to load" (confirmed live). So the bundle itself, and the
// physics-world evmap fetch+parse its own module-level code triggers, load unconditionally here,
// same as before. That's a one-time, bounded cost (sub-second), not the thing actually worth
// avoiding.
//
// What IS worth avoiding, and CAN be deferred (it's just a function call, not importScripts()):
// game_server.js's own tick scheduler + heartbeat sweep. Its top-level code no longer auto-starts
// them on load — see bootServer()'s own comment there — ensureGameServerStarted() below is the
// one place that calls it, only when hosting actually starts or a game-socket connects.
self.process = { env: {}, argv: [], on() {}, exitCode: 0 };
importScripts('sim/bundle.js');
const sim = self.EvioSim.default;
const physicsWorld = sim.physicsWorld;

physicsWorld.ready
    .then(() => console.log('[evio-ext] physics world ready:', physicsWorld.spawnPoints.length, 'spawns'))
    .catch((err) => console.error('[evio-ext] physics world failed to load', err));

function ensureGameServerStarted() {
    return sim.gameServer.bootServer();
}

// Wraps a chrome.runtime.Port in the exact interface game_server.js's handleConnection expects
// from a `ws` WebSocket connection — the same adapter pattern the Node server's own
// netlib_adapter.js already uses for WebRTC peers (see that file's NetlibPeerSocket and its own
// comment: "wraps each connected peer in an EventEmitter shaped enough like a `ws` WebSocket that
// local_ws_server.js's existing connection-handling code ... needs no changes at all"). No real
// EventEmitter exists in a service worker, so this implements the minimal on/emit/once surface
// handleConnection actually calls — nothing more.
class PortPeerSocket {
    constructor(port) {
        this._port = port;
        this._listeners = new Map(); // event -> [fn]
        this._closed = false;
        this.readyState = 1; // OPEN — a Port only reaches us once content.js has one open
        this.isAlive = true; // read/written by the heartbeat sweep, same as a real ws socket
    }
    get OPEN() { return 1; } get CONNECTING() { return 0; }
    get CLOSING() { return 2; } get CLOSED() { return 3; }
    get bufferedAmount() { return 0; } // no real backpressure signal from a Port either
    on(event, fn) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(fn);
        return this;
    }
    emit(event, ...args) {
        (this._listeners.get(event) || []).slice().forEach((fn) => {
            try { fn(...args); } catch (e) { console.error(`[evio-ext] PortPeerSocket '${event}' listener threw`, e); }
        });
    }
    send(data, opts) {
        if (this.readyState !== 1) return;
        // Binary payloads cross the Port as a plain array of byte values — see the matching
        // comment in content.js/page-socket-hook.js on why (chrome.runtime.Port's own
        // serialization isn't guaranteed to preserve a typed array the way window.postMessage
        // preserves one via structured clone).
        const wire = (data instanceof Uint8Array) ? Array.from(data)
            : ArrayBuffer.isView(data) ? Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
            : data;
        // 'message' (a server->client data message), not 'send' — content.js's relay forwards
        // this verbatim as the page hook's evt.type, and the page hook only recognizes 'open',
        // 'message' and 'close'. content.js ALSO uses the literal 'send' for the opposite
        // direction (content.js -> background.js, client->server data) in its own 'socket-send'
        // handler — same word, opposite direction, which is exactly how this got silently
        // dropped end to end: everything except the bare {type:'open'} marker (which happens to
        // already match) was being posted under a type the page hook's dispatcher never checks.
        try { this._port.postMessage({ type: 'message', data: wire }); } catch (err) { this.emit('error', err); }
    }
    close(code, reason) {
        if (this.readyState === 3) return;
        this.readyState = 2;
        try { this._port.disconnect(); } catch (_) {}
        this._finishClose(code, reason);
    }
    terminate() { this.close(1006, 'terminated'); }
    // The heartbeat sweep (handleConnection's ws.isAlive/ws.on('pong',...)) exists to catch a
    // TCP connection that died silently, with no close event — real risk for a raw WebSocket, not
    // for a chrome.runtime.Port: a Port that's actually dead already fired onDisconnect (that's
    // how Chrome implements it), so there's no "silently dead but still passing" case to detect
    // here. Confirming aliveness immediately, synchronously, is therefore correct for this
    // transport, not a workaround — it was this no-op that was wrong: isAlive never got set back
    // to true after the sweep's own `sock.isAlive = false`, so every session got killed as "dead"
    // after HEARTBEAT_MISSES sweeps (2, i.e. ~30s) regardless of whether anything was wrong.
    ping() { this.isAlive = true; this.emit('pong'); }
    _finishClose(code, reason) {
        if (this._closed) return;
        this._closed = true;
        this.readyState = 3;
        this.emit('close', Number.isFinite(code) ? code : 1000, reason || '');
    }
}

// Ported from the Node custom server's own netlib_adapter.js NetlibPeerSocket — a REAL remote
// player, reached over a netlib/WebRTC data channel, made to look enough like a `ws` WebSocket
// that handleConnection() can't tell it apart from PortPeerSocket above (same interface, same
// EventEmitter-shaped surface). This is the other half of the Port/netlib duality this file now
// has: PortPeerSocket is used when the HOST plays in their own tab (no networking at all,
// same-process message passing); NetlibPeerSocket is used for every OTHER player, whether they
// joined OUR lobby or we joined THEIRS — same class either direction, just constructed from
// whichever side's perspective applies (see startHosting()/joinRemoteLobby() below).
//
// UNLIKE the Node server's own version, this does NOT hold a real netlib Network/Peer — those
// only exist inside the offscreen document (see offscreen.js's own top comment for why:
// RTCPeerConnection doesn't exist in a service worker at all). This is a pure relay: every
// send()/ping() posts a message to the offscreen Port instead of calling network.send()
// directly, and the offscreen message handlers below call .emit() on whichever socket a peerId
// maps to.
class NetlibPeerSocket {
    constructor(peerId, remoteLabel) {
        this.peerId = peerId;
        this._closed = false;
        this.readyState = 1; // a peer only reaches us once netlib itself calls it 'connected'
        this.isAlive = true;
        this.remoteLabel = remoteLabel;
        this._listeners = new Map();
    }
    get OPEN() { return 1; } get CONNECTING() { return 0; }
    get CLOSING() { return 2; } get CLOSED() { return 3; }
    get bufferedAmount() { return 0; } // netlib's Peer doesn't surface this; see the Node server's own note
    on(event, fn) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(fn);
        return this;
    }
    emit(event, ...args) {
        (this._listeners.get(event) || []).slice().forEach((fn) => {
            try { fn(...args); } catch (e) { console.error(`[evio-ext] NetlibPeerSocket '${event}' listener threw`, e); }
        });
    }
    send(data, opts) {
        if (this.readyState !== 1) return;
        // Same routing rule as the Node server's adapter: per-tick state/input (binary, msgpack)
        // already tolerates loss by design in this protocol, so it rides the unreliable channel —
        // the actual fix for head-of-line blocking. Join/chat/RPCs (always strings) need
        // guaranteed ordered delivery, so they go reliable. Transport routing, not a protocol
        // change — the exact same bytes/string either way.
        const channel = (opts && opts.binary) ? 'unreliable' : 'reliable';
        try { sendToOffscreen({ type: 'host:send', peerId: this.peerId, channel, data: toWire(data) }); } catch (err) { this.emit('error', err); }
    }
    close(code, reason) {
        if (this.readyState === 3) return;
        this.readyState = 2;
        // Deliberately NOT asking the offscreen document to actually close the RTCPeerConnection
        // here — netlib's own 'disconnected' event (which the offscreen relay already forwards as
        // host:peerDisconnected) is what real disconnection looks like; this socket just stops
        // accepting further use locally. Matches close enough to the Node adapter's own
        // peer.close(reason) intent without needing a dedicated offscreen message for it.
        this._finishClose(code, reason);
    }
    terminate() { this.close(1006, 'terminated'); }
    // UNLIKE PortPeerSocket (same-process, same-tab — a dead Port always fires onDisconnect
    // promptly), a real WebRTC peer genuinely CAN go silently stale with no event at all (frozen
    // tab, network partition, etc.) — exactly the case the heartbeat sweep exists to catch. So
    // this sends a real control message over the data channel; the receiving end's own message
    // handler (see the offscreen port's 'host:peerMessage' handling below) replies with
    // NETLIB_PONG, which is what actually sets isAlive back to true and emits 'pong' here.
    ping() {
        if (this.readyState !== 1) return;
        try { sendToOffscreen({ type: 'host:send', peerId: this.peerId, channel: 'reliable', data: NETLIB_PING }); } catch (e) { /* ignore */ }
    }
    _finishClose(code, reason) {
        if (this._closed) return;
        this._closed = true;
        this.readyState = 3;
        this.emit('close', Number.isFinite(code) ? code : 1000, reason || '');
    }
}

// Shared with the Node custom-server ecosystem on purpose — a lobby created from this extension
// and one created by local_ws_server.js's netlib_adapter.js show up in the SAME list() results,
// since both just mean "a custom-hosted ev.io lobby," regardless of what's running the host side.
const LOBBY_APP_MARKER = 'evio-custom-server';
const DEFAULT_GAME_ID = '0d6a3b8e-6b8b-4f0a-9a2b-3a6e7b7a2b39';
const HOST_PORT_NAME = 'evio-hosting';
// Reserved control-message strings (same literals netlib_adapter.js uses) — emulated ping/pong
// over the data channel, since unlike a raw WebSocket there's no protocol-level PING/PONG frame
// to send instead. Distinct from anything the real wire protocol ever sends (always `;`/`` ` ``
// -prefixed JSON, or a msgpack array), so this can never collide with real game traffic.
const NETLIB_PING = '\u0000EVIO_PING';
const NETLIB_PONG = '\u0000EVIO_PONG';

// ── Offscreen document relay ────────────────────────────────────────────────────────────────
// RTCPeerConnection does not exist in a service worker (confirmed live: "ReferenceError:
// RTCPeerConnection is not defined", thrown from inside netlib-client.js the moment an actual
// peer connection was attempted — advertising/listing a lobby is pure signaling and worked fine
// without this, which is why that part of the code below is untouched). chrome.offscreen gives
// the service worker access to a real, hidden DOM document that DOES have it. offscreen.js is a
// deliberately dumb relay (see its own top comment) — this is the background.js side of that
// same relay: a lazily-created, reused-forever document, one long-lived Port to it, and a
// requestId-correlated call() helper for the two actual request/response operations
// (host:create, join:start); everything else (peer events, sends) is fire-and-forget in one
// direction, handled by whichever of startHosting()/joinRemoteLobby()'s own listeners below owns
// that peerId/requestId.
const OFFSCREEN_PORT_NAME = 'evio-offscreen';
let offscreenPort = null;
let offscreenReadyPromise = null;
let _offscreenRequestSeq = 0;
const pendingOffscreenRequests = new Map(); // requestId -> {resolve, reject}
// peerId -> NetlibPeerSocket (peers in OUR lobby) and requestId -> {sock} (lobbies WE joined) —
// the offscreen port's onMessage handler below is the one place that reads these; startHosting()/
// joinRemoteLobby() are the ones that populate them.
const hostPeerSockets = new Map();
const joinSockets = new Map();

// Mirrors offscreen.js's own toWire()/fromWire() — binary data crossing the offscreen Port needs
// the same explicit plain-array normalization as every other chrome.runtime.Port hop in this
// extension (confirmed live: a raw ArrayBuffer surviving this specific hop implicitly produced a
// shape the client's msgpack decoder read as garbage — "RangeError: Offset is outside the bounds
// of the DataView" — not a silent failure, a silent CORRUPTION, which is worse).
function toWire(data) {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return Array.from(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) return Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return data;
}
function fromWire(data) {
    return Array.isArray(data) ? new Uint8Array(data) : data;
}

async function ensureOffscreenDocument() {
    if (offscreenReadyPromise) return offscreenReadyPromise;
    offscreenReadyPromise = (async () => {
        const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        // An offscreen document can outlive the service worker that created it (MV3 idle
        // eviction) — if one already exists but we have no Port to it (this is a fresh worker
        // instance), there's no way to make the OLD document reconnect: it only ever calls
        // chrome.runtime.connect() once, at its own top-level load, long before this worker
        // existed. Close and recreate fresh rather than waiting forever for a connect that will
        // never come.
        if (existing.length && !offscreenPort) {
            await chrome.offscreen.closeDocument().catch(() => {});
        }
        if (!existing.length || !offscreenPort) {
            // The listener MUST be registered before createDocument() is even called, not after
            // awaiting it — createDocument()'s promise only resolves once the document has
            // finished loading, by which point offscreen.js's own top-level chrome.runtime.connect()
            // call has ALREADY run. Registering the listener afterward missed that connection
            // event permanently (chrome.runtime.onConnect does not buffer/replay a connection for
            // a listener that registers late) — confirmed live as a silent, permanent hang on
            // every single host/join attempt, with no error anywhere.
            const connected = new Promise((resolve) => {
                function onConnect(port) {
                    if (port.name !== OFFSCREEN_PORT_NAME) return;
                    chrome.runtime.onConnect.removeListener(onConnect);
                    attachOffscreenPort(port);
                    resolve();
                }
                chrome.runtime.onConnect.addListener(onConnect);
            });
            await chrome.offscreen.createDocument({
                url: chrome.runtime.getURL('offscreen.html'),
                reasons: ['WEB_RTC'],
                justification: 'netlib/WebRTC peer connections for player-hosted lobbies (hosting and joining) — RTCPeerConnection does not exist in the service worker.',
            });
            await connected;
        }
    })();
    return offscreenReadyPromise;
}

function attachOffscreenPort(port) {
    offscreenPort = port;
    port.onMessage.addListener(handleOffscreenMessage);
    port.onDisconnect.addListener(() => {
        // The offscreen document doesn't close itself and nothing here closes it either, so in
        // practice this only fires if Chrome itself tears it down (extension update/reload). Any
        // in-flight request or live peer/join socket on our side is now orphaned — fail/close
        // them all rather than leaving callers hanging forever.
        offscreenPort = null;
        offscreenReadyPromise = null;
        for (const { reject } of pendingOffscreenRequests.values()) reject(new Error('offscreen document disconnected'));
        pendingOffscreenRequests.clear();
        for (const sock of hostPeerSockets.values()) { try { sock._finishClose(1006, 'offscreen document disconnected'); } catch (e) { /* ignore */ } }
        hostPeerSockets.clear();
        for (const { sock } of joinSockets.values()) { try { sock.close(1006, 'offscreen document disconnected'); } catch (e) { /* ignore */ } }
        joinSockets.clear();
    });
}

function sendToOffscreen(msg) {
    if (!offscreenPort) throw new Error('offscreen document not connected');
    offscreenPort.postMessage(msg);
}

// Request/response helper for host:create and join:start — everything else the offscreen relay
// sends is an unsolicited event (peer connected/message/disconnected), handled directly in
// handleOffscreenMessage below instead of through this.
function callOffscreen(msg) {
    return ensureOffscreenDocument().then(() => new Promise((resolve, reject) => {
        const requestId = String(++_offscreenRequestSeq);
        pendingOffscreenRequests.set(requestId, { resolve, reject });
        try {
            offscreenPort.postMessage({ ...msg, requestId });
        } catch (err) {
            pendingOffscreenRequests.delete(requestId);
            reject(err);
        }
    }));
}

function handleOffscreenMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'host:created') {
        const p = pendingOffscreenRequests.get(msg.requestId);
        if (p) { pendingOffscreenRequests.delete(msg.requestId); msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error)); }
        return;
    }
    if (msg.type === 'join:result') {
        const p = pendingOffscreenRequests.get(msg.requestId);
        if (p) { pendingOffscreenRequests.delete(msg.requestId); msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error)); }
        return;
    }

    // ── Real players in OUR lobby ───────────────────────────────────────────────────────────
    if (msg.type === 'host:peerConnected') {
        console.log('[evio-ext] peer joined our lobby:', msg.peerId);
        const sock = new NetlibPeerSocket(msg.peerId, `netlib:${msg.peerId}`);
        hostPeerSockets.set(msg.peerId, sock);
        const fakeReq = { socket: { remoteAddress: `netlib:${msg.peerId}`, remotePort: 0 }, headers: {} };
        ensureGameServerStarted().then(() => {
            const handleConnection = sim.gameServer.getHandleConnection();
            if (!handleConnection) { console.error('[evio-ext] game server never produced a handleConnection'); return; }
            handleConnection(sock, fakeReq);
        }).catch((err) => console.error('[evio-ext] game server failed to start for peer', msg.peerId, err));
        return;
    }
    if (msg.type === 'host:peerDisconnected') {
        const sock = hostPeerSockets.get(msg.peerId);
        hostPeerSockets.delete(msg.peerId);
        if (sock) sock._finishClose(1000, 'peer disconnected');
        return;
    }
    if (msg.type === 'host:peerMessage') {
        const sock = hostPeerSockets.get(msg.peerId);
        if (!sock) return; // from a peer we never finished wrapping, or already closed
        if (msg.data === NETLIB_PING) { try { sendToOffscreen({ type: 'host:send', peerId: msg.peerId, channel: 'reliable', data: NETLIB_PONG }); } catch (e) { /* ignore */ } return; }
        if (msg.data === NETLIB_PONG) { sock.isAlive = true; sock.emit('pong'); return; }
        sock.emit('message', fromWire(msg.data), msg.isBinary);
        return;
    }

    // ── Lobbies WE joined (see joinRemoteLobby) ─────────────────────────────────────────────
    if (msg.type === 'join:message') {
        const entry = joinSockets.get(msg.requestId);
        if (!entry) return;
        if (msg.data === NETLIB_PING) { try { sendToOffscreen({ type: 'join:send', requestId: msg.requestId, channel: 'reliable', data: NETLIB_PONG }); } catch (e) { /* ignore */ } return; }
        if (msg.data === NETLIB_PONG) return; // no heartbeat sweep on this side needs it
        // .send() (deliver OUT to the Port, i.e. to the page), NOT .emit('message', ...) — that
        // would re-trigger the client-outgoing listener registered in joinRemoteLobby (sock.on
        // ('message', ...) means "the page sent this TO the server"), looping the server's own
        // reply back at itself instead of ever reaching the page. This exact mix-up was why the
        // client never got the server's "ID..." handshake and so never sent its own join back —
        // confirmed live via the VPS's own "no join within 20s" log.
        entry.sock.send(fromWire(msg.data), { binary: msg.isBinary });
        return;
    }
    if (msg.type === 'join:disconnected') {
        const entry = joinSockets.get(msg.requestId);
        joinSockets.delete(msg.requestId);
        if (entry) entry.sock.close(1006, 'server peer disconnected');
        return;
    }
}

// Settings the user configures (see content.js's hosting panel, which pre-fills the field below
// as its own default too — kept in sync by hand since the two contexts can't share a constant).
// Defaults to our own VPS-hosted netlib-signaling deployment, the same one local_ws_server.js's
// own netlibSignalingUrl setting points at in production — still fully overridable per-user.
const DEFAULT_SIGNALING_URL = 'wss://217.216.72.239.sslip.io/netlib/v0/signaling';

async function getHostingConfig() {
    const stored = await chrome.storage.local.get(['evioSignalingUrl', 'evioGameId', 'evioHostName']);
    return {
        signalingUrl: stored.evioSignalingUrl || DEFAULT_SIGNALING_URL,
        gameId: stored.evioGameId || DEFAULT_GAME_ID,
        hostName: stored.evioHostName || '',
    };
}

let hostNetwork = null;   // truthy while actively hosting, else null (see startHosting's own note)
let hostLobbyCode = null;
let hostPort = null;      // the content.js keep-alive port for the current hosting session
let activeGameSocket = null; // the host's own PortPeerSocket into game_server.js, if connected
let hostTeardownTimer = null; // pending grace-period teardown — see onConnect's HOST_PORT_NAME case

// How long to wait for a NEW keep-alive port before actually tearing the lobby down. A
// chrome.runtime.Port is tied to the content-script context that created it — a plain page
// RELOAD (e.g. clicking a Self-Hosted lobby row to toggle routing, see content.js) destroys that
// context and disconnects the port, even though the user never meant to stop hosting at all.
// Without this grace period, every such reload would silently kill the lobby. Long enough to
// cover a normal reload's load time, short enough that an ACTUAL tab close/crash still cleans up
// promptly (matches the kind of timescale the signaling server's own peer-timeout uses).
const HOST_TEARDOWN_GRACE_MS = 5000;

// Separate from hostNetwork, reused across list() polls instead of reconnecting to signaling
// every 5s — only hostNetwork needs a lobby of its own; this one just needs to stay connected.
// No explicit teardown: once content.js stops polling (panel closed), nothing keeps this
// worker non-idle, so it and this connection simply die together after ~30s, same as the rest
// of the worker's state — cheap and self-cleaning rather than something to track separately.
let discoveryNetwork = null;
let discoveryNetworkGameId = null; // reconnect if the configured gameId/signalingUrl ever changes

async function getDiscoveryNetwork(cfg) {
    const key = cfg.gameId + '|' + cfg.signalingUrl;
    if (discoveryNetwork && discoveryNetworkGameId === key) return discoveryNetwork;
    if (discoveryNetwork) { try { discoveryNetwork.leave(); } catch (e) { /* ignore */ } }

    const network = new netlib.Network(cfg.gameId, netlib.DefaultRTCConfiguration, cfg.signalingUrl);
    await new Promise((resolve, reject) => {
        network.once('ready', resolve);
        network.once('failed', () => reject(new Error('netlib signaling failed')));
    });
    discoveryNetwork = network;
    discoveryNetworkGameId = key;
    return network;
}

// Joins ANOTHER player's lobby — ours or anyone else's, including the VPS-hosted Node server's
// own lobbies (netlib_adapter.js there uses the identical LOBBY_APP_MARKER/serverPeerId
// convention, so this works against either kind of host transparently, no special-casing which
// one it is). `sock` is already duck-typed ws-shaped (PortPeerSocket, wrapping the chrome.runtime
// Port back to the page) — this function's whole job is relaying between it and the offscreen
// document's real netlib peer connection to the remote host (see that file's own comment for why
// the actual WebRTC work can't happen here, in the service worker, at all).
async function joinRemoteLobby(lobbyCode, sock) {
    const cfg = await getHostingConfig();

    // Registered up front, before the offscreen call below resolves — the Port can disconnect
    // (page closed) at any point during the join handshake, not just after it succeeds, and
    // this is the only reliable way to make sure that still tells the offscreen document to
    // leave rather than leaking the in-progress join.
    let requestId = null;
    sock.on('close', () => {
        if (requestId != null) {
            joinSockets.delete(requestId);
            try { sendToOffscreen({ type: 'join:leave', requestId }); } catch (e) { /* ignore */ }
        }
    });

    const result = await callOffscreen({
        type: 'join:start', lobbyCode, gameId: cfg.gameId, signalingUrl: cfg.signalingUrl,
    });
    requestId = result.requestId;
    if (sock._closed) { try { sendToOffscreen({ type: 'join:leave', requestId }); } catch (e) { /* ignore */ } throw new Error('port closed during join'); }

    joinSockets.set(requestId, { sock });

    // Relay the local client's own outgoing traffic (joined over the Port from the page) to the
    // real remote host peer, via the offscreen document. Routing rule matches
    // NetlibPeerSocket.send() / the Node server's own adapter: binary (per-tick input)
    // unreliable, strings (join/RPCs) reliable.
    sock.on('message', (data, isBinary) => {
        const channel = isBinary ? 'unreliable' : 'reliable';
        try { sendToOffscreen({ type: 'join:send', requestId, channel, data: toWire(data) }); } catch (err) { sock.emit('error', err); }
    });

    return result.serverPeerId;
}

function teardownHosting() {
    if (hostNetwork) {
        try { sendToOffscreen({ type: 'host:leave' }); } catch (e) { /* already gone */ }
    }
    hostNetwork = null;
    hostLobbyCode = null;
    hostPort = null;
    // Close the host's own in-progress session too — this is the actual CPU cost (the 20Hz tick
    // loop + physics step), and game_server.js's own maybeStopGameLoop() already halts it the
    // instant no accepted session remains. Without this, "stop hosting" only delisted the lobby
    // while the host's still-open tab kept the loop running underneath.
    if (activeGameSocket) {
        try { activeGameSocket.close(1000, 'hosting stopped'); } catch (e) { /* already gone */ }
        activeGameSocket = null;
    }
    for (const sock of hostPeerSockets.values()) {
        try { sock.close(1001, 'hosting stopped'); } catch (e) { /* already gone */ }
    }
    hostPeerSockets.clear();
    // bootServer() itself is NOT un-called here (_bootServerCalled stays true) — the heartbeat
    // sweep interval it set up keeps running at its own low frequency (cheap: it just iterates an
    // empty sessions Map once no one's connected), and there's no exported way to clearInterval
    // it from outside anyway. That's an acceptable idle cost; the tick loop above, the actually
    // expensive part, is what this function exists to stop.

    // The offscreen document (and its netlib Network/RTCPeerConnection/data-channel objects) is
    // NOT recreated by a normal stop/start hosting cycle — ensureOffscreenDocument() reuses
    // whatever document+Port already exists, and host:leave only calls the netlib Network's
    // .leave() (closes peer connections) rather than .close() (also closes the signaling socket
    // and tears the Network object down). A long hosting session's WebRTC/data-channel state —
    // reported live as "connection gets laggy after ~15 min, stop+start hosting doesn't fix it,
    // only fully reloading the extension does" — never actually gets reset by "stop hosting" as
    // a result. Force a fresh offscreen document on every stop, as long as we're not also mid-
    // join elsewhere in this same browser (closing it would yank that join's own connection too).
    if (!joinSockets.size) {
        offscreenPort = null;
        offscreenReadyPromise = null;
        chrome.offscreen.closeDocument().catch(() => {});
    }
}

async function startHosting({ isPublic }) {
    if (hostNetwork) {
        return { ok: false, error: 'already hosting a lobby — stop it first' };
    }
    // Starts the tick scheduler/heartbeat sweep now rather than waiting for the host to actually
    // click into their own lobby — bootServer() is idempotent, so by the time they do this is a
    // no-op instead of a delay on their first join.
    ensureGameServerStarted();
    const cfg = await getHostingConfig();
    if (!cfg.signalingUrl) {
        return { ok: false, error: 'no signaling URL configured — set one in the hosting panel first' };
    }

    try {
        // The actual netlib Network/lobby creation happens in the offscreen document (see its own
        // top comment, and OFFSCREEN_PORT_NAME's, for why) — host:create there both advertises
        // the lobby AND wires up its own network.on('connected'/'disconnected'/'message',...),
        // which arrive back here as host:peerConnected/host:peerDisconnected/host:peerMessage,
        // handled in handleOffscreenMessage above. Every peer that reaches us that way goes
        // through the identical handleConnection() path the host's own PortPeerSocket already
        // uses (see netlib_adapter.js's own comment on the Node server side, which this mirrors
        // exactly: "makes a netlib peer look enough like a `ws` WebSocket that this function
        // can't tell the difference").
        const result = await callOffscreen({
            type: 'host:create', isPublic: !!isPublic, gameId: cfg.gameId, signalingUrl: cfg.signalingUrl,
            customData: { app: LOBBY_APP_MARKER, hostedBy: 'extension', hostName: cfg.hostName || undefined },
        });

        hostNetwork = true; // no real Network object on this side any more — just "are we hosting"
        hostLobbyCode = result.lobbyCode;
        return { ok: true, lobbyCode: result.lobbyCode };
    } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === 'fetchPlayerCount') {
        (async () => {
            if (!isAllowedPlayersUrl(msg.url)) {
                sendResponse({ ok: false, error: 'blocked: not a *.rivet.game /players URL' });
                return;
            }
            try {
                const res = await fetch(msg.url);
                if (!res.ok) { sendResponse({ ok: false, error: 'http ' + res.status }); return; }
                const data = await res.json();
                sendResponse({ ok: true, data });
            } catch (err) {
                sendResponse({ ok: false, error: String((err && err.message) || err) });
            }
        })();
        return true;
    }

    if (msg.type === 'listCustomLobbies') {
        (async () => {
            try {
                const cfg = await getHostingConfig();
                if (!cfg.signalingUrl) {
                    sendResponse({ ok: false, error: 'no signaling URL configured' });
                    return;
                }
                // hostNetwork (if set) is just a boolean flag now — the real Network for hosting
                // lives in the offscreen document (see its own top comment for why) and isn't
                // reachable from here. The discovery connection below is independent of it and
                // works the same whether or not we're also hosting — .list() is pure signaling,
                // doesn't need WebRTC, so it's fine to keep running in the service worker.
                const network = await getDiscoveryNetwork(cfg);
                const lobbies = await network.list({}, {}, 50);
                // The signaling server does NOT delete a lobby's row the moment it empties out —
                // LeaveLobby (a clean Stop Hosting) and the 90s-timeout path (an ungraceful close)
                // both just remove the peer from the lobby's peer list, dropping playerCount to 0.
                // The row itself only gets deleted by a server-side sweep that runs every 30
                // minutes and only touches lobbies that have been empty for over 24 HOURS (see
                // netlib-signaling's CleanEmptyLobbies/LobbyCleanInterval/LobbyCleanThreshold) —
                // nowhere near prompt enough to rely on. Filtering out playerCount===0 here is
                // what actually makes an abandoned lobby disappear from the list within one poll
                // cycle instead of staying visible for up to a day.
                const custom = (lobbies || []).filter(l =>
                    l && l.customData && l.customData.app === LOBBY_APP_MARKER && (l.playerCount || 0) > 0);
                sendResponse({ ok: true, lobbies: custom });
            } catch (err) {
                sendResponse({ ok: false, error: String((err && err.message) || err) });
            }
        })();
        return true;
    }

    if (msg.type === 'startHosting') {
        startHosting({ isPublic: !!msg.isPublic }).then(sendResponse);
        return true;
    }

    if (msg.type === 'getHostingStatus') {
        sendResponse({ ok: true, hosting: !!hostNetwork, lobbyCode: hostLobbyCode });
        return true;
    }

    if (msg.type === 'admin') {
        handleAdminRequest(msg.path, msg.method, msg.body).then(sendResponse);
        return true;
    }

    if (msg.type === 'openAdmin') {
        // content.js runs in an isolated world with no chrome.tabs access, hence the round trip.
        chrome.tabs.create({ url: chrome.runtime.getURL('admin.html') });
        sendResponse({ ok: true });
        return true;
    }

    return false;
});

// Ported from admin_server.js (the Node custom server's own dashboard backend) — same route list,
// same functions underneath (game.getStatus()/adminAction()/etc., S.list()/S.set()/etc.), just
// reached via chrome.runtime.sendMessage instead of a real HTTP server (admin.html's own fetch()
// override — see that file — is the other half of this swap). The token/rate-limit/loopback
// checks admin_server.js has are gone on purpose: those exist because that port is reachable over
// a real network; chrome.runtime.sendMessage for this extension's id is already private to this
// browser's own extension context, nothing external can reach it at all.
async function handleAdminRequest(path, method, body) {
    try {
        const S = sim.gameServer.settings;
        if (method === 'GET' && path === '/api/status') {
            return { ok: true, status: 200, body: sim.gameServer.getStatus() };
        }
        if (method === 'GET' && path === '/api/settings') {
            return { ok: true, status: 200, body: { settings: S.list(), persistence: S.persistenceStatus() } };
        }
        if (method === 'GET' && path === '/api/log') {
            return { ok: true, status: 200, body: { log: S.changeLog() } };
        }
        if (method === 'POST' && path === '/api/settings') {
            const r = S.set(body.key, body.value, 'admin-ui');
            return { ok: r.ok, status: r.ok ? 200 : 400, body: r };
        }
        if (method === 'POST' && path === '/api/settings/reset') {
            const r = S.reset(body.key, 'admin-ui');
            return { ok: r.ok, status: r.ok ? 200 : 400, body: r };
        }
        if (method === 'GET' && path === '/api/maps') {
            const cached = new Set((await sim.gameServer.mapLoader.cachedMaps()).map((m) => m.nid));
            return {
                ok: true, status: 200,
                body: {
                    active: sim.gameServer.getStatus().map,
                    maps: sim.gameServer.mapLoader.listMaps().map((m) => ({
                        nid: m.nid, title: m.title, cached: cached.has(m.nid), inRotation: m.inRotation,
                    })),
                },
            };
        }
        if (method === 'POST' && path === '/api/map') {
            // Downloads + converts on first use (a few seconds — real network fetch of a few MB,
            // same as the Node server), then cached (Cache Storage API — see map_loader.js).
            try {
                const r = await sim.gameServer.switchMap(sim.gameServer.getSessions(), body.map);
                return { ok: true, status: 200, body: r };
            } catch (err) {
                return { ok: false, status: 400, body: { ok: false, err: String((err && err.message) || err) } };
            }
        }
        if (method === 'GET' && path === '/api/parity') {
            return { ok: true, status: 200, body: { rings: sim.gameServer.getParityRings() } };
        }
        if (method === 'GET' && path === '/api/presets') {
            return { ok: true, status: 200, body: { presets: S.listPresets() } };
        }
        if (method === 'POST' && path === '/api/preset') {
            const r = S.applyPreset(body.preset, 'admin-ui');
            return { ok: r.ok, status: r.ok ? 200 : 400, body: r };
        }
        if (method === 'POST' && path === '/api/server') {
            const r = sim.gameServer.adminServerAction(body.action, body.arg);
            return { ok: r.ok, status: r.ok ? 200 : 400, body: r };
        }
        if (method === 'POST' && path === '/api/player') {
            const r = sim.gameServer.adminAction(body.sessionId, body.action, body.arg);
            return { ok: r.ok, status: r.ok ? 200 : 400, body: r };
        }
        return { ok: false, status: 404, body: { ok: false, err: 'not found' } };
    } catch (err) {
        return { ok: false, status: 400, body: { ok: false, err: String((err && err.message) || err) } };
    }
}

// The keep-alive + auto-cleanup port — see the comment block above. content.js connects this
// the moment "Start Hosting" succeeds, and keeps it open for exactly as long as the tab is open
// and the user hasn't clicked "Stop Hosting".
const LOCAL_GAME_SOCKET_PORT = 'evio-local-game-socket';

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === HOST_PORT_NAME) {
        // A fresh port connecting while a teardown from a PREVIOUS port's disconnect is still
        // pending (the grace period below) means the same page just reloaded — same session
        // continuing, not a new one. Cancel the pending teardown and just re-attach.
        if (hostTeardownTimer) {
            clearTimeout(hostTeardownTimer);
            hostTeardownTimer = null;
        }
        hostPort = port;
        port.onDisconnect.addListener(() => {
            if (hostPort !== port) return; // a newer port already replaced this one
            hostPort = null;
            // Don't tear down immediately — give a reload a chance to reconnect first (see
            // HOST_TEARDOWN_GRACE_MS's own comment). Real tab closes/crashes still clean up,
            // just a few seconds later than before.
            hostTeardownTimer = setTimeout(() => {
                hostTeardownTimer = null;
                if (!hostPort) teardownHosting();
            }, HOST_TEARDOWN_GRACE_MS);
        });
        return;
    }

    if (port.name === LOCAL_GAME_SOCKET_PORT) {
        console.log('[evio-ext] local game socket connected');

        // PortPeerSocket's whole job is making a chrome.runtime.Port look enough like a `ws`
        // WebSocket that it can feed EITHER handleConnection() directly (we're hosting this exact
        // lobby — no networking at all, same-process message passing) OR joinRemoteLobby()'s
        // relay (anyone else's lobby, including the VPS Node server's own — see that function's
        // comment). Which one depends on the lobbyCode carried in the first 'init' message, so
        // 'open' is held back until that decision is actually made and (for the remote case) the
        // real peer connection is up — telling the page's LocalSimSocket it's open any earlier
        // would let it start sending its join before there's anywhere for that data to go.
        const sock = new PortPeerSocket(port);
        let settled = false;

        port.onMessage.addListener((msg) => {
            if (!msg) return;
            if (msg.type === 'init') {
                if (settled) return; // a second 'init' on the same connection should never happen
                settled = true;
                const lobbyCode = msg.lobbyCode;
                console.log('[evio-ext] local game socket requested lobby:', lobbyCode);

                if (lobbyCode && hostLobbyCode && lobbyCode === hostLobbyCode) {
                    // Our own lobby — the existing no-networking path.
                    activeGameSocket = sock;
                    ensureGameServerStarted().then(() => {
                        const handleConnection = sim.gameServer.getHandleConnection();
                        if (!handleConnection) { console.error('[evio-ext] game server never produced a handleConnection'); return; }
                        try { port.postMessage({ type: 'open' }); } catch (e) { /* port already gone */ }
                        const fakeReq = { socket: { remoteAddress: 'extension:host', remotePort: 0 }, headers: {} };
                        handleConnection(sock, fakeReq);
                    }).catch((err) => {
                        console.error('[evio-ext] game server failed to start', err);
                        sock.close(1011, 'game server failed to start');
                    });
                } else if (lobbyCode) {
                    // Someone else's lobby (another extension host, or a VPS/Node-hosted one —
                    // joinRemoteLobby() doesn't care which).
                    joinRemoteLobby(lobbyCode, sock)
                        .then(() => { try { port.postMessage({ type: 'open' }); } catch (e) { /* port already gone */ } })
                        .catch((err) => {
                            console.error('[evio-ext] failed to join remote lobby', lobbyCode, err);
                            sock.close(1011, String((err && err.message) || err));
                        });
                } else {
                    sock.close(1011, 'no lobby code given');
                }
                return;
            }
            if (msg.type !== 'send') return;
            // Whichever consumer is on the other end (handleConnection directly, or
            // joinRemoteLobby()'s own sock.on('message',...) relay) expects (data, isBinary)
            // matching the real `ws` library — a plain-array payload means content.js's own
            // send-direction normalization (see its matching comment) carried binary bytes
            // across this same Port boundary.
            const isBinary = Array.isArray(msg.data);
            const data = isBinary ? new Uint8Array(msg.data) : msg.data;
            sock.emit('message', data, isBinary);
        });
        port.onDisconnect.addListener(() => {
            console.log('[evio-ext] local game socket disconnected');
            if (activeGameSocket === sock) activeGameSocket = null;
            sock._finishClose(1000, 'port disconnected');
        });
        return;
    }
});
