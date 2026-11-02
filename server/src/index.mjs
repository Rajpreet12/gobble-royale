// Gobble Royale - one small server that serves the page, runs every arena, and speaks WebSocket.
//   GET  /                 the game
//   GET  /status           live status page: SLOs, p50/p95/p99, last hour
//   GET  /health           is it up?
//   GET  /metrics          Prometheus metrics, for monitoring tools
//   GET  /api/config       name lists and states
//   GET  /api/leaderboard  top states, all-time counters, turkeys online
//   GET  /api/status       what the status page shows, as JSON
//   WS   /play             { t: "hello", name, state } then { t: "in", x, y, d } and { t: "pong", n }

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { WebSocketServer } from "ws";
import { MAX_HUMANS, Room, TICK_HZ } from "./game.mjs";
import { counter, gauge, renderPrometheus } from "./metrics.mjs";
import { ADJECTIVES, NOUNS, STATES, isName, isState } from "./names.mjs";
import { leaderboard, loadScores, saveFile, syncScores } from "./scores.mjs";
import { httpDuration, rtt, sloReport, startHistory, tickDuration, tickLag } from "./slo.mjs";

const PORT = Number(process.env.PORT) || 8080;
// Raised only for local load tests, where every fake player shares one address.
const MAX_PER_IP = Number(process.env.MAX_PER_IP) || 4;
const MAX_MESSAGES_PER_SECOND = 40; // the page sends about 20
const RTT_EVERY_MS = 2_000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const STARTED = Date.now();
// The git commit this server is running, written into the bundle by the deploy pipeline. /health
// reports it, so a deploy can prove the new code is live instead of assuming it.
const VERSION = (() => { try { return readFileSync(join(ROOT, "VERSION"), "utf8").trim(); } catch { return "dev"; } })();

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const FILES = ["index.html", "game.js", "status.html"];

// --- Counters: things that only go up. Rates come from comparing two readings. ---
const connections = counter("gobble_connections_total", "WebSocket connections opened");
const joins = counter("gobble_joins_total", "Players who joined an arena");
const received = counter("gobble_messages_received_total", "Messages received from players");
const dropped = counter("gobble_messages_dropped_total", "Messages dropped by the rate limit", { reason: "rate_limit" });
const rejectedIp = counter("gobble_connections_rejected_total", "Connections refused", { reason: "ip_limit" });
const rejectedPath = counter("gobble_connections_rejected_total", "Connections refused", { reason: "bad_path" });

const rooms = [];
let nextRoom = 1;

// Fill the busiest arena that still has space, so every field feels alive.
function pickRoom() {
  const open = rooms.filter((r) => r.humans().length < MAX_HUMANS);
  open.sort((a, b) => b.humans().length - a.humans().length);
  if (open[0]) return open[0];
  const room = new Room(nextRoom++);
  rooms.push(room);
  return room;
}

const online = () => rooms.reduce((n, r) => n + r.humans().length, 0);

// Event loop utilization: the share of time Node was busy rather than waiting. Near 1 means
// the server can't keep up. Sampled on a timer so two readers never disturb each other.
let elu = performance.eventLoopUtilization();
let busy = 0;
setInterval(() => {
  const next = performance.eventLoopUtilization();
  busy = performance.eventLoopUtilization(next, elu).utilization;
  elu = next;
}, 5_000).unref();

// --- Gauges: values that go up and down, read when someone asks ---
gauge("gobble_players_online", "Players connected to an arena", online);
gauge("gobble_rooms", "Arenas running", () => rooms.length);
gauge("gobble_event_loop_utilization", "Share of time the event loop was busy (0 to 1)", () => busy);
gauge("process_resident_memory_bytes", "Memory used by the server process", () => process.memoryUsage().rss);
gauge("gobble_uptime_seconds", "Seconds since the server started", () => (Date.now() - STARTED) / 1000);

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

// The route label is picked from a fixed list, never the raw URL (see labelKey in metrics.mjs).
const ROUTES = {
  "/": "page", "/index.html": "page", "/game.js": "asset", "/status": "status", "/status.html": "status",
  "/health": "health", "/metrics": "metrics", "/api/config": "api", "/api/leaderboard": "api", "/api/status": "api",
};

let statusCache = null;
function status() {
  if (statusCache && Date.now() - statusCache.at < 2_000) return statusCache.body;
  const body = {
    now: Date.now(),
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - STARTED) / 1000),
    online: online(),
    rooms: rooms.length,
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    eventLoopBusy: Math.round(busy * 1000) / 10,
    totals: { connections: connections.value, joins: joins.value, rateLimited: dropped.value, rejected: rejectedIp.value + rejectedPath.value },
    slos: sloReport(),
  };
  statusCache = { at: Date.now(), body };
  return body;
}

const server = createServer(async (req, res) => {
  const start = performance.now();
  const path = new URL(req.url, "http://x").pathname;
  const timer = httpDuration(ROUTES[path] ?? "not_found");
  res.on("finish", () => timer.observe(performance.now() - start));

  if (req.method !== "GET") return sendJson(res, 405, { error: "GET only" });
  if (path === "/health") return sendJson(res, 200, { ok: true, online: online(), version: VERSION });
  if (path === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
    return res.end(renderPrometheus());
  }
  if (path === "/api/config") return sendJson(res, 200, { adjectives: ADJECTIVES, nouns: NOUNS, states: STATES });
  if (path === "/api/leaderboard") return sendJson(res, 200, { ...leaderboard(), online: online() });
  if (path === "/api/status") return sendJson(res, 200, status());

  const file = path === "/" ? "index.html" : path === "/status" ? "status.html" : path.slice(1);
  if (!FILES.includes(file)) return sendJson(res, 404, { error: "Not here. Try the field." });
  try {
    const body = await readFile(join(PUBLIC, file));
    res.writeHead(200, { "content-type": TYPES[file.slice(file.lastIndexOf("."))], "cache-control": "public, max-age=60" });
    res.end(body);
  } catch {
    sendJson(res, 500, { error: "The barn door is stuck." });
  }
});

// The proxy in front (Caddy, or a load balancer) adds the real client address to the end of x-forwarded-for.
const clientIp = (req) => (req.headers["x-forwarded-for"]?.split(",").pop() ?? req.socket.remoteAddress ?? "").trim();
const perIp = new Map();

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 });

server.on("upgrade", (req, socket, head) => {
  const ip = clientIp(req);
  const badPath = new URL(req.url, "http://x").pathname !== "/play";
  if (badPath || (perIp.get(ip) ?? 0) >= MAX_PER_IP) {
    (badPath ? rejectedPath : rejectedIp).inc();
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, ip));
});

wss.on("connection", (ws, ip) => {
  connections.inc();
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  let room = null;
  let turkey = null;
  let budget = MAX_MESSAGES_PER_SECOND;
  const refill = setInterval(() => (budget = MAX_MESSAGES_PER_SECOND), 1000);
  const hello = setTimeout(() => !turkey && ws.close(4000, "Say hello first"), 10_000);
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  // Round-trip time: the server notes when it sent ping n and times the answer itself,
  // so a player can't fake a good (or bad) number by editing the page.
  let pingN = 0;
  let pingAt = 0;
  const pinger = setInterval(() => {
    if (!turkey || ws.readyState !== 1) return;
    pingAt = performance.now();
    ws.send(JSON.stringify({ t: "ping", n: ++pingN }));
  }, RTT_EVERY_MS);

  ws.on("message", (raw) => {
    received.inc();
    if (--budget < 0) { dropped.inc(); return; } // flooding: drop until the next second
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === "hello" && !turkey) {
      if (!isName(msg.name) || !isState(msg.state)) return ws.close(4001, "Pick a name and a state from the lists");
      room = pickRoom();
      turkey = room.add(ws, msg.name, msg.state);
      joins.inc();
    } else if (msg.t === "in" && turkey) {
      room.input(turkey.id, msg);
    } else if (msg.t === "pong" && msg.n === pingN && pingAt) {
      const ms = performance.now() - pingAt;
      pingAt = 0;
      rtt.observe(ms);
      ws.send(JSON.stringify({ t: "rtt", ms: Math.round(ms) }));
    }
  });

  ws.on("close", () => {
    clearInterval(refill);
    clearInterval(pinger);
    clearTimeout(hello);
    const left = (perIp.get(ip) ?? 1) - 1;
    if (left > 0) perIp.set(ip, left); else perIp.delete(ip);
    if (room && turkey) room.remove(turkey.id);
  });
});

// One clock for every arena, on a fixed timestep. setInterval would drift: every late wake-up
// (a coarse OS timer, garbage collection, a busy CPU) would slow the whole game down for good.
// Instead each tick has a deadline; a late wake-up runs the ticks it missed (up to a few) so game
// time keeps pace with real time, and a hopeless delay (a laptop waking from sleep) just resyncs.
//
// Each tick is timed (how long the work took) and each wake-up is checked for lateness (how far
// past its deadline it ran). Both are only recorded while someone is playing: an empty server
// ticking quickly would make the numbers look better than any player felt.
const TICK_MS = 1000 / TICK_HZ;
const MAX_CATCH_UP = 3;
let deadline = performance.now() + TICK_MS;

function runTick() {
  const start = performance.now();
  for (const room of rooms) room.tick();
  for (let i = rooms.length - 1; i > 0; i--) if (!rooms[i].humans().length) rooms.splice(i, 1);
  if (online() > 0) tickDuration.observe(performance.now() - start);
}

function loop() {
  const now = performance.now();
  if (online() > 0) tickLag.observe(Math.max(0, now - deadline));
  for (let ran = 0; now >= deadline && ran < MAX_CATCH_UP; ran++) {
    runTick();
    deadline += TICK_MS;
  }
  if (now - deadline > 1000) deadline = now + TICK_MS;
  setTimeout(loop, Math.max(0, deadline - performance.now()));
}
setTimeout(loop, TICK_MS);

// Drop connections that stopped answering (closed laptops, lost signal).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20_000);

await loadScores().catch((err) => console.warn("Starting with an empty leaderboard", err.name));
syncScores();
startHistory();
// LISTEN_HOST=127.0.0.1 behind Caddy on Lightsail; unset (all interfaces) everywhere else.
server.listen(PORT, process.env.LISTEN_HOST, () => console.log(`Gobble Royale on :${PORT}`));

// systemd (or Fargate) sends SIGTERM before a restart: say goodbye and save the scores first.
process.on("SIGTERM", () => {
  for (const ws of wss.clients) ws.close(1012, "The farm is restarting. Rejoin in a moment.");
  saveFile().catch(() => {}).finally(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
});

