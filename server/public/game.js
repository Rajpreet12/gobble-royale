// Gobble Royale - the browser side.
// The server decides where everyone is. This page draws it smoothly: other turkeys are shown
// slightly in the past and blended between snapshots, and your own turkey moves the moment you
// press a key (then is nudged toward where the server says it really is).

(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $("field");
  const g = canvas.getContext("2d");

  // Must match the server (src/game.mjs)
  const TURKEY_R = 16, TURKEY_SPEED = 230, DASH_SPEED = 600, DASH_TIME = 0.2, DASH_COOLDOWN = 2.5, CHEF_R = 22;
  let W = 1600, H = 1000;
  const RING_FULL = Math.hypot(1600, 1000) / 2;
  const INTERP_DELAY = 110; // ms behind the newest snapshot, so there's always two to blend between

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: nothing remembered */ } },
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let config = null;
  let ws = null;
  let myId = null;
  let obstacles = [];
  let meta = new Map(); // id -> { name, state, hue, bot }
  const snaps = [];
  let phase = "lobby";
  let lastResult = null;
  const facing = new Map(); // id -> { x, dir }
  const particles = [];
  const me = { x: 0, y: 0, alive: false, dash: 0, cd: 0, srvX: 0, srvY: 0 };
  const input = { x: 0, y: 0, dashQueued: false };

  // ---------- Joining ----------

  let profile = store.get("profile") ?? {};

  function rollName() {
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    profile.name = `${pick(config.adjectives)} ${pick(config.nouns)}`;
    $("name").textContent = profile.name;
    store.set("profile", profile);
  }

  async function boot() {
    try {
      config = await (await fetch("/api/config")).json();
    } catch {
      $("join-err").textContent = "Can't reach the farm right now. Refresh in a moment.";
      return;
    }
    const [adj, noun] = String(profile.name ?? "").split(" ");
    if (config.adjectives.includes(adj) && config.nouns.includes(noun)) $("name").textContent = profile.name;
    else rollName();
    if (!config.states.some(([code]) => code === profile.state)) profile.state = null;
    showState();
    renderStates("");
    loadBoard();
    setInterval(loadBoard, 15000);
  }

  $("reroll").addEventListener("click", () => { rollName(); gobble(); });

  // ---------- The state picker ----------

  function showState() {
    $("state-name").textContent = profile.state ? stateName(profile.state) : "Pick your state...";
  }

  function openStates(open) {
    $("state-panel").hidden = !open;
    $("state-btn").setAttribute("aria-expanded", String(open));
    if (open) {
      $("state-search").value = "";
      renderStates("");
      // On phones, focusing the search box would pop the keyboard over the list, so only focus it with a mouse.
      if (matchMedia("(pointer: fine)").matches) $("state-search").focus();
      $("state-list").querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
    }
  }

  function renderStates(query) {
    const q = query.trim().toLowerCase();
    const list = $("state-list");
    list.replaceChildren();
    const matches = config.states.filter(([code, name]) => !q || name.toLowerCase().includes(q) || code.toLowerCase() === q);
    for (const [code, name] of matches) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(code === profile.state));
      b.textContent = name;
      b.addEventListener("click", () => pickState(code));
      list.appendChild(b);
    }
    if (!matches.length) {
      const p = document.createElement("div");
      p.className = "none";
      p.textContent = "No state by that name. Try \"Outside the US\".";
      list.appendChild(p);
    }
  }

  function pickState(code) {
    profile.state = code;
    store.set("profile", profile);
    showState();
    openStates(false);
    $("join-err").textContent = "";
    $("play").focus();
  }

  $("state-btn").addEventListener("click", () => openStates($("state-panel").hidden));
  $("state-search").addEventListener("input", (e) => renderStates(e.target.value));
  // Enter picks the first match, so "tex" + Enter is all it takes.
  $("state-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("state-list").querySelector("button")?.click(); }
    if (e.key === "Escape") { openStates(false); $("state-btn").focus(); }
  });

  $("play").addEventListener("click", () => {
    if (!profile.state) {
      $("join-err").textContent = "Pick a state to play for. 🇺🇸";
      return openStates(true);
    }
    unlockAudio();
    connect();
  });

  function connect() {
    $("play").disabled = true;
    $("join-err").textContent = "";
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/play`);
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello", name: profile.name, state: profile.state }));
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = (e) => {
      $("play").disabled = false;
      myId = null;
      me.alive = false;
      $("dash").hidden = true;
      $("watching").hidden = true;
      $("ping-wrap").hidden = true;
      $("join").hidden = false;
      $("join-err").textContent = e.reason || (e.code === 1006 ? "Lost the connection to the farm. Try again." : "");
    };
  }

  // ---------- Messages from the server ----------

  function handle(msg) {
    switch (msg.t) {
      case "you":
        myId = msg.id;
        W = msg.w; H = msg.h;
        obstacles = msg.obstacles;
        $("join").hidden = true;
        $("dash").hidden = false;
        break;
      case "meta":
        meta = new Map(msg.m.map(([id, name, state, hue, bot]) => [id, { name, state, hue, bot: !!bot }]));
        break;
      case "round":
        obstacles = msg.obstacles;
        particles.length = 0;
        $("feed").replaceChildren();
        $("result").hidden = true;
        banner("RUN!", `${msg.n} turkeys. One Chef. Good luck.`, 1600);
        ding();
        break;
      case "s":
        onSnapshot(msg);
        break;
      case "ping": // the server times the round trip itself; we just answer straight away
        ws.send(JSON.stringify({ t: "pong", n: msg.n }));
        break;
      case "rtt":
        $("ping").textContent = msg.ms;
        $("ping-wrap").hidden = false;
        $("ping-wrap").title = msg.ms < 100 ? "Great connection" : msg.ms < 250 ? "OK connection" : "Slow connection: expect some lag";
        break;
      case "out":
        onOut(msg);
        break;
      case "result":
        showResult(msg);
        break;
      case "over": {
        const names = msg.winners.map((id) => meta.get(id)?.name).filter(Boolean);
        const title = names.length === 0 ? "The Chef wins!" : names.length === 1 ? `${names[0]} wins!` : "Survivors!";
        const sub = names.length === 0 ? "Nobody escaped the kitchen." : names.length === 1 ? `For ${stateName(meta.get(msg.winners[0])?.state)}` : names.join(" · ");
        banner(title, sub, 3000);
        setTimeout(loadBoard, 800);
        break;
      }
    }
  }

  function onSnapshot(s) {
    const entry = { at: performance.now(), ph: s.ph, k: s.k, r: s.r, c: s.c, p: new Map(s.p.map(([id, x, y, f, cd]) => [id, { x, y, f, cd }])) };
    snaps.push(entry);
    while (snaps.length > 30) snaps.shift();
    phase = s.ph;

    const mine = entry.p.get(myId);
    if (mine) {
      // Respawned, or knocked far off course: jump straight there.
      if (!me.alive || Math.hypot(mine.x - me.x, mine.y - me.y) > 150) { me.x = mine.x; me.y = mine.y; }
      me.srvX = mine.x; me.srvY = mine.y;
      me.alive = true;
      if (mine.cd / 10 > me.cd + 0.3) me.cd = mine.cd / 10;
    } else {
      me.alive = false;
    }
    $("watching").hidden = !myId || me.alive || phase !== "play";
    updateStatus(entry);
  }

  function onOut(msg) {
    const info = meta.get(msg.id);
    burst(msg.x, msg.y, info?.hue ?? 30);
    const line = document.createElement("div");
    const how = msg.by === "oven" ? "got roasted by the oven 🔥" : "got stuffed by the Chef 👨‍🍳";
    line.textContent = `${msg.name} ${how}`;
    if (msg.id === myId) line.className = "mine";
    const feed = $("feed");
    feed.prepend(line);
    while (feed.children.length > 4) feed.lastChild.remove();
    if (msg.id === myId) { sadHorn(); if (navigator.vibrate) navigator.vibrate([90, 50, 160]); }
    else poof();
  }

  function updateStatus(s) {
    const alive = s.p.size;
    const humans = [...meta.values()].filter((m) => !m.bot).length;
    const mm = Math.floor(s.k / 60), ss = String(s.k % 60).padStart(2, "0");
    $("status").textContent =
      s.ph === "lobby" ? `⏳ Round starts in ${s.k} · ${humans} turkey${humans === 1 ? "" : "s"} here`
      : s.ph === "play" ? `🦃 ${alive} left · ⏱ ${mm}:${ss}`
      : "🏁 Round over. Next one soon...";
    if (s.ph === "lobby" && s.k <= 3 && s.k > 0 && s.k !== updateStatus.lastCount) { tick(); updateStatus.lastCount = s.k; }
    if (s.ph !== "lobby") updateStatus.lastCount = null;
  }

  const stateName = (code) => config?.states.find(([c]) => c === code)?.[1] ?? code;

  // ---------- Banner and result ----------

  let bannerTimer;
  function banner(title, sub, ms) {
    const el = $("banner");
    el.replaceChildren(document.createTextNode(title));
    if (sub) {
      const small = document.createElement("small");
      small.textContent = sub;
      el.appendChild(small);
    }
    el.classList.add("on");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.classList.remove("on"), ms);
  }

  function showResult(r) {
    lastResult = r;
    const card = $("result-card");
    card.classList.toggle("won", r.won);
    card.classList.toggle("lost", !r.won);
    $("result-emoji").textContent = r.won ? "🏆🦃" : r.by === "oven" ? "🔥🍗" : "👨‍🍳🍗";
    $("result-title").textContent = r.won ? (r.shared ? "You survived!" : "Winner winner, no turkey dinner!") : r.by === "oven" ? "Roasted!" : "Stuffed!";
    $("result-line").textContent = r.won
      ? `You outlasted ${r.of - 1} turkeys and won it for ${stateName(profile.state)}.`
      : `You lasted ${r.lasted}s and finished #${r.place} of ${r.of}. You're in the next round.`;
    // Wait for the feathers to settle before covering the field.
    setTimeout(() => { $("result").hidden = false; }, r.won ? 1200 : 900);
    if (r.won) setTimeout(fanfare, 300);
  }

  $("close-result").addEventListener("click", () => { $("result").hidden = true; });
  $("brag").addEventListener("click", async () => {
    const r = lastResult;
    if (!r) return;
    const url = location.origin;
    const text = r.won
      ? `🏆 I just won Gobble Royale for ${stateName(profile.state)}! Outlasted ${r.of - 1} turkeys and the Chef. Can your state beat us? 🦃`
      : `🍗 I lasted ${r.lasted}s in Gobble Royale before the Chef got me. Come play for your state 🦃`;
    try {
      if (navigator.share) return await navigator.share({ title: "Gobble Royale", text, url });
    } catch (err) {
      if (err.name === "AbortError") return;
    }
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(`${text} ${url} #GobbleRoyale`)}`, "_blank", "noopener");
  });

  // ---------- Leaderboard ----------

  async function loadBoard() {
    try {
      const b = await (await fetch("/api/leaderboard")).json();
      $("t-stuffed").textContent = b.stuffed.toLocaleString();
      $("t-rounds").textContent = b.rounds.toLocaleString();
      $("t-online").textContent = $("online").textContent = b.online.toLocaleString();
      const body = $("board");
      body.replaceChildren();
      if (!b.states.length) {
        const tr = document.createElement("tr");
        tr.innerHTML = '<td colspan="4" class="empty">No wins yet. Be the first state on the board.</td>';
        body.appendChild(tr);
        return;
      }
      b.states.forEach((s, i) => {
        const tr = document.createElement("tr");
        if (s.code === profile.state) tr.className = "mine";
        for (const [cls, text] of [["rank", i + 1], ["", stateName(s.code)], ["n", s.wins], ["n", s.plays]]) {
          const td = document.createElement("td");
          if (cls) td.className = cls;
          td.textContent = text;
          tr.appendChild(td);
        }
        body.appendChild(tr);
      });
    } catch { /* the board refreshes again in 15s */ }
  }

  // ---------- Controls ----------

  const keys = new Set();
  const KEYMAP = { ArrowUp: "u", KeyW: "u", ArrowDown: "d", KeyS: "d", ArrowLeft: "l", KeyA: "l", ArrowRight: "r", KeyD: "r" };
  addEventListener("keydown", (e) => {
    if (!myId) return;
    if (KEYMAP[e.code]) { keys.add(KEYMAP[e.code]); e.preventDefault(); }
    if ((e.code === "Space" || e.code === "ShiftLeft") && !e.repeat) { flap(); e.preventDefault(); }
  });
  addEventListener("keyup", (e) => { if (KEYMAP[e.code]) keys.delete(KEYMAP[e.code]); });
  addEventListener("blur", () => keys.clear());

  // Touch: drag anywhere for a joystick. Mouse: hold the button and the turkey runs toward the pointer.
  let stick = null; // { id, ox, oy, x, y } in screen pixels
  let steer = null; // { x, y } in world units
  const toWorld = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (!myId) return;
    canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === "mouse") steer = toWorld(e);
    else stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (stick && e.pointerId === stick.id) { stick.x = e.clientX; stick.y = e.clientY; }
    else if (steer && e.buttons) steer = toWorld(e);
  });
  const release = (e) => {
    if (stick && e.pointerId === stick.id) stick = null;
    if (e.pointerType === "mouse") steer = null;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  $("dash").addEventListener("pointerdown", (e) => { e.preventDefault(); flap(); });

  function flap() {
    if (me.alive && me.cd <= 0) {
      me.dash = DASH_TIME;
      me.cd = DASH_COOLDOWN;
      gobble();
    }
    input.dashQueued = true;
  }

  function readInput() {
    let x = 0, y = 0;
    if (stick) {
      const dx = stick.x - stick.ox, dy = stick.y - stick.oy;
      const d = Math.hypot(dx, dy);
      if (d > 8) { const k = Math.min(1, d / 50); x = (dx / d) * k; y = (dy / d) * k; }
    } else if (steer) {
      const dx = steer.x - me.x, dy = steer.y - me.y;
      const d = Math.hypot(dx, dy);
      if (d > 12) { x = dx / d; y = dy / d; }
    } else {
      x = (keys.has("r") ? 1 : 0) - (keys.has("l") ? 1 : 0);
      y = (keys.has("d") ? 1 : 0) - (keys.has("u") ? 1 : 0);
      const d = Math.hypot(x, y);
      if (d > 1) { x /= d; y /= d; }
    }
    input.x = x;
    input.y = y;
  }

  // 20 times a second, only when something changed (plus a keep-alive).
  let sent = { x: 0, y: 0, at: 0 };
  setInterval(() => {
    if (!myId || ws?.readyState !== 1) return;
    const x = Math.round(input.x * 100) / 100, y = Math.round(input.y * 100) / 100;
    const now = performance.now();
    if (x === sent.x && y === sent.y && !input.dashQueued && now - sent.at < 1000) return;
    ws.send(JSON.stringify(input.dashQueued ? { t: "in", x, y, d: 1 } : { t: "in", x, y }));
    input.dashQueued = false;
    sent = { x, y, at: now };
  }, 50);

  // ---------- Drawing ----------

  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = canvas.clientWidth;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round((w * H / W) * dpr);
  }
  addEventListener("resize", resize);

  // Same rule as the server: stay in the fence, slide around hay bales.
  function collide(e, r) {
    e.x = clamp(e.x, r, W - r);
    e.y = clamp(e.y, r, H - r);
    for (const o of obstacles) {
      const dx = e.x - o.x, dy = e.y - o.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < o.r + r) { e.x = o.x + (dx / d) * (o.r + r); e.y = o.y + (dy / d) * (o.r + r); }
    }
  }

  function predict(dt) {
    me.cd = Math.max(0, me.cd - dt);
    if (!me.alive || phase === "over") return;
    const speed = me.dash > 0 ? DASH_SPEED : TURKEY_SPEED;
    me.dash = Math.max(0, me.dash - dt);
    me.x += input.x * speed * dt;
    me.y += input.y * speed * dt;
    collide(me, TURKEY_R);
    // Drift toward the server's answer so small differences never build up.
    const pull = Math.min(1, dt * 4);
    me.x += (me.srvX - me.x) * pull * 0.5;
    me.y += (me.srvY - me.y) * pull * 0.5;
  }

  // Blend the two snapshots around (now - delay).
  function view(now) {
    if (!snaps.length) return null;
    const t = now - INTERP_DELAY;
    let i = snaps.length - 1;
    while (i > 0 && snaps[i].at > t) i--;
    const a = snaps[i], b = snaps[i + 1];
    if (!b) return { ring: a.r, turkeys: a.p, chefs: a.c };
    const f = clamp((t - a.at) / (b.at - a.at), 0, 1);
    const turkeys = new Map();
    for (const [id, pb] of b.p) {
      const pa = a.p.get(id);
      // Only blend if it's the same life (a respawn jumps far)
      turkeys.set(id, pa && Math.hypot(pb.x - pa.x, pb.y - pa.y) < 120
        ? { x: pa.x + (pb.x - pa.x) * f, y: pa.y + (pb.y - pa.y) * f, f: pb.f }
        : pb);
    }
    const chefs = b.c.map((cb, j) => {
      const ca = a.c[j];
      return ca ? [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f] : cb;
    });
    return { ring: a.r + (b.r - a.r) * f, turkeys, chefs };
  }

  function drawField(ring, now) {
    g.fillStyle = "#8bc34a";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "rgba(255,255,255,.06)";
    for (let x = 0; x < W; x += 200) g.fillRect(x, 0, 100, H);

    // The oven: everything outside the ring glows hot
    if (ring < RING_FULL) {
      g.save();
      g.beginPath();
      g.rect(0, 0, W, H);
      g.arc(W / 2, H / 2, Math.max(0, ring), 0, Math.PI * 2);
      g.fillStyle = `rgba(255, 80, 20, ${0.3 + 0.08 * Math.sin(now / 180)})`;
      g.fill("evenodd");
      g.setLineDash([22, 14]);
      g.lineDashOffset = -now / 30;
      g.lineWidth = 7;
      g.strokeStyle = "#ffb300";
      g.beginPath();
      g.arc(W / 2, H / 2, Math.max(0, ring), 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }

    for (const o of obstacles) {
      g.fillStyle = "rgba(0,0,0,.18)";
      g.beginPath(); g.ellipse(o.x + 6, o.y + 8, o.r, o.r * 0.9, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#e5bd4f";
      g.strokeStyle = "#b5862a";
      g.lineWidth = 4;
      g.beginPath(); g.arc(o.x, o.y, o.r, 0, Math.PI * 2); g.fill(); g.stroke();
      g.lineWidth = 2;
      for (let k = -1; k <= 1; k++) {
        g.beginPath(); g.moveTo(o.x - o.r * 0.7, o.y + k * o.r * 0.4); g.lineTo(o.x + o.r * 0.7, o.y + k * o.r * 0.4); g.stroke();
      }
    }

    g.strokeStyle = "#8d5a2b";
    g.lineWidth = 12;
    g.strokeRect(6, 6, W - 12, H - 12);
  }

  function drawTurkey(id, x, y, flags, isMe, now) {
    const info = meta.get(id) ?? { hue: 30, name: "" };
    const last = facing.get(id) ?? { x, dir: 1 };
    if (Math.abs(x - last.x) > 0.5) last.dir = x > last.x ? 1 : -1;
    last.x = x;
    facing.set(id, last);
    const bob = reduceMotion ? 0 : Math.sin(now / 90 + id) * 1.5;

    if (isMe) {
      g.strokeStyle = "#ffe066";
      g.lineWidth = 4;
      g.beginPath(); g.arc(x, y + 4, 24, 0, Math.PI * 2); g.stroke();
    }
    if (flags & 1) { // flapping: speed lines
      g.strokeStyle = "rgba(255,255,255,.8)";
      g.lineWidth = 3;
      for (let k = -1; k <= 1; k++) {
        g.beginPath(); g.moveTo(x - last.dir * 22, y + k * 8); g.lineTo(x - last.dir * 46, y + k * 8); g.stroke();
      }
    }

    g.save();
    g.translate(x, y + bob);
    g.scale(last.dir, 1);
    const h = info.hue;
    const tail = [`hsl(${h} 70% 42%)`, `hsl(${h + 30} 85% 55%)`, `hsl(${h} 75% 50%)`, `hsl(${h + 30} 85% 55%)`, `hsl(${h} 70% 42%)`];
    tail.forEach((col, k) => {
      g.save();
      g.translate(-6, 6);
      g.rotate((k - 2) * 0.42 - 0.45);
      g.fillStyle = col;
      g.beginPath(); g.ellipse(0, -18, 6.5, 15, 0, 0, Math.PI * 2); g.fill();
      g.restore();
    });
    g.strokeStyle = "#f2a93b"; g.lineWidth = 3;
    g.beginPath(); g.moveTo(-3, 14); g.lineTo(-4, 21); g.moveTo(4, 14); g.lineTo(5, 21); g.stroke();
    g.fillStyle = "#7a4220";
    g.beginPath(); g.arc(0, 4, 13, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#8b5128";
    g.beginPath(); g.arc(10, -8, 6.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#f2a93b";
    g.beginPath(); g.moveTo(15, -9); g.lineTo(21, -7); g.lineTo(15, -5); g.fill();
    g.fillStyle = "#e0435a";
    g.beginPath(); g.ellipse(15, -2, 2.2, 4, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#fff";
    g.beginPath(); g.arc(11, -10, 2.2, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#111";
    g.beginPath(); g.arc(11.6, -10, 1.1, 0, Math.PI * 2); g.fill();
    if (flags & 2) { // too hot
      g.fillStyle = `rgba(255, 40, 0, ${0.35 + 0.25 * Math.sin(now / 60)})`;
      g.beginPath(); g.arc(0, 0, 20, 0, Math.PI * 2); g.fill();
    }
    g.restore();

    g.textAlign = "center";
    g.font = `800 ${isMe ? 15 : 12}px Nunito, sans-serif`;
    g.lineWidth = 4;
    g.strokeStyle = "rgba(0,0,0,.6)";
    const label = isMe ? "YOU" : info.name;
    g.strokeText(label, x, y - 30);
    g.fillStyle = isMe ? "#ffe066" : info.bot ? "rgba(255,255,255,.7)" : "#fff";
    g.fillText(label, x, y - 30);
  }

  function drawChef(x, y, now) {
    const bob = reduceMotion ? 0 : Math.sin(now / 70) * 2;
    g.save();
    g.translate(x, y + bob);
    g.fillStyle = "rgba(0,0,0,.2)";
    g.beginPath(); g.ellipse(4, 22, 22, 7, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#fafafa"; g.strokeStyle = "#bbb"; g.lineWidth = 2;
    g.beginPath(); g.arc(0, 6, 20, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = "#e0435a";
    g.fillRect(-12, 4, 24, 16);
    g.fillStyle = "#f5c9a0";
    g.beginPath(); g.arc(0, -16, 12, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#5a3417";
    g.beginPath(); g.ellipse(-4, -10, 5, 2.4, 0.3, 0, Math.PI * 2); g.ellipse(4, -10, 5, 2.4, -0.3, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#111";
    g.beginPath(); g.arc(-4, -18, 1.7, 0, Math.PI * 2); g.arc(4, -18, 1.7, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#fff"; g.strokeStyle = "#ccc";
    g.fillRect(-10, -36, 20, 10); g.strokeRect(-10, -36, 20, 10);
    g.beginPath(); g.arc(-7, -38, 7, 0, Math.PI * 2); g.arc(7, -38, 7, 0, Math.PI * 2); g.arc(0, -43, 8, 0, Math.PI * 2); g.fill();
    // The roasting pan
    g.fillStyle = "#555"; g.strokeStyle = "#333"; g.lineWidth = 2;
    g.beginPath();
    if (g.roundRect) g.roundRect(14, -2, 28, 12, 3); else g.rect(14, -2, 28, 12);
    g.fill(); g.stroke();
    g.restore();
    g.textAlign = "center";
    g.font = "800 13px Nunito, sans-serif";
    g.lineWidth = 4; g.strokeStyle = "rgba(0,0,0,.6)"; g.strokeText("CHEF", x, y - 52);
    g.fillStyle = "#ff8a97"; g.fillText("CHEF", x, y - 52);
  }

  function burst(x, y, hue) {
    if (reduceMotion) return;
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2, v = 80 + Math.random() * 220;
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, rot: Math.random() * 6, vr: Math.random() * 8 - 4, life: 1.4, hue: hue + Math.random() * 40 - 20 });
    }
  }

  function drawParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.vx *= 0.96; p.vy = p.vy * 0.96 + 140 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      g.save();
      g.globalAlpha = Math.min(1, p.life);
      g.translate(p.x, p.y); g.rotate(p.rot);
      g.fillStyle = `hsl(${p.hue} 75% 50%)`;
      g.beginPath(); g.ellipse(0, 0, 3, 9, 0, 0, Math.PI * 2); g.fill();
      g.restore();
    }
  }

  function drawStick() {
    if (!stick) return;
    const r = canvas.getBoundingClientRect();
    const k = canvas.width / r.width;
    const ox = (stick.ox - r.left) * k, oy = (stick.oy - r.top) * k;
    const dx = stick.x - stick.ox, dy = stick.y - stick.oy, d = Math.hypot(dx, dy) || 1, m = Math.min(d, 50);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "rgba(255,255,255,.18)"; g.strokeStyle = "rgba(255,255,255,.5)"; g.lineWidth = 3 * k;
    g.beginPath(); g.arc(ox, oy, 50 * k, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = "rgba(255,255,255,.6)";
    g.beginPath(); g.arc(ox + (dx / d) * m * k, oy + (dy / d) * m * k, 20 * k, 0, Math.PI * 2); g.fill();
  }

  // Shown behind the join card before anyone connects
  function drawIdle(now) {
    drawField(RING_FULL, now);
    for (let i = 0; i < 6; i++) {
      const x = W / 2 + Math.cos(now / 1400 + i) * (220 + i * 40);
      const y = H / 2 + Math.sin(now / 1100 + i * 2) * (160 + i * 20);
      drawTurkey(-i - 1, x, y, 0, false, now);
    }
    drawChef(W / 2 + Math.cos(now / 1400 + 0.6) * 220, H / 2 + Math.sin(now / 1100 + 0.6) * 160, now);
  }

  let lastFrame = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    readInput();
    predict(dt);

    g.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    const v = myId ? view(now) : null;
    if (!v) drawIdle(now);
    else {
      drawField(v.ring, now);
      // Draw lower turkeys last so they overlap naturally
      const list = [...v.turkeys.entries()].filter(([id]) => id !== myId);
      if (me.alive) list.push([myId, { x: me.x, y: me.y, f: me.dash > 0 ? 1 : (v.turkeys.get(myId)?.f ?? 0) & 2 }]);
      list.sort((a, b) => a[1].y - b[1].y);
      for (const [id, t] of list) drawTurkey(id, t.x, t.y, t.f, id === myId, now);
      for (const [x, y] of v.chefs) drawChef(x, y, now);
      drawParticles(dt);
    }
    drawStick();
    $("dash").style.setProperty("--ready", String(1 - me.cd / DASH_COOLDOWN));
    requestAnimationFrame(frame);
  }

  // ---------- Sounds, made with Web Audio (no files to load) ----------

  let audio = null;
  let muted = store.get("muted") === true;
  $("mute").textContent = muted ? "🔇" : "🔊";
  $("mute").addEventListener("click", () => {
    muted = !muted;
    store.set("muted", muted);
    $("mute").textContent = muted ? "🔇" : "🔊";
  });
  function unlockAudio() {
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch { /* no sound */ }
  }
  function tone(type, from, to, start, len, vol = 0.15, wobble = 0) {
    if (!audio || muted) return;
    const t = audio.currentTime + start;
    const o = audio.createOscillator(), gain = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + len);
    if (wobble) {
      const lfo = audio.createOscillator(), depth = audio.createGain();
      lfo.frequency.value = wobble; depth.gain.value = from * 0.18;
      lfo.connect(depth).connect(o.frequency);
      lfo.start(t); lfo.stop(t + len);
    }
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(gain).connect(audio.destination);
    o.start(t); o.stop(t + len + 0.02);
  }
  const gobble = () => { tone("sawtooth", 760, 380, 0, 0.16, 0.1, 40); tone("sawtooth", 700, 340, 0.17, 0.16, 0.1, 40); };
  const ding = () => { tone("triangle", 1320, 1310, 0, 0.6, 0.2); tone("triangle", 1760, 1750, 0.08, 0.6, 0.12); };
  const tick = () => tone("square", 880, 870, 0, 0.08, 0.06);
  const poof = () => tone("triangle", 420, 90, 0, 0.25, 0.08);
  const sadHorn = () => [[392, 0], [370, 0.3], [349, 0.6], [330, 0.9]].forEach(([f, s], i) => tone("triangle", f, f * 0.98, s, i === 3 ? 0.8 : 0.28, 0.18, i === 3 ? 6 : 0));
  const fanfare = () => [[523, 0], [659, 0.12], [784, 0.24], [1047, 0.38]].forEach(([f, s], i) => tone("square", f, f, s, i === 3 ? 0.6 : 0.14, 0.08));

  resize();
  boot();
  requestAnimationFrame(frame);
})();
