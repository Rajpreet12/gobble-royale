// Smoke test after a deploy: is the NEW version live, and can a player get in?
//   node scripts/smoke.mjs <base url> <expected version>
// Exits 1 on any failure; the deploy script then rolls back.

const [base, expected] = process.argv.slice(2);
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`✓ ${msg}`);
const get = (path) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });

// 1. The new version is the one answering (the restart takes a moment)
let version = null;
for (let i = 0; i < 30 && version !== expected; i++) {
  try { version = (await (await get("/health")).json()).version; } catch { /* still restarting */ }
  if (version !== expected) await new Promise((r) => setTimeout(r, 2_000));
}
if (version !== expected) fail(`/health reports version ${version ?? "nothing"}, expected ${expected}`);
ok(`/health reports the new version ${expected}`);

// 2. The pages a player and an on-call engineer need
for (const [path, mustContain] of [["/", "Gobble Royale"], ["/status", "Gobble Royale status"], ["/game.js", "WebSocket"]]) {
  const res = await get(path);
  const body = await res.text();
  if (res.status !== 200 || !body.includes(mustContain)) fail(`${path} answered ${res.status} without "${mustContain}"`);
  ok(`${path} loads`);
}
const config = await (await get("/api/config")).json();
if (!config.states?.length) fail("/api/config has no states");
ok("/api/config has the name and state lists");

// 3. The game connection opens (and closes without joining, like the uptime checker)
await new Promise((resolve) => {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/play`);
  const timer = setTimeout(() => fail("the game connection didn't open within 5 s"), 5_000);
  ws.onopen = () => { clearTimeout(timer); ws.close(1000); resolve(); };
  ws.onerror = () => fail("the game connection was refused");
});
ok("the game connection opens");
console.log("Smoke test passed");
