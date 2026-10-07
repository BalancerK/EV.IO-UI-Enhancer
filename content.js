function applyHudAdjustments(){
    const selectors = ['#canvas','#canvas2','#game_hud','#game_menu_overlay','#lobbyBG','#fracSurPWDiv'];
    selectors.forEach(sel => {
        const el = document.querySelector(sel);
        if(el) el.style.setProperty('height','100vh','important');
    });

    const move = el => {
        if(el) {
            el.style.transform = 'translateY(85px)';
            el.style.transition = 'transform 0.3s ease';
        }
    };
    move(document.getElementById('chat-window'));
    move(document.querySelector('#game_hud_inner #lower_left_container'));

    const weapons = document.querySelector('#game_hud_inner #weaponsDiv');
    if(weapons){
        weapons.style.setProperty('transform','translateY(100px)','important');
        weapons.style.setProperty('transition','transform 0.3s ease','important');
    }

    const adv = document.getElementById('ad_728');
    if(adv) adv.remove();

    const crosshair = document.getElementById('canvas_crosshair');
    if (crosshair) {
        crosshair.style.position = 'absolute';
        crosshair.style.top = '50%';
        crosshair.style.left = '50%';
    }
}

const fixObs = new MutationObserver(applyHudAdjustments);
window.addEventListener('load', () => {
    applyHudAdjustments();
    fixObs.observe(document.body, { childList: true, subtree: true });
});

(function () {
    'use strict';

    // ----------------- small helpers -----------------

    function addStyle(css) {
        if (typeof GM_addStyle === 'function') {
            GM_addStyle(css);
            return;
        }
        // document.head doesn't exist yet this early (content script now runs at document_start,
        // specifically so page-socket-hook.js installs before the game bundle ever runs — see
        // injectPageHook below) — <head> hasn't been parsed yet at that point. Retry rather than
        // assume it exists, same pattern already used for the bundle-tag MutationObserver.
        const target = document.head || document.documentElement;
        if (!target) { setTimeout(() => addStyle(css), 0); return; }
        const s = document.createElement('style');
        s.textContent = css;
        target.appendChild(s);
    }

    function waitFor(fn, timeout = 15000, step = 200) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const timer = setInterval(() => {
                if (fn()) {
                    clearInterval(timer);
                    resolve(true);
                } else if (Date.now() - start > timeout) {
                    clearInterval(timer);
                    reject(new Error('waitFor timeout'));
                }
            }, step);
        });
    }

    const GAMEMODE_NAMES = {
        deathmatch: 'Deathmatch',
        deathmatch_earn: 'Deathmatch (Earn)',
        team_deathmatch: 'Team Deathmatch',
        team_deathmatch_earn: 'Team Deathmatch (Earn)',
        survival: 'Survival',
        survival_earn: 'Survival (Earn)',
        infection: 'Infection',
        last_man_standing: 'Last Man Standing',
        sniper_shotgun: 'Sniper Shotgun'
    };

    const REGION_NAMES = {
        fra: 'FRA',
        sin: 'SIN',
        gru: 'GRU',
        atl: 'ATL',
        lax: 'LAX'
    };

    function prettyGamemode(code) {
        return GAMEMODE_NAMES[code] || code || 'Unknown';
    }

    function prettyRegion(code) {
        if (!code) return '';
        return REGION_NAMES[code] || code.toUpperCase();
    }

    // ----------------- CSS -----------------

    addStyle(`
.ev-lobby-row.ev-lobby-active {
    background: rgba(100, 255, 150, 0.05);
    border-left: 3px solid #7dff7d;
}

.ev-lobby-row.ev-lobby-empty {
    opacity: 0.65;
}

.ev-lobby-row.ev-lobby-active:hover {
    background: rgba(100, 255, 150, 0.12);
}

#ev_lobbies_module.module_box.wide {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    max-width: none;
    margin: 0;
    padding: 0;
}

#ev_lobbies_module .module_content {
    font-size: 16px;
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 70px 80px 40px 80px;
    box-sizing: border-box;
}

/* #ev-official-view/#ev-self-hosted-view wrap the tab bodies (added for the Official/Custom tab
   redesign) and sit between .module_content's own flex column and the list itself — without
   these being flex columns too (with min-height:0, so a flex item can shrink below its content's
   natural height — the other classic cause of "overflow:auto has nothing to scroll within"),
   #ev-lobbies-list's flex:1 had no bounded height to constrain it against, so the list just grew
   the page instead of scrolling internally. */
#ev-official-view, #ev-self-hosted-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
}

#ev-lobbies-list, #ev-custom-lobbies-list {
    margin-top: 15px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
}

#ev-lobbies-list::-webkit-scrollbar, #ev-custom-lobbies-list::-webkit-scrollbar {
    width: 10px;
}
#ev-lobbies-list::-webkit-scrollbar-track, #ev-custom-lobbies-list::-webkit-scrollbar-track {
    background: rgba(255,255,255,0.05);
}
#ev-lobbies-list::-webkit-scrollbar-thumb, #ev-custom-lobbies-list::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.85);
    border-radius: 5px;
}
#ev-lobbies-list::-webkit-scrollbar-thumb:hover, #ev-custom-lobbies-list::-webkit-scrollbar-thumb:hover {
    background: rgba(255,255,255,1);
}

.ev-lobby-row {
    padding: 10px 0;
    cursor: pointer;
    border-bottom: 1px solid rgba(255,255,255,0.15);
}
.ev-lobby-row:hover {
    background: rgba(255,255,255,0.06);
}
.ev-lobby-mainline {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
}
.ev-lobby-name {
    font-weight: 600;
    font-size: 19px;
}
.ev-lobby-players {
    font-size: 17px;
    opacity: 0.9;
}
.ev-lobby-players.full {
    color: #ff6969;
}
.ev-lobby-players.mid {
    color: #ffcf4d;
}
.ev-lobby-players.low {
    color: #7dff7d;
}

#ev-lobbies-status {
    font-size: 13px;
    opacity: 0.8;
    margin-top: 4px;
    min-height: 18px;
}

#ev-lobbies-nav-wrapper {
    display: inline-block;
    margin-right: 6px;
}
#ev-lobbies-nav {
    text-transform: uppercase;
}

/* #7dff7d is this extension's own established accent (already used for the active-lobby
   highlight and the "plenty of slots free" player-count color below) — reused here as the
   one accent color threaded through every new control, rather than inventing a second one. */
.ev-tab-bar {
    display: flex;
    gap: 4px;
    margin: 14px 0 18px;
    padding: 4px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px;
}
#ev_lobbies_module .ev-tab-btn {
    flex: 1;
    padding: 11px 0;
    border: 0;
    border-radius: 7px;
    background: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.65;
    font-family: inherit;
    /* A fixed size rather than copying the GAME LOBBIES <h2>'s own computed size via JS (the
       original approach) — that drifted with the page's own theme and read as oversized; this
       is deliberately smaller than the h2 but large enough to read clearly as a tab, not a
       caption. Uppercase + letter-spacing keeps it reading as a tab control, not a second heading. */
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    transition: background-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}
#ev_lobbies_module .ev-tab-btn:hover {
    opacity: 0.9;
    background: rgba(255,255,255,0.06);
}
/* Must match #ev_lobbies_module .ev-tab-btn's own specificity (an ID + a class) or beat it — a
   plain .ev-tab-btn.ev-tab-active (two classes, no ID) loses to that ID-scoped rule regardless of
   source order, silently overridden back to opacity:0.65/background:none/color:inherit on every
   tab. Confirmed live: the active tab never visibly lit up because of exactly this. */
#ev_lobbies_module .ev-tab-btn.ev-tab-active {
    opacity: 1;
    color: #7dff7d;
    background: rgba(125,255,125,0.14);
}
#ev_lobbies_module .ev-tab-btn.ev-tab-active:hover {
    background: rgba(125,255,125,0.18);
}
/* Explicit colors from here on, not inherited — turns out this page's own cascade gives these
   tags (label/input/select) white text but leaves their BACKGROUND at the browser default white,
   since nothing in ev.io's own CSS was ever written to target plain <label>/<input>/<select>
   tags (its own UI presumably doesn't use them the same way). White-on-white was invisible in
   practice, so these are pinned explicitly instead of trusting the page's theme to carry them. */
.ev-field-label {
    display: block;
    font-size: 12px;
    color: #fff;
    opacity: 0.85;
    margin: 10px 0 4px;
}
.ev-field-input {
    width: 100%;
    box-sizing: border-box;
    color: #000;
    background: #fff;
    border: 1px solid rgba(0,0,0,0.3);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 13px;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.ev-field-input:focus {
    outline: none;
    border-color: #5fd65f;
    box-shadow: 0 0 0 2px rgba(125,255,125,0.25);
}
.ev-field-group {
    margin-bottom: 4px;
}
.ev-field-hint {
    font-size: 11px;
    opacity: 0.6;
    margin: 4px 0 0;
}
/* A text input paired with a same-height action button (the signaling URL's "Reset Default") —
   the input flexes, the button stays a fixed, compact width next to it. */
.ev-field-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
}
.ev-field-row .ev-field-input {
    flex: 1;
    min-width: 0;
}
.ev-btn-reset {
    flex-shrink: 0;
    padding: 0 12px;
    font-size: 12px;
    font-weight: 600;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.22);
    background: rgba(255,255,255,0.07);
    color: #fff;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 0.15s ease, border-color 0.15s ease;
}
.ev-btn-reset:hover {
    background: rgba(255,255,255,0.14);
    border-color: rgba(255,255,255,0.35);
}
/* Same reasoning as .ev-field-input above, plus: the native options POPUP always renders on a
   white background regardless of page theme, so the <option>s need their own explicit color
   even though the closed <select> itself is already covered by .ev-field-input. */
#ev-host-public option {
    color: #000;
    background: #fff;
}
#ev_host_module .module_content {
    max-width: 900px;
}
.ev-host-layout {
    display: flex;
    gap: 24px;
    align-items: flex-start;
    margin-top: 4px;
}
.ev-host-col-left {
    flex: 0 0 340px;
    min-width: 0;
}
.ev-host-col-right {
    flex: 1;
    min-width: 0;
}
.ev-host-card {
    margin-top: 6px;
    padding: 16px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px;
}
.ev-host-actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 18px;
}
.ev-btn-primary {
    width: 100%;
    box-sizing: border-box;
    padding: 11px 16px;
    border-radius: 7px;
    border: 0;
    background: #7dff7d;
    color: #0c1f0c;
    font-weight: 700;
    font-size: 14px;
    cursor: pointer;
    font-family: inherit;
    transition: filter 0.15s ease, transform 0.05s ease;
}
.ev-btn-primary:hover { filter: brightness(1.08); }
.ev-btn-primary:active { transform: scale(0.99); }
.ev-btn-primary.ev-btn-stop {
    background: #ff6969;
    color: #230707;
}
.ev-btn-secondary {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 16px;
    border-radius: 7px;
    border: 1px solid rgba(255,255,255,0.22);
    background: rgba(255,255,255,0.05);
    color: #fff;
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
    font-family: inherit;
    transition: background-color 0.15s ease, border-color 0.15s ease;
}
.ev-btn-secondary:hover {
    background: rgba(255,255,255,0.11);
    border-color: rgba(255,255,255,0.35);
}
.ev-quick-admin {
    padding: 16px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px;
    max-height: 70vh;
    overflow-y: auto;
}
.ev-qa-heading {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #7dff7d;
}
.ev-qa-section {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid rgba(255,255,255,0.08);
}
.ev-qa-section:first-of-type {
    margin-top: 14px;
}
.ev-qa-section-title {
    font-size: 13px;
    font-weight: 700;
    margin-bottom: 8px;
    opacity: 0.9;
}
.ev-qa-section-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
}
.ev-qa-section-title-row .ev-qa-section-title {
    margin-bottom: 0;
}
.ev-qa-setting {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 0;
}
.ev-qa-setting-label {
    font-size: 12.5px;
    opacity: 0.9;
    flex: 1;
}
.ev-qa-setting-ctl {
    flex-shrink: 0;
}
.ev-qa-number {
    width: 88px;
    box-sizing: border-box;
    color: #000;
    background: #fff;
    border: 1px solid rgba(0,0,0,0.3);
    border-radius: 6px;
    padding: 5px 7px;
    font-size: 13px;
    text-align: right;
}
.ev-qa-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.ev-qa-chip {
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 600;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.22);
    background: rgba(255,255,255,0.06);
    color: #fff;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 0.15s ease, border-color 0.15s ease;
}
.ev-qa-chip:hover {
    background: rgba(255,255,255,0.13);
    border-color: rgba(255,255,255,0.35);
}
.ev-qa-chip-danger {
    border-color: rgba(255,105,105,0.4);
    color: #ff9a9a;
}
.ev-qa-chip-danger:hover {
    background: rgba(255,105,105,0.14);
    border-color: rgba(255,105,105,0.6);
}
.ev-qa-status {
    font-size: 12px;
    opacity: 0.85;
    margin-top: 14px;
    min-height: 16px;
}
#ev-custom-lobbies-status,
#ev-host-status {
    font-size: 13px;
    opacity: 0.8;
    margin-top: 4px;
    min-height: 18px;
}
.ev-lobby-empty-note {
    font-size: 13px;
    opacity: 0.7;
    padding: 8px 0;
}
    `);

    // ----------------- global state -----------------

    let LOBBIES = null;
    let PLAYER_INFO = {};
    let lobbiesLoaded = false;
    let lobbiesLoading = false;
    let playerCountPollTimer = null;

    // Counts only auto-refreshed on open/reopen before this; now also polls every 5s while the
    // panel is actually visible, so it doesn't drift stale if someone leaves it open. Fetches are
    // already parallel per-lobby (see refreshPlayerCounts' Promise.allSettled), so 5s is bounded
    // by Rivet's own response time, not anything serialized on our end.
    const PLAYER_COUNT_POLL_MS = 5000;

    function startPlayerCountPolling() {
        stopPlayerCountPolling();
        playerCountPollTimer = setInterval(() => {
            if (lobbiesLoaded && !lobbiesLoading) refreshPlayerCounts();
        }, PLAYER_COUNT_POLL_MS);
    }

    function stopPlayerCountPolling() {
        if (playerCountPollTimer) {
            clearInterval(playerCountPollTimer);
            playerCountPollTimer = null;
        }
    }

    // ----------------- player-hosted lobbies -----------------
    // See background.js's own comment block for why hosting/signaling runs there, not here.

    let CUSTOM_LOBBIES = [];
    let customLobbiesLoading = false;
    let customLobbyPollTimer = null;
    let hostingPort = null;      // open while actively hosting; see startHosting()/stopHosting()
    let hostingLobbyCode = null;

    const CUSTOM_LOBBY_POLL_MS = 5000;

    function startCustomLobbyPolling() {
        stopCustomLobbyPolling();
        refreshCustomLobbies();
        customLobbyPollTimer = setInterval(refreshCustomLobbies, CUSTOM_LOBBY_POLL_MS);
    }

    function stopCustomLobbyPolling() {
        if (customLobbyPollTimer) {
            clearInterval(customLobbyPollTimer);
            customLobbyPollTimer = null;
        }
    }

    async function refreshCustomLobbies() {
        if (customLobbiesLoading) return;
        customLobbiesLoading = true;
        try {
            const resp = await chrome.runtime.sendMessage({ type: 'listCustomLobbies' });
            if (resp && resp.ok) {
                CUSTOM_LOBBIES = resp.lobbies || [];
                setCustomLobbyStatus('');
            } else {
                setCustomLobbyStatus(resp && resp.error ? resp.error : 'Could not load player-hosted lobbies.');
            }
        } catch (e) {
            setCustomLobbyStatus('Could not load player-hosted lobbies.');
        } finally {
            customLobbiesLoading = false;
            renderCustomLobbyList();
        }
    }

    function setCustomLobbyStatus(msg) {
        const el = document.getElementById('ev-custom-lobbies-status');
        if (el) el.textContent = msg || '';
    }

    function renderCustomLobbyList() {
        const list = document.getElementById('ev-custom-lobbies-list');
        if (!list) return;
        list.innerHTML = '';

        if (!CUSTOM_LOBBIES.length) {
            const none = document.createElement('div');
            none.className = 'ev-lobby-empty-note';
            none.textContent = 'No player-hosted lobbies right now.';
            list.appendChild(none);
            return;
        }

        CUSTOM_LOBBIES.forEach(lobby => {
            const row = document.createElement('div');
            row.className = 'ev-lobby-row';

            const name = document.createElement('div');
            name.className = 'ev-lobby-name';
            const hostName = (lobby.customData && lobby.customData.hostName) || 'Player-hosted';
            const isOwnLobby = lobby.code === hostingLobbyCode;
            name.textContent = hostName + (isOwnLobby ? ' (yours)' : '');

            row.addEventListener('click', () => {
                // Own lobby or someone else's — both navigate identically, with the SAME
                // ?evioCustom=<code> URL param. background.js's LOCAL_GAME_SOCKET_PORT handler is
                // the one place that actually distinguishes them: it checks whether this code
                // matches the lobby WE'RE hosting right now (handleConnection() locally, no
                // networking needed) or not (netlib-join the real remote peer — see its own
                // ensureRemoteJoin()/NetlibPeerSocket). Same shape as how the OFFICIAL list's own
                // rows navigate (?game=<id>) — a plain
                // URL param the page hook reads synchronously at its own startup (see
                // page-socket-hook.js), not a localStorage flag + a postMessage telling it what
                // to do after the fact. That earlier approach was still fundamentally racy: it
                // depended on content.js's message arriving before the bundle needed the
                // decision, same class of problem as the undefended WebSocket override before
                // the bundle-interception fix. A URL param has no such race — it's already part
                // of the page's own address before a single byte of it loads.
                window.location.href = `${location.origin}/?evioCustom=${encodeURIComponent(lobby.code)}`;
            });

            row.appendChild(name);
            list.appendChild(row);
        });
    }

    // --- hosting settings (persisted via chrome.storage.local, read/written in background.js) ---

    // Our own VPS-hosted netlib-signaling deployment — the same one local_ws_server.js's own
    // netlibSignalingUrl setting points at by default in production. Pre-filled but fully
    // editable: anyone can still point this at their own deployment instead.
    const DEFAULT_SIGNALING_URL = 'wss://217.216.72.239.sslip.io/netlib/v0/signaling';

    async function loadHostingSettingsIntoForm() {
        const stored = await chrome.storage.local.get(['evioSignalingUrl', 'evioHostName', 'evioHostPublic']);
        const urlInput = document.getElementById('ev-host-signaling-url');
        const nameInput = document.getElementById('ev-host-name');
        const visSelect = document.getElementById('ev-host-public');
        if (urlInput) urlInput.value = stored.evioSignalingUrl || DEFAULT_SIGNALING_URL;
        if (nameInput) nameInput.value = stored.evioHostName || '';
        if (visSelect) visSelect.value = stored.evioHostPublic || 'public';
    }

    // Only writes keys whose field actually exists on the current page — the signaling URL now
    // lives in the Lobbies module's Custom tab while name/visibility stay in the Host module, two
    // separate panels that are each built lazily and may not both exist yet. Writing a hardcoded
    // fallback for an absent field (the old behavior) would silently blank out whatever the OTHER
    // panel had already saved the moment either one fired a 'change' event on its own.
    async function saveHostingSettings() {
        const urlInput = document.getElementById('ev-host-signaling-url');
        const nameInput = document.getElementById('ev-host-name');
        const visSelect = document.getElementById('ev-host-public');
        const patch = {};
        if (urlInput) patch.evioSignalingUrl = urlInput.value.trim();
        if (nameInput) patch.evioHostName = nameInput.value.trim();
        if (visSelect) patch.evioHostPublic = visSelect.value;
        await chrome.storage.local.set(patch);
    }

    function setHostStatus(msg, isError) {
        const el = document.getElementById('ev-host-status');
        if (!el) return;
        el.textContent = msg || '';
        el.style.color = isError ? '#ef9a9a' : '#a5d6a7';
    }

    function paintHostingButton() {
        const btn = document.getElementById('ev-host-toggle');
        if (!btn) return;
        btn.textContent = hostingPort ? 'Stop Hosting' : 'Start Hosting';
        // .ev-btn-stop swaps the primary action's accent from green ("go") to red ("stop") —
        // same two-state pattern as the lobby-row player-count coloring elsewhere in this file.
        btn.classList.toggle('ev-btn-stop', !!hostingPort);
    }

    // Same ?evioCustom=<code> shape every other lobby link in this file already uses (the Custom
    // tab's own row click handler) — this is just that same URL, handed to the host directly
    // instead of making them find their own lobby in the list to get it.
    function showShareLink(lobbyCode) {
        const box = document.getElementById('ev-host-share');
        const input = document.getElementById('ev-host-share-link');
        if (!box || !input) return;
        input.value = `${location.origin}/?evioCustom=${encodeURIComponent(lobbyCode)}`;
        box.style.display = '';
    }
    function hideShareLink() {
        const box = document.getElementById('ev-host-share');
        if (box) box.style.display = 'none';
    }

    // Keep-alive + auto-cleanup port — see background.js's comment block. This single connect()
    // call is what keeps the service worker's hosting state alive for as long as SOME page has
    // it open, and what tells background.js to tear the lobby down once nothing reconnects
    // within its grace period (see HOST_TEARDOWN_GRACE_MS there) — covering both a real tab
    // close AND a same-page reload (e.g. clicking a Self-Hosted lobby row to toggle routing),
    // which also disconnects this port even though the user never meant to stop hosting.
    // Shared by startHosting() (a fresh lobby) and the early-reconnect check below (an existing
    // one, found via getHostingStatus, that this new page load needs to re-attach to).
    function attachHostingPort(lobbyCode) {
        hostingLobbyCode = lobbyCode;
        hostingPort = chrome.runtime.connect({ name: 'evio-hosting' });
        hostingPort.onDisconnect.addListener(() => {
            hostingPort = null;
            hostingLobbyCode = null;
            paintHostingButton();
            setHostStatus('Hosting stopped.', false);
        });
        paintHostingButton();
    }

    async function startHosting() {
        const nameInput = document.getElementById('ev-host-name');
        const name = nameInput ? nameInput.value.trim() : '';
        if (!name) {
            setHostStatus('Enter a lobby name before hosting.', true);
            if (nameInput) nameInput.focus();
            return;
        }

        await saveHostingSettings();
        const isPublicEl = document.getElementById('ev-host-public');
        const isPublic = isPublicEl ? isPublicEl.value === 'public' : true;

        setHostStatus('Starting…', false);
        const resp = await chrome.runtime.sendMessage({ type: 'startHosting', isPublic });
        if (!resp || !resp.ok) {
            setHostStatus((resp && resp.error) || 'Failed to start hosting.', true);
            return;
        }

        // Deliberately NOT routing this tab's own socket just because hosting started — see
        // "explicit join this lobby" below: official stays the default until a specific lobby
        // (possibly, but not necessarily, this very one) is explicitly clicked.
        attachHostingPort(resp.lobbyCode);
        setHostStatus('Hosting — lobby code: ' + hostingLobbyCode, false);
        showShareLink(resp.lobbyCode);
        refreshCustomLobbies();
    }

    // ----------------- quick admin panel -----------------
    // Same chrome.runtime.sendMessage({type:'admin',...}) protocol admin.html's own fetch() shim
    // uses (see background.js's handleAdminRequest) — this is a second, independent client of
    // that same backend, not a reimplementation of it. Returns resp.body directly (the actual
    // payload — status/settings/etc.), or throws resp.body.err on a non-ok response, so callers
    // can just `await adminFetch(...)` without re-unwrapping {ok,status,body} every time.
    async function adminFetch(path, method, body) {
        const resp = await chrome.runtime.sendMessage({ type: 'admin', path, method: method || 'GET', body: body || null });
        if (!resp || resp.ok === false) throw new Error((resp && resp.body && resp.body.err) || 'admin request failed');
        return resp.body;
    }

    // The exact settings this panel exposes, in the order they're shown — a deliberately curated
    // subset of the full dashboard's ~70, picked for "things worth tuning mid-match without
    // leaving the game." Everything about rendering/committing a given one (its control type,
    // min/max/step, reset) is still read live from /api/settings, same as the full dashboard —
    // only WHICH keys show up here is hardcoded.
    const QUICK_ADMIN_SETTING_KEYS = [
        'roundTicks', 'damageScale', 'botDamageMult', 'botWeaponPickupsEnabled',
        'botFriendlyFire', 'swordBotImpulseEnabled', 'swordBotGrenadesEnabled',
        'botCount', 'swordBotCount', 'botLevel', 'swordBotLevel',
        'gravity', 'throwableCooldownScale', 'teleportCooldownScale',
    ];
    const ANNOUNCE_QUICK_MESSAGES = [
        ['Round starting — good luck!', '🏁 Round starting'],
        ['Server restarting shortly.', '🔧 Restarting soon'],
        ['Switching map — hold on.', '🗺️ Map change'],
        ['gg!', '👏 gg'],
    ];
    // [action, arg-or-null, label, needsConfirm]
    const MATCH_ACTIONS = [
        ['restartround', null, '🔄 Restart round', false],
        ['endround', null, '⏭️ End round now', false],
        ['addtime', 1200, '➕ 1 min', false],
        ['addtime', -1200, '➖ 1 min', false],
        ['healall', null, '💚 Heal all', false],
        ['respawnall', null, '♻️ Respawn all', false],
        ['gather', null, '🧲 Gather all', false],
        ['slapall', 18, '👋 Slap all', false],
        ['killall', null, '💀 Kill all', true],
    ];

    function quickAdminStatus(msg, isError) {
        const el = document.getElementById('ev-quick-admin-status');
        if (!el) return;
        el.textContent = msg || '';
        el.style.color = isError ? '#ef9a9a' : '#a5d6a7';
    }

    async function serverAction(action, arg) {
        try {
            const r = await adminFetch('/api/server', 'POST', { action, arg });
            quickAdminStatus(action + ' ok' + (r && r.affected !== undefined ? ` (${r.affected})` : ''), false);
        } catch (e) {
            quickAdminStatus(`${action} failed: ${(e && e.message) || e}`, true);
        }
    }

    async function commitSetting(key, value) {
        try {
            const r = await adminFetch('/api/settings', 'POST', { key, value });
            quickAdminStatus(`${key} = ${r.value}${r.restartRequired ? ' (restart required)' : ''}`, false);
        } catch (e) {
            quickAdminStatus(`${key}: ${(e && e.message) || e}`, true);
        }
        return loadQuickAdminSettings();
    }

    async function resetAllQuickSettings() {
        for (const key of QUICK_ADMIN_SETTING_KEYS) {
            try { await adminFetch('/api/settings/reset', 'POST', { key }); } catch (e) { /* keep going */ }
        }
        quickAdminStatus('All quick-admin settings reset to default.', false);
        loadQuickAdminSettings();
    }

    // Rebuilds just the settings control list from a fresh /api/settings read — called after
    // every commit/reset so a value that failed validation (clamped, rejected) is shown as what
    // it ACTUALLY is server-side, not what was typed.
    async function loadQuickAdminSettings() {
        const host = document.getElementById('ev-quick-admin-settings');
        if (!host) return;
        let all;
        try { all = (await adminFetch('/api/settings')).settings; } catch (e) { return; }
        const byKey = new Map(all.map((s) => [s.key, s]));
        host.innerHTML = '';
        for (const key of QUICK_ADMIN_SETTING_KEYS) {
            const s = byKey.get(key);
            if (s) host.appendChild(buildSettingRow(s));
        }
    }

    function buildSettingRow(s) {
        const row = document.createElement('div');
        row.className = 'ev-qa-setting';

        const label = document.createElement('label');
        label.className = 'ev-qa-setting-label';
        label.textContent = s.label;

        const ctl = document.createElement('div');
        ctl.className = 'ev-qa-setting-ctl';

        let input;
        if (s.type === 'bool') {
            input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !!s.value;
            input.addEventListener('change', () => commitSetting(s.key, input.checked));
        } else {
            input = document.createElement('input');
            input.type = 'number';
            input.className = 'ev-qa-number';
            input.value = s.value;
            if (s.min !== null && s.min !== undefined) input.min = s.min;
            if (s.max !== null && s.max !== undefined) input.max = s.max;
            input.step = (s.step !== null && s.step !== undefined) ? s.step : (s.type === 'int' ? 1 : 'any');
            stopKeyPropagation(input);
            input.addEventListener('change', () => commitSetting(s.key, input.value));
        }
        ctl.appendChild(input);
        row.appendChild(label);
        row.appendChild(ctl);
        return row;
    }

    async function loadQuickAdminMaps() {
        const select = document.getElementById('ev-quick-admin-map');
        if (!select) return;
        let data;
        try { data = await adminFetch('/api/maps'); } catch (e) { return; }
        select.innerHTML = '';
        (data.maps || []).forEach((m) => {
            const o = document.createElement('option');
            o.value = m.title; o.textContent = m.title;
            if (m.title === data.active) o.selected = true;
            select.appendChild(o);
        });
    }

    function buildQuickAdminPanel() {
        const panel = document.createElement('div');
        panel.id = 'ev-quick-admin';
        panel.className = 'ev-quick-admin';

        const heading = document.createElement('h3');
        heading.className = 'ev-qa-heading';
        heading.textContent = 'QUICK ADMIN';
        panel.appendChild(heading);
        const sub = document.createElement('p');
        sub.className = 'ev-field-hint';
        sub.textContent = 'Changes apply live to your hosted server. For the full dashboard (players, parity, presets), use Open Admin Dashboard.';
        panel.appendChild(sub);

        // ----- Map -----
        const mapSection = document.createElement('div');
        mapSection.className = 'ev-qa-section';
        const mapHeading = document.createElement('div');
        mapHeading.className = 'ev-qa-section-title';
        mapHeading.textContent = 'Map';
        const mapSelect = document.createElement('select');
        mapSelect.id = 'ev-quick-admin-map';
        mapSelect.className = 'ev-field-input';
        stopKeyPropagation(mapSelect);
        mapSelect.addEventListener('change', async () => {
            quickAdminStatus(`Switching map to ${mapSelect.value}…`, false);
            try {
                await adminFetch('/api/map', 'POST', { map: mapSelect.value });
                quickAdminStatus(`Map switched to ${mapSelect.value}.`, false);
            } catch (e) {
                quickAdminStatus(`Map switch failed: ${(e && e.message) || e}`, true);
            }
        });
        mapSection.appendChild(mapHeading);
        mapSection.appendChild(mapSelect);
        panel.appendChild(mapSection);

        // ----- Settings -----
        const settingsSection = document.createElement('div');
        settingsSection.className = 'ev-qa-section';
        const settingsHeadingRow = document.createElement('div');
        settingsHeadingRow.className = 'ev-qa-section-title-row';
        const settingsHeading = document.createElement('div');
        settingsHeading.className = 'ev-qa-section-title';
        settingsHeading.textContent = 'Settings';
        const resetAllBtn = document.createElement('button');
        resetAllBtn.type = 'button';
        resetAllBtn.className = 'ev-btn-reset';
        resetAllBtn.textContent = 'Reset Default';
        resetAllBtn.addEventListener('click', resetAllQuickSettings);
        settingsHeadingRow.appendChild(settingsHeading);
        settingsHeadingRow.appendChild(resetAllBtn);
        const settingsList = document.createElement('div');
        settingsList.id = 'ev-quick-admin-settings';
        settingsSection.appendChild(settingsHeadingRow);
        settingsSection.appendChild(settingsList);
        panel.appendChild(settingsSection);

        // ----- Announce -----
        const announceSection = document.createElement('div');
        announceSection.className = 'ev-qa-section';
        const announceHeading = document.createElement('div');
        announceHeading.className = 'ev-qa-section-title';
        announceHeading.textContent = 'Announce';
        const announceRow = document.createElement('div');
        announceRow.className = 'ev-field-row';
        const announceInput = document.createElement('input');
        announceInput.className = 'ev-field-input';
        announceInput.placeholder = 'Message to every connected player…';
        stopKeyPropagation(announceInput);
        const announceSendBtn = document.createElement('button');
        announceSendBtn.type = 'button';
        announceSendBtn.className = 'ev-btn-reset';
        announceSendBtn.textContent = 'Send';
        function fireAnnounce() {
            const msg = announceInput.value.trim();
            if (!msg) { quickAdminStatus('Nothing to announce.', true); return; }
            serverAction('announce', msg).then(() => { announceInput.value = ''; });
        }
        announceSendBtn.addEventListener('click', fireAnnounce);
        announceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') fireAnnounce(); });
        announceRow.appendChild(announceInput);
        announceRow.appendChild(announceSendBtn);
        const announceChips = document.createElement('div');
        announceChips.className = 'ev-qa-chips';
        ANNOUNCE_QUICK_MESSAGES.forEach(([msg, label]) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ev-qa-chip';
            chip.textContent = label;
            chip.addEventListener('click', () => serverAction('announce', msg));
            announceChips.appendChild(chip);
        });
        announceSection.appendChild(announceHeading);
        announceSection.appendChild(announceRow);
        announceSection.appendChild(announceChips);
        panel.appendChild(announceSection);

        // ----- Match -----
        const matchSection = document.createElement('div');
        matchSection.className = 'ev-qa-section';
        const matchHeading = document.createElement('div');
        matchHeading.className = 'ev-qa-section-title';
        matchHeading.textContent = 'Match';
        const matchChips = document.createElement('div');
        matchChips.className = 'ev-qa-chips';
        MATCH_ACTIONS.forEach(([action, arg, label, needsConfirm]) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ev-qa-chip' + (needsConfirm ? ' ev-qa-chip-danger' : '');
            chip.textContent = label;
            chip.addEventListener('click', () => {
                if (needsConfirm && !confirm('Kill every connected player?')) return;
                serverAction(action, arg === null ? undefined : arg);
            });
            matchChips.appendChild(chip);
        });
        matchSection.appendChild(matchHeading);
        matchSection.appendChild(matchChips);
        panel.appendChild(matchSection);

        const status = document.createElement('div');
        status.id = 'ev-quick-admin-status';
        status.className = 'ev-qa-status';
        panel.appendChild(status);

        loadQuickAdminMaps();
        loadQuickAdminSettings();

        return panel;
    }

    function stopHosting() {
        if (hostingPort) {
            hostingPort.disconnect(); // triggers background.js's onDisconnect -> teardownHosting()
            hostingPort = null;
        }
        hostingLobbyCode = null;
        paintHostingButton();
        setHostStatus('Hosting stopped.', false);
        hideShareLink();
        refreshCustomLobbies();
    }

    // ----------------- routing the host's OWN game socket to our simulation -----------------
    //
    // While hosting, the host plays in the SAME tab that's hosting (the L4D2-listen-server
    // model this whole feature is built around) — so when their own client opens its game
    // socket, it needs to reach the simulation running in background.js instead of official
    // ev.io infrastructure. Other players reaching the host's simulation is a different,
    // separate case (netlib/WebRTC, actual cross-machine networking) — not needed for the host's
    // OWN connection, because host and simulation are already in the same browser.
    //
    // THIS NEEDS THREE HOPS, NOT TWO: the actual WebSocket override has to run in the page's
    // MAIN world (page-socket-hook.js, injected via manifest.json's "world":"MAIN" — see there),
    // because a standard content script runs in an ISOLATED world with its own separate `window`
    // that the real page/game code never sees. (This is different from the Tampermonkey
    // userscript's unsafeWindow, which this extension doesn't have.) The MAIN-world hook also
    // can't use chrome.runtime.* directly — main-world scripts don't get extension API access —
    // so it relays through window.postMessage to THIS isolated-world script, which is the one
    // that actually holds the chrome.runtime.connect Port to background.js.
    //
    // Hop 1: page-socket-hook.js (MAIN world)  <-- postMessage -->  Hop 2: here (ISOLATED world)
    // Hop 2: here (ISOLATED world)  <-- chrome.runtime.Port -->  Hop 3: background.js
    //
    // THIS SLICE: prove the relay itself works end to end (connect/send/receive/disconnect all
    // actually reach background.js and back) before any real join/spawn/tick protocol is layered
    // on top.

    const LOCAL_GAME_SOCKET_PORT = 'evio-local-game-socket';
    const HOOK_MSG_SOURCE = 'evio-ext-page-hook';
    const RELAY_MSG_SOURCE = 'evio-ext-isolated-relay';

    let localGameSocketPort = null;

    window.addEventListener('message', (event) => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        const msg = event.data;
        if (!msg || msg.source !== HOOK_MSG_SOURCE) return;

        if (msg.type === 'socket-open-request') {
            // The page wants a new routed socket. Open (or reuse) the Port to background.js —
            // one real game socket at a time in practice, so one Port is all this needs.
            if (localGameSocketPort) {
                console.warn('[evio-ext] socket-open-request arrived while a Port was already open — disconnecting the old one');
                try { localGameSocketPort.disconnect(); } catch (e) { /* ignore */ }
            }
            console.log('[evio-ext] opening chrome.runtime.Port for the local game socket');
            localGameSocketPort = chrome.runtime.connect({ name: LOCAL_GAME_SOCKET_PORT });
            // Threaded through from the ?evioCustom=<lobbyCode> URL param (see page-socket-hook.js)
            // for when real multi-peer joining exists — unused by background.js for now, since
            // this slice only ever relays to the host's OWN simulation regardless of the code.
            localGameSocketPort.postMessage({ type: 'init', lobbyCode: msg.lobbyCode });
            localGameSocketPort.onMessage.addListener((portMsg) => {
                window.postMessage({ source: RELAY_MSG_SOURCE, type: 'socket-event', event: portMsg }, window.location.origin);
            });
            localGameSocketPort.onDisconnect.addListener(() => {
                console.warn('[evio-ext] local game socket Port disconnected; chrome.runtime.lastError=', chrome.runtime.lastError && chrome.runtime.lastError.message);
                localGameSocketPort = null;
                window.postMessage({ source: RELAY_MSG_SOURCE, type: 'socket-event', event: { type: 'close', code: 1000, reason: '' } }, window.location.origin);
            });
        } else if (msg.type === 'socket-send') {
            if (localGameSocketPort) {
                // window.postMessage (page hook -> here) preserves ArrayBuffer natively via structured
                // clone, but chrome.runtime.Port's own serialization is not guaranteed to — normalize to
                // a plain array of byte values here, the one shape that survives any Port implementation,
                // and let background.js reconstruct a real buffer from it.
                let data = msg.data;
                if (data instanceof ArrayBuffer) data = Array.from(new Uint8Array(data));
                else if (ArrayBuffer.isView(data)) data = Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
                try { localGameSocketPort.postMessage({ type: 'send', data }); } catch (e) { console.error('[evio-ext] relay send failed', e); }
            } else {
                console.warn('[evio-ext] socket-send dropped — no localGameSocketPort open');
            }
        } else if (msg.type === 'socket-close') {
            console.warn('[evio-ext] socket-close requested by the page hook');
            if (localGameSocketPort) { try { localGameSocketPort.disconnect(); } catch (e) { /* ignore */ } localGameSocketPort = null; }
        }
    });

    (function injectPageHook() {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('page-socket-hook.js');
        script.onload = function () { this.remove(); };
        (document.head || document.documentElement).appendChild(script);
    })();

    // Re-attach the keep-alive port on EVERY page load if hosting is still live, not only when
    // the user happens to open the Host panel — otherwise a reload with no panel open would sail
    // right past background.js's grace period with nothing ever reconnecting, and the lobby
    // would be torn down for real a few seconds later even though hosting was never meant to
    // stop. This is also fire-and-forget: it may well lose the race with background.js's
    // teardown timer on a sufficiently slow page load, which is fine — worst case, hosting ends
    // a few seconds later than it would have otherwise.
    chrome.runtime.sendMessage({ type: 'getHostingStatus' }).then((resp) => {
        if (resp && resp.ok && resp.hosting && !hostingPort) {
            attachHostingPort(resp.lobbyCode);
            setHostStatus('Hosting — lobby code: ' + hostingLobbyCode, false);
            showShareLink(resp.lobbyCode);
        }
    });

    // ----------------- module panel -----------------

    function ensureLobbyModule() {
        if (document.getElementById('ev_lobbies_module')) return;

        const mod = document.createElement('div');
        mod.id = 'ev_lobbies_module';
        mod.className = 'module_box wide';
        mod.style.display = 'none';

        const close = document.createElement('span');
        close.className = 'close_button';
        close.textContent = '[x]';

        const content = document.createElement('div');
        content.className = 'module_content';

        const title = document.createElement('h2');
        title.textContent = 'GAME LOBBIES';
        content.appendChild(title);

        // ----- tab bar -----
        const tabBar = document.createElement('div');
        tabBar.className = 'ev-tab-bar';
        const officialTab = document.createElement('button');
        officialTab.type = 'button';
        officialTab.id = 'ev-tab-official';
        officialTab.className = 'ev-tab-btn ev-tab-active';
        officialTab.textContent = 'Official';
        const selfHostedTab = document.createElement('button');
        selfHostedTab.type = 'button';
        selfHostedTab.id = 'ev-tab-self-hosted';
        selfHostedTab.className = 'ev-tab-btn';
        selfHostedTab.textContent = 'Custom';
        tabBar.appendChild(officialTab);
        tabBar.appendChild(selfHostedTab);
        content.appendChild(tabBar);

        function selectTab(which) {
            const officialView = document.getElementById('ev-official-view');
            const selfHostedView = document.getElementById('ev-self-hosted-view');
            const isOfficial = which === 'official';
            officialTab.classList.toggle('ev-tab-active', isOfficial);
            selfHostedTab.classList.toggle('ev-tab-active', !isOfficial);
            if (officialView) officialView.style.display = isOfficial ? '' : 'none';
            if (selfHostedView) selfHostedView.style.display = isOfficial ? 'none' : '';
        }
        officialTab.addEventListener('click', () => selectTab('official'));
        selfHostedTab.addEventListener('click', () => selectTab('self-hosted'));

        // ----- official view -----
        const officialView = document.createElement('div');
        officialView.id = 'ev-official-view';

        const info = document.createElement('p');
        info.style.marginTop = '0';
        info.style.marginBottom = '8px';
        info.textContent = 'Click a lobby to join it.';

        const status = document.createElement('div');
        status.id = 'ev-lobbies-status';
        status.textContent = '';

        const list = document.createElement('div');
        list.id = 'ev-lobbies-list';

        officialView.appendChild(info);
        officialView.appendChild(status);
        officialView.appendChild(list);
        content.appendChild(officialView);

        // ----- self-hosted ("Custom") view -----
        const selfHostedView = document.createElement('div');
        selfHostedView.id = 'ev-self-hosted-view';
        selfHostedView.style.display = 'none';

        // The signaling server setting lives here, not in the Host module — it's really a
        // property of "how this browser reaches/discovers custom lobbies at all" (both joining
        // and hosting go through it), which is squarely a Custom-tab concern, not something
        // specific to the act of hosting your own.
        const signalingGroup = document.createElement('div');
        signalingGroup.className = 'ev-field-group';
        const signalingLab = document.createElement('label');
        signalingLab.className = 'ev-field-label';
        signalingLab.textContent = 'Signaling server';
        const signalingRow = document.createElement('div');
        signalingRow.className = 'ev-field-row';
        const signalingInput = document.createElement('input');
        signalingInput.id = 'ev-host-signaling-url';
        signalingInput.placeholder = 'wss://your-domain/netlib/v0/signaling';
        signalingInput.className = 'ev-field-input';
        stopKeyPropagation(signalingInput);
        const signalingResetBtn = document.createElement('button');
        signalingResetBtn.type = 'button';
        signalingResetBtn.className = 'ev-btn-reset';
        signalingResetBtn.textContent = 'Reset Default';
        signalingResetBtn.addEventListener('click', () => {
            signalingInput.value = DEFAULT_SIGNALING_URL;
            saveHostingSettings();
            refreshCustomLobbies();
        });
        signalingRow.appendChild(signalingInput);
        signalingRow.appendChild(signalingResetBtn);
        const signalingHint = document.createElement('p');
        signalingHint.className = 'ev-field-hint';
        signalingHint.textContent = 'Used to find and host player lobbies. Only change this if you run your own netlib-signaling deployment.';
        signalingGroup.appendChild(signalingLab);
        signalingGroup.appendChild(signalingRow);
        signalingGroup.appendChild(signalingHint);
        signalingInput.addEventListener('change', () => { saveHostingSettings(); refreshCustomLobbies(); });

        const customStatus = document.createElement('div');
        customStatus.id = 'ev-custom-lobbies-status';

        const customList = document.createElement('div');
        customList.id = 'ev-custom-lobbies-list';

        selfHostedView.appendChild(signalingGroup);
        selfHostedView.appendChild(customStatus);
        selfHostedView.appendChild(customList);
        content.appendChild(selfHostedView);

        mod.appendChild(close);
        mod.appendChild(content);
        document.body.appendChild(mod);

        loadHostingSettingsIntoForm();

        close.addEventListener('click', () => {
            mod.style.display = 'none';
            stopPlayerCountPolling();
            stopCustomLobbyPolling();
        });

        // Safety net for any OTHER way this panel ends up hidden — e.g. the site's own UI
        // switching to a different panel, if that code ever touches .module_box elements the
        // same way showLobbyModule() does to ours. Without this, polling would keep running
        // (and fetching) with the panel invisible, exactly the background task to avoid.
        new MutationObserver(() => {
            if (mod.style.display === 'none') {
                stopPlayerCountPolling();
                stopCustomLobbyPolling();
            }
        }).observe(mod, { attributes: true, attributeFilter: ['style'] });
    }

    function showLobbyModule() {
        ensureLobbyModule();

        document.querySelectorAll('.module_box').forEach(el => {
            if (el.id !== 'ev_lobbies_module') {
                el.classList.add('hidden-module');
                el.style.display = 'none';
            }
        });

        const mod = document.getElementById('ev_lobbies_module');
        if (mod) {
            mod.classList.remove('hidden-module');
            mod.style.display = 'block';
        }

        // Both lists poll together regardless of which tab is active, so switching tabs is
        // instant (already-fresh data) rather than triggering a fetch-and-wait every time.
        startPlayerCountPolling();
        startCustomLobbyPolling();
    }

    // ev.io's own page listens for keydown globally (WASD/movement/hotkeys) without checking
    // whether a text field has focus first — a very common pattern on game pages, and the reason
    // typing into an injected input can silently do nothing: the keystroke reaches the input
    // (browsers always deliver it to the focused element first) but then keeps bubbling up to
    // that global listener, which can act on it too. stopPropagation here doesn't block the
    // input's own normal handling (that already happened before this bubbles anywhere), it only
    // stops the event from reaching ancestors/document/window afterward.
    function stopKeyPropagation(el) {
        ['keydown', 'keyup', 'keypress'].forEach(type => {
            el.addEventListener(type, (e) => e.stopPropagation());
        });
    }

    // ----------------- host-a-lobby module (separate panel, opened only via the repurposed
    // Private button — see installTopBarButton) -----------------

    function ensureHostModule() {
        if (document.getElementById('ev_host_module')) return;

        const mod = document.createElement('div');
        mod.id = 'ev_host_module';
        mod.className = 'module_box wide';
        mod.style.display = 'none';

        const close = document.createElement('span');
        close.className = 'close_button';
        close.textContent = '[x]';

        const content = document.createElement('div');
        content.className = 'module_content';

        const title = document.createElement('h2');
        title.textContent = 'HOST A LOBBY';
        content.appendChild(title);

        // Card wrapper for the form fields — the signaling URL moved to the Lobbies module's
        // Custom tab (see ensureLobbyModule), since it's a property of reaching custom lobbies at
        // all, not something specific to hosting your own.
        const card = document.createElement('div');
        card.className = 'ev-host-card';

        const hostNameGroup = document.createElement('div');
        hostNameGroup.className = 'ev-field-group';
        const hostNameLab = document.createElement('label');
        hostNameLab.className = 'ev-field-label';
        hostNameLab.textContent = 'Lobby name shown to other players (required)';
        const hostNameInput = document.createElement('input');
        hostNameInput.id = 'ev-host-name';
        hostNameInput.placeholder = 'e.g. "Alice\'s lobby"';
        hostNameInput.className = 'ev-field-input';
        stopKeyPropagation(hostNameInput);
        hostNameGroup.appendChild(hostNameLab);
        hostNameGroup.appendChild(hostNameInput);

        const hostVisGroup = document.createElement('div');
        hostVisGroup.className = 'ev-field-group';
        const hostVisLab = document.createElement('label');
        hostVisLab.className = 'ev-field-label';
        hostVisLab.textContent = 'Visibility';
        const hostVisSelect = document.createElement('select');
        hostVisSelect.id = 'ev-host-public';
        hostVisSelect.className = 'ev-field-input';
        stopKeyPropagation(hostVisSelect);
        [['public', 'Public'], ['private', 'Private']]
            .forEach(([value, label]) => {
                const o = document.createElement('option');
                o.value = value; o.textContent = label;
                hostVisSelect.appendChild(o);
            });
        hostVisGroup.appendChild(hostVisLab);
        hostVisGroup.appendChild(hostVisSelect);

        // Persist as you go, not only at Start Hosting time — switching tabs away and back (or
        // closing this panel) shouldn't lose what was typed.
        hostNameInput.addEventListener('change', saveHostingSettings);
        hostVisSelect.addEventListener('change', saveHostingSettings);

        card.appendChild(hostNameGroup);
        card.appendChild(hostVisGroup);

        const actions = document.createElement('div');
        actions.className = 'ev-host-actions';

        const hostToggleBtn = document.createElement('button');
        hostToggleBtn.id = 'ev-host-toggle';
        hostToggleBtn.type = 'button';
        hostToggleBtn.className = 'ev-btn-primary';
        hostToggleBtn.textContent = 'Start Hosting';

        // Opens in a new tab rather than inline — it's a full dashboard (settings, player list,
        // match controls), not something that belongs squeezed into this lobby popup. Works
        // whether or not hosting is currently active: status/settings panels still render (the
        // settings registry exists from the moment the bundle loads), only player-list/action
        // panels show empty until someone's actually connected.
        const adminBtn = document.createElement('button');
        adminBtn.id = 'ev-host-admin';
        adminBtn.type = 'button';
        adminBtn.className = 'ev-btn-secondary';
        adminBtn.textContent = 'Open Admin Dashboard';
        adminBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'openAdmin' });
        });

        hostToggleBtn.addEventListener('click', () => {
            if (hostingPort) stopHosting();
            else startHosting();
        });

        actions.appendChild(hostToggleBtn);
        actions.appendChild(adminBtn);

        // Shown once hosting actually starts (see startHosting()/attachHostingPort()) — a direct
        // link bypasses needing whoever you're sharing it with to find your lobby in their own
        // Custom tab list at all, which matters for a Private lobby especially (it's not even
        // listed there) but is just more convenient for Public ones too.
        const shareBox = document.createElement('div');
        shareBox.id = 'ev-host-share';
        shareBox.className = 'ev-field-group';
        shareBox.style.display = 'none';
        const shareLab = document.createElement('label');
        shareLab.className = 'ev-field-label';
        shareLab.textContent = 'Share this link to invite players';
        const shareRow = document.createElement('div');
        shareRow.className = 'ev-field-row';
        const shareInput = document.createElement('input');
        shareInput.id = 'ev-host-share-link';
        shareInput.className = 'ev-field-input';
        shareInput.readOnly = true;
        stopKeyPropagation(shareInput);
        shareInput.addEventListener('focus', () => shareInput.select());
        const shareCopyBtn = document.createElement('button');
        shareCopyBtn.type = 'button';
        shareCopyBtn.className = 'ev-btn-reset';
        shareCopyBtn.textContent = 'Copy Link';
        shareCopyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(shareInput.value);
                shareCopyBtn.textContent = 'Copied!';
            } catch (e) {
                shareInput.select();
                document.execCommand('copy');
                shareCopyBtn.textContent = 'Copied!';
            }
            setTimeout(() => { shareCopyBtn.textContent = 'Copy Link'; }, 1500);
        });
        shareRow.appendChild(shareInput);
        shareRow.appendChild(shareCopyBtn);
        shareBox.appendChild(shareLab);
        shareBox.appendChild(shareRow);

        // Same navigation a Custom-tab lobby row's own click does (including for your OWN lobby,
        // labelled "(yours)" there) — this is just that shortcut surfaced right next to the link
        // instead of making the host go find their own row in the list to join the match they
        // just started.
        const joinOwnBtn = document.createElement('button');
        joinOwnBtn.type = 'button';
        joinOwnBtn.className = 'ev-btn-secondary';
        joinOwnBtn.style.marginTop = '8px';
        joinOwnBtn.style.width = '100%';
        joinOwnBtn.textContent = 'Join Lobby';
        joinOwnBtn.addEventListener('click', () => {
            window.location.href = shareInput.value;
        });
        shareBox.appendChild(joinOwnBtn);

        actions.appendChild(shareBox);

        const hostStatus = document.createElement('div');
        hostStatus.id = 'ev-host-status';

        // Two columns below the title: the hosting form/actions on the left (its own fixed
        // width, same as before), the quick-admin panel on the right — lets you tune the server
        // you're hosting without leaving this screen or opening the full dashboard in a new tab.
        const layout = document.createElement('div');
        layout.className = 'ev-host-layout';

        const leftCol = document.createElement('div');
        leftCol.className = 'ev-host-col-left';
        leftCol.appendChild(card);
        leftCol.appendChild(actions);
        leftCol.appendChild(hostStatus);

        const rightCol = document.createElement('div');
        rightCol.className = 'ev-host-col-right';
        rightCol.appendChild(buildQuickAdminPanel());

        layout.appendChild(leftCol);
        layout.appendChild(rightCol);
        content.appendChild(layout);

        mod.appendChild(close);
        mod.appendChild(content);
        document.body.appendChild(mod);

        close.addEventListener('click', () => {
            mod.style.display = 'none';
        });

        loadHostingSettingsIntoForm();
        // Sets the button's initial text AND color (ev-btn-stop) to match reality if hosting is
        // already active by the time this panel is first built (e.g. the early-reconnect check
        // near the top of this file already re-attached the port before this was ever opened) —
        // matters more now that the button's whole color, not just its label, depends on it.
        paintHostingButton();
        if (hostingLobbyCode) showShareLink(hostingLobbyCode);
        // No reconciliation needed here any more — the early check right after injectPageHook
        // (top of this file) already re-attaches the keep-alive port on every page load if
        // hosting is still live, regardless of whether this panel is ever opened. By the time
        // this panel builds, hostingPort/hostingLobbyCode already reflect current reality.
    }

    function showHostModule() {
        ensureHostModule();

        document.querySelectorAll('.module_box').forEach(el => {
            if (el.id !== 'ev_host_module') {
                el.classList.add('hidden-module');
                el.style.display = 'none';
            }
        });

        const mod = document.getElementById('ev_host_module');
        if (mod) {
            mod.classList.remove('hidden-module');
            mod.style.display = 'block';
        }

        // ensureHostModule() only builds the quick-admin panel's DOM once; refresh its live data
        // every time this panel is actually shown, not just on first build, so settings/map
        // state changed elsewhere (the full admin dashboard, another visit) isn't left stale.
        loadQuickAdminSettings();
        loadQuickAdminMaps();
    }

    function setStatus(msg) {
        const status = document.getElementById('ev-lobbies-status');
        if (!status) return;
        status.textContent = msg || '';
    }

    // ----------------- render list -----------------

    function renderLobbyList() {
    const list = document.getElementById('ev-lobbies-list');
    if (!list) return;
    list.innerHTML = '';

    if (!Array.isArray(LOBBIES) || !LOBBIES.length) {
        setStatus('No lobby data found.');
        return;
    }

    const sorted = [...LOBBIES].sort((a, b) => {
        const gmA = prettyGamemode(a.gamemode).toLowerCase();
        const gmB = prettyGamemode(b.gamemode).toLowerCase();
        if (gmA < gmB) return -1;
        if (gmA > gmB) return 1;
        const rA = prettyRegion(a.region);
        const rB = prettyRegion(b.region);
        if (rA < rB) return -1;
        if (rA > rB) return 1;
        return 0;
    });

    sorted.forEach(lobby => {
        const row = document.createElement('div');
        row.className = 'ev-lobby-row';
        row.dataset.lobbyId = lobby.id;

        const main = document.createElement('div');
        main.className = 'ev-lobby-mainline';

        const name = document.createElement('div');
        name.className = 'ev-lobby-name';
        name.textContent = `[${prettyRegion(lobby.region)}] ${prettyGamemode(lobby.gamemode)}`;

        const players = document.createElement('div');
        players.className = 'ev-lobby-players';

        const info = PLAYER_INFO[lobby.id];
        let n = null;

        if (!info || typeof info.count !== 'number') {
            players.textContent = '… players';
            row.classList.add('ev-lobby-empty');
        } else {
            n = info.count;
            players.textContent = `${n} player${n === 1 ? '' : 's'}`;

            if (n >= 11) players.classList.add('full');
            else if (n >= 6) players.classList.add('mid');
            else players.classList.add('low');

            if (n > 0) {
                row.classList.add('ev-lobby-active');
            } else {
                row.classList.add('ev-lobby-empty');
            }
        }

        main.appendChild(name);
        main.appendChild(players);
        row.appendChild(main);

        row.addEventListener('click', () => {
            const id = lobby.id;
            if (!id) return;
            // No cleanup needed here any more — an official lobby's URL simply has no
            // ?evioCustom= param, so routing is off by default with nothing to explicitly clear.
            const url = `${location.origin}/?game=${encodeURIComponent(id)}`;
            window.location.href = url;
        });

        list.appendChild(row);
    });
}


    // ----------------- load from bundle.js -----------------

    async function loadLobbiesFromBundle() {
        if (lobbiesLoaded || lobbiesLoading) return;
        lobbiesLoading = true;

        try {
            const meta = document.getElementById('dist_path_meta');
            const distPath = meta && meta.content ? meta.content : '/dist/1-7-0/public/';
            const bundleUrl = distPath.replace(/\/+$/, '/') + 'bundle.js';

            const text = await fetch(bundleUrl).then(r => r.text());

            const re = /parse\('(\[{"id":"lobby-[\s\S]*?}])'\)/;
            const m = text.match(re);
            if (!m) {
                console.warn('[ev-lobbies] Could not find lobby array in bundle.js');
                setStatus('Could not locate lobby list in game files.');
                return;
            }

            const jsonStr = m[1];
            const data = JSON.parse(jsonStr);

            if (!Array.isArray(data) || !data.length) {
                setStatus('Lobby list is empty.');
                return;
            }

            LOBBIES = data;
            lobbiesLoaded = true;
            console.log('[ev-lobbies] Loaded lobbies:', LOBBIES);
            renderLobbyList();
            refreshPlayerCounts();
        } catch (err) {
            console.error('[ev-lobbies] Error loading lobbies from bundle:', err);
            setStatus('Error loading lobby list.');
        } finally {
            lobbiesLoading = false;
        }
    }

    // ----------------- player counts -----------------
async function refreshPlayerCounts() {
    if (!Array.isArray(LOBBIES) || !LOBBIES.length) return;

    setStatus('Updating player counts ...');

    // Deliberately NOT resetting every count to null before fetching (that used to blank the
    // whole list every refresh, then repopulate it) — the last known count stays on screen until
    // its own fetch actually resolves with a new one, so a poll cycle updates numbers in place
    // instead of flashing the list empty first. A lobby only ever shows the "..." loading state
    // the very first time, before it's ever had a successful response.
    const tasks = LOBBIES.map(lobby => (async () => {
        try {
            const httpBase = lobby.connectionUrl
                .replace(/^wss:/, 'https:')
                .replace(/^ws:/, 'http:');
            const url = httpBase + 'players?' + Math.random();
            // Fetched via the background worker, not here — a content-script fetch runs in the
            // PAGE's origin (https://ev.io) and gets CORS-blocked by the rivet.game lobby server,
            // which doesn't send it an Access-Control-Allow-Origin header. See background.js.
            const resp = await chrome.runtime.sendMessage({ type: 'fetchPlayerCount', url });
            if (!resp || !resp.ok) return;

            const data = resp.data;
            const count = typeof data.playerCount === 'number'
                ? data.playerCount
                : (Array.isArray(data.players) ? data.players.length : null);

            if (!PLAYER_INFO[lobby.id]) PLAYER_INFO[lobby.id] = {};
            PLAYER_INFO[lobby.id].count = count;
            PLAYER_INFO[lobby.id].updatedAt = Date.now();
        } catch (e) {
        }
    })());

    await Promise.allSettled(tasks);

    renderLobbyList();
    setStatus('');
}


    // ----------------- top-bar button -----------------

    function installTopBarButton() {
        if (document.getElementById('ev-lobbies-nav')) return true;

        const topBarCont = document.getElementById('top_bar_cont');
        if (!topBarCont) return false;

        const privBtn = document.getElementById('priv_game');

        const wrapper = document.createElement('div');
        wrapper.id = 'ev-lobbies-nav-wrapper';
        wrapper.className = 'dropdown';

        const btn = document.createElement('button');
        btn.id = 'ev-lobbies-nav';
        btn.type = 'button';
        btn.className = 'btn btn-default dropdown-toggle';
        btn.textContent = 'LOBBIES';

        wrapper.appendChild(btn);

        if (privBtn && privBtn.parentNode === topBarCont) {
            topBarCont.insertBefore(wrapper, privBtn);
        } else {
            topBarCont.insertBefore(wrapper, topBarCont.firstChild);
        }

        btn.addEventListener('click', () => openLobbyBrowser());

        // Repurpose the native "Private" button to open our self-hosting menu, since a private
        // self-hosted lobby IS what this site's own "create a private game" concept maps onto
        // now. cloneNode + replace strips any addEventListener-attached native click handler
        // (clone carries attributes/classes but never JS listeners) without touching its
        // visuals — our own listener is then the only one left on the button.
        if (privBtn && !privBtn.dataset.evioRewired) {
            const replacement = privBtn.cloneNode(true);
            replacement.dataset.evioRewired = '1';
            // "Private" is the site's own original label; "CUSTOM LOBBY" says what this button
            // now actually opens. Plain text node (confirmed against the real page's own markup),
            // so textContent is enough — but it also carries the site's "translate-me" class,
            // which its own i18n system could re-render and overwrite our label with a translated
            // "Private" later. Drop the class so nothing but us ever touches this button's text again.
            replacement.classList.remove('translate-me');
            replacement.textContent = 'CUSTOM LOBBY';
            privBtn.parentNode.replaceChild(replacement, privBtn);
            replacement.addEventListener('click', () => openHostingMenu());
        }

        return true;
    }

    // Shared by both entry points (LOBBIES button and the repurposed Private button) so the
    // panel/data loading logic lives in exactly one place.
    function openLobbyBrowser() {
        showLobbyModule();
        if (!lobbiesLoaded && !lobbiesLoading) {
            setStatus('Loading lobby list ...');
            loadLobbiesFromBundle();
        } else {
            renderLobbyList();
            refreshPlayerCounts();
        }
    }

    function openHostingMenu() {
        showHostModule();
    }

    async function init() {
        try {
            await waitFor(() => document.getElementById('top_bar_cont'));
            ensureLobbyModule();
            installTopBarButton();
            // Deliberately NOT loading lobbies/player counts here — that used to fetch
            // bundle.js and every lobby's /players endpoint on every page load, whether or not
            // the user ever opens the Lobbies panel. The button's click handler already loads
            // lobbies on first open (see installTopBarButton), so there's nothing to do until
            // then.
        } catch (e) {
            console.error('[ev-lobbies] init error', e);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
