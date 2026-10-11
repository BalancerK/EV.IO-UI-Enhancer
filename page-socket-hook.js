// page-socket-hook.js — runs in the PAGE's MAIN world (see manifest.json's "world":"MAIN"),
// injected by content.js via a <script src="..."> tag. This is the only file in this extension
// that actually touches window.WebSocket, because overriding it from content.js's own isolated
// world would have no effect on the real page/game code at all — they're separate `window`
// objects. See content.js's own comment block for the full three-hop relay this is one end of.
//
// This file has NO access to chrome.runtime.* (main-world scripts don't get extension APIs), so
// it only ever talks to content.js via window.postMessage — never directly to background.js.
(function () {
    'use strict';

    if (window.__EVIO_EXT_PAGE_HOOK__) return;
    window.__EVIO_EXT_PAGE_HOOK__ = true;

    const HOOK_MSG_SOURCE = 'evio-ext-page-hook';
    const RELAY_MSG_SOURCE = 'evio-ext-isolated-relay';

    // Read synchronously, right now, at this file's own startup — same pattern the userscript
    // already uses (?evioCustom=... in readCustomConfig), and for the same reason: a URL param
    // is already part of the page's own address before a single byte of this script (or the
    // real game bundle) has loaded, so there is no "did the message arrive in time" race to
    // have in the first place, unlike the postMessage-based flag this replaced.
    //
    // Only the PRESENCE of the param matters for now, not matching its value against a specific
    // lobby code — this slice only ever routes to the host's OWN local simulation (via the
    // chrome.runtime Port relay below), regardless of which lobby code is in the URL. Joining a
    // DIFFERENT player's lobby (real netlib peer connection, not this same-browser relay) is a
    // separate, not-yet-built feature; the lobby code is already threaded through here so that
    // feature has it available when it exists, without another round of URL-scheme plumbing.
    const hostingActive = new URLSearchParams(window.location.search).has('evioCustom');
    const targetLobbyCode = new URLSearchParams(window.location.search).get('evioCustom');
    let activeSocket = null; // the one LocalSimSocket currently relayed, if any

    function isEvioSocialSocket(url) {
        return typeof url === 'string' && url.indexOf('social.ev.io') !== -1;
    }
    function isEvioGameSocket(url) {
        if (typeof url !== 'string') return false;
        if (isEvioSocialSocket(url)) return false;
        return /wss?:\/\/evio-[^/]+\.rivet\.game\/?/i.test(url) || /wss?:\/\/evio-[^/]+/i.test(url);
    }

    // ── Identity/loadout/skin bridge ──────────────────────────────────────────────────────────
    // Ported from "ev.io - Custom Server Socket.user.js"'s own identity-capture block: the bare
    // join payload the client itself sends only carries uid/token/mmLobbyId/buildIdentifier (see
    // evidence/client/PHASE1_CONNECTION_FLOW.md) — no NAME, no loadout, no skin. The real client
    // fetches those from its own account/skins endpoints for its OWN UI; we just read the same
    // responses as they fly by (via a fetch() override, since this is a GET the page already
    // makes for itself) and bridge them into the join payload the fake socket sends, the same way
    // the userscript does. Namespaced as __EVIO_EXT_* throughout so it can never collide with an
    // actual userscript doing the same thing on the same page.
    window.__EVIO_EXT_SKINS__ = null; // nid (string) -> skin catalogue entry, from /all-skins
    window.__EVIO_EXT_PROFILE__ = null;

    // Pushes a loadout/skin/clan CHANGE to the already-joined session via '#EVL#' — needed
    // because the clan insignia specifically only ever resolves AFTER the join already went out
    // (fetchClanData is a network round-trip; the join can't wait on it), so without this the
    // clan logo would never show up at all except by luck. _lastLoadoutKey's "skip the first
    // capture" rule exists because that snapshot is already covered by the join payload itself —
    // only a CHANGE after that point needs pushing live. Ported from the userscript's identical
    // maybePushLoadoutUpdate/_lastLoadoutKey.
    let _lastLoadoutKey = null;
    function maybePushLoadoutUpdate(prof) {
        try {
            const key = JSON.stringify([prof.abilityLoadoutId, prof.abilitySeed, prof.skinUrl,
                prof.weaponSkins, prof.thumbUrl, prof.skinRarity, prof.clanImgUrl, prof.clanLink]);
            if (key === _lastLoadoutKey) return;
            const firstCapture = _lastLoadoutKey === null;
            _lastLoadoutKey = key;
            if (firstCapture) return;
            if (!activeSocket || activeSocket.readyState !== 1) return;
            activeSocket.send('#EVL#' + JSON.stringify({
                abilityLoadoutId: prof.abilityLoadoutId,
                abilitySeed: prof.abilitySeed,
                skinUrl: prof.skinUrl,
                weaponSkins: prof.weaponSkins,
                thumbUrl: prof.thumbUrl,
                skinRarity: prof.skinRarity,
                clanImgUrl: prof.clanImgUrl,
                clanLink: prof.clanLink,
            }));
            console.log(`%c[evio-ext] pushed LIVE loadout update -> server (weapon=${prof.abilityLoadoutId})`, 'color:#00bcd4;font-weight:bold');
        } catch (e) { /* ignore */ }
    }

    // Clan insignia bridging — ported from the userscript's scanForClan/fetchClanData/
    // extractClanForUid. Two sources, cheapest first: (1) scan the account JSON we already have
    // in hand for an embedded clan hint (no extra fetch), (2) fall back to a /clans-all3 fetch and
    // a generic object walk for an entry whose membership list contains our uid/name. Manual
    // override keys (evioClanImg/evioClanLink) are the SAME localStorage keys the userscript
    // reads — intentionally shared, not namespaced, since this is a user-facing manual override
    // either tool should honor if the player already set one.
    const _clan = { img: null, link: null };
    function clanOverrideLoaded() {
        try {
            const i = localStorage.getItem('evioClanImg'), l = localStorage.getItem('evioClanLink');
            if (i) _clan.img = i;
            if (l) _clan.link = l;
        } catch (e) { /* ignore */ }
        return !!(_clan.img && _clan.link);
    }
    function scanForClan(node, depth) {
        if (!node || depth > 6 || (_clan.img && _clan.link)) return;
        if (typeof node === 'string') {
            if (!_clan.img && node.indexOf('/insignias/') !== -1) {
                _clan.img = /^https?:/i.test(node) ? node : ('https://ev.io/' + node.replace(/^\/*/, '/'));
            } else if (!_clan.link) {
                const m = /^\/?group\/(\d+)$/.exec(node);
                if (m) _clan.link = '/group/' + m[1];
            }
            return;
        }
        if (typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach((v) => scanForClan(v, depth + 1)); return; }
        for (const k in node) {
            if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
            if (!_clan.link && /^(gid|group_?id|clan_?id)$/i.test(k)) {
                const v = node[k];
                if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) _clan.link = '/group/' + v;
            }
            scanForClan(node[k], depth + 1);
        }
    }
    function extractClanForUid(data, uid, username) {
        const uidStr = String(uid), nameStr = String(username || '').toLowerCase();
        let best = null;
        (function walk(n, depth) {
            if (!n || depth > 8 || typeof n !== 'object' || best) return;
            if (Array.isArray(n)) { for (const v of n) { if (best) break; walk(v, depth + 1); } return; }
            let insignia = null, link = null, cid = null;
            const ids = {}, names = [];
            for (const k in n) {
                if (!Object.prototype.hasOwnProperty.call(n, k)) continue;
                const v = n[k];
                if (typeof v === 'string' && v.indexOf('/insignias/') !== -1) insignia = v;
                else if (typeof v === 'string' && /homepage|clan_?url|link|path/i.test(k)) link = v;
                if (/^(cid|gid|id|group_?id|clan_?id|nid)$/i.test(k)) cid = String(v);
                if (!/^(deployed|members?|players?|uids?|users?|roster)$/i.test(k)) continue;
                const flat = (typeof v === 'string') ? v : (typeof v === 'number' ? String(v) : (Array.isArray(v) ? v.join(',') : null));
                if (!flat) continue;
                const t = flat.match(/[0-9]+/g);
                if (t) t.forEach((n2) => { ids[n2] = 1; });
                flat.toLowerCase().split(/\s*,\s*/).forEach((nm) => { if (nm) names.push(nm); });
            }
            if (insignia && (ids[uidStr] || (nameStr && names.indexOf(nameStr) !== -1))) {
                best = { insignia, link, gid: cid, node: n };
                return;
            }
            for (const k2 in n) { if (Object.prototype.hasOwnProperty.call(n, k2)) walk(n[k2], depth + 1); }
        })(data, 0);
        return best;
    }
    function fetchClanData(prof) {
        if (!prof || prof.isGuest) return;
        if (_clan.img && _clan.link) return;
        try {
            _nativeFetch('https://ev.io/clans-all3', { credentials: 'include' })
                .then((r) => (r.ok ? r.json() : null))
                .then((data) => {
                    if (!data) return;
                    window.__EVIO_EXT_CLANS_RAW__ = data;
                    const hit = extractClanForUid(data, prof.uid, prof.name);
                    if (!hit) return;
                    if (!_clan.img) {
                        _clan.img = /^https?:/i.test(hit.insignia) ? hit.insignia : ('https://ev.io/' + String(hit.insignia).replace(/^\/*/, '/'));
                    }
                    if (!_clan.link) {
                        if (hit.link) _clan.link = (hit.link.charAt(0) === '/' || /^https?:/i.test(hit.link)) ? hit.link : ('/' + hit.link);
                        else if (hit.gid) _clan.link = '/group/' + hit.gid;
                    }
                    prof.clanImgUrl = _clan.img;
                    prof.clanLink = _clan.link;
                    console.log(`%c[evio-ext] clan resolved from clans-all3: img=${_clan.img} link=${_clan.link}`, 'color:#00bcd4;font-weight:bold');
                    maybePushLoadoutUpdate(prof);
                })
                .catch((e) => console.log('[evio-ext] clans-all3 fetch failed:', e && e.message));
        } catch (e) { /* ignore */ }
    }

    function resolveSkinUrl(skinNid) {
        const skins = window.__EVIO_EXT_SKINS__;
        if (skinNid == null || !skins) return null;
        const e = skins[String(skinNid)];
        return (e && e.field_skin) ? ('https://ev.io' + e.field_skin) : null;
    }
    function resolveThumbUrl(skinNid) {
        const skins = window.__EVIO_EXT_SKINS__;
        if (skinNid == null || !skins) return null;
        const e = skins[String(skinNid)];
        return (e && e.field_profile_thumb) ? ('https://ev.io/' + e.field_profile_thumb) : null;
    }
    function resolveSkinRarity(skinNid) {
        const skins = window.__EVIO_EXT_SKINS__;
        if (skinNid == null || !skins) return null;
        const e = skins[String(skinNid)];
        return (e && (e.field_tier || e.field_rarity)) || null;
    }
    function resolveWeaponSkinUrl(skinNid) {
        const skins = window.__EVIO_EXT_SKINS__;
        if (skinNid == null || !skins) return null;
        const e = skins[String(skinNid)];
        return (e && e.field_model) ? ('https://ev.io/' + e.field_model) : null;
    }
    const WEAPON_SKIN_MAP = [
        { acct: 'field_auto_rifle_skin',  prop: 'Qcdgi7s' },
        { acct: 'field_hand_cannon_skin', prop: 'Qy8jpjd' },
        { acct: 'field_laser_rifle_skin', prop: 'Qclpb4q' },
        { acct: 'field_burst_rifle_skin', prop: 'Qb9vw3f' },
        { acct: 'field_sweeper_skin',     prop: 'Ql3d4qw' },
        { acct: 'field_sword_skin',       prop: 'Q53m0bo' },
    ];
    function resolveWeaponSkins(acc) {
        const out = {};
        WEAPON_SKIN_MAP.forEach((m) => {
            const fld = acc[m.acct];
            let nid = fld && fld[0] && fld[0].target_id;
            nid = (nid === undefined || nid === null) ? null : parseInt(nid, 10);
            if (!nid) return;
            const url = resolveWeaponSkinUrl(nid);
            if (url) out[m.prop] = url;
        });
        return out;
    }

    function looksLikeAccount(o) {
        return !!(o && o.uid && o.uid[0] && o.uid[0].value !== undefined && o.uid[0].value !== null);
    }
    function extractAccount(data) {
        if (looksLikeAccount(data)) return data;
        if (data && looksLikeAccount(data.account)) return data.account;
        if (Array.isArray(data)) {
            let guest = null;
            for (const d of data) {
                const a = looksLikeAccount(d) ? d : (d && d.account);
                if (!looksLikeAccount(a)) continue;
                if (a.uid[0].value === 17) guest = a; else return a;
            }
            return guest;
        }
        return null;
    }
    // Local loadout override — mirrors the userscript's own fallback for when the account API
    // hasn't caught up with a just-changed loadout yet (ev.io's own settings cache key).
    function readLocalLoadout() {
        try {
            const raw = localStorage.getItem('ev_settings_k');
            if (!raw) return null;
            const s = JSON.parse(raw);
            if (!s || typeof s !== 'object') return null;
            let build = s.abilityBuild;
            if (typeof build === 'string') { try { build = JSON.parse(build); } catch (e) { build = null; } }
            const pw = parseInt(s.primaryWeaponId, 10);
            return {
                primaryWeaponId: Number.isFinite(pw) ? pw : NaN,
                abilityBuild: Array.isArray(build) ? build : null,
            };
        } catch (e) { return null; }
    }

    function captureAccount(data) {
        const acc = extractAccount(data);
        if (!acc) return;
        const loadoutRaw = (acc.field_abilities_loadout && acc.field_abilities_loadout[0] && acc.field_abilities_loadout[0].value) || null;
        let abilitySeed = null;
        if (loadoutRaw) { try { abilitySeed = JSON.parse(loadoutRaw); } catch (e) { /* ignore */ } }
        let primaryWeapon = acc.field_primary_weapon && acc.field_primary_weapon[0] && acc.field_primary_weapon[0].value;
        primaryWeapon = (primaryWeapon === undefined || primaryWeapon === null) ? NaN : parseInt(primaryWeapon, 10);

        const localCfg = readLocalLoadout();
        if (!Number.isFinite(primaryWeapon) && localCfg && Number.isFinite(localCfg.primaryWeaponId)) {
            primaryWeapon = localCfg.primaryWeaponId;
        }
        if ((!Array.isArray(abilitySeed) || !abilitySeed.length) && localCfg && Array.isArray(localCfg.abilityBuild)) {
            abilitySeed = localCfg.abilityBuild;
        }
        const prof = {
            uid: acc.uid[0].value,
            name: (acc.name && acc.name[0] && acc.name[0].value) || 'Guest',
            isGuest: acc.uid[0].value === 17,
            abilityLoadoutId: Number.isFinite(primaryWeapon) ? primaryWeapon : null,
            skinTargetId: (acc.field_eq_skin && acc.field_eq_skin[0] && acc.field_eq_skin[0].target_id) || null,
            abilitySeed: Array.isArray(abilitySeed) ? abilitySeed : null,
        };
        prof.skinUrl = resolveSkinUrl(prof.skinTargetId);
        prof.thumbUrl = resolveThumbUrl(prof.skinTargetId);
        prof.skinRarity = resolveSkinRarity(prof.skinTargetId);
        clanOverrideLoaded();
        scanForClan(acc, 0);
        prof.clanImgUrl = _clan.img;
        prof.clanLink = _clan.link;
        fetchClanData(prof); // async — fills in prof.clanImgUrl/clanLink later if scanForClan found nothing
        prof.weaponSkins = resolveWeaponSkins(acc);
        window.__EVIO_EXT_AUTH__ = acc;
        window.__EVIO_EXT_PROFILE__ = prof;
        console.log(`%c[evio-ext] identity captured: uid=${prof.uid} name=${JSON.stringify(prof.name)}`
            + `${prof.isGuest ? ' (guest)' : ' (registered)'} primaryWeapon=${prof.abilityLoadoutId}`
            + ` skin=${prof.skinTargetId} skinUrl=${prof.skinUrl} weaponSkins=${Object.keys(prof.weaponSkins).length}`,
            'color:#00bcd4;font-weight:bold');
        maybePushLoadoutUpdate(prof);
    }

    function captureSkins(list) {
        if (!Array.isArray(list)) return;
        const map = {};
        for (const s of list) {
            if (s && s.nid !== undefined) map[String(s.nid)] = s;
        }
        window.__EVIO_EXT_SKINS__ = map;
        console.log(`%c[evio-ext] skins catalogue captured: ${list.length} entries`, 'color:#00bcd4');
        const prof = window.__EVIO_EXT_PROFILE__;
        if (prof) {
            if (!prof.skinUrl && prof.skinTargetId != null) prof.skinUrl = resolveSkinUrl(prof.skinTargetId);
            if (!prof.thumbUrl && prof.skinTargetId != null) prof.thumbUrl = resolveThumbUrl(prof.skinTargetId);
            if (!prof.skinRarity && prof.skinTargetId != null) prof.skinRarity = resolveSkinRarity(prof.skinTargetId);
            if (window.__EVIO_EXT_AUTH__ && (!prof.weaponSkins || !Object.keys(prof.weaponSkins).length)) {
                prof.weaponSkins = resolveWeaponSkins(window.__EVIO_EXT_AUTH__);
            }
        }
    }

    const _nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        let url = '';
        try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) { /* ignore */ }
        const p = _nativeFetch.apply(this, arguments);
        try {
            if (/\/(me|user\/\d+)\?_format=json/.test(url)) {
                p.then((res) => { try { res.clone().json().then(captureAccount).catch(() => {}); } catch (e) { /* ignore */ } }).catch(() => {});
            } else if (/\/all-skins(\?|$)/.test(url)) {
                p.then((res) => { try { res.clone().json().then(captureSkins).catch(() => {}); } catch (e) { /* ignore */ } }).catch(() => {});
            }
        } catch (e) { /* ignore */ }
        return p;
    };
    try {
        _nativeFetch('https://ev.io/all-skins', { headers: { Accept: 'application/json' } })
            .then((r) => r.json()).then(captureSkins)
            .catch((e) => console.warn('[evio-ext] all-skins fetch failed', e));
    } catch (e) { /* ignore */ }

    function LocalSimSocket() {
        this.readyState = 0; // CONNECTING
        this.binaryType = 'blob';
        this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
        this._listeners = { open: [], message: [], close: [], error: [] };
        if (activeSocket) console.warn('[evio-ext] a SECOND LocalSimSocket was constructed while one was already active — the first is being abandoned');
        activeSocket = this;
        window.__EVIO_EXT_GAME_SOCKET__ = this; // for manual inspection from devtools if needed
        console.log('[evio-ext] LocalSimSocket constructed, requesting open');
        window.postMessage({ source: HOOK_MSG_SOURCE, type: 'socket-open-request', lobbyCode: targetLobbyCode }, window.location.origin);
    }
    LocalSimSocket.prototype.CONNECTING = 0;
    LocalSimSocket.prototype.OPEN = 1;
    LocalSimSocket.prototype.CLOSING = 2;
    LocalSimSocket.prototype.CLOSED = 3;
    LocalSimSocket.prototype.addEventListener = function (type, fn) {
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(fn);
    };
    LocalSimSocket.prototype.removeEventListener = function (type, fn) {
        const list = this._listeners[type];
        if (!list) return;
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
    };
    LocalSimSocket.prototype._dispatch = function (type, evt) {
        evt = evt || {}; evt.type = type; evt.target = this;
        const direct = this['on' + type];
        if (typeof direct === 'function') {
            try { direct.call(this, evt); } catch (e) { console.error('[evio-ext] on' + type + ' handler threw', e); }
        }
        (this._listeners[type] || []).slice().forEach((fn) => {
            try { fn.call(this, evt); } catch (e) { console.error('[evio-ext] ' + type + ' listener threw', e); }
        });
    };
    LocalSimSocket.prototype.send = function (data) {
        if (this.readyState !== 1) {
            console.warn('[evio-ext] LocalSimSocket.send() dropped — readyState is', this.readyState, 'not OPEN', data);
            return;
        }
        // Join-payload augmentation — ported from the userscript's own sock.send() wrapper. The
        // bare client's join only carries uid/token/mmLobbyId/buildIdentifier; this bridges in
        // whatever we've captured from the account/skins fetches above, same fields, same
        // "only fill in what's missing" rule (never overwrite something the client already set).
        if (typeof data === 'string' && data.charAt(0) === ';' && data.length > 1) {
            const prof = window.__EVIO_EXT_PROFILE__;
            if (prof) {
                try {
                    const obj = JSON.parse(data.slice(1));
                    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                        if (obj.name === undefined && prof.name) obj.name = prof.name;
                        if (obj.uid === undefined && prof.uid !== undefined) obj.uid = prof.uid;
                        if (obj.abilityLoadoutId === undefined && prof.abilityLoadoutId != null) obj.abilityLoadoutId = prof.abilityLoadoutId;
                        if (obj.abilitySeed === undefined && prof.abilitySeed) obj.abilitySeed = prof.abilitySeed;
                        if (obj.skinUrl === undefined && prof.skinUrl) obj.skinUrl = prof.skinUrl;
                        if (obj.thumbUrl === undefined && prof.thumbUrl) obj.thumbUrl = prof.thumbUrl;
                        if (obj.skinRarity === undefined && prof.skinRarity) obj.skinRarity = prof.skinRarity;
                        if (obj.clanImgUrl === undefined && prof.clanImgUrl) obj.clanImgUrl = prof.clanImgUrl;
                        if (obj.clanLink === undefined && prof.clanLink) obj.clanLink = prof.clanLink;
                        if (obj.weaponSkins === undefined && prof.weaponSkins && Object.keys(prof.weaponSkins).length) obj.weaponSkins = prof.weaponSkins;
                        data = ';' + JSON.stringify(obj);
                        console.log(`%c[evio-ext] join augmented: name=${JSON.stringify(prof.name)} uid=${obj.uid} skinUrl=${prof.skinUrl || '(default)'}`, 'color:#00bcd4;font-weight:bold');
                    }
                } catch (e) { /* not JSON — leave it alone */ }
            }
        }
        window.postMessage({ source: HOOK_MSG_SOURCE, type: 'socket-send', data }, window.location.origin);
    };
    LocalSimSocket.prototype.close = function (code, reason) {
        if (this.readyState === 3) return;
        console.warn('[evio-ext] LocalSimSocket.close() called by the game client', { code, reason });
        console.trace('[evio-ext] close call stack');
        this.readyState = 2;
        window.postMessage({ source: HOOK_MSG_SOURCE, type: 'socket-close' }, window.location.origin);
        this.readyState = 3;
        if (activeSocket === this) activeSocket = null;
        this._dispatch('close', { code: code || 1000, reason: reason || '', wasClean: true });
    };

    window.addEventListener('message', (event) => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        const msg = event.data;
        if (!msg || msg.source !== RELAY_MSG_SOURCE) return;

        if (msg.type !== 'socket-event') return;
        if (!activeSocket) {
            console.warn('[evio-ext] socket-event arrived with no activeSocket — dropped:', msg.event && msg.event.type);
            return;
        }

        const evt = msg.event;
        if (evt.type === 'open') {
            console.log('[evio-ext] LocalSimSocket received open confirmation');
            activeSocket.readyState = 1;
            activeSocket._dispatch('open', {});
        } else if (evt.type === 'message') {
            // Binary packets cross the chrome.runtime.Port hop (background.js -> content.js) as a
            // plain array of byte values (see content.js's own comment on the reverse direction) —
            // rebuild a real ArrayBuffer here so the game's own msgpack decode sees what it expects.
            let data = evt.data;
            if (Array.isArray(data)) data = new Uint8Array(data).buffer;
            activeSocket._dispatch('message', { data });
        } else if (evt.type === 'close') {
            activeSocket.readyState = 3;
            activeSocket._dispatch('close', { code: evt.code || 1000, reason: evt.reason || '', wasClean: true });
            activeSocket = null;
        }
    });

    const NativeWebSocket = window.WebSocket;

    function RoutedWebSocket(url, protocols) {
        const urlStr = String(url || '');
        if (hostingActive && isEvioGameSocket(urlStr)) {
            console.log('%c[evio-ext] game socket routed to our own hosted simulation', 'color:#9c27b0;font-weight:bold', urlStr);
            window.__EVIO_EXT_CUSTOM__.enabled = true;
            return new LocalSimSocket();
        }
        return protocols !== undefined ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
    }
    RoutedWebSocket.prototype = NativeWebSocket.prototype;
    RoutedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    RoutedWebSocket.OPEN = NativeWebSocket.OPEN;
    RoutedWebSocket.CLOSING = NativeWebSocket.CLOSING;
    RoutedWebSocket.CLOSED = NativeWebSocket.CLOSED;
    window.WebSocket = RoutedWebSocket;

    // ── Bundle interception, ported from the userscript's patchAndInject/startBundleObserver ──
    //
    // The override above alone isn't reliable enough: this script is injected by content.js,
    // which runs asynchronously relative to the page's own bootstrap, so there's a real race
    // where ev.io's bundle.js could start executing (and capture its own reference to the
    // original WebSocket, or open its socket) before this file has even finished loading. The
    // userscript solves this proven way: don't just override WebSocket early and hope — actively
    // intercept the bundle's own <script> tag however it gets inserted (via the `.src` property,
    // via setAttribute, or caught after the fact by a MutationObserver as a last resort), stop
    // the browser from loading it directly, fetch its source ourselves, and inject it as a new
    // script under OUR control. That guarantees this file's own code (already run by the time any
    // of these interception paths fire) is fully installed before the bundle's code ever runs —
    // a guarantee "install the override early" alone can't make.
    //
    // Ported verbatim from "ev.io - Custom Server Socket.user.js"'s own `patches` array (same
    // from/to text, same find-and-replace mechanism) — this extension's hosting feature needs the
    // same client-side relief from treating a custom simulation's output as if it were an official
    // server's: the production comparator otherwise logs/acts on cosmetic server/client
    // disagreements (pitch, pitchOffset, recoil state wiped on every reconcile) that are expected
    // and harmless against our own sim, exactly as they are against the Node custom server.
    //
    // Gated on window.__EVIO_EXT_CUSTOM__.enabled — this extension's OWN namespaced flag, not the
    // userscript's window.__EVIO_CUSTOM__, so the two never collide if both happen to be
    // installed. Set true only while a hosted/joined session is actually routed to our sim (see
    // the RoutedWebSocket check below), same as the userscript only enables its own flag when
    // cfg.enabled is true.
    window.__EVIO_EXT_CUSTOM__ = { enabled: false };

    // 6b8's reconcile-preserve glue: keeps recoil/pitch/weaponSlots state across a reconcile reset
    // instead of letting the server's (intentionally minimal) per-tick body wipe them — see the
    // userscript's own identical comment on 6b8 for why this is needed at all (no opcode carries
    // these fields, so a wholesale state swap zeros them with nothing to restore them from).
    window.__EVIO_EXT_PRESERVE_RECON__ = function (oldState, newState) {
        try {
            if (window.__EVIO_EXT_CUSTOM__.enabled && oldState && newState) {
                newState.Qcrzrpr = oldState.Qcrzrpr;
                newState.Qd0yy90 = oldState.Qd0yy90;
                newState.Qq1azjr = oldState.Qq1azjr;
                newState.Qq1azd5 = oldState.Qq1azd5;
                newState.Qm2pxgr = oldState.Qm2pxgr;
                if (oldState.Qwf7j5k) newState.Qwf7j5k = oldState.Qwf7j5k;
            }
        } catch (e) { /* ignore */ }
        return newState;
    };

    // SR1's forwarding glue: sends the client's own exact shot ray (not a server-reconstructed
    // approximation from player state) to game_server.js's enqueueClientRay/"#SHOT#" handler —
    // same format the Node server's own protocol already expects.
    window.__EVIO_EXT_SHOTRAY__ = function (origin, dir, sid) {
        try {
            if (!window.__EVIO_EXT_CUSTOM__.enabled || !origin || !dir) return;
            if (!activeSocket || activeSocket.readyState !== 1) return;
            const r = (n) => Math.round(n * 1000) / 1000;
            let msg = `#SHOT#${r(origin.x)},${r(origin.y)},${r(origin.z)},${r(dir.x)},${r(dir.y)},${r(dir.z)}`;
            if (sid != null && sid !== '') msg += ',' + sid;
            activeSocket.send(msg);
        } catch (e) { /* ignore */ }
    };

    const patches = [
        {
            // Mis-assessed last cleanup pass as a generic, rarely-relevant safety net — it's not.
            // This guards Qto0i2z, the SOUND engine's per-tick update: it loops bullet/shot events
            // and looks up each shooter's player entity from the state's roster to pick the right
            // shoot sound. On the custom server, a shot event can reference a shooter whose entity
            // hasn't been (re)registered in that exact snapshot yet — far more likely here than
            // against official's own timing — and the resulting uncaught exception aborts the rest
            // of that frame's update chain, including the weapon-slot/HUD work scheduled after it.
            // Confirmed live: removing this made the primary weapon not show up in a custom lobby.
            name: '6a  undefined player crash guard',
            from: 'var Q=n.Qa7phk3[p.Qxluan],f=hb.Qhkjwni.Qqg43ev().dataById[Q.Qslw9vf];',
            to:   'var Q=n.Qa7phk3[p.Qxluan];if(void 0===Q)continue;var f=hb.Qhkjwni.Qqg43ev().dataById[Q.Qslw9vf];',
        },
        {
            name: '6b7 custom-mode: skip pitch + pitchOffset (production comparator)',
            from: 'Math.abs(e.Qcrzrpr-t.Qcrzrpr)>1e-4||Math.abs(e.Qd0yy90-t.Qd0yy90)>1e-4||',
            to:   '(!(window.__EVIO_EXT_CUSTOM__&&window.__EVIO_EXT_CUSTOM__.enabled)&&(Math.abs(e.Qcrzrpr-t.Qcrzrpr)>1e-4||Math.abs(e.Qd0yy90-t.Qd0yy90)>1e-4))||',
        },
        {
            name: '6b9 custom-mode: skip pitch + pitchOffset in the DEBUG comparator (the live one)',
            from: "Math.abs(e.Qcrzrpr-t.Qcrzrpr)>1e-4&&n.push('pitch  =>  Server: '+JSON.stringify(e.Qcrzrpr)+'   Client: '+JSON.stringify(t.Qcrzrpr)),Math.abs(e.Qd0yy90-t.Qd0yy90)>1e-4&&n.push('pitchOffset  =>  Server: '+JSON.stringify(e.Qd0yy90)+'   Client: '+JSON.stringify(t.Qd0yy90)),",
            to:   "!(window.__EVIO_EXT_CUSTOM__&&window.__EVIO_EXT_CUSTOM__.enabled)&&(Math.abs(e.Qcrzrpr-t.Qcrzrpr)>1e-4&&n.push('pitch  =>  Server: '+JSON.stringify(e.Qcrzrpr)+'   Client: '+JSON.stringify(t.Qcrzrpr)),Math.abs(e.Qd0yy90-t.Qd0yy90)>1e-4&&n.push('pitchOffset  =>  Server: '+JSON.stringify(e.Qd0yy90)+'   Client: '+JSON.stringify(t.Qd0yy90))),",
        },
        {
            name: '6b8 custom-mode: preserve recoil + ammo through reconcile reset',
            from: 'this.Qxo2o14[t].Qt03jhz.Qcvr9bt=this.Qh23rk3.Q820rrc(e.body)',
            to:   'this.Qxo2o14[t].Qt03jhz.Qcvr9bt=(window.__EVIO_EXT_PRESERVE_RECON__?window.__EVIO_EXT_PRESERVE_RECON__(this.Qxo2o14[t].Qt03jhz.Qcvr9bt,this.Qh23rk3.Q820rrc(e.body)):this.Qh23rk3.Q820rrc(e.body))',
        },
        {
            name: 'CH1 custom-mode: send all chat over the game socket (social is dead)',
            from: "a.includes('/examine')||a.includes('/dance'))lb.Ql1g6nk.Qam4u9w.Qm0eht4({msg:a})",
            to:   "(window.__EVIO_EXT_CUSTOM__&&window.__EVIO_EXT_CUSTOM__.enabled)||a.includes('/examine')||a.includes('/dance'))lb.Ql1g6nk.Qam4u9w.Qm0eht4({msg:a})",
        },
        {
            name: 'SR1 forward exact shot ray + sessionId to custom server',
            from: "u.push({Q7q6byi:f+':'+p+':'+a,Q616y7o:0,Qxluan:p,Qtql1ud:l.clone(),Qsjaj00:v,",
            to:   "(window.__EVIO_EXT_SHOTRAY__&&window.__EVIO_EXT_SHOTRAY__(l,v,f+':'+p+':'+a)),u.push({Q7q6byi:f+':'+p+':'+a,Q616y7o:0,Qxluan:p,Qtql1ud:l.clone(),Qsjaj00:v,",
        },
        {
            // Also restored, same reasoning as 6a. This is the per-PEER health-bar/nameplate
            // render step (confirmed against the real bundle: sets the nameplate sprite's
            // .position, toggles its .visible by HP, draws its canvas text) — called once per
            // peer inside a loop. If the previous-frame snapshot `h` is missing for one peer, the
            // original code throws reading h.Qdsukt4, and an uncaught exception here aborts the
            // REST of that per-frame loop for every peer processed after it in the same pass —
            // plausibly including weapon-slot/model work for later entries. Confirmed live:
            // restoring 6a alone did not fix "primary weapon doesn't show up"; this is the next
            // most likely candidate by the same mechanism, and is a pure null-guard regardless —
            // safe to have unconditionally, identical behavior whenever `h` is actually present.
            name: 'HB3 health-bar: guard the position lerp against a missing previous frame',
            from: 'n.copy(h.Qdsukt4).lerp(c.Qdsukt4,e.Qzh2kcz)',
            to:   'n.copy((h||c).Qdsukt4).lerp(c.Qdsukt4,e.Qzh2kcz)',
        },
        {
            // Restored. Neither 6a nor HB3 fixed the reported "primary weapon doesn't show up in
            // a custom lobby" regression (confirmed live, both extension and VPS) — this is the
            // actual cause. Removing these four entirely (rather than just gating them, which was
            // already correct and stays) took away a real safety net against a runaway
            // reconciliation failure: Qak2r7y (the reconciler) returns -1 ("Divergence check
            // failed, no match for server state found locally") whenever it can't find a matching
            // local snapshot for an echoed tick, and the fallback path (bundle :27354) is
            // `this.Qgx464++` — UNBOUNDED growth with no cap. Once that starts,
            // Qxo2o14[0].Q1o118x ("Global tick", built from Qgx464) drifts further from reality
            // every tick, which makes EVERY subsequent reconcile attempt less likely to find a
            // match too — a self-reinforcing spiral, not a one-off. Qak2r7y is also where weapon/
            // recoil/ammo state gets rebuilt on a successful match
            // (this.Qxo2o14[t].Qt03jhz.Qcvr9bt=...Qh23rk3.Q820rrc(e.body), see 6b8's own comment
            // on why that matters) — once reconciliation stops succeeding at all, that state stops
            // being restored too, consistent with getting stuck on whatever was equipped at the
            // exact moment it broke (reported as "looks like sword-only, only melee shows up").
            // Gated to custom mode only, same as before — this was never official play's problem,
            // only ours.
            name: '6d3 custom-mode: clamp incoming Q1o1c43 to ±3',
            from: 'this.Qjdbmai=o.body,this.Q1o1c43=o.sync;',
            to:   'this.Qjdbmai=o.body,this.Q1o1c43=(window.__EVIO_EXT_CUSTOM__&&window.__EVIO_EXT_CUSTOM__.enabled)?Math.max(-3,Math.min(3,o.sync)):o.sync;',
        },
        {
            name: '6d4 custom-mode: clamp Q1o1c43 in loading path',
            from: 'this.Q1o1c43=this.Qorty0h.length-1,this.Qobex5z',
            to:   'this.Q1o1c43=(window.__EVIO_EXT_CUSTOM__&&window.__EVIO_EXT_CUSTOM__.enabled)?Math.min(this.Qorty0h.length-1,3):this.Qorty0h.length-1,this.Qobex5z',
        },
        {
            name: 'K1  custom-mode: cap Qgx464 from server RTT delta to 3 ticks (150ms max)',
            from: 's>=0&&(this.Qgx464=s)',
            to:   's>=0&&(this.Qgx464=(window.__EVIO_EXT_CUSTOM__&&window.__EVIO_EXT_CUSTOM__.enabled)?Math.min(s,3):s)',
        },
        {
            name: 'K2  custom-mode: cap Qgx464 no-state-increment to 3 ticks (150ms max)',
            from: 'this.Qjdbmah=this.Qjdbmai,this.Qgx464++,this.Qjtawf1',
            to:   'this.Qjdbmah=this.Qjdbmai,this.Qgx464=(window.__EVIO_EXT_CUSTOM__&&window.__EVIO_EXT_CUSTOM__.enabled)?Math.min(this.Qgx464+1,3):this.Qgx464+1,this.Qjtawf1',
        },
    ];

    function isBundle(v) { return typeof v === 'string' && v.indexOf('bundle.js') !== -1; }

    function patchBundle(src) {
        let applied = 0;
        const skipped = [];
        for (const p of patches) {
            if (src.indexOf(p.from) !== -1) {
                src = src.replace(p.from, p.to);
                applied++;
            } else {
                skipped.push(p.name);
            }
        }
        const colour = applied === patches.length ? '#4caf50' : '#ff9800';
        console.log(
            `%c[evio-ext] ${applied}/${patches.length} patches applied` +
            (skipped.length ? ' | missed: ' + skipped.join(', ') : ' — ALL OK'),
            `background:${colour};color:#000;font-weight:bold;padding:2px 6px;border-radius:3px`
        );
        return src;
    }

    let _intercepted = false;

    function patchAndInject(src) {
        if (_intercepted) return;
        _intercepted = true;
        console.log('%c[evio-ext] intercepted ' + src.split('?')[0], 'color:#2196f3;font-weight:bold');

        fetch(src, { cache: 'no-cache' })
            .then((res) => res.text())
            .then((text) => {
                const patched = patchBundle(text);
                const blob = new Blob([patched], { type: 'text/javascript' });
                const s = _origCE.call(document, 'script');
                s.src = URL.createObjectURL(blob);
                document.head.appendChild(s);
                console.log('%c[evio-ext] bundle re-injected (post-hook-install)', 'background:#4caf50;color:#000;font-weight:bold;padding:2px 6px;border-radius:3px');
            })
            .catch((err) => {
                console.error('[evio-ext] bundle fetch/patch failed, loading original', err);
                const s2 = _origCE.call(document, 'script');
                s2.src = src;
                document.head.appendChild(s2);
            });
    }

    const _bundleObserver = new MutationObserver((muts) => {
        for (const mut of muts) {
            for (const nd of mut.addedNodes) {
                if (nd.tagName === 'SCRIPT' && isBundle(nd.src || nd.getAttribute('src'))) {
                    if (_intercepted) return;
                    const url = nd.src || nd.getAttribute('src');
                    nd.type = 'javascript/blocked';
                    nd.removeAttribute('src');
                    try { nd.parentNode && nd.parentNode.removeChild(nd); } catch (e) { /* ignore */ }
                    patchAndInject(url);
                    return;
                }
            }
        }
    });

    (function startBundleObserver() {
        const root = document.documentElement || document.head || document;
        if (!root || !root.nodeType) { setTimeout(startBundleObserver, 0); return; }
        try {
            _bundleObserver.observe(root, { childList: true, subtree: true });
        } catch (e) {
            setTimeout(startBundleObserver, 0);
        }
    })();

    const _origCE = Document.prototype.createElement;
    Document.prototype.createElement = function (tag) {
        const el = _origCE.apply(this, arguments);
        if (typeof tag === 'string' && tag.toLowerCase() === 'script') {
            const srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
            let _v = '';
            Object.defineProperty(el, 'src', {
                get() { return _v; },
                set(val) {
                    _v = val;
                    if (isBundle(val)) { patchAndInject(val); return; }
                    if (srcDesc && srcDesc.set) srcDesc.set.call(el, val);
                },
                configurable: true,
            });
        }
        return el;
    };

    const _origSA = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
        if (this.tagName === 'SCRIPT' && String(name).toLowerCase() === 'src' && isBundle(value)) {
            patchAndInject(value);
            return;
        }
        return _origSA.apply(this, arguments);
    };

    console.log('%c[evio-ext] page-world game-socket hook installed', 'color:#4caf50');
})();
