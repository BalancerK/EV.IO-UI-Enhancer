// offscreen.js — runs in the hidden offscreen document background.js creates via
// chrome.offscreen.createDocument(). The ONLY reason this file exists: RTCPeerConnection (and
// therefore all of WebRTC) is not exposed inside ANY service worker — confirmed live
// ("ReferenceError: RTCPeerConnection is not defined", thrown from inside netlib-client.js the
// moment a real peer connection was attempted, not merely advertised/listed). An offscreen
// document is a real, hidden DOM document, so it has RTCPeerConnection like any other page.
//
// This file is deliberately a "dumb pipe": it knows nothing about ev.io's protocol, sessions, or
// handleConnection — only netlib operations (create/join/list/send) and forwarding their raw
// events back to background.js over one long-lived chrome.runtime.Port. Every protocol-level
// decision (who's a real peer, what to do with their bytes, ping/pong) stays in background.js,
// exactly where it already lived before this split — this file only had to move the parts that
// literally cannot run anywhere else.
'use strict';

const netlib = self.netlib;
const PORT_NAME = 'evio-offscreen';

// This document has no visible UI and background.js's own console never sees anything thrown
// here (separate execution context) — without this, a stray exception is silent everywhere.
window.addEventListener('error', (e) => console.error('[evio-offscreen] uncaught error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[evio-offscreen] unhandled rejection', e.reason));

let hostNetwork = null;     // our own lobby, while hosting
const joinNetworks = new Map(); // requestId -> { network, serverPeerId }

const port = chrome.runtime.connect({ name: PORT_NAME });

function send(msg) {
    try { port.postMessage(msg); } catch (e) { /* background.js gone; nothing to do about it here */ }
}

// Binary data crossing THIS Port (offscreen <-> background.js, a hop that didn't exist before
// the offscreen split) needs the same explicit normalize-to-plain-array treatment every other
// chrome.runtime.Port hop in this extension already uses (see content.js's/background.js's own
// matching comments on why structured clone of a typed array isn't trusted across a Port).
// toWire() runs on data fresh off a netlib data channel (real ArrayBuffer/ArrayBufferView) before
// posting it; fromWire() runs on data just received over the Port before handing it back to
// netlib's own network.send(), which — unlike a plain array — RTCDataChannel.send() actually
// requires be a string, Blob, ArrayBuffer or ArrayBufferView.
function toWire(data) {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return Array.from(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) return Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return data;
}
function fromWire(data) {
    return Array.isArray(data) ? new Uint8Array(data) : data;
}

// netlib-client.js's Peer.send()/sendEncoded()/sendAuto() all call the real RTCDataChannel's own
// .send() unconditionally — confirmed by reading its source, there is no bufferedAmount check
// anywhere in the vendored library. Over a real internet P2P link (not localhost), any sustained
// jitter lets the channel's internal send buffer grow faster than it drains; since nothing ever
// throttles on it, the backlog only grows, and every later send sits further back in an
// ever-larger queue — this IS the root cause behind "the lobby gets laggier the longer it runs,
// and never recovers on its own" reported live after ~15 minutes of real P2P play.
//
// IMPORTANT, found the hard way: this must ONLY drop on the HOST's own OUTGOING 'unreliable'
// channel (background.js's channel split: binary -> 'unreliable', string -> 'reliable' — see
// its own comment). That channel carries per-tick game STATE broadcast from host to peer, where
// dropping is genuinely safe ("the next tick's data supersedes it anyway", the same philosophy
// game_server.js's own INPUT_QUEUE_MAX_TICKS already applies). It must NEVER be applied to a
// joining peer's own OUTGOING data (join:send — their movement/fire input, which is NOT safely
// "superseded" the same way; a dropped single-click semi-auto fire edge is a shot that never
// happened at all) or to the 'reliable' channel in EITHER direction (the exact "#SHOT#" aim ray,
// chat, ping/pong, handshake control — none of these have a "next one" to fall back on, and
// 'reliable' means reliable: WebRTC's own retransmission is what's supposed to handle congestion
// there, not us discarding the message ourselves before it ever gets that chance).
//
// Reported live: a high-ping (200-300ms) player joining through the extension saw ~25% of their
// own shots simply not register — root-caused to this exact drop firing on THEIR outgoing input/
// shot-ray traffic (join:send), not the host's broadcast it was actually designed for.
const BUFFERED_AMOUNT_DROP_THRESHOLD = 256 * 1024; // ~1s+ of backlog at typical tick-packet sizes
const _lastBackpressureWarnAt = new Map(); // peerId -> timestamp, so a sustained drop run logs once/5s, not every tick
function backpressureSend(network, peerId, channel, data) {
    if (channel === 'unreliable') {
        const peer = network.peers.get(peerId);
        const ch = peer && peer.channels && peer.channels[channel];
        if (ch && typeof ch.bufferedAmount === 'number' && ch.bufferedAmount > BUFFERED_AMOUNT_DROP_THRESHOLD) {
            const now = Date.now();
            const last = _lastBackpressureWarnAt.get(peerId) || 0;
            if (now - last > 5000) {
                _lastBackpressureWarnAt.set(peerId, now);
                console.warn(`[evio-offscreen] dropping send to ${peerId} on channel "${channel}" — bufferedAmount ${ch.bufferedAmount} over threshold, data channel can't keep up`);
            }
            return;
        }
    }
    network.send(channel, peerId, data);
}

// The data channels, by label in this order (netlib numbers them 0, 1, 2 and both ends must agree on
// the labels, so none may be added, removed or reordered). netlib's own "unreliable" is ORDERED with
// no retransmits: when one packet is lost, every later one waits in the receiver's SCTP stack until
// the sender gives the lost one up (a fast-retransmit round, ~1 RTT plus a few packets), then they all
// arrive at once — a hitch, then a burst of 3-4 states the client throws away to catch up. Unordered
// delivers each packet the moment it lands. Ordering is a sending-side choice per message, so a peer
// still on the old setting talks to this one without trouble.
const RTC_DATA_CHANNELS = {
    reliable: { ordered: true },
    unreliable: { ordered: false, maxRetransmits: 0 },
    control: { ordered: false },
};

// The server tick of a state packet ([sync, echoTick, [1, tick, ...]]), read straight from the
// msgpack bytes, or null for anything else. Only used to drop a state that arrives after a newer
// one (possible now the channel is unordered): applying it would step every player back a tick.
function readInt(v, p) {
    const b = v.getUint8(p);
    if (b <= 0x7f) return [b, p + 1];
    if (b >= 0xe0) return [b - 0x100, p + 1];
    switch (b) {
        case 0xcc: return [v.getUint8(p + 1), p + 2];
        case 0xcd: return [v.getUint16(p + 1), p + 3];
        case 0xce: return [v.getUint32(p + 1), p + 5];
        case 0xd0: return [v.getInt8(p + 1), p + 2];
        case 0xd1: return [v.getInt16(p + 1), p + 3];
        case 0xd2: return [v.getInt32(p + 1), p + 5];
        default: return null;
    }
}
function stateTick(data) {
    try {
        const v = data instanceof ArrayBuffer ? new DataView(data)
            : ArrayBuffer.isView(data) ? new DataView(data.buffer, data.byteOffset, data.byteLength) : null;
        if (!v || v.byteLength < 6 || v.getUint8(0) !== 0x93) return null;
        let r = readInt(v, 1); if (!r) return null;            // sync
        r = readInt(v, r[1]); if (!r) return null;             // echoed client tick
        let p = r[1];
        const h = v.getUint8(p);                               // body array header
        if (h >= 0x90 && h <= 0x9f) p += 1; else if (h === 0xdc) p += 3; else if (h === 0xdd) p += 5; else return null;
        if (v.getUint8(p) !== 0x01) return null;               // opcode 1 = tick
        r = readInt(v, p + 1);
        return r ? r[0] : null;
    } catch (e) { return null; }
}
const STALE_GUARD_AFTER = 40;   // packets: leave a join's first ~2s (its bootstraps) alone

function connectNetwork(gameId, signalingUrl) {
    const network = new netlib.Network(gameId, netlib.DefaultRTCConfiguration, signalingUrl);
    network.dataChannels = RTC_DATA_CHANNELS;   // before any peer exists: channels are made per peer
    return new Promise((resolve, reject) => {
        network.once('ready', () => resolve(network));
        network.once('failed', () => reject(new Error('netlib signaling failed')));
    });
}

port.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string') return;

    // ── Hosting: advertise our own lobby and accept real peers ──────────────────────────────
    if (msg.type === 'host:create') {
        (async () => {
            try {
                console.log('[evio-offscreen] host: connecting to signaling');
                if (hostNetwork) { try { hostNetwork.leave(); } catch (e) { /* ignore */ } }
                const network = await connectNetwork(msg.gameId, msg.signalingUrl);
                hostNetwork = network;
                network.on('rtcerror', (err) => console.error('[evio-offscreen] host: rtcerror', err));
                network.on('signalingerror', (err) => console.error('[evio-offscreen] host: signalingerror', err));
                console.log(`[evio-offscreen] host: signaling ready (my id=${network.id}), creating lobby`);

                network.on('connected', (peer) => { console.log('[evio-offscreen] host: peer connected', peer.id); send({ type: 'host:peerConnected', peerId: peer.id }); });
                network.on('disconnected', (peer) => { console.log('[evio-offscreen] host: peer disconnected', peer.id); _lastBackpressureWarnAt.delete(peer.id); send({ type: 'host:peerDisconnected', peerId: peer.id }); });
                network.on('message', (peer, channel, data) => {
                    send({ type: 'host:peerMessage', peerId: peer.id, data: toWire(data), isBinary: typeof data !== 'string' });
                });

                const code = await network.create({
                    public: !!msg.isPublic,
                    canUpdateBy: 'creator',
                    customData: { ...msg.customData, serverPeerId: network.id },
                });
                if (!code) throw new Error('create() failed — signaling server refused the lobby');
                console.log(`[evio-offscreen] host: lobby created, code=${code}`);
                send({ type: 'host:created', requestId: msg.requestId, ok: true, lobbyCode: code, peerId: network.id });
            } catch (err) {
                console.error('[evio-offscreen] host: failed', err);
                if (hostNetwork) { try { hostNetwork.leave(); } catch (e) { /* ignore */ } hostNetwork = null; }
                send({ type: 'host:created', requestId: msg.requestId, ok: false, error: String((err && err.message) || err) });
            }
        })();
        return;
    }
    if (msg.type === 'host:send') {
        if (!hostNetwork) return;
        try { backpressureSend(hostNetwork, msg.peerId, msg.channel, fromWire(msg.data)); } catch (e) { /* peer likely already gone */ }
        return;
    }
    if (msg.type === 'host:leave') {
        if (hostNetwork) { try { hostNetwork.leave(); } catch (e) { /* ignore */ } hostNetwork = null; }
        return;
    }

    // ── Joining: reach another peer's lobby (ours elsewhere, another extension host, or the
    // VPS/Node server's own — all identical from here, netlib doesn't distinguish) ───────────
    if (msg.type === 'join:start') {
        (async () => {
            const requestId = msg.requestId;
            try {
                console.log(`[evio-offscreen] join: connecting to signaling for lobby ${msg.lobbyCode}`);
                const network = await connectNetwork(msg.gameId, msg.signalingUrl);
                network.on('rtcerror', (err) => console.error('[evio-offscreen] join: rtcerror', err));
                network.on('signalingerror', (err) => console.error('[evio-offscreen] join: signalingerror', err));
                console.log(`[evio-offscreen] join: signaling ready (my id=${network.id}), calling join(${msg.lobbyCode})`);

                const lobbyInfo = await network.join(msg.lobbyCode);
                console.log('[evio-offscreen] join: join() resolved, lobbyInfo=', lobbyInfo);
                const serverPeerId = lobbyInfo && lobbyInfo.customData && lobbyInfo.customData.serverPeerId;
                if (!serverPeerId) throw new Error('joined lobby has no customData.serverPeerId — refusing to trust it as the server');

                const entry = { network, serverPeerId, newestTick: null, received: 0, stale: 0 };
                joinNetworks.set(requestId, entry);

                network.on('message', (peer, channel, data) => {
                    if (peer.id !== serverPeerId) return;
                    if (channel === 'unreliable' && typeof data !== 'string') {
                        const t = stateTick(data);
                        if (t !== null) {
                            entry.received++;
                            // Strictly older only: a packet with the same tick (an introduction
                            // riding next to the tick body) always goes through. A big step back
                            // is a restarted host, not a late packet.
                            if (entry.newestTick !== null && t < entry.newestTick && entry.newestTick - t < 200
                                && entry.received > STALE_GUARD_AFTER) {
                                if (++entry.stale <= 3 || entry.stale % 100 === 0) {
                                    console.log(`[evio-offscreen] join: dropped a late state (tick ${t} after ${entry.newestTick}; ${entry.stale} so far)`);
                                }
                                return;
                            }
                            if (entry.newestTick === null || t > entry.newestTick || entry.newestTick - t >= 200) entry.newestTick = t;
                        }
                    }
                    send({ type: 'join:message', requestId, data: toWire(data), isBinary: typeof data !== 'string' });
                });
                network.on('disconnected', (peer) => {
                    if (peer.id !== serverPeerId) return;
                    console.warn('[evio-offscreen] join: server peer disconnected', peer.id);
                    _lastBackpressureWarnAt.delete(peer.id);
                    joinNetworks.delete(requestId);
                    send({ type: 'join:disconnected', requestId });
                });

                // The data-channel handshake can finish before OR after join() resolves — check
                // both rather than only ever listening forward.
                if (!network.peers.get(serverPeerId)) {
                    console.log(`[evio-offscreen] join: waiting for data channel to peer ${serverPeerId}`);
                    await new Promise((resolve) => {
                        function onConnected(peer) {
                            if (peer.id !== serverPeerId) return;
                            network.off('connected', onConnected);
                            resolve();
                        }
                        network.on('connected', onConnected);
                    });
                }
                console.log(`[evio-offscreen] join: data channel to ${serverPeerId} is up`);

                send({ type: 'join:result', requestId, ok: true, serverPeerId });
            } catch (err) {
                console.error('[evio-offscreen] join: failed', err);
                const entry = joinNetworks.get(requestId);
                if (entry) { try { entry.network.leave(); } catch (e) { /* ignore */ } joinNetworks.delete(requestId); }
                send({ type: 'join:result', requestId, ok: false, error: String((err && err.message) || err) });
            }
        })();
        return;
    }
    if (msg.type === 'join:send') {
        const entry = joinNetworks.get(msg.requestId);
        if (!entry) return;
        // Deliberately NOT backpressureSend — see its own comment. This is a joining peer's own
        // outgoing input/shot data, which is never safe for us to silently drop.
        try { entry.network.send(msg.channel, entry.serverPeerId, fromWire(msg.data)); } catch (e) { /* ignore */ }
        return;
    }
    if (msg.type === 'join:leave') {
        const entry = joinNetworks.get(msg.requestId);
        if (!entry) return;
        joinNetworks.delete(msg.requestId);
        try { entry.network.leave(); } catch (e) { /* ignore */ }
        return;
    }
});
