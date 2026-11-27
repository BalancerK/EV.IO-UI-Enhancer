// ── Survival "best time" — our own implementation ───────────────────────────────────────────
// The real client's own "Your Best time"/"New best time!" text (#roundCountdown .bestTimeP)
// compares elapsed round time against a value it only ever gets from the player's REAL ev.io
// account (a network fetch — the same one failing as "Failed to fetch" on a custom/local server
// with no account backend reachable). That value never loads here, stays at its default, and
// every run trivially "beats" it — which is why it always says "New best time!" regardless of
// how long the player actually survived. We can't fix the official code (it's the real bundle,
// not ours), so this replaces its output with our own correct version: track elapsed time
// ourselves from the wave number already on screen, keep the real record in localStorage
// (scoped per ?evioCustom= lobby code, so different custom lobbies don't share one record), and
// overwrite the paragraph's text/class right after each HUD rebuild — same "observe then patch"
// pattern applyHudAdjustments itself already uses for every other post-load DOM fixup here.
let _survivalBestTimeRoundStartMs = null;
let _survivalBestTimeLastWave = null;
let _survivalBestTimeLastWrittenText = null; // breaks the MutationObserver feedback loop below
function _survivalBestTimeFormat(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
    const ss = String(sec).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
function applySurvivalBestTime() {
    try {
        const bestP = document.querySelector('#roundCountdown .bestTimeP');
        const waveP = document.querySelector('#roundCountdown .nextWaveP');
        if (!bestP || !waveP) {
            _survivalBestTimeRoundStartMs = null;
            _survivalBestTimeLastWave = null;
            _survivalBestTimeLastWrittenText = null;
            return;
        }

        const m = waveP.textContent.match(/-?\d+/);
        if (!m) return;
        const wave = parseInt(m[0], 10);

        // A wave number LOWER than the last one we saw means a new round just started (our own
        // server always resets to the wave-0 grace period on a fresh round) — re-anchor our own
        // elapsed-time clock. First-ever sighting also anchors (best-effort baseline if the page
        // loaded mid-round).
        if (_survivalBestTimeRoundStartMs === null || (_survivalBestTimeLastWave !== null && wave < _survivalBestTimeLastWave)) {
            _survivalBestTimeRoundStartMs = Date.now();
        }
        _survivalBestTimeLastWave = wave;

        const lobbyCode = new URLSearchParams(location.search).get('evioCustom') || 'default';
        const storageKey = `evio_custom_survival_best_${lobbyCode}`;
        const elapsedSeconds = (Date.now() - _survivalBestTimeRoundStartMs) / 1000;
        let bestSeconds = 0;
        try { bestSeconds = parseFloat(localStorage.getItem(storageKey)) || 0; } catch (e) { /* ignore */ }

        let text, isNewBest;
        if (elapsedSeconds > bestSeconds) {
            try { localStorage.setItem(storageKey, String(elapsedSeconds)); } catch (e) { /* ignore (private mode, quota, etc.) */ }
            text = 'New best time!';
            isNewBest = true;
        } else {
            text = `Your Best time: ${_survivalBestTimeFormat(bestSeconds)}`;
            isNewBest = false;
        }

        // applyHudAdjustments (which calls this) runs from a MutationObserver watching
        // document.body's whole subtree for childList changes. `.textContent =` ALWAYS replaces
        // a node's children — even when the new string equals the old one — so writing it
        // unconditionally on every call re-triggers that same observer, which calls this again,
        // which writes again, forever. In survival specifically the wave/HUD text underneath
        // this already changes on close to every tick, so this was spinning the tab at 100% CPU
        // (or worse) almost immediately after joining. Only touch the DOM when the text actually
        // changes, so an unrelated mutation elsewhere stops propagating back through this one.
        if (text === _survivalBestTimeLastWrittenText) return;
        _survivalBestTimeLastWrittenText = text;
        bestP.textContent = text;
        bestP.classList.toggle('newBest', isNewBest);
    } catch (e) { /* never let a HUD patch take down the page */ }
}

function applyHudAdjustments(){
    applySurvivalBestTime();

    // Ad-removal patch, AND the height-forcing/translateY pull-downs that went with it, both
    // DROPPED (ev.io 1-7-1): the old #ad_728 banner + the CSS reserving a 90px footer for it are
    // both gone from the real page now. The new ad system (Freestar, #freestar-leaderboard) ships
    // `hidden` by default and the site's own layout is already full-height with no ad-reserved
    // space, so forcing #canvas/#canvas2/etc to 100vh and then shoving chat/abilities (85px) and
    // weapons (100px) back down to compensate just pushed them below where they already,
    // correctly, sit on their own now — nothing left here for us to remove or work around.

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
        sniper_shotgun: 'Sniper Shotgun',
        deathmatch_fractal_earn: 'Deathmatch (Fractal)',
        social: 'Social',
        instagib: 'Instagib',
        swords: 'Swords',
        mayhem: 'Mayhem',
        snipe_the_streamer: 'Snipe the Streamer',
        last_team_standing: 'Last Team Standing',
        last_team_standing_earn: 'Last Team Standing (Earn)',
        search_and_destroy: 'Search and Destroy',
        capture_the_flag: 'Capture the Flag'
    };

    const REGION_NAMES = {
        fra: 'Europe',
        sin: 'Asia',
        gru: 'South America',
        atl: 'NA East',
        lax: 'NA West'
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
.ev-lobby-latency {
    font-size: 17px;
    opacity: 0.9;
}
.ev-lobby-right {
    display: flex;
    align-items: baseline;
    gap: 14px;
    flex-shrink: 0;
}
.ev-lobby-players {
    font-size: 17px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}
.ev-lobby-players.busy {
    color: #7dff7d;
}
.ev-lobby-players.empty,
.ev-lobby-players.pending {
    opacity: 0.6;
}
.ev-lobby-players {
    cursor: default;
    padding: 2px 8px;
    border-radius: 4px;
}
.ev-lobby-players:hover {
    background: rgba(255,255,255,0.1);
}

#ev-players-card {
    position: fixed;
    z-index: 2147483000;
    width: 280px;
    max-height: 60vh;
    display: none;
    flex-direction: column;
    background: rgba(14, 17, 24, 0.97);
    color: #e8ecf2;
    border: 1px solid rgba(255,255,255,0.14);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.55);
    font-family: inherit;
    font-size: 14px;
    line-height: 1.35;
    pointer-events: none;
    overflow: hidden;
}
#ev-players-card.open {
    display: flex;
    animation: ev-pc-in 90ms ease-out;
}
@keyframes ev-pc-in {
    from { opacity: 0; transform: translateY(-3px); }
    to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
    #ev-players-card.open { animation: none; }
}
#ev-players-card .ev-pc-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 10px;
    padding: 10px 12px 8px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
}
#ev-players-card .ev-pc-title {
    font-weight: 700;
    font-size: 15px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
#ev-players-card .ev-pc-region {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    opacity: 0.6;
    white-space: nowrap;
}
#ev-players-card .ev-pc-summary {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    padding: 8px 6px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
}
#ev-players-card .ev-pc-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
}
#ev-players-card .ev-pc-stat-value {
    font-size: 18px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
}
#ev-players-card .ev-pc-stat-label {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    opacity: 0.55;
}
#ev-players-card .ev-pc-stat.playing .ev-pc-stat-value { color: #7dff7d; }
#ev-players-card .ev-pc-stat.watching .ev-pc-stat-value { color: #ffcf4d; }
#ev-players-card .ev-pc-stat.bots .ev-pc-stat-value { opacity: 0.7; }
#ev-players-card .ev-pc-list {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    overflow-y: auto;
}
#ev-players-card .ev-pc-list li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px;
}
#ev-players-card .ev-pc-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: #7dff7d;
}
#ev-players-card li.watching .ev-pc-dot { background: #ffcf4d; }
#ev-players-card li.watching .ev-pc-name { opacity: 0.7; }
#ev-players-card .ev-pc-name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
#ev-players-card .ev-pc-note {
    padding: 10px 12px;
    opacity: 0.7;
}
#ev-players-card .ev-pc-foot {
    padding: 6px 12px 8px;
    font-size: 11px;
    opacity: 0.45;
    border-top: 1px solid rgba(255,255,255,0.08);
}
.ev-lobby-latency.full {
    color: #ff6969;
}
.ev-lobby-latency.mid {
    color: #ffcf4d;
}
.ev-lobby-latency.low {
    color: #7dff7d;
}

.ev-lobbies-toolbar {
    display: flex;
    justify-content: flex-end;
}
.ev-btn-refresh {
    padding: 6px 16px;
    font-size: 13px;
    font-weight: 600;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.22);
    background: rgba(255,255,255,0.07);
    color: #fff;
    cursor: pointer;
}
.ev-btn-refresh:hover:not(:disabled) {
    background: rgba(255,255,255,0.14);
}
.ev-btn-refresh:focus-visible {
    outline: 2px solid rgba(255,255,255,0.7);
    outline-offset: 2px;
}
.ev-btn-refresh:disabled {
    opacity: 0.55;
    cursor: default;
}
.ev-lobbies-empty {
    padding: 14px 0;
    font-size: 14px;
    opacity: 0.7;
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
/* Safe-mode notice: the site's own dark, blurred panel look, at the bottom of the page (the top
   holds the site's menu bar). */
#ev-safe-mode {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483000;
    display: flex;
    align-items: center;
    gap: 14px;
    max-width: min(760px, calc(100vw - 32px));
    padding: 10px 14px 10px 16px;
    background: rgba(1, 1, 1, 0.82);
    backdrop-filter: blur(10px);
    border-left: 3px solid #ff9800;
    color: #fff;
    font-family: Rajdhani, sans-serif;
    font-size: 16px;
    line-height: 1.3;
}
#ev-safe-mode .ev-safe-close {
    flex-shrink: 0;
    height: 30px;
    padding: 0 12px;
    border: 0;
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
    font-family: inherit;
    font-size: 14px;
    text-transform: uppercase;
    cursor: pointer;
}
#ev-safe-mode .ev-safe-close:hover {
    background: rgba(255, 255, 255, 0.22);
}
/* The native options popup ignores the page theme: options get explicit colours. */
#ev_host_module select option {
    color: #fff;
    background: #1b1b1b;
}
/* ----- Host a Lobby: laid out like the official Private Game panel (#new_game_module). The
   site's own classes (game_param_div, small_toggle, switch/slider, form-control, newLineDiv,
   col-4, map_name_heading) carry its theme; these rules only add what the official panel styles
   by its id, plus the hosting controls it has no equivalent for. ----- */
#ev_host_module {
    overflow-y: auto;
    overscroll-behavior: contain;
}
#ev_host_module .module_content {
    max-width: 1000px;
}
/* The official switches sit top-right (float right: the first one in the markup is rightmost). */
#ev_host_module .small_toggle {
    float: right;
    margin: 0 0 20px 20px;
}
#ev_host_module .container-new-game {
    display: flow-root;
}
#ev_host_module .container-new-game label {
    display: block;
}
#ev_host_module .small_toggle label {
    max-width: 70px;
    line-height: 1.2;
    min-height: 29px;
}
#ev_host_module .switch.ev-switch-block {
    display: block;
}
#ev-host-name {
    width: 240px;
}
#ev_host_module input[type="number"].form-control {
    width: 96px;
}
.ev-host-actions,
.ev-host-row,
.ev-host-mapbar,
.ev-host-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
}
.ev-host-row .form-control {
    flex: 1 1 260px;
    min-width: 0;
    max-width: 460px;
}
.ev-host-btn,
.ev-host-chip {
    height: 38px;
    padding: 0 18px;
    border: 0;
    border-radius: 0;
    background: rgba(0, 0, 0, 0.3);
    color: #fff;
    font-family: inherit;
    font-size: 16px;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 0.15s ease, filter 0.15s ease;
}
.ev-host-chip {
    height: 32px;
    padding: 0 12px;
    font-size: 14px;
    text-transform: none;
}
.ev-host-btn:hover,
.ev-host-chip:hover {
    background: rgba(255, 255, 255, 0.14);
}
.ev-host-btn:focus-visible,
.ev-host-chip:focus-visible {
    outline: 2px solid #2196f3;
    outline-offset: 1px;
}
.ev-host-btn:disabled {
    opacity: 0.5;
    cursor: default;
}
/* The official switches' blue (input:checked + .slider) marks the main action. */
.ev-host-btn-go,
.ev-host-btn-go:hover {
    background: #2196f3;
}
.ev-host-btn-go:hover {
    filter: brightness(1.12);
}
.ev-host-btn-go.ev-btn-stop,
.ev-host-btn-go.ev-btn-stop:hover {
    background: #e53935;
}
.ev-host-chip-danger {
    color: #ff8a80;
}
.ev-host-status-line {
    font-size: 15px;
    min-height: 22px;
    margin: 8px 0 14px;
}
.ev-host-status-line span + span:not(:empty)::before {
    content: " · ";
    color: rgba(255, 255, 255, 0.5);
}
.ev-host-block {
    margin-bottom: 16px;
}
.ev-host-label {
    display: block;
    font-size: 16px;
    font-weight: 400;
    margin: 0 0 5px;
}
.ev-host-note {
    font-size: 14px;
    opacity: 0.75;
}
.ev-host-mapbar {
    margin: 22px 0 20px;
}
#ev-host-map-source {
    width: auto;
}
/* Map tiles: the official .col-4 + .map_name_heading, with the image rules the official panel
   scopes to its own id (#new_game_module img). */
.ev-map-tile {
    cursor: pointer;
    vertical-align: top;
}
.ev-map-thumb {
    display: block;
    width: 166px;
    height: 70px;
    max-width: none;
    object-fit: cover;
    box-sizing: border-box;
    border: 1px solid transparent;
    background: rgba(255, 255, 255, 0.06);
    opacity: 0.9;
    transition: 0.3s;
}
.ev-map-tile:hover .ev-map-thumb {
    opacity: 1;
    filter: brightness(120%) contrast(120%) saturate(120%);
}
.ev-map-tile.ev-map-active .ev-map-thumb {
    border-color: #fff;
    opacity: 1;
}
.ev-map-tile.ev-map-active {
    cursor: default;
}
.ev-map-tile.ev-map-busy .ev-map-thumb {
    opacity: 0.35;
}
#ev-custom-lobbies-status {
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

/* #ev-priv-dropdown-wrapper reuses the site's own .dropdown/.dropdown-toggle/.dropdown-menu
   markup (same as the PROFILE/Store/Social/Crypto top-bar menus) so it matches ev.io's theme
   exactly — this just adds a HOVER reveal on top of it, since the native button underneath
   isn't wired to Bootstrap's own click-toggle dropdown JS (and shouldn't be — see
   installTopBarButton's own comment on leaving its native click handler untouched). */
#ev-priv-dropdown-wrapper .dropdown-menu {
    display: none;
}
#ev-priv-dropdown-wrapper:hover .dropdown-menu {
    display: block;
}
/* Public Game menu: the additional modes added by page-socket-hook.js GM1. The menu is longer
   now, so let it scroll instead of running off the screen. */
#game_mode_menu .dropdown-menu {
    max-height: 75vh;
    overflow-y: auto;
}
#game_mode_menu .evio-more-header {
    opacity: 0.7;
}
    `);

    // ----------------- global state -----------------

    let LOBBIES = null;
    let lobbiesLoaded = false;
    let lobbiesLoading = false;
    let lobbiesLoadedAt = 0;
    let REGION_LATENCY = {}; // region id -> ms, or null if unreachable

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
                if (customLobbiesOff()) { showSafeModeNotice(true); return; }
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
        if (visSelect) visSelect.checked = (stored.evioHostPublic || 'public') === 'public';
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
        if (visSelect) patch.evioHostPublic = visSelect.checked ? 'public' : 'private';
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

    // Navigating to your OWN lobby's ?evioCustom= link (the Custom-tab row click, or the new
    // "Join Lobby" button) is a same-origin navigation, which Chrome is free to serve via bfcache
    // — and a bfcache-EVICTED port is what logs "the page keeping the extension port is moved
    // into back/forward cache ... Unchecked runtime.lastError" to the console. pageshow's
    // persisted=true (handled above) covers coming BACK from that; this covers LEAVING: disconnect
    // our own port cleanly before the browser gets a chance to force-close it, so the eviction
    // path — and its console warning — never triggers in the first place. Purely cosmetic either
    // way: the grace-period teardown in background.js already tolerates this exact disconnect
    // (that's what it exists for), so this changes nothing about actual hosting behavior.
    window.addEventListener('pagehide', () => {
        if (hostingPort) { try { hostingPort.disconnect(); } catch (e) { /* already gone */ } }
    });

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
        const isPublic = isPublicEl ? isPublicEl.checked : true;

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

    // ----- the Host a Lobby panel's live settings -----
    // The panel mirrors ev.io's own Private Game panel (#new_game_module): small switches floated
    // top-right, rows of labelled .game_param_div controls, then a map source select and a grid of
    // map thumbnails. It reuses the site's own style classes (game_param_div, small_toggle,
    // switch/slider, form-control, newLineDiv, col-4, map_name_heading) so it follows the site's
    // theme. It never reuses an official element id or .private_map_thumb: those belong to the
    // site's own code, and a click on one starts an official private game.
    //
    // Every control is a live server setting: read from /api/settings, committed on change.
    // `scale` converts the panel's units to the setting's: gravity is shown the way the official
    // panel shows it (0.07 per tick²), which is our 28 u/s² (x 20²).
    const HOST_TOGGLES = [   // floated right like the official switches, so the first is rightmost
        { key: 'swordBotGrenadesEnabled', label: 'Sword Grenades' },
        { key: 'swordBotImpulseEnabled', label: 'Sword Impulse' },
        { key: 'botFriendlyFire', label: 'Bot Friendly Fire' },
        { key: 'botWeaponPickupsEnabled', label: 'Bot Pickups' },
    ];
    const HOST_PARAMS = [
        { key: 'gravity', label: 'Gravity', scale: 400, step: 0.01, digits: 3 },
        { key: 'damageScale', label: 'Dmg Multiplier' },
        { key: 'botDamageMult', label: 'Bot Dmg' },
        { key: 'botCount', label: 'Bot Count' },
        { key: 'botLevel', label: 'Bot Level' },
        { key: 'swordBotCount', label: 'Sword Bots' },
        { key: 'swordBotLevel', label: 'Sword Bot Level' },
        { key: 'throwableCooldownScale', label: 'Grenade Cooldown' },
        { key: 'teleportCooldownScale', label: 'Teleport Cooldown' },
    ];
    // Reset Default resets exactly the settings this panel shows.
    const QUICK_ADMIN_SETTING_KEYS = ['gameMode', 'roundTicks',
        ...HOST_TOGGLES.map((t) => t.key), ...HOST_PARAMS.map((p) => p.key)];
    const GAME_MODE_LABELS = { deathmatch: 'Deathmatch', survival: 'Survival' };
    const TICKS_PER_MINUTE = 1200;   // the official Duration select's values: 1200 = 1 min at 20 Hz

    const ANNOUNCE_QUICK_MESSAGES = [
        ['Round starting — good luck!', 'Round starting'],
        ['Server restarting shortly.', 'Restarting soon'],
        ['Switching map — hold on.', 'Map change'],
        ['gg!', 'gg'],
    ];
    // [action, arg-or-null, label, needsConfirm]
    const MATCH_ACTIONS = [
        ['restartround', null, 'Restart Round', false],
        ['endround', null, 'End Round', false],
        ['addtime', 1200, '+1 Min', false],
        ['addtime', -1200, '−1 Min', false],
        ['healall', null, 'Heal All', false],
        ['respawnall', null, 'Respawn All', false],
        ['gather', null, 'Gather All', false],
        ['slapall', 18, 'Slap All', false],
        ['killall', null, 'Kill All', true],
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
        quickAdminStatus('Settings reset to default.', false);
        loadQuickAdminSettings();
    }

    // Official-style building blocks.
    function hostParamDiv(labelText, control) {
        const d = document.createElement('div');
        d.className = 'game_param_div';
        const l = document.createElement('label');
        l.textContent = labelText;
        if (control.id) l.htmlFor = control.id;
        d.appendChild(l);
        d.appendChild(control);
        return d;
    }
    function hostToggleDiv(labelText, input) {
        const d = document.createElement('div');
        d.className = 'small_toggle game_param_div';
        const l = document.createElement('label');
        l.textContent = labelText;
        l.htmlFor = input.id;
        const sw = document.createElement('label');
        sw.className = 'switch ev-switch-block';
        input.type = 'checkbox';
        const slider = document.createElement('span');
        slider.className = 'slider';
        sw.appendChild(input);
        sw.appendChild(slider);
        d.appendChild(l);
        d.appendChild(sw);
        return d;
    }
    function hostSelect(id, options, onChange) {
        const sel = document.createElement('select');
        sel.className = 'form-control';
        sel.id = id;
        stopKeyPropagation(sel);
        options.forEach(([value, label]) => {
            const o = document.createElement('option');
            o.value = value; o.textContent = label;
            sel.appendChild(o);
        });
        if (onChange) sel.addEventListener('change', () => onChange(sel.value));
        return sel;
    }
    function hostButton(label, cls, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = label;
        if (onClick) b.addEventListener('click', onClick);
        return b;
    }

    // Writes fresh values from /api/settings into the panel's controls (built once, in
    // ensureHostModule). Called after every commit/reset, so a value the server clamped or rejected
    // shows as what it really is. The control being typed into is left alone.
    async function loadQuickAdminSettings() {
        if (!document.getElementById('ev_host_module')) return;
        let all;
        try { all = (await adminFetch('/api/settings')).settings; } catch (e) { return; }
        const byKey = new Map(all.map((s) => [s.key, s]));
        const focused = document.activeElement;

        const mode = document.getElementById('ev-host-mode');
        const ms = byKey.get('gameMode');
        if (mode && ms) {
            if (Array.isArray(ms.choices) && mode.options.length !== ms.choices.length) {
                mode.textContent = '';
                ms.choices.forEach((c) => {
                    const o = document.createElement('option');
                    o.value = c; o.textContent = GAME_MODE_LABELS[c] || c;
                    mode.appendChild(o);
                });
            }
            if (mode !== focused) mode.value = ms.value;
        }

        const dur = document.getElementById('ev-host-duration');
        const rs = byKey.get('roundTicks');
        if (dur && rs && dur !== focused) {
            // A round length that is not a whole minute (set from the dashboard) gets its own entry.
            dur.querySelectorAll('option[data-custom]').forEach((o) => o.remove());
            if (!dur.querySelector(`option[value="${rs.value}"]`)) {
                const o = document.createElement('option');
                o.value = String(rs.value); o.dataset.custom = '1';
                o.textContent = `${(rs.value / TICKS_PER_MINUTE).toFixed(2).replace(/\.?0+$/, '')} min`;
                dur.insertBefore(o, dur.firstChild);
            }
            dur.value = String(rs.value);
        }

        for (const t of HOST_TOGGLES) {
            const el = document.getElementById(`ev-host-set-${t.key}`);
            const s = byKey.get(t.key);
            if (el && s) el.checked = !!s.value;
        }
        for (const p of HOST_PARAMS) {
            const el = document.getElementById(`ev-host-set-${p.key}`);
            const s = byKey.get(p.key);
            if (!el || !s) continue;
            const k = p.scale || 1;
            if (s.min !== null && s.min !== undefined) el.min = s.min / k;
            if (s.max !== null && s.max !== undefined) el.max = s.max / k;
            el.step = p.step || ((s.step !== null && s.step !== undefined) ? s.step / k : (s.type === 'int' ? 1 : 'any'));
            el.title = s.desc || '';
            if (el !== focused) el.value = p.digits ? +(s.value / k).toFixed(p.digits) : s.value / k;
        }
    }

    // ----- the map grid -----
    let hostMapsData = null;
    let hostMapSource = 'official';
    let hostMapSwitching = null;
    async function loadQuickAdminMaps() {
        if (!document.getElementById('ev-quick-admin-map')) return;
        try { hostMapsData = await adminFetch('/api/maps'); } catch (e) { return; }
        renderHostMaps();
    }
    function renderHostMaps() {
        const grid = document.getElementById('ev-quick-admin-map');
        if (!grid || !hostMapsData) return;
        const data = hostMapsData;
        grid.textContent = '';
        const tile = (title, thumbUrl, active, onClick) => {
            const t = document.createElement('div');
            t.className = 'col-4 ev-map-tile' + (active ? ' ev-map-active' : '') + (hostMapSwitching === title ? ' ev-map-busy' : '');
            t.title = active ? `${title} (playing now)` : `Switch to ${title}`;
            let img;
            if (thumbUrl) {
                img = document.createElement('img');
                img.src = thumbUrl;
                img.alt = '';
                img.loading = 'lazy';
            } else {
                img = document.createElement('div');
            }
            img.className = 'ev-map-thumb';
            const name = document.createElement('div');
            name.className = 'map_name_heading';
            name.textContent = title;
            t.appendChild(img);
            t.appendChild(name);
            if (onClick) t.addEventListener('click', onClick);
            return t;
        };
        // A running test map is in no list: it is shown first, as the map being played.
        if (data.testMap) grid.appendChild(tile(`${data.testMap.name} (test)`, null, true, null));
        const maps = (data.maps || [])
            .filter((m) => hostMapSource === 'all' || (hostMapSource === 'community') === !!m.extra)
            // Newest first, like the official grid.
            .sort((a, b) => (Number(b.nid) || 0) - (Number(a.nid) || 0));
        maps.forEach((m) => grid.appendChild(tile(m.title, m.thumbUrl, !data.testMap && m.title === data.active,
            () => switchHostMap(m.title))));
        if (!maps.length) {
            const empty = document.createElement('div');
            empty.className = 'ev-host-note';
            empty.textContent = hostMapSource === 'community' ? 'No community maps yet.' : 'No maps.';
            grid.appendChild(empty);
        }
        const note = document.getElementById('ev-quick-admin-testmap');
        if (note) note.textContent = data.testMap ? `Playing test map: ${data.testMap.name}` : '';
    }
    async function switchHostMap(title) {
        if (hostMapSwitching) return;
        if (hostMapsData && !hostMapsData.testMap && hostMapsData.active === title) {
            quickAdminStatus(`${title} is already the map.`, false);
            return;
        }
        hostMapSwitching = title;
        renderHostMaps();
        quickAdminStatus(`Switching map to ${title}…`, false);
        try {
            await adminFetch('/api/map', 'POST', { map: title });
            quickAdminStatus(`Map switched to ${title}.`, false);
        } catch (e) {
            quickAdminStatus(`Map switch failed: ${(e && e.message) || e}`, true);
        } finally {
            hostMapSwitching = null;
            loadQuickAdminMaps();
        }
    }

    // Test map: any .evmap from this computer, played by everyone in the lobby. It stays in
    // memory only (not cached, not in the map list) — see background.js's /api/testmap.
    function loadTestMapFile(f, btn) {
        if (f.size > 32 * 1048576) { quickAdminStatus('Test maps can be at most 32 MB.', true); return; }
        quickAdminStatus(`Loading test map ${f.name}…`, false);
        btn.disabled = true;
        const reader = new FileReader();
        reader.onerror = () => { btn.disabled = false; quickAdminStatus('Could not read that file.', true); };
        reader.onload = async () => {
            const url = String(reader.result);
            try {
                const r = await adminFetch('/api/testmap', 'POST', { name: f.name, data: url.slice(url.indexOf(',') + 1) });
                quickAdminStatus(`Test map ${r.map} loaded (${r.spawns} spawns). Loading another map removes it.`, false);
                loadQuickAdminMaps();
            } catch (e) {
                quickAdminStatus(`Test map failed: ${(e && e.message) || e}`, true);
            } finally {
                btn.disabled = false;
            }
        };
        reader.readAsDataURL(f);
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

    // ----------------- safe mode -----------------
    // page-socket-hook.js checks ev.io's game bundle before changing anything. When ev.io has
    // shipped a build this extension was not made for (or its code changed under a patch, or the
    // patched bundle crashed), the game loads unmodified and every hook passes through: SAFE MODE.
    // Official games are untouched; custom lobbies (hosting and joining) are switched off, since
    // they need the patches and the protocol this extension knows.
    let extCompat = { state: 'pending', build: null, reasons: [] };
    const customLobbiesOff = () => extCompat.state === 'safe';

    function showSafeModeNotice(force) {
        try { if (!force && sessionStorage.getItem('evioExtSafeNoticeHidden') === '1') return; } catch (e) { /* ignore */ }
        let box = document.getElementById('ev-safe-mode');
        if (!box) {
            box = document.createElement('div');
            box.id = 'ev-safe-mode';
            box.setAttribute('role', 'status');
            const text = document.createElement('div');
            text.className = 'ev-safe-text';
            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'ev-safe-close';
            close.textContent = 'Dismiss';
            close.addEventListener('click', () => {
                box.remove();
                try { sessionStorage.setItem('evioExtSafeNoticeHidden', '1'); } catch (e) { /* ignore */ }
            });
            box.appendChild(text);
            box.appendChild(close);
            (document.body || document.documentElement).appendChild(box);
        }
        const what = extCompat.build && !/^1-7-1$/.test(extCompat.build)
            ? `ev.io updated the game (build ${extCompat.build})`
            : 'ev.io changed the game';
        box.querySelector('.ev-safe-text').textContent =
            `EV.IO UI Enhancer is paused: ${what}. Official games run normally; custom lobbies are off until the extension is updated.`;
        box.title = extCompat.reasons.join('\n');
    }
    if (!document.body) document.addEventListener('DOMContentLoaded', () => { if (customLobbiesOff()) showSafeModeNotice(false); });

    window.addEventListener('message', (event) => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        const msg = event.data;
        if (!msg || msg.source !== HOOK_MSG_SOURCE) return;

        if (msg.type === 'compat') {
            extCompat = { state: msg.state, build: msg.build || null, reasons: Array.isArray(msg.reasons) ? msg.reasons : [] };
            if (extCompat.state === 'safe') showSafeModeNotice(false);
            return;
        }
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
        } else if (msg.type === 'test-map-request') {
            // The game is downloading a test map (see page-socket-hook.js): background.js has it in
            // memory if we host the lobby, or fetches it from the lobby's host. The bytes go back to
            // the page as an ArrayBuffer (window.postMessage clones it natively).
            const reply = (extra) => window.postMessage({ source: RELAY_MSG_SOURCE, type: 'test-map-response', id: msg.id, ...extra }, window.location.origin);
            chrome.runtime.sendMessage({ type: 'testMapGet', key: msg.key }).then((resp) => {
                if (!resp || !resp.ok) { reply({ ok: false, error: (resp && resp.error) || 'no response' }); return; }
                const s = atob(resp.data);
                const bytes = new Uint8Array(s.length);
                for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
                reply({ ok: true, data: bytes.buffer });
            }).catch((e) => reply({ ok: false, error: String((e && e.message) || e) }));
        }
    });

    (function injectPageHook() {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('page-socket-hook.js');
        script.dataset.extVersion = chrome.runtime.getManifest().version;
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
    function reconnectHostingPortIfNeeded() {
        chrome.runtime.sendMessage({ type: 'getHostingStatus' }).then((resp) => {
            if (resp && resp.ok && resp.hosting && !hostingPort) {
                attachHostingPort(resp.lobbyCode);
                setHostStatus('Hosting — lobby code: ' + hostingLobbyCode, false);
                showShareLink(resp.lobbyCode);
            }
        });
    }
    reconnectHostingPortIfNeeded();

    // A page Chrome puts into the back/forward cache (navigating away via back/forward, or in
    // some cases a same-origin SPA-style navigation) has every chrome.runtime.Port it held closed
    // by the browser itself — by design, so an extension can never block instant bfcache restore.
    // That's where "the page keeping the extension port is moved into back/forward cache" comes
    // from; it's expected Chrome behavior, not a sign anything broke. What IS a real gap: nothing
    // previously re-ran the reconnect logic above when the SAME page is later restored FROM
    // bfcache (pageshow fires with persisted=true, but the page never re-executes its own
    // top-level script — there is no second "page load" to trigger it from). Without this, a host
    // who navigated back/forward while hosting would either lose their lobby once
    // HOST_TEARDOWN_GRACE_MS elapsed with nothing reconnecting, or — even if they returned inside
    // that window — be left with a permanently dead port that never got re-attached.
    window.addEventListener('pageshow', (e) => {
        if (e.persisted) reconnectHostingPortIfNeeded();
    });

    // ----------------- module panel -----------------

    // "Game file cache" row under the official lobby list. The cache itself lives in
    // page-socket-hook.js (Cache Storage belongs to the page); this only asks it for its size and
    // passes on the toggle / clear.
    function buildAssetCacheRow() {
        const group = document.createElement('div');
        group.className = 'ev-field-group';
        group.id = 'ev-asset-cache';
        group.style.marginTop = '12px';
        const row = document.createElement('div');
        row.className = 'ev-field-row';
        row.style.alignItems = 'center';
        const label = document.createElement('label');
        label.style.cssText = 'flex:1;display:flex;gap:8px;align-items:center;cursor:pointer;font-size:13px;';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.id = 'ev-asset-cache-enabled';
        const text = document.createElement('span');
        text.textContent = 'Keep game files on this computer (faster loading)';
        label.appendChild(box);
        label.appendChild(text);
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'ev-btn-reset';
        clearBtn.id = 'ev-asset-cache-clear';
        clearBtn.textContent = 'Clear';
        clearBtn.style.padding = '4px 12px';
        row.appendChild(label);
        row.appendChild(clearBtn);
        const hint = document.createElement('p');
        hint.className = 'ev-field-hint';
        hint.id = 'ev-asset-cache-status';
        hint.textContent = 'Maps, pictures and sounds are loaded from here instead of ev.io, and checked for updates in the background.';
        group.appendChild(row);
        group.appendChild(hint);

        let seq = 0;
        const ask = (type, extra) => window.postMessage(
            Object.assign({ source: 'evio-ext-isolated-relay', type, id: ++seq }, extra || {}), window.location.origin);
        const fmt = (b) => b >= 1048576 ? (b / 1048576).toFixed(0) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
        window.addEventListener('message', (event) => {
            if (event.source !== window || event.origin !== window.location.origin) return;
            const m = event.data;
            if (!m || m.source !== 'evio-ext-page-hook' || m.type !== 'asset-cache-info') return;
            box.checked = !!m.enabled;
            clearBtn.disabled = !m.count;
            if (!m.available) { hint.textContent = 'This browser does not allow the cache here.'; return; }
            const stored = m.count ? `${m.count} files kept (${fmt(m.bytes)})` : 'Nothing kept yet';
            const used = (m.hits || m.misses) ? ` · this visit: ${m.hits} loaded from here, ${m.misses} from ev.io` : '';
            hint.textContent = (m.enabled ? stored : 'Off. ' + stored) + used;
        });
        box.addEventListener('change', () => ask('asset-cache-enable', { enabled: box.checked }));
        clearBtn.addEventListener('click', () => { hint.textContent = 'Clearing...'; ask('asset-cache-clear'); });
        // Refresh whenever the panel is shown.
        new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) ask('asset-cache-stats'); })
            .observe(group);
        ask('asset-cache-stats');
        return group;
    }

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

        const toolbar = document.createElement('div');
        toolbar.className = 'ev-lobbies-toolbar';
        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.id = 'ev-lobbies-refresh';
        refreshBtn.className = 'ev-btn-refresh';
        refreshBtn.textContent = 'Refresh';
        refreshBtn.addEventListener('click', () => forceRefreshLobbies());
        toolbar.appendChild(refreshBtn);

        const list = document.createElement('div');
        list.id = 'ev-lobbies-list';

        officialView.appendChild(toolbar);
        officialView.appendChild(list);
        officialView.appendChild(buildAssetCacheRow());
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
            stopCustomLobbyPolling();
        });

        // Safety net for any OTHER way this panel ends up hidden — e.g. the site's own UI
        // switching to a different panel, if that code ever touches .module_box elements the
        // same way showLobbyModule() does to ours. Without this, polling would keep running
        // (and fetching) with the panel invisible, exactly the background task to avoid.
        new MutationObserver(() => {
            if (mod.style.display === 'none') {
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
        title.textContent = 'Host a Lobby';
        content.appendChild(title);

        // Laid out like the official Private Game panel: switches floated top-right, then rows of
        // labelled controls (floated .game_param_div, each row ended by a .newLineDiv).
        const form = document.createElement('div');
        form.className = 'container-new-game';

        // Visibility is the lobby's own setting (kept in chrome.storage), not a server setting.
        const publicInput = document.createElement('input');
        publicInput.id = 'ev-host-public';
        publicInput.addEventListener('change', saveHostingSettings);
        form.appendChild(hostToggleDiv('Public', publicInput));
        for (const t of HOST_TOGGLES) {
            const input = document.createElement('input');
            input.id = `ev-host-set-${t.key}`;
            input.addEventListener('change', () => commitSetting(t.key, input.checked));
            form.appendChild(hostToggleDiv(t.label, input));
        }
        form.appendChild(Object.assign(document.createElement('div'), { className: 'newLineDiv' }));

        const hostNameInput = document.createElement('input');
        hostNameInput.id = 'ev-host-name';
        hostNameInput.type = 'text';
        hostNameInput.className = 'form-control';
        hostNameInput.placeholder = 'e.g. "Alice\'s lobby"';
        hostNameInput.maxLength = 40;
        stopKeyPropagation(hostNameInput);
        // Persist as you go: closing the panel or reloading shouldn't lose what was typed.
        hostNameInput.addEventListener('change', saveHostingSettings);
        form.appendChild(hostParamDiv('Lobby Name', hostNameInput));

        form.appendChild(hostParamDiv('Game Mode', hostSelect('ev-host-mode',
            [['deathmatch', 'Deathmatch']], (v) => commitSetting('gameMode', v))));
        const minutes = [];
        for (let m = 1; m <= 20; m++) minutes.push([String(m * TICKS_PER_MINUTE), `${m} min`]);
        form.appendChild(hostParamDiv('Duration', hostSelect('ev-host-duration', minutes,
            (v) => commitSetting('roundTicks', Number(v)))));
        form.appendChild(Object.assign(document.createElement('div'), { className: 'newLineDiv' }));

        for (const p of HOST_PARAMS) {
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'form-control';
            input.id = `ev-host-set-${p.key}`;
            stopKeyPropagation(input);
            input.addEventListener('change', () => {
                const v = Number(input.value);
                if (input.value === '' || !Number.isFinite(v)) { loadQuickAdminSettings(); return; }
                commitSetting(p.key, p.scale ? +(v * p.scale).toFixed(4) : v);
            });
            form.appendChild(hostParamDiv(p.label, input));
        }
        form.appendChild(Object.assign(document.createElement('div'), { className: 'newLineDiv' }));
        content.appendChild(form);

        // ----- hosting -----
        const actions = document.createElement('div');
        actions.className = 'ev-host-actions';
        const hostToggleBtn = hostButton('Start Hosting', 'ev-host-btn ev-host-btn-go', () => {
            if (hostingPort) stopHosting();
            else startHosting();
        });
        hostToggleBtn.id = 'ev-host-toggle';
        // The full dashboard (players, parity, presets) opens in its own tab.
        const adminBtn = hostButton('Admin Dashboard', 'ev-host-btn', () => chrome.runtime.sendMessage({ type: 'openAdmin' }));
        adminBtn.id = 'ev-host-admin';
        const resetBtn = hostButton('Reset Default', 'ev-host-btn', resetAllQuickSettings);
        resetBtn.title = 'Put every setting on this panel back to its default';
        actions.appendChild(hostToggleBtn);
        actions.appendChild(adminBtn);
        actions.appendChild(resetBtn);
        content.appendChild(actions);

        const statusLine = document.createElement('div');
        statusLine.className = 'ev-host-status-line';
        const hostStatus = document.createElement('span');
        hostStatus.id = 'ev-host-status';
        const qaStatus = document.createElement('span');
        qaStatus.id = 'ev-quick-admin-status';
        statusLine.appendChild(hostStatus);
        statusLine.appendChild(qaStatus);
        content.appendChild(statusLine);

        // Shown once hosting starts: a direct link means invited players need not find the lobby
        // in their own list (a Private lobby is not listed at all).
        const shareBox = document.createElement('div');
        shareBox.id = 'ev-host-share';
        shareBox.className = 'ev-host-block';
        shareBox.style.display = 'none';
        const shareLab = document.createElement('label');
        shareLab.className = 'ev-host-label';
        shareLab.htmlFor = 'ev-host-share-link';
        shareLab.textContent = 'Invite Link';
        const shareRow = document.createElement('div');
        shareRow.className = 'ev-host-row';
        const shareInput = document.createElement('input');
        shareInput.id = 'ev-host-share-link';
        shareInput.className = 'form-control';
        shareInput.readOnly = true;
        stopKeyPropagation(shareInput);
        shareInput.addEventListener('focus', () => shareInput.select());
        const shareCopyBtn = hostButton('Copy Link', 'ev-host-btn', async () => {
            try {
                await navigator.clipboard.writeText(shareInput.value);
            } catch (e) {
                shareInput.select();
                document.execCommand('copy');
            }
            shareCopyBtn.textContent = 'Copied!';
            setTimeout(() => { shareCopyBtn.textContent = 'Copy Link'; }, 1500);
        });
        // The same navigation a lobby row's click does, for the host's own lobby.
        const joinOwnBtn = hostButton('Join Lobby', 'ev-host-btn ev-host-btn-go', () => { window.location.href = shareInput.value; });
        shareRow.appendChild(shareInput);
        shareRow.appendChild(shareCopyBtn);
        shareRow.appendChild(joinOwnBtn);
        shareBox.appendChild(shareLab);
        shareBox.appendChild(shareRow);
        content.appendChild(shareBox);

        // ----- match controls (live, on the hosted server) -----
        const matchBlock = document.createElement('div');
        matchBlock.className = 'ev-host-block';
        const matchLab = document.createElement('label');
        matchLab.className = 'ev-host-label';
        matchLab.textContent = 'Match';
        const matchChips = document.createElement('div');
        matchChips.className = 'ev-host-chips';
        MATCH_ACTIONS.forEach(([action, arg, label, needsConfirm]) => {
            matchChips.appendChild(hostButton(label, 'ev-host-chip' + (needsConfirm ? ' ev-host-chip-danger' : ''), () => {
                if (needsConfirm && !confirm('Kill every connected player?')) return;
                serverAction(action, arg === null ? undefined : arg);
            }));
        });
        matchBlock.appendChild(matchLab);
        matchBlock.appendChild(matchChips);
        content.appendChild(matchBlock);

        const announceBlock = document.createElement('div');
        announceBlock.className = 'ev-host-block';
        const announceLab = document.createElement('label');
        announceLab.className = 'ev-host-label';
        announceLab.htmlFor = 'ev-host-announce';
        announceLab.textContent = 'Announce';
        const announceRow = document.createElement('div');
        announceRow.className = 'ev-host-row';
        const announceInput = document.createElement('input');
        announceInput.id = 'ev-host-announce';
        announceInput.className = 'form-control';
        announceInput.placeholder = 'Message to every connected player…';
        stopKeyPropagation(announceInput);
        function fireAnnounce() {
            const msg = announceInput.value.trim();
            if (!msg) { quickAdminStatus('Nothing to announce.', true); return; }
            serverAction('announce', msg).then(() => { announceInput.value = ''; });
        }
        announceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') fireAnnounce(); });
        announceRow.appendChild(announceInput);
        announceRow.appendChild(hostButton('Send', 'ev-host-btn', fireAnnounce));
        ANNOUNCE_QUICK_MESSAGES.forEach(([msg, label]) => {
            announceRow.appendChild(hostButton(label, 'ev-host-chip', () => serverAction('announce', msg)));
        });
        announceBlock.appendChild(announceLab);
        announceBlock.appendChild(announceRow);
        content.appendChild(announceBlock);

        // ----- map: source select + thumbnail grid, like the official panel -----
        const mapBar = document.createElement('div');
        mapBar.className = 'ev-host-mapbar';
        const source = hostSelect('ev-host-map-source',
            [['official', 'Official'], ['community', 'Community'], ['all', 'All Maps']],
            (v) => { hostMapSource = v; renderHostMaps(); });
        source.value = hostMapSource;
        const testFile = document.createElement('input');
        testFile.type = 'file';
        testFile.accept = '.evmap';
        testFile.id = 'ev-quick-admin-testmap-file';
        testFile.style.display = 'none';
        const testBtn = hostButton('Load Test Map…', 'ev-host-btn', () => testFile.click());
        testBtn.title = 'Play a .evmap from this computer with everyone in your lobby. It is not saved or added to the map list.';
        testFile.addEventListener('change', () => {
            const f = testFile.files && testFile.files[0];
            testFile.value = '';
            if (f) loadTestMapFile(f, testBtn);
        });
        const testNote = document.createElement('span');
        testNote.id = 'ev-quick-admin-testmap';
        testNote.className = 'ev-host-note';
        mapBar.appendChild(source);
        mapBar.appendChild(testBtn);
        mapBar.appendChild(testNote);
        mapBar.appendChild(testFile);
        content.appendChild(mapBar);

        const grid = document.createElement('div');
        grid.id = 'ev-quick-admin-map';
        grid.className = 'ev-host-maps';
        content.appendChild(grid);

        mod.appendChild(close);
        mod.appendChild(content);
        document.body.appendChild(mod);

        close.addEventListener('click', () => {
            mod.style.display = 'none';
        });

        loadHostingSettingsIntoForm();
        // Matches the button's text and colour to reality if hosting was already active when the
        // panel was first built (the early-reconnect check re-attaches the port on page load).
        paintHostingButton();
        if (hostingLobbyCode) showShareLink(hostingLobbyCode);
        loadQuickAdminSettings();
        loadQuickAdminMaps();
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

    // Loading/error messages show inside the list itself, and only while it has no rooms.
    let lobbyListMessage = '';
    function setStatus(msg) {
        lobbyListMessage = msg || '';
        const list = document.getElementById('ev-lobbies-list');
        if (!list || list.querySelector('.ev-lobby-row')) return;
        list.textContent = '';
        if (lobbyListMessage) {
            const note = document.createElement('div');
            note.className = 'ev-lobbies-empty';
            note.textContent = lobbyListMessage;
            list.appendChild(note);
        }
    }

    // ----------------- render list -----------------

    function renderLobbyList() {
    const list = document.getElementById('ev-lobbies-list');
    if (!list) return;
    hidePlayersCard();   // its anchor badge is about to be replaced
    list.innerHTML = '';

    if (!Array.isArray(LOBBIES) || !LOBBIES.length) {
        setStatus(lobbiesLoading ? 'Loading lobbies…' : lobbyListMessage);
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

        // Region latency, colored by the same full/mid/low scale (low ms = green). The player
        // count beside it comes from probeLobby() below — the matchmaker reports no counts.
        const latency = document.createElement('div');
        latency.className = 'ev-lobby-latency';

        const ms = REGION_LATENCY[lobby.region];
        if (ms === undefined) {
            latency.textContent = '… ms';
        } else if (ms === null) {
            latency.textContent = 'unreachable';
            latency.classList.add('full');
        } else {
            latency.textContent = `${ms}ms`;
            if (ms >= 200) latency.classList.add('full');
            else if (ms >= 100) latency.classList.add('mid');
            else latency.classList.add('low');
        }

        const right = document.createElement('div');
        right.className = 'ev-lobby-right';
        right.appendChild(renderPlayerCount(lobby.id, lobby));
        right.appendChild(latency);

        main.appendChild(name);
        main.appendChild(right);
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


    // ----------------- player counts (guest probe) -----------------

    // The matchmaker reports no player counts, so each room is asked directly: join it as a guest
    // over the game WebSocket, read the first state packets (which list every player entity),
    // and leave about a second later. Same protocol as tools/probe_lobby.py:
    //   server "ID<clientId>"  ->  client ";{join}"  ->  server ";1" + msgpack [sync, tick, body]
    // body is a flat [op, value, ...] list; a player entity starts `244, id, 90, id, 91, joinState`
    // and carries displayName 210 and isBot 237 further on. joinState 0 = connected but still on
    // "click to play". The probe never clicks play, so it gets no scoreboard row, is excluded
    // from its own count, and drops out of the room's roster within seconds of leaving (tested).
    // This content script runs in the isolated world, so page-socket-hook's WebSocket patch never
    // sees these sockets.
    const PROBE_TTL_MS = 60000;      // reuse a room's count for this long
    // The first state packet after the join is the full bootstrap and lists every player, so the
    // probe leaves as soon as it arrives. PROBE_STAY_MS is only the fallback for a room that sends
    // no player entities at all. Every room is probed at once (they share one host per region).
    const PROBE_STAY_MS = 800;
    const PROBE_TIMEOUT_MS = 6000;
    const PLAYER_COUNTS = {};        // room id -> { state: 'loading'|'ok'|'error', at, playing, waiting, bots, names, error }
    let probeQueue = [];

    function msgpackDecode(buf) {
        const view = new DataView(buf);
        const bytes = new Uint8Array(buf);
        const text = new TextDecoder();
        let i = 0;
        const str = (n) => { const s = text.decode(bytes.subarray(i, i + n)); i += n; return s; };
        const arr = (n) => { const out = new Array(n); for (let k = 0; k < n; k++) out[k] = read(); return out; };
        const map = (n) => { const out = {}; for (let k = 0; k < n; k++) { const key = read(); out[key] = read(); } return out; };
        const ext = (n) => { i += 1 + n; return null; };
        function read() {
            const t = bytes[i++];
            if (t <= 0x7f) return t;
            if (t >= 0xe0) return t - 0x100;
            if (t >= 0x80 && t <= 0x8f) return map(t & 0x0f);
            if (t >= 0x90 && t <= 0x9f) return arr(t & 0x0f);
            if (t >= 0xa0 && t <= 0xbf) return str(t & 0x1f);
            let v;
            switch (t) {
                case 0xc0: return null;
                case 0xc2: return false;
                case 0xc3: return true;
                case 0xc4: v = bytes[i]; i += 1; i += v; return null;
                case 0xc5: v = view.getUint16(i); i += 2 + v; return null;
                case 0xc6: v = view.getUint32(i); i += 4 + v; return null;
                case 0xc7: v = bytes[i]; i += 1; return ext(v);
                case 0xc8: v = view.getUint16(i); i += 2; return ext(v);
                case 0xc9: v = view.getUint32(i); i += 4; return ext(v);
                case 0xca: v = view.getFloat32(i); i += 4; return v;
                case 0xcb: v = view.getFloat64(i); i += 8; return v;
                case 0xcc: return bytes[i++];
                case 0xcd: v = view.getUint16(i); i += 2; return v;
                case 0xce: v = view.getUint32(i); i += 4; return v;
                case 0xcf: v = Number(view.getBigUint64(i)); i += 8; return v;
                case 0xd0: v = view.getInt8(i); i += 1; return v;
                case 0xd1: v = view.getInt16(i); i += 2; return v;
                case 0xd2: v = view.getInt32(i); i += 4; return v;
                case 0xd3: v = Number(view.getBigInt64(i)); i += 8; return v;
                case 0xd4: return ext(1);
                case 0xd5: return ext(2);
                case 0xd6: return ext(4);
                case 0xd7: return ext(8);
                case 0xd8: return ext(16);
                case 0xd9: v = bytes[i]; i += 1; return str(v);
                case 0xda: v = view.getUint16(i); i += 2; return str(v);
                case 0xdb: v = view.getUint32(i); i += 4; return str(v);
                case 0xdc: v = view.getUint16(i); i += 2; return arr(v);
                case 0xdd: v = view.getUint32(i); i += 4; return arr(v);
                case 0xde: v = view.getUint16(i); i += 2; return map(v);
                case 0xdf: v = view.getUint32(i); i += 4; return map(v);
            }
            throw new Error('bad msgpack byte ' + t);
        }
        return read();
    }

    // Every player entity in one state body: id -> { name, bot, joinState }.
    function collectPlayers(body, into) {
        for (let s = 0; s + 3 < body.length; s++) {
            if (body[s] !== 244 || body[s + 2] !== 90 || body[s + 3] !== body[s + 1]) continue;
            let e = s + 4;
            while (e + 3 < body.length && !(body[e] === 244 && body[e + 2] === 90 && body[e + 3] === body[e + 1])) e++;
            const seg = body.slice(s, e + 3 < body.length ? e : body.length);
            const base = Math.max(0, seg.indexOf(210));
            const after = (op) => { const j = seg.indexOf(op, base); return j >= 0 ? seg[j + 1] : undefined; };
            into[String(seg[1])] = {
                name: after(210),
                bot: after(237) === true,
                joinState: seg[4] === 91 ? seg[5] : undefined,
            };
        }
    }

    function probeLobby(room) {
        return new Promise((resolve, reject) => {
            let ws;
            try {
                ws = new WebSocket(room.connectionUrl);
            } catch (e) {
                reject(e);
                return;
            }
            ws.binaryType = 'arraybuffer';
            const players = {};
            let clientId = null;
            let stayTimer = null;
            const finish = (err) => {
                clearTimeout(hardTimer);
                clearTimeout(stayTimer);
                try { ws.close(1000); } catch (e) { /* already closed */ }
                if (err) { reject(err); return; }
                delete players[clientId];   // never count the probe itself
                const list = Object.values(players);
                resolve({
                    players: list.filter((p) => !p.bot).length,
                    playing: list.filter((p) => !p.bot && p.joinState !== 0).length,
                    waiting: list.filter((p) => !p.bot && p.joinState === 0).length,
                    bots: list.filter((p) => p.bot).length,
                    // Humans for the hover card: playing first, then by name.
                    humans: list.filter((p) => !p.bot)
                        .map((p) => ({
                            name: typeof p.name === 'string' && p.name ? p.name : 'Unknown',
                            playing: p.joinState !== 0,
                        }))
                        .sort((a, b) => (b.playing - a.playing) || a.name.localeCompare(b.name)),
                });
            };
            const hardTimer = setTimeout(() => finish(stayTimer ? null : new Error('timed out')), PROBE_TIMEOUT_MS);
            ws.onerror = () => finish(new Error('connection failed'));
            ws.onclose = () => { if (stayTimer) finish(null); else finish(new Error('closed by server')); };
            ws.onmessage = (ev) => {
                if (typeof ev.data === 'string') {
                    const kind = ev.data[0];
                    if (ev.data.startsWith('ID') && clientId === null) {
                        clientId = ev.data.slice(2);
                        ws.send(';' + JSON.stringify({
                            uid: 17, token: '', mmLobbyId: room.id, buildIdentifier: '1.6.4-release-no-obf',
                            id: '', adminPass: '', isShareGame: false,
                        }));
                    } else if (kind === ';') {
                        if (!ev.data.startsWith(';1')) finish(new Error('join refused'));
                        else stayTimer = setTimeout(() => finish(null), PROBE_STAY_MS);
                    } else if (kind === '!') {
                        finish(new Error(ev.data === '!7' ? 'room full' : 'refused (' + ev.data + ')'));
                    }
                    return;
                }
                try {
                    const packet = msgpackDecode(ev.data);
                    if (Array.isArray(packet) && Array.isArray(packet[2])) {
                        collectPlayers(packet[2], players);
                        if (stayTimer && Object.keys(players).length) finish(null);
                    }
                } catch (e) { /* skip a packet we can't decode */ }
            };
        });
    }

    const probesInFlight = new Set();

    function pumpProbeQueue() {
        while (probeQueue.length) {
            const room = probeQueue.shift();
            const job = probeLobby(room)
                .then((r) => { PLAYER_COUNTS[room.id] = { state: 'ok', at: Date.now(), ...r }; })
                .catch((e) => { PLAYER_COUNTS[room.id] = { state: 'error', at: Date.now(), error: e.message }; })
                .finally(() => {
                    probesInFlight.delete(job);
                    updatePlayerCountCell(room.id);
                });
            probesInFlight.add(job);
        }
    }

    // Refresh button: fetch the room list, pings and every player count again, ignoring the
    // 60 s cache. The old numbers stay on screen until the new ones arrive.
    let refreshingLobbies = false;
    async function forceRefreshLobbies() {
        if (refreshingLobbies) return;
        refreshingLobbies = true;
        const btn = document.getElementById('ev-lobbies-refresh');
        if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
        try {
            Object.values(PLAYER_COUNTS).forEach((c) => { if (c.state !== 'loading') c.at = 0; });
            const latency = refreshRegionLatency();
            if (!lobbiesLoading) {
                lobbiesLoaded = false;
                await loadLobbiesFromBundle();   // re-renders and queues the probes
            }
            await latency;
            await Promise.allSettled([...probesInFlight]);
        } finally {
            refreshingLobbies = false;
            if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
        }
    }

    // Queue a probe for every room whose count is missing or older than PROBE_TTL_MS.
    function refreshPlayerCounts() {
        const now = Date.now();
        (LOBBIES || []).forEach((room) => {
            if (!room || !room.id || !room.connectionUrl) return;
            const c = PLAYER_COUNTS[room.id];
            if (c && (c.state === 'loading' || now - c.at < PROBE_TTL_MS)) return;
            // Keep the last good numbers on screen while the new probe runs.
            PLAYER_COUNTS[room.id] = { ...(c && c.state === 'ok' ? c : {}), state: 'loading', at: now };
            probeQueue.push(room);
        });
        pumpProbeQueue();
    }

    function renderPlayerCount(roomId, lobby) {
        const el = document.createElement('div');
        el.className = 'ev-lobby-players';
        el.dataset.roomId = roomId;
        fillPlayerCount(el, PLAYER_COUNTS[roomId]);
        el.addEventListener('mouseenter', () => showPlayersCard(el, lobby));
        el.addEventListener('mouseleave', hidePlayersCard);
        return el;
    }

    // ----- hover card: who is in the room -----
    // One shared floating card, shown on mouseenter with no delay (the native title tooltip waits
    // 1-2 s) and refilled live if the room's probe finishes while it is open.
    let playersCard = null;
    let playersCardAnchor = null;
    let playersCardLobby = null;

    function ensurePlayersCard() {
        if (playersCard && playersCard.isConnected) return playersCard;
        playersCard = document.createElement('div');
        playersCard.id = 'ev-players-card';
        playersCard.setAttribute('role', 'tooltip');
        document.body.appendChild(playersCard);
        // Scrolling the list moves the badge out from under the card: close it.
        document.addEventListener('scroll', hidePlayersCard, true);
        return playersCard;
    }

    function showPlayersCard(anchor, lobby) {
        playersCardAnchor = anchor;
        playersCardLobby = lobby;
        const card = ensurePlayersCard();
        fillPlayersCard(card, lobby, PLAYER_COUNTS[lobby.id]);
        card.classList.add('open');
        positionPlayersCard();
    }

    function hidePlayersCard() {
        playersCardAnchor = null;
        playersCardLobby = null;
        if (playersCard) playersCard.classList.remove('open');
    }

    function positionPlayersCard() {
        if (!playersCard || !playersCardAnchor) return;
        const a = playersCardAnchor.getBoundingClientRect();
        const w = playersCard.offsetWidth;
        const h = playersCard.offsetHeight;
        const gap = 8;
        // Right edge lined up with the badge, below it; flipped above when it would run off-screen.
        let left = Math.min(a.right - w, window.innerWidth - w - 12);
        left = Math.max(12, left);
        let top = a.bottom + gap;
        if (top + h > window.innerHeight - 12) top = Math.max(12, a.top - gap - h);
        playersCard.style.left = left + 'px';
        playersCard.style.top = top + 'px';
    }

    function fillPlayersCard(card, lobby, c) {
        card.textContent = '';
        const head = document.createElement('div');
        head.className = 'ev-pc-head';
        const title = document.createElement('div');
        title.className = 'ev-pc-title';
        title.textContent = prettyGamemode(lobby.gamemode);
        const region = document.createElement('div');
        region.className = 'ev-pc-region';
        region.textContent = prettyRegion(lobby.region);
        head.appendChild(title);
        head.appendChild(region);
        card.appendChild(head);

        const note = (text) => {
            const n = document.createElement('div');
            n.className = 'ev-pc-note';
            n.textContent = text;
            card.appendChild(n);
        };
        if (!c || (c.state === 'loading' && c.players === undefined)) { note('Counting players…'); return; }
        if (c.state === 'error') { note('Could not count players: ' + c.error); return; }

        const summary = document.createElement('div');
        summary.className = 'ev-pc-summary';
        const stat = (value, label, cls) => {
            const box = document.createElement('div');
            box.className = 'ev-pc-stat' + (cls ? ' ' + cls : '');
            const v = document.createElement('span');
            v.className = 'ev-pc-stat-value';
            v.textContent = value;
            const l = document.createElement('span');
            l.className = 'ev-pc-stat-label';
            l.textContent = label;
            box.appendChild(v);
            box.appendChild(l);
            summary.appendChild(box);
        };
        stat(c.playing, 'playing', 'playing');
        stat(c.waiting, 'watching', 'watching');
        stat(c.bots, c.bots === 1 ? 'bot' : 'bots', 'bots');
        card.appendChild(summary);

        const humans = c.humans || [];
        if (!humans.length) {
            note('No players right now — only bots.');
        } else {
            const list = document.createElement('ol');
            list.className = 'ev-pc-list';
            humans.forEach((p) => {
                const li = document.createElement('li');
                li.className = p.playing ? 'playing' : 'watching';
                const dot = document.createElement('span');
                dot.className = 'ev-pc-dot';
                const name = document.createElement('span');
                name.className = 'ev-pc-name';
                name.textContent = p.name;   // textContent: player names are untrusted
                li.appendChild(dot);
                li.appendChild(name);
                list.appendChild(li);
            });
            card.appendChild(list);
        }

        const foot = document.createElement('div');
        foot.className = 'ev-pc-foot';
        const age = Math.max(0, Math.round((Date.now() - c.at) / 1000));
        foot.textContent = c.state === 'loading' ? 'Refreshing…' : (age < 5 ? 'Updated just now' : `Updated ${age}s ago`);
        card.appendChild(foot);
    }

    function fillPlayerCount(el, c) {
        el.classList.remove('busy', 'empty', 'pending');
        if (!c || (c.state === 'loading' && c.players === undefined)) {
            el.textContent = '… players';
            el.classList.add('pending');
            return;
        }
        if (c.state === 'error') {
            el.textContent = '? players';
            el.classList.add('pending');
            return;
        }
        // Players = every human in the room, including those still on the click-to-play screen.
        el.textContent = `${c.players} player${c.players === 1 ? '' : 's'}`;
        el.classList.add(c.players > 0 ? 'busy' : 'empty');
    }

    function updatePlayerCountCell(roomId) {
        document.querySelectorAll('#ev-lobbies-list .ev-lobby-players').forEach((el) => {
            if (el.dataset.roomId === roomId) fillPlayerCount(el, PLAYER_COUNTS[roomId]);
        });
        if (playersCard && playersCardLobby && playersCardLobby.id === roomId && playersCardAnchor && playersCardAnchor.isConnected) {
            fillPlayersCard(playersCard, playersCardLobby, PLAYER_COUNTS[roomId]);
            positionPlayersCard();
        }
    }

    // ----------------- load from the live matchmaker -----------------

    // ev.io 1-7-1 moved the lobby list from a static JSON array embedded in bundle.js (which the
    // old regex above scraped) to a runtime matchmaker API — the client itself calls GET
    // {region.httpUrl}/matchmaker/rooms per region and merges the results (confirmed from the
    // bundle's own listAllLobbies()/createLobby()/fetchLobbyById() SDK wrappers). The region URLs
    // themselves are NOT fetched at runtime — zd.SHARED_CONFIG.matchmakerRegions ships as a
    // literal object baked into the bundle at build time (the *.example.com addresses you'd find
    // searching the bundle text are just the dev-mode fallback; this is the real override). Pulled
    // directly from the live bundle and confirmed working with a plain unauthenticated GET
    // (Access-Control-Allow-Origin: * — no CORS issue, unlike the per-lobby /players endpoint
    // below). If ev.io migrates hosts again this list is the first thing to re-check.
    const MATCHMAKER_REGIONS = [
        { id: 'atl', name: 'NA East', httpUrl: 'https://ev-game-na.159.65.175.174.sslip.io' },
        { id: 'fra', name: 'Europe', httpUrl: 'https://ev-game-eu.139.59.151.96.sslip.io' },
        { id: 'sin', name: 'Asia', httpUrl: 'https://ev-game-asia.188.166.184.152.sslip.io' },
    ];

    // Same /ping endpoint the official client itself pings for latency-based region selection
    // (confirmed from fetchRegionRecommendation() in the live bundle — it pings twice per region,
    // the first as a TLS/TCP warm-up it discards, timing only the second). One measured ping per
    // region is plenty for a display badge here; we're not picking a region automatically, just
    // showing the number, so the warm-up round trip isn't worth the extra requests. 4s timeout
    // per region — these are tiny unauthenticated GETs (Access-Control-Allow-Origin: *), the same
    // kind of call the game itself already makes on every cold matchmaking attempt.
    async function refreshRegionLatency() {
        await Promise.allSettled(
            MATCHMAKER_REGIONS.map(async (region) => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 4000);
                try {
                    const start = performance.now();
                    const resp = await fetch(`${region.httpUrl}/ping`, { cache: 'no-store', signal: controller.signal });
                    if (!resp.ok) throw new Error('ping failed');
                    await resp.text();
                    REGION_LATENCY[region.id] = Math.round(performance.now() - start);
                } catch (e) {
                    REGION_LATENCY[region.id] = null;
                } finally {
                    clearTimeout(timer);
                }
            })
        );
        renderLobbyList();
    }

    async function loadLobbiesFromBundle() {
        if (lobbiesLoaded || lobbiesLoading) return;
        lobbiesLoading = true;

        try {
            const results = await Promise.allSettled(
                MATCHMAKER_REGIONS.map((region) =>
                    fetch(`${region.httpUrl}/matchmaker/rooms`).then((r) => r.json())
                )
            );

            const data = [];
            let anyOk = false;
            results.forEach((res) => {
                if (res.status === 'fulfilled' && Array.isArray(res.value)) {
                    anyOk = true;
                    data.push(...res.value);
                } else if (res.status === 'rejected') {
                    console.warn('[ev-lobbies] A matchmaker region failed to load:', res.reason);
                }
            });

            if (!anyOk) {
                console.warn('[ev-lobbies] Could not reach any matchmaker region');
                setStatus('Could not load lobby list (matchmaker unreachable).');
                return;
            }

            setStatus(data.length ? '' : 'No public lobbies right now.');

            LOBBIES = data;
            lobbiesLoaded = true;
            lobbiesLoadedAt = Date.now();
            console.log('[ev-lobbies] Loaded lobbies:', LOBBIES);
            renderLobbyList();
            refreshPlayerCounts();
        } catch (err) {
            console.error('[ev-lobbies] Error loading lobbies from matchmaker:', err);
            setStatus('Error loading lobby list.');
        } finally {
            lobbiesLoading = false;
        }
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

        // The native "Private" button is left COMPLETELY untouched now — ev.io's own private-game
        // menu is back (confirmed real: 1-7-1 ships the "Private Game" panel again), so clicking
        // the button directly still does exactly what it always did. We only ADD a hover dropdown
        // around it — same Bootstrap dropdown/dropdown-toggle/dropdown-menu markup the site's own
        // PROFILE/Store/Social/Crypto top-bar menus already use (see evio.html) — offering an
        // explicit choice between that native flow and our own self-hosted lobby.
        if (privBtn && !privBtn.dataset.evioRewired) {
            privBtn.dataset.evioRewired = '1';

            const privWrapper = document.createElement('div');
            privWrapper.id = 'ev-priv-dropdown-wrapper';
            privWrapper.className = 'dropdown';

            privBtn.parentNode.insertBefore(privWrapper, privBtn);
            privWrapper.appendChild(privBtn);

            const caret = document.createElement('span');
            caret.className = 'caret';
            privBtn.appendChild(caret);

            const menu = document.createElement('ul');
            menu.className = 'dropdown-menu';

            // "Official" just re-fires a real click on the untouched button — the site's own
            // handler runs exactly as if this dropdown never existed. Not a duplicate of the
            // button's own click (the button itself keeps working too, e.g. for anyone who
            // clicks straight through without hovering) — this is the explicit, same-outcome
            // choice the hover menu offers.
            const officialItem = document.createElement('li');
            const officialLink = document.createElement('a');
            officialLink.href = '#';
            officialLink.textContent = 'Official';
            officialLink.addEventListener('click', (e) => {
                e.preventDefault();
                privBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            officialItem.appendChild(officialLink);

            const customItem = document.createElement('li');
            const customLink = document.createElement('a');
            customLink.href = '#';
            customLink.textContent = 'Custom';
            customLink.addEventListener('click', (e) => {
                e.preventDefault();
                openHostingMenu();
            });
            customItem.appendChild(customLink);

            menu.appendChild(officialItem);
            menu.appendChild(customItem);
            privWrapper.appendChild(menu);
        }

        return true;
    }

    // Shared by both entry points (LOBBIES button and the repurposed Private button) so the
    // panel/data loading logic lives in exactly one place.
    function openLobbyBrowser() {
        showLobbyModule();
        refreshRegionLatency(); // cheap (3 tiny GETs), refresh every open rather than caching
        // Rooms open and close every few minutes, so a list older than the count TTL is
        // fetched again (which re-probes); otherwise just refresh any stale counts.
        if (lobbiesLoaded && !lobbiesLoading && Date.now() - lobbiesLoadedAt > PROBE_TTL_MS) {
            lobbiesLoaded = false;
        }
        if (!lobbiesLoaded && !lobbiesLoading) {
            if (!LOBBIES || !LOBBIES.length) setStatus('Loading lobbies…');
            loadLobbiesFromBundle();
        } else {
            renderLobbyList();
            refreshPlayerCounts();
        }
    }

    function openHostingMenu() {
        if (customLobbiesOff()) { showSafeModeNotice(true); return; }
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
