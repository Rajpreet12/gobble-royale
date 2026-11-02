// Load test: connects many fake players, plays for a while, and reports p50/p95/p99 for what
// they experienced, then prints the server's own SLO report. Exits 1 if any SLO is missed, so
// a CI pipeline can block a change that makes the game slower.
//
//   node scripts/loadtest.mjs --url http://localhost:8080 --players 60 --seconds 45
//
// Run it against your own local server (started with MAX_PER_IP raised, since every fake player
// comes from one address). Don't point it at the live game: real players share that server.

import WebSocket from "ws";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const BASE = (args.url ?? "http://localhost:8080").replace(/\/$/, "");
const PLAYERS = Number(args.players ?? 60);
const SECONDS = Number(args.seconds ?? 45);
const WS_URL = BASE.replace(/^http/, "ws") + "/play";

const percentile = (sorted, q) => (sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null);
const summary = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 0.5), p95: percentile(s, 0.95), p99: percentile(s, 0.99), max: s.at(-1) ?? null };
};

const config = await (await fetch(`${BASE}/api/config`)).json();
const pick = (list) => list[Math.floor(Math.random() * list.length)];

const joinMs = [];      // click "Waddle in" until the server says "you're in"
const rttMs = [];       // the server's own timing of each player's round trip
const gapMs = [];       // time between snapshots: should be ~67 ms; spikes are what players see as stutter
let errors = 0;
let closedEarly = 0;

function player(i) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const opened = performance.now();
    let lastSnap = 0;
    let steer;
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", name: `${pick(config.adjectives)} ${pick(config.nouns)}`, state: pick(config.states)[0] })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (msg.t === "you") {
        joinMs.push(performance.now() - opened);
        // Wander like a (bad) player: a new direction every 300 ms, flap now and then
        steer = setInterval(() => {
          if (ws.readyState !== 1) return;
          const a = Math.random() * Math.PI * 2;
          ws.send(JSON.stringify({ t: "in", x: Math.cos(a), y: Math.sin(a), ...(Math.random() < 0.1 ? { d: 1 } : {}) }));
        }, 300);
      } else if (msg.t === "s") {
        const now = performance.now();
        if (lastSnap) gapMs.push(now - lastSnap);
        lastSnap = now;
      } else if (msg.t === "ping") {
        ws.send(JSON.stringify({ t: "pong", n: msg.n }));
      } else if (msg.t === "rtt") {
        rttMs.push(msg.ms);
      }
    });
    ws.on("error", () => { errors++; });
    ws.on("close", (code) => {
      clearInterval(steer);
      if (code !== 1000) closedEarly++;
      resolve();
    });
    setTimeout(() => ws.close(1000), SECONDS * 1000 + i * 20);
  });
}

console.log(`Load test: ${PLAYERS} players for ${SECONDS}s against ${BASE}\n`);
// Join in a quick ramp rather than all at once, like real traffic
const runs = [];
for (let i = 0; i < PLAYERS; i++) {
  runs.push(player(i));
  await new Promise((r) => setTimeout(r, 20));
}
// Meanwhile, new visitors keep opening the page (that's what the page-response SLO measures)
const pageLoads = [];
for (let i = 0; i < 30; i++) {
  pageLoads.push(new Promise((r) => setTimeout(r, (i * SECONDS * 1000) / 30)).then(() => fetch(`${BASE}/`).then((res) => res.text())));
}
await Promise.all([...runs, ...pageLoads]);

const fmt = (v) => (v == null ? "–" : `${v.toFixed(1)} ms`.padStart(10));
const row = (name, s) => console.log(`${name.padEnd(26)}${String(s.n).padStart(8)}${fmt(s.p50)}${fmt(s.p95)}${fmt(s.p99)}${fmt(s.max)}`);
console.log(`${"What players felt".padEnd(26)}${"samples".padStart(8)}${"p50".padStart(10)}${"p95".padStart(10)}${"p99".padStart(10)}${"max".padStart(10)}`);
row("Join time", summary(joinMs));
row("Round trip (server-timed)", summary(rttMs));
row("Gap between snapshots", summary(gapMs));
console.log(`\nConnection errors: ${errors} · closed early: ${closedEarly}\n`);

const status = await (await fetch(`${BASE}/api/status`)).json();
console.log("Server SLOs (last 5 minutes):");
let failed = 0;
for (const s of status.slos) {
  const value = s[s.percentile];
  const verdict = s.met === null ? "no data" : s.met ? "MET" : "MISSED";
  if (s.met === false) failed++;
  console.log(`  ${s.met === false ? "✗" : s.met ? "✓" : "·"} ${s.name.padEnd(24)} ${s.percentile} ${fmt(value).trim().padStart(9)}  (target < ${s.targetMs} ms)  ${verdict}`);
}
if (errors || closedEarly) failed++;
console.log(failed ? "\nResult: FAIL" : "\nResult: PASS");
process.exit(failed ? 1 : 0);
