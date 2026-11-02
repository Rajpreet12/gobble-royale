// One arena: up to 30 human turkeys, bots to fill the field, the Chefs who chase them,
// and the oven that closes in. The server is the only source of truth: clients send a
// direction, never a position, so nobody can teleport out of trouble.

import { counter } from "./metrics.mjs";
import { record } from "./scores.mjs";

const sentMessages = counter("gobble_messages_sent_total", "Messages sent to players");
const sentBytes = counter("gobble_bytes_sent_total", "Bytes of game messages sent to players");
// A rising number here is an early warning: players' connections can't keep up.
const skippedSlow = counter("gobble_snapshots_skipped_total", "Snapshots skipped because a player's connection was backed up");
const roundsStarted = counter("gobble_rounds_total", "Rounds started");
const caughtByChef = counter("gobble_turkeys_out_total", "Turkeys knocked out", { by: "chef" });
const caughtByOven = counter("gobble_turkeys_out_total", "Turkeys knocked out", { by: "oven" });

export const W = 1600;
export const H = 1000;
export const TICK_HZ = 30;
const DT = 1 / TICK_HZ;
const SNAP_EVERY = 2; // 15 snapshots a second; the browser smooths between them

export const TURKEY_R = 16;
export const TURKEY_SPEED = 230;
export const DASH_SPEED = 600;
export const DASH_TIME = 0.2;
export const DASH_COOLDOWN = 2.5;
const CHEF_R = 22;
const CHEF_WARMUP = 2.5; // seconds the Chefs wait at the start, so nobody is caught before they find the keys

export const MAX_HUMANS = 30;
const MIN_TURKEYS = 10; // bots fill the field, so the first visitor never plays alone
const LOBBY_SECONDS = 6;
const ROUND_SECONDS = 90;
const OVER_SECONDS = 6;

// The oven: a ring that starts shrinking after RING_START and stops at RING_MIN.
const RING_START = 12;
const RING_END = 75;
const RING_MIN = 130;
const RING_MAX = Math.hypot(W, H) / 2 + 40;
const HEAT_LIMIT = 1.5; // seconds outside the ring before the oven gets you

const BOT_NAMES = [
  "Bot Butterball", "Robo Gobbler", "Tin Turkey", "Auto Drumstick", "Beep Boop Bird",
  "Circuit Giblet", "Mecha Wattle", "Byte Basted", "Cyber Cranberry", "Silicon Stuffing",
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

// Keeps a circle inside the fence and outside every hay bale. Sliding along a bale
// falls out of this naturally: only the part of the move into the bale is undone.
export function collide(e, r, obstacles) {
  e.x = clamp(e.x, r, W - r);
  e.y = clamp(e.y, r, H - r);
  for (const o of obstacles) {
    const dx = e.x - o.x, dy = e.y - o.y;
    const d = Math.hypot(dx, dy) || 1;
    const min = o.r + r;
    if (d < min) {
      e.x = o.x + (dx / d) * min;
      e.y = o.y + (dy / d) * min;
    }
  }
}

function makeObstacles() {
  const bales = [];
  for (let tries = 0; bales.length < 7 && tries < 200; tries++) {
    const b = { x: Math.round(rand(160, W - 160)), y: Math.round(rand(130, H - 130)), r: Math.round(rand(28, 46)) };
    if (bales.every((o) => Math.hypot(o.x - b.x, o.y - b.y) > o.r + b.r + 90)) bales.push(b);
  }
  return bales;
}

export class Room {
  constructor(id) {
    this.id = id;
    this.turkeys = new Map(); // id -> turkey, humans and bots
    this.chefs = [];
    this.obstacles = makeObstacles();
    this.phase = "lobby";
    this.clock = LOBBY_SECONDS;
    this.elapsed = 0;
    this.ring = RING_MAX;
    this.ticks = 0;
    this.nextId = 1;
    this.feed = [];
  }

  humans() {
    return [...this.turkeys.values()].filter((t) => !t.bot);
  }

  alive() {
    return [...this.turkeys.values()].filter((t) => t.alive);
  }

  // --- People coming and going ---

  add(ws, name, state) {
    const t = this.makeTurkey({ name, state, bot: false });
    t.ws = ws;
    // In the lobby you can waddle around right away; mid-round you watch until the next one.
    if (this.phase === "lobby") this.spawn(t);
    this.turkeys.set(t.id, t);
    this.send(t, { t: "you", id: t.id, room: this.id, w: W, h: H, obstacles: this.obstacles });
    this.broadcastMeta();
    return t;
  }

  remove(id) {
    if (!this.turkeys.delete(id)) return;
    this.broadcastMeta();
  }

  input(id, msg) {
    const t = this.turkeys.get(id);
    if (!t) return;
    const x = clamp(Number(msg.x) || 0, -1, 1);
    const y = clamp(Number(msg.y) || 0, -1, 1);
    t.input = { x, y };
    if (msg.d) t.wantDash = true;
  }

  makeTurkey({ name, state, bot }) {
    return {
      id: this.nextId++, name, state, bot,
      hue: Math.floor(Math.random() * 360),
      x: W / 2, y: H / 2, input: { x: 0, y: 0 }, wantDash: false,
      dash: 0, cd: 0, heat: 0, alive: false,
      // Bots think every few ticks; slower thinkers make more mistakes.
      think: 0, thinkEvery: Math.floor(rand(2, 7)), wander: rand(0, Math.PI * 2),
    };
  }

  spawn(t) {
    for (let tries = 0; tries < 50; tries++) {
      t.x = rand(80, W - 80);
      t.y = rand(80, H - 80);
      const clearOfBales = this.obstacles.every((o) => Math.hypot(o.x - t.x, o.y - t.y) > o.r + TURKEY_R + 10);
      const clearOfChefs = this.chefs.every((c) => Math.hypot(c.x - t.x, c.y - t.y) > 450);
      if (clearOfBales && clearOfChefs) break;
    }
    t.alive = true;
    t.dash = t.cd = t.heat = 0;
  }

  // --- The round ---

  startRound() {
    for (const t of this.turkeys.values()) if (t.bot) this.turkeys.delete(t.id);
    const humans = this.humans();
    for (let i = 0; this.turkeys.size < MIN_TURKEYS; i++) {
      const bot = this.makeTurkey({ name: BOT_NAMES[i % BOT_NAMES.length], state: "BOT", bot: true });
      this.turkeys.set(bot.id, bot);
    }

    this.phase = "play";
    this.elapsed = 0;
    this.ring = RING_MAX;
    this.obstacles = makeObstacles();
    this.feed = [];
    // The Chefs start along the edges, then every turkey spawns away from them.
    this.chefs = [];
    for (let i = 0; i < 1 + Math.floor(humans.length / 8); i++) this.addChef();
    for (const t of this.turkeys.values()) this.spawn(t);
    this.started = this.turkeys.size;

    record("_TOTAL", { rounds: 1 });
    roundsStarted.inc();
    this.broadcast({ t: "round", obstacles: this.obstacles, n: this.started });
    this.broadcastMeta();
  }

  addChef() {
    const side = Math.floor(rand(0, 4));
    const x = side === 0 ? CHEF_R : side === 1 ? W - CHEF_R : rand(200, W - 200);
    const y = side === 2 ? CHEF_R : side === 3 ? H - CHEF_R : rand(200, H - 200);
    this.chefs.push({ x, y, target: null, retarget: 0 });
  }

  tick() {
    this.ticks++;
    if (this.phase === "lobby") {
      // The countdown only runs while someone is here to play.
      this.clock = this.humans().length ? this.clock - DT : LOBBY_SECONDS;
      this.moveTurkeys();
      if (this.clock <= 0) this.startRound();
    } else if (this.phase === "play") {
      this.elapsed += DT;
      this.step();
      this.checkEnd();
    } else {
      this.clock -= DT;
      if (this.clock <= 0) this.openLobby();
    }
    if (this.ticks % SNAP_EVERY === 0) this.broadcast(this.snapshot());
  }

  openLobby() {
    for (const t of this.turkeys.values()) {
      if (t.bot) this.turkeys.delete(t.id);
      else this.spawn(t);
    }
    this.chefs = [];
    this.ring = RING_MAX;
    this.phase = "lobby";
    this.clock = LOBBY_SECONDS;
    this.broadcastMeta();
  }

  moveTurkeys() {
    for (const t of this.turkeys.values()) {
      if (!t.alive) continue;
      const dir = t.bot ? this.botBrain(t) : t.input;
      const len = Math.hypot(dir.x, dir.y);
      const nx = len > 1 ? dir.x / len : dir.x;
      const ny = len > 1 ? dir.y / len : dir.y;
      if (t.wantDash && t.cd <= 0 && len > 0.1) {
        t.dash = DASH_TIME;
        t.cd = DASH_COOLDOWN;
      }
      t.wantDash = false;
      const speed = t.dash > 0 ? DASH_SPEED : TURKEY_SPEED;
      t.x += nx * speed * DT;
      t.y += ny * speed * DT;
      t.dash = Math.max(0, t.dash - DT);
      t.cd = Math.max(0, t.cd - DT);
      collide(t, TURKEY_R, this.obstacles);
    }
  }

  step() {
    this.moveTurkeys();

    // The oven closes in
    const p = clamp((this.elapsed - RING_START) / (RING_END - RING_START), 0, 1);
    this.ring = RING_MAX + (RING_MIN - RING_MAX) * p;
    for (const t of this.alive()) {
      const outside = Math.hypot(t.x - W / 2, t.y - H / 2) > this.ring - TURKEY_R / 2;
      t.heat = outside ? t.heat + DT : Math.max(0, t.heat - DT / 2);
      if (t.heat >= HEAT_LIMIT) this.out(t, "oven");
    }

    // More Chefs join as the round goes on
    if (this.chefs.length < 2 + Math.floor(this.started / 8) && this.elapsed > 25 * this.chefs.length) this.addChef();

    // The Chefs: chase the nearest turkey, aiming a little ahead of it, and get faster over time
    const chefSpeed = Math.min(265, 150 + 1.6 * this.elapsed);
    if (this.elapsed < CHEF_WARMUP) return;
    const alive = this.alive();
    for (const c of this.chefs) {
      c.retarget -= DT;
      if (c.retarget <= 0 || !c.target?.alive) {
        c.target = null;
        let best = Infinity;
        for (const t of alive) {
          const d = Math.hypot(t.x - c.x, t.y - c.y);
          if (d < best) { best = d; c.target = t; }
        }
        c.retarget = 0.4;
      }
      if (c.target) {
        const t = c.target;
        const lead = t.bot ? this.botBrain(t, true) : t.input;
        const aimX = t.x + lead.x * TURKEY_SPEED * 0.2;
        const aimY = t.y + lead.y * TURKEY_SPEED * 0.2;
        const d = Math.hypot(aimX - c.x, aimY - c.y) || 1;
        c.x += ((aimX - c.x) / d) * chefSpeed * DT;
        c.y += ((aimY - c.y) / d) * chefSpeed * DT;
      }
      collide(c, CHEF_R, this.obstacles);
      for (const t of alive) {
        if (t.alive && Math.hypot(t.x - c.x, t.y - c.y) < TURKEY_R + CHEF_R - 4) this.out(t, "chef");
      }
    }
  }

  // Bots run from the nearest Chef, stay inside the oven ring, and wander a little.
  // `peek` returns the last decision without thinking again (used by the Chefs to aim).
  botBrain(t, peek = false) {
    if (peek || t.think-- > 0) return t.dir ?? { x: 0, y: 0 };
    t.think = t.thinkEvery;
    let ax = 0, ay = 0, nearest = Infinity;
    for (const c of this.chefs) {
      const dx = t.x - c.x, dy = t.y - c.y;
      const d = Math.hypot(dx, dy) || 1;
      nearest = Math.min(nearest, d);
      if (d < 380) {
        const w = ((380 - d) / 380) * 2.2;
        ax += (dx / d) * w;
        ay += (dy / d) * w;
      }
    }
    const cx = t.x - W / 2, cy = t.y - H / 2;
    const fromCenter = Math.hypot(cx, cy) || 1;
    if (fromCenter > this.ring * 0.7) {
      const pull = (fromCenter / this.ring) * 1.8;
      ax -= (cx / fromCenter) * pull;
      ay -= (cy / fromCenter) * pull;
    }
    // Walls are corners to get trapped in
    if (t.x < 120) ax += 1; else if (t.x > W - 120) ax -= 1;
    if (t.y < 120) ay += 1; else if (t.y > H - 120) ay -= 1;
    t.wander += rand(-0.6, 0.6);
    ax += Math.cos(t.wander) * 0.5;
    ay += Math.sin(t.wander) * 0.5;
    if (nearest < 110 && Math.random() < 0.35) t.wantDash = true;
    const len = Math.hypot(ax, ay) || 1;
    t.dir = { x: ax / len, y: ay / len };
    return t.dir;
  }

  out(t, by) {
    t.alive = false;
    const left = this.alive().length;
    const line = { id: t.id, name: t.name, by, x: Math.round(t.x), y: Math.round(t.y) };
    this.feed.push(line);
    this.broadcast({ t: "out", ...line, left });
    record("_TOTAL", { stuffed: 1 });
    (by === "oven" ? caughtByOven : caughtByChef).inc();
    if (!t.bot) {
      record(t.state, { plays: 1 });
      this.send(t, { t: "result", won: false, place: left + 1, of: this.started, lasted: Math.round(this.elapsed), by });
    }
  }

  checkEnd() {
    const alive = this.alive();
    const humansAlive = alive.some((t) => !t.bot);
    if (alive.length > 1 && humansAlive && this.elapsed < ROUND_SECONDS) return;

    // Last turkey standing wins. If the clock runs out, every turkey still standing shares the win.
    for (const t of alive) {
      if (t.bot) continue;
      record(t.state, { wins: 1, plays: 1 });
      this.send(t, { t: "result", won: true, place: 1, of: this.started, lasted: Math.round(this.elapsed), shared: alive.length > 1 });
    }
    this.broadcast({ t: "over", winners: alive.map((t) => t.id), timeUp: this.elapsed >= ROUND_SECONDS });
    this.phase = "over";
    this.clock = OVER_SECONDS;
  }

  // --- Talking to browsers ---

  snapshot() {
    const p = [];
    for (const t of this.turkeys.values()) {
      if (t.alive) p.push([t.id, Math.round(t.x), Math.round(t.y), (t.dash > 0 ? 1 : 0) | (t.heat > 0.3 ? 2 : 0), Math.round(t.cd * 10)]);
    }
    const clock = this.phase === "play" ? ROUND_SECONDS - this.elapsed : this.clock;
    return {
      t: "s", ph: this.phase, k: Math.max(0, Math.ceil(clock)), r: Math.round(this.ring),
      p, c: this.chefs.map((c) => [Math.round(c.x), Math.round(c.y)]),
    };
  }

  broadcastMeta() {
    const m = [...this.turkeys.values()].map((t) => [t.id, t.name, t.state, t.hue, t.bot ? 1 : 0]);
    this.broadcast({ t: "meta", m, humans: this.humans().length });
  }

  send(t, msg) {
    if (t.ws?.readyState !== 1) return;
    const data = JSON.stringify(msg);
    t.ws.send(data);
    sentMessages.inc();
    sentBytes.inc(data.length);
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const t of this.turkeys.values()) {
      if (t.ws?.readyState !== 1) continue;
      // A slow connection skips a snapshot rather than letting messages pile up in memory.
      if (t.ws.bufferedAmount >= 256 * 1024) { skippedSlow.inc(); continue; }
      t.ws.send(data);
      sentMessages.inc();
      sentBytes.inc(data.length);
    }
  }
}
