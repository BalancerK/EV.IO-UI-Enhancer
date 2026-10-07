  // Ported from admin_server.js (the Node custom server's own dashboard) — same HTML/CSS/JS,
  // unchanged below this point. The ONLY thing replaced is how a "request" actually travels:
  // the Node version talks to a real HTTP server (and needs the token/429 plumbing this used to
  // do, since that port is reachable over the network); this page is itself a privileged
  // extension page with its own chrome.runtime access, so every one of the dashboard's existing
  // fetch('/api/...') calls below is intercepted here and routed through
  // chrome.runtime.sendMessage to background.js instead — same path, method and body shape,
  // just a different transport. No token needed: nothing outside this browser's own extension
  // context can reach chrome.runtime.sendMessage for this extension's id at all.
  (function () {
    window.fetch = function (input, init) {
      init = init || {};
      var path = typeof input === 'string' ? input : (input && input.url) || '';
      var method = (init.method || 'GET').toUpperCase();
      var body = null;
      if (init.body) { try { body = JSON.parse(init.body); } catch (e) { body = init.body; } }
      return chrome.runtime.sendMessage({ type: 'admin', path: path, method: method, body: body })
        .then(function (resp) {
          if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
          var status = (resp && resp.status) || (resp && resp.ok === false ? 400 : 200);
          // handleAdminRequest() wraps the real payload as {ok, status, body} — unwrap it here so
          // this still looks exactly like a real fetch Response to every caller below: r.json()
          // resolves to the actual status/settings/etc. object, same as it did against the real
          // HTTP server (the Node admin_server.js's json(res, code, body) sent `body` as the
          // whole response, not wrapped — this shim's job is to put it back in that shape).
          return {
            ok: status >= 200 && status < 300,
            status: status,
            json: function () { return Promise.resolve(resp && resp.body); },
          };
        });
    };
  })();

(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var settingsCache = [];
  var openCats = {};

  function toast(msg, isErr) {
    var d = document.createElement('div');
    if (isErr) d.className = 'err';
    d.textContent = msg;
    $('toast').appendChild(d);
    setTimeout(function () { d.remove(); }, isErr ? 6000 : 2600);
  }

  function fmtUptime(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + (s % 60) + 's';
    return s + 's';
  }

  // ── Status polling ──────────────────────────────────────────────────────
  // ── Sparklines ─────────────────────────────────────────────────────────────
  // Drawn on a canvas with no library: the page ships with a strict CSP that forbids loading
  // anything external, and a chart dependency would be far more code than the 30 lines below.
  var SERIES = {
    rate:    { fmt: function (v) { return v.toFixed(1) + ' Hz'; }, el: 'cvRate',
               // The known failure here is the tick loop sagging to ~16Hz on Windows timer
               // granularity, so judge against the TARGET rather than a fixed number.
               grade: function (v, st) { var t = st.targetTickRate || 20;
                 return v < t * 0.9 ? 'bad' : v < t * 0.98 ? 'warn' : ''; } },
    jitter:  { fmt: function (v) { return v.toFixed(0) + ' ms'; }, el: 'cvJitter',
               grade: function (v) { return v > 25 ? 'bad' : v > 10 ? 'warn' : ''; } },
    players: { fmt: function (v) { return String(v); }, el: 'cvPlayers', grade: function () { return ''; } },
    lag:     { fmt: function (v) { return v + ' ticks'; }, el: 'cvLag',
               // Beyond ~3 ticks the client is predicting well past what we have confirmed.
               grade: function (v) { return v > 6 ? 'bad' : v > 3 ? 'warn' : ''; } },
    queued:  { fmt: function (v) { return String(v); }, el: 'cvQueued',
               grade: function (v) { return v > 4 ? 'bad' : v > 2 ? 'warn' : ''; } },
    errs:    { fmt: function (v) { return String(v); }, el: 'cvErrs',
               grade: function (v) { return v > 0 ? 'bad' : ''; } },
  };

  function drawSpark(canvas, values, cls) {
    // Backing-store sizing. The CSS height is the source of truth and is read ONCE into a data
    // attribute; never read it back off canvas.height, because that property already holds the
    // DPR-scaled value. Doing so multiplies by DPR on every render — on a 125%-scaled Windows
    // display the canvas grew 46 -> 57 -> 72 -> ... and blew past the ~32767px limit in about
    // fifteen seconds, at which point the draw threw, poll()'s .catch fired, and the dashboard
    // showed "offline" and stopped updating. On a 1.0-DPR screen it was invisible.
    var dpr = window.devicePixelRatio || 1;
    if (!canvas._cssH) canvas._cssH = canvas.height || 46;
    var w = Math.max(1, canvas.clientWidth || 160), h = canvas._cssH;
    canvas.style.height = h + 'px';
    var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!values.length) return;
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    // A flat series should read as flat, not as noise amplified to fill the box.
    if (max - min < 1e-9) { min -= 1; max += 1; }
    var pad = 3, iw = w - pad * 2, ih = h - pad * 2;
    var x = function (i) { return pad + (values.length === 1 ? iw / 2 : (i / (values.length - 1)) * iw); };
    var y = function (v) { return pad + ih - ((v - min) / (max - min)) * ih; };
    var stroke = cls === 'bad' ? '#f85149' : cls === 'warn' ? '#d29922' : '#3fb950';
    ctx.beginPath(); ctx.moveTo(x(0), y(values[0]));
    for (var i = 1; i < values.length; i++) ctx.lineTo(x(i), y(values[i]));
    ctx.lineTo(x(values.length - 1), pad + ih); ctx.lineTo(x(0), pad + ih); ctx.closePath();
    ctx.fillStyle = stroke + '22'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(x(0), y(values[0]));
    for (var j = 1; j < values.length; j++) ctx.lineTo(x(j), y(values[j]));
    ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
  }

  function renderTelemetry(st) {
    var hist = st.history || [];
    var range = $('telemetryRange');
    if (range) range.textContent = hist.length ? '· last ' + hist.length + 's' : '· collecting…';
    var note = $('telemetryNote');
    if (note) {
      note.textContent = hist.length < 5
        ? 'Graphs fill in at 1 sample/second once the game loop is running (it idles with no players).'
        : '';
    }
    Object.keys(SERIES).forEach(function (k) {
      var cfg = SERIES[k];
      var canvas = document.querySelector('canvas[data-k="' + k + '"]');
      if (!canvas) return;
      var vals = hist.map(function (h) { return Number(h[k]) || 0; });
      var last = vals.length ? vals[vals.length - 1] : 0;
      var cls = cfg.grade(last, st);
      drawSpark(canvas, vals, cls);
      var lab = $(cfg.el);
      if (lab) lab.textContent = vals.length ? cfg.fmt(last) : '–';
      var box = canvas.parentElement;
      if (box) { box.classList.remove('warn', 'bad'); if (cls) box.classList.add(cls); }
    });
  }

  function renderStatus(st) {
    renderTelemetry(st);
    $('conn').innerHTML = '<span class="dot up"></span>online';
    $('tick').textContent = st.globalTick;
    $('rate').textContent = st.tickRate.toFixed(1);
    $('rateTarget').textContent = st.targetTickRate;
    // Colour the tick rate by health. It is the single best indicator of overload: it holds a flat
    // 20.00 right up to saturation and then falls off a cliff, and a slow tick desyncs everyone.
    // Overruns climb BEFORE the rate visibly drops, so they are the earlier warning of the two.
    (function () {
      var el = $('rate');
      var over = st.tickOverruns || 0;
      var behind = st.targetTickRate ? (st.tickRate / st.targetTickRate) : 1;
      var bad = st.tickRate > 0 && behind < 0.95;
      var warn = !bad && over > (el.__lastOver || 0);
      el.__lastOver = over;
      el.style.color = bad ? 'var(--bad)' : (warn ? 'var(--warn)' : '');
      el.title = 'last tick ' + (st.tickMsLast || 0) + 'ms / budget ' + (st.tickBudgetMs || 50)
        + 'ms · worst ' + (st.tickMsWorst || 0) + 'ms · overruns ' + over
        + (bad ? ' — OVERLOADED: the tick rate has dropped, players will desync' : '');
    })();
    $('pcount').textContent = st.playerCount;
    $('uptime').textContent = fmtUptime(st.uptimeMs);
    $('wsUrl').textContent = st.listening || '';
    $('mapPill').textContent = st.map || '–';
    $('roundPill').textContent = st.round + ' · ' + st.roundPhase + ' · ' + st.roundSecondsLeft + 's';
    $('modePill').textContent = (st.swordOnly ? 'sword-only' : 'all weapons')
      + ' · ' + st.tickModel + ' · echo ' + st.echoLagTicks;

    // ── Netcode health ────────────────────────────────────────────────────
    // Three faults here were each invisible for weeks, so surface them permanently rather than
    // relying on someone thinking to look:
    //   tick/sim errors — a throwing tick used to kill the whole game loop silently.
    //   echo lag > 0    — moves the echo LABEL without moving the state BODY, so the client
    //                     compares its prediction against the wrong tick and corrects every tick
    //                     while rotating. Depth is the correct knob; this one should stay 0.
    //   input loss      — look = received vs queued, appl = queued vs applied.
    var net = [], bad = false;
    if (st.tickErrors) { net.push(st.tickErrors + ' tick err'); bad = true; }
    if (st.simErrors)  { net.push(st.simErrors + ' sim err');  bad = true; }
    if (st.echoLagTicks > 0) { net.push('echo lag ' + st.echoLagTicks + '!'); bad = true; }
    var worstLook = null;
    st.players.forEach(function (p) {
      if (p.lookKept != null && (worstLook === null || p.lookKept < worstLook)) worstLook = p.lookKept;
      if (p.lookApplied != null && (worstLook === null || p.lookApplied < worstLook)) worstLook = p.lookApplied;
    });
    if (worstLook !== null && worstLook < 0.99) { net.push('input ' + worstLook.toFixed(2)); bad = true; }
    var np = $('netPill');
    np.textContent = 'net ' + (net.length ? net.join(' · ') : 'ok');
    np.style.color = bad ? '#ff5f56' : '';
    np.title = bad
      ? 'Something is wrong: ' + net.join(', ')
      : 'No tick/sim faults, echo label matches the state body, and all client input reaches the sim';

    var tb = document.querySelector('#players tbody');
    $('noPlayers').style.display = st.players.length ? 'none' : 'block';
    tb.innerHTML = '';
    st.players.forEach(function (p) {
      var tr = document.createElement('tr');
      function td(txt, cls) {
        var e = document.createElement('td');
        if (cls) e.className = cls;
        e.textContent = txt;
        return e;
      }
      var nameTd = td(p.name || '—');
      if (p.isBot) {
        var botBadge = document.createElement('span');
        botBadge.className = 'badge';
        botBadge.textContent = 'BOT';
        botBadge.title = 'Server-driven bot (see the Bots setting category for count/level)';
        botBadge.style.marginLeft = '6px';
        nameTd.appendChild(botBadge);
      }
      tr.appendChild(nameTd);
      tr.appendChild(td(p.playerId == null ? '—' : p.playerId, 'num'));
      var stateTd = document.createElement('td');
      var tag = document.createElement('span');
      tag.className = 'tag ' + (p.dead ? 'dead' : 'alive');
      tag.textContent = p.dead ? 'dead' : (p.grounded ? (p.sprinting ? 'sprint' : (p.crouching ? 'crouch' : 'ground')) : 'air');
      stateTd.appendChild(tag);
      tr.appendChild(stateTd);
      tr.appendChild(td(p.health == null ? '—' : Math.round(p.health * 100), 'num'));
      tr.appendChild(td(p.position ? p.position.x.toFixed(1) : '—', 'num'));
      tr.appendChild(td(p.position ? p.position.y.toFixed(1) : '—', 'num'));
      tr.appendChild(td(p.position ? p.position.z.toFixed(1) : '—', 'num'));
      tr.appendChild(td(p.speed == null ? '—' : p.speed.toFixed(1), 'num'));
      tr.appendChild(td(p.weapon == null ? '—' : p.weapon, 'num'));
      tr.appendChild(td(p.ammo == null ? '—' : p.ammo, 'num'));
      tr.appendChild(td(p.actionTickCounter == null ? '—' : p.actionTickCounter, 'num'));
      tr.appendChild(td(p.lastClientTick == null ? '—' : p.lastClientTick, 'num'));
      tr.appendChild(td(p.processedClientTick == null ? '—' : p.processedClientTick, 'num'));
      tr.appendChild(td(p.queuedInputs == null ? '—' : p.queuedInputs, 'num'));
      // err: this player's sim threw and was contained. Non-zero explains a desync that hits one
      // player while everyone else is fine, so make it stand out rather than blend into the row.
      var errTd = td(p.simErrors ? p.simErrors : '—', 'num');
      if (p.simErrors) errTd.style.color = '#ff5f56';
      tr.appendChild(errTd);
      // look: fraction of the client's rotation that actually reached the sim. Below ~0.99 the
      // server turns less far than the client, which reads in-game as stutter while rotating.
      var lk = p.lookKept;
      var lkTd = td(lk == null ? '—' : lk.toFixed(3), 'num');
      if (lk != null && lk < 0.99) lkTd.style.color = '#ff5f56';
      lkTd.title = p.lostBy ? JSON.stringify(p.lostBy) : 'no input discarded';
      tr.appendChild(lkTd);
      // appl: fraction of received rotation that actually reached the simulation. The look
      // column can read 1.0 (nothing discarded on ingest) while this is low — sub-frames that were
      // queued and then never folded.
      var ap = p.lookApplied;
      var apTd = td(ap == null ? '—' : ap.toFixed(3), 'num');
      if (ap != null && ap < 0.99) apTd.style.color = '#ff5f56';
      apTd.title = 'received rotation that reached the sim (queue -> applied)';
      tr.appendChild(apTd);
      var act = document.createElement('td');
      // [action, label, class, arg]
      [['heal', 'heal', '', undefined],
       ['respawn', 'respawn', '', undefined],
       ['slap', 'slap', 'fun', 18],
       ['teleport', 'tp', '', undefined],
       ['kill', 'kill', 'danger', undefined],
       ['kick', 'kick', 'danger', undefined]]
        .forEach(function (a) {
          var b = document.createElement('button');
          b.textContent = a[1];
          if (a[2]) b.className = a[2];
          b.onclick = function () { playerAction(p.sessionId, a[0], a[3]); };
          act.appendChild(b);
        });
      tr.appendChild(act);
      tb.appendChild(tr);
    });
  }

  // Separate the two failure modes. A NETWORK failure means offline; a RENDER failure is a bug in
  // this page and must not be reported as the server being down — that conflation is what made a
  // canvas-sizing bug look like a dropped connection. A render throw is logged once and the poll
  // keeps running, so one bad panel cannot take the whole dashboard with it.
  var renderFailed = false;
  function poll() {
    fetch('/api/status')
      .then(function (r) { return r.json(); })
      .then(function (st) {
        try {
          renderStatus(st);
          renderFailed = false;
        } catch (e) {
          if (!renderFailed) { renderFailed = true; console.error('[admin] render error', e); }
        }
      })
      .catch(function () { $('conn').innerHTML = '<span class="dot down"></span>offline'; });
  }

  function playerAction(sessionId, action, arg) {
    fetch('/api/player', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, action: action, arg: arg })
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r.ok) { toast(action + ' ok'); poll(); }
      else toast(action + ' failed: ' + r.err, true);
    });
  }

  // ── Tabs ────────────────────────────────────────────────────────────────
  // Several sections can share a data-panel name, so a tab can group more than one panel (Controls
  // is three). The choice is remembered per tab so a poll-driven refresh never yanks you back.
  function showTab(name) {
    var panels = document.querySelectorAll('section[data-panel]');
    for (var i = 0; i < panels.length; i++) {
      panels[i].hidden = panels[i].getAttribute('data-panel') !== name;
    }
    var tabs = document.querySelectorAll('nav#tabs button[data-tab]');
    for (var j = 0; j < tabs.length; j++) {
      tabs[j].setAttribute('aria-selected', tabs[j].getAttribute('data-tab') === name ? 'true' : 'false');
    }
    try { sessionStorage.setItem('evio.tab', name); } catch (e) {}
  }
  (function initTabs() {
    var tabs = document.querySelectorAll('nav#tabs button[data-tab]');
    for (var i = 0; i < tabs.length; i++) {
      (function (b) {
        b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
      })(tabs[i]);
    }
    var saved = null;
    try { saved = sessionStorage.getItem('evio.tab'); } catch (e) {}
    showTab(saved || 'overview');

    // Number keys jump between tabs — but never while typing, or the announce box becomes unusable.
    document.addEventListener('keydown', function (ev) {
      var t = ev.target || {};
      var tag = (t.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      var idx = '12345'.indexOf(ev.key);
      if (idx === -1) return;
      var order = ['overview', 'players', 'controls', 'map', 'settings'];
      if (order[idx]) { showTab(order[idx]); ev.preventDefault(); }
    });
  })();

  // ── Server-wide actions ─────────────────────────────────────────────────
  function serverAction(action, arg) {
    return fetch('/api/server', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: action, arg: arg })
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r.ok) {
        var extra = (r.affected !== undefined) ? ' (' + r.affected + ')' : '';
        toast(action + ' ok' + extra); poll();
      } else toast(action + ' failed: ' + r.err, true);
      return r;
    });
  }
  (function initServerButtons() {
    var btns = document.querySelectorAll('button[data-srv]');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          var act = b.getAttribute('data-srv');
          var arg = b.getAttribute('data-arg');
          // The irreversible ones ask first. Everything else is cheap to undo.
          if (act === 'killall' && !confirm('Kill every connected player?')) return;
          serverAction(act, arg === null ? undefined : (isNaN(Number(arg)) ? arg : Number(arg)));
        });
      })(btns[i]);
    }
  })();

  // ── Announcements ───────────────────────────────────────────────────────
  (function initAnnounce() {
    var box = $('announceText'), send = $('announceSend');
    if (!box || !send) return;
    function fire() {
      var msg = box.value.trim();
      if (!msg) { toast('nothing to announce', true); return; }
      serverAction('announce', msg).then(function (r) { if (r.ok) box.value = ''; });
    }
    send.addEventListener('click', fire);
    box.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') fire(); });
    var quick = document.querySelectorAll('#announceQuick button[data-msg]');
    for (var i = 0; i < quick.length; i++) {
      (function (b) {
        b.addEventListener('click', function () { serverAction('announce', b.getAttribute('data-msg')); });
      })(quick[i]);
    }
  })();

  // ── Presets ─────────────────────────────────────────────────────────────
  function loadPresets() {
    fetch('/api/presets').then(function (r) { return r.json(); }).then(function (d) {
      var host = $('presets');
      if (!host) return;
      host.textContent = '';
      (d.presets || []).forEach(function (p) {
        var b = document.createElement('button');
        b.className = 'preset';
        // textContent throughout — preset text is ours, but building DOM by string concatenation is
        // how an injection bug eventually arrives.
        var t = document.createElement('span'); t.className = 'pTitle';
        t.textContent = (p.emoji ? p.emoji + '  ' : '') + p.label;
        var d2 = document.createElement('span'); d2.className = 'pDesc';
        d2.textContent = p.desc + ' (' + p.keys + ' settings)';
        b.appendChild(t); b.appendChild(d2);
        b.addEventListener('click', function () {
          fetch('/api/preset', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preset: p.id })
          }).then(function (r) { return r.json(); }).then(function (r) {
            if (r.ok) {
              toast(r.label + ' applied (' + r.applied.length + ' settings)');
              loadSettings();
            } else toast('preset failed: ' + r.err, true);
          });
        });
        host.appendChild(b);
      });
    }).catch(function () { /* dashboard still works without presets */ });
  }

  // ── Settings ────────────────────────────────────────────────────────────
  function loadSettings() {
    var fi = $('settingFilter'), co = $('changedOnly');
    if (fi && !fi._wired) { fi._wired = 1; fi.addEventListener('input', renderSettings); }
    if (co && !co._wired) { co._wired = 1; co.addEventListener('change', renderSettings); }
    fetch('/api/settings').then(function (r) { return r.json(); }).then(function (d) {
      settingsCache = d.settings;
      renderSettings();
    });
  }

  function commit(key, value, el) {
    fetch('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: key, value: value })
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (!r.ok) { toast(key + ': ' + r.err, true); loadSettings(); return; }
      toast(key + ' = ' + r.value + (r.restartRequired ? ' (restart required)' : ''));
      if (el) { el.closest('.setting').classList.add('changed'); }
      // Refresh so derived settings (crouch speed, sprint thresholds) show their new values.
      loadSettings();
    });
  }

  function resetSetting(key) {
    fetch('/api/settings/reset', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: key })
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r.ok) { toast(key + ' reset to ' + r.value); loadSettings(); }
      else toast(key + ': ' + r.err, true);
    });
  }

  // A setting counts as "changed" when its live value differs from the value it would have had
  // from env/default — that is what the registry's 'explicit' flag tracks, and it is the single
  // most useful thing to know at a glance when a server is misbehaving. NOTE: this text lives
  // inside the PAGE template literal, so it must never contain a backtick.
  // see at a glance when a server is behaving oddly.
  function isChanged(s) {
    if (s.explicit) return true;
    return s.default !== undefined && s.default !== null && String(s.value) !== String(s.default);
  }
  function settingMatches(s, q) {
    if (!q) return true;
    var hay = (s.label + ' ' + s.key + ' ' + (s.env || '') + ' ' + (s.desc || '') + ' ' + s.category).toLowerCase();
    // AND across terms so "combat zoom" narrows instead of widening.
    return q.split(/\s+/).every(function (t) { return hay.indexOf(t) !== -1; });
  }

  function renderSettings() {
    var q = (($('settingFilter') || {}).value || '').trim().toLowerCase();
    var onlyChanged = !!(($('changedOnly') || {}).checked);
    var visible = settingsCache.filter(function (s) {
      return settingMatches(s, q) && (!onlyChanged || isChanged(s));
    });
    var cnt = $('settingCount');
    if (cnt) {
      cnt.textContent = (q || onlyChanged)
        ? visible.length + ' / ' + settingsCache.length
        : settingsCache.length + ' settings';
    }
    var byCat = {};
    visible.forEach(function (s) { (byCat[s.category] = byCat[s.category] || []).push(s); });
    var order = ['Gameplay', 'Combat', 'Bots', 'Movement', 'Netcode', 'Grenades', 'Feedback', 'Protocol', 'Server', 'Debug'];
    var cats = Object.keys(byCat).sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    var root = $('settings');
    root.innerHTML = '';
    cats.forEach(function (cat) {
      var det = document.createElement('details');
      det.className = 'cat';
      if (openCats[cat] === undefined) openCats[cat] = (cat === 'Gameplay' || cat === 'Combat' || cat === 'Bots');
      // While a filter is active every surviving category is opened — otherwise a match can sit
      // hidden inside a collapsed group and the search looks broken.
      det.open = (q || onlyChanged) ? true : openCats[cat];
      det.addEventListener('toggle', function () { openCats[cat] = det.open; });
      var sum = document.createElement('summary');
      sum.innerHTML = '<span>' + cat + '</span><span class="count">' + byCat[cat].length + '</span>';
      det.appendChild(sum);
      byCat[cat].forEach(function (s) { det.appendChild(settingRow(s)); });
      root.appendChild(det);
    });
  }

  function settingRow(s) {
    var row = document.createElement('div');
    row.className = 'setting' + (isChanged(s) ? ' changed' : '');

    var left = document.createElement('div');
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.label;
    if (!s.live) {
      var b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'restart';
      b.title = 'Changing this only takes effect when the server restarts';
      name.appendChild(document.createTextNode(' '));
      name.appendChild(b);
    }
    // INERT: declared and persisted, but consumed by nothing that runs. Marked loudly, because a
    // knob that silently does nothing makes an operator conclude the GAME is broken rather than the
    // setting. Kept in the list (not hidden) so a documented EVIO_* var is still discoverable.
    if (s.inert) {
      var bi = document.createElement('span');
      bi.className = 'badge inert';
      bi.textContent = 'no effect';
      bi.title = 'This setting does nothing: ' + s.inert;
      name.appendChild(document.createTextNode(' '));
      name.appendChild(bi);
      row.className += ' inertRow';
    }
    if (s.explicit) {
      var b2 = document.createElement('span');
      b2.className = 'badge set';
      b2.textContent = 'set';
      b2.title = 'Explicitly set (env or here) rather than the default';
      name.appendChild(document.createTextNode(' '));
      name.appendChild(b2);
    }
    left.appendChild(name);
    if (s.env) {
      var env = document.createElement('div');
      env.className = 'env';
      env.textContent = s.env;
      left.appendChild(env);
    }
    row.appendChild(left);

    var ctl = document.createElement('div');
    ctl.className = 'ctl';
    var input;
    if (s.type === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!s.value;
      input.onchange = function () { commit(s.key, input.checked, input); };
    } else if (s.type === 'enum') {
      input = document.createElement('select');
      s.choices.forEach(function (c) {
        var o = document.createElement('option');
        o.value = c; o.textContent = c;
        if (c === s.value) o.selected = true;
        input.appendChild(o);
      });
      input.onchange = function () { commit(s.key, input.value, input); };
    } else if (s.type === 'string') {
      input = document.createElement('input');
      input.type = 'text';
      input.value = s.value;
      input.onchange = function () { commit(s.key, input.value, input); };
    } else {
      input = document.createElement('input');
      input.type = 'number';
      input.value = s.value;
      if (s.min !== null) input.min = s.min;
      if (s.max !== null) input.max = s.max;
      if (s.step !== null) input.step = s.step;
      else if (s.type === 'int') input.step = 1;
      input.onchange = function () { commit(s.key, input.value, input); };
    }
    ctl.appendChild(input);

    var rst = document.createElement('button');
    rst.textContent = '↺';
    rst.title = 'Reset to default (' + s['default'] + ')';
    rst.onclick = function () { resetSetting(s.key); };
    ctl.appendChild(rst);
    row.appendChild(ctl);

    if (s.desc) {
      var d = document.createElement('div');
      d.className = 'desc';
      d.textContent = s.desc;
      row.appendChild(d);
    }
    return row;
  }

  // ── Maps ────────────────────────────────────────────────────────────────
  function loadMaps() {
    fetch('/api/maps').then(function (r) { return r.json(); }).then(function (d) {
      var sel = $('mapSelect');
      var keep = sel.value;
      sel.innerHTML = '';
      d.maps.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.nid;
        // A filled dot marks maps already on disk — those switch instantly.
        o.textContent = (m.cached ? '● ' : '○ ') + m.title;
        sel.appendChild(o);
      });
      if (keep) sel.value = keep;
      $('mapActive').textContent = d.active ? 'active: ' + d.active : '';
    });
  }
  $('mapLoad').onclick = function () {
    var sel = $('mapSelect');
    var title = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent.slice(2) : '';
    $('mapStatus').textContent = 'loading ' + title + ' (first use downloads ~2-10 MB)...';
    $('mapLoad').disabled = true;
    fetch('/api/map', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ map: sel.value })
    }).then(function (r) { return r.json(); }).then(function (r) {
      $('mapLoad').disabled = false;
      if (!r.ok) { $('mapStatus').textContent = 'failed: ' + r.err; toast('map load failed: ' + r.err, true); return; }
      $('mapStatus').textContent = r.map + ' loaded — ' + r.tris + ' triangles, ' + r.spawns
        + ' spawns, ' + (r.fromCache ? 'from cache' : 'downloaded') + ' (generation ' + r.generation + ')';
      toast('map -> ' + r.map);
      loadMaps();
    }).catch(function (e) {
      $('mapLoad').disabled = false;
      $('mapStatus').textContent = 'failed: ' + e.message;
    });
  };
  loadMaps();

  $('refreshSettings').onclick = loadSettings;
  loadSettings();
  loadPresets();
  poll();
  setInterval(poll, 500);
})();
