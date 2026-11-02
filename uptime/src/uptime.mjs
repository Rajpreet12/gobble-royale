// Uptime: an outside view of whether players can reach the game.
//
// It runs in AWS Lambda, not on the game server, on purpose: if the server dies, anything
// running on it dies too and can't report the outage. (It's still in us-east-1, next to the
// server, so it won't notice a problem between a player's internet provider and AWS.)
//
//   probe   every minute: can a player load the page AND open the game connection?
//           Then: should anyone be alerted? (rules in alerts.mjs)
//   budget  a public URL the status page reads: availability, error budget, burn rate

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { decide } from "./alerts.mjs";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns = new SNSClient({});
const TABLE = process.env.TABLE_NAME;
const TARGET = process.env.TARGET_URL;
const ALERT_TOPIC = process.env.ALERT_TOPIC_ARN;
const SLO = Number(process.env.SLO_PERCENT || 99.5); // percent of minutes that must be good
const WINDOW_DAYS = 30;
const TIMEOUT_MS = 5_000;
const KEEP_DAYS = 35; // a little longer than the window, then DynamoDB deletes old rows itself

const MINUTE = 60_000;
const BUDGET_MINUTES = (1 - SLO / 100) * WINDOW_DAYS * 24 * 60; // 99.5% of 30 days -> 216 bad minutes allowed

// --- The checks: the same two steps a player's browser takes ---

async function checkHealth(base) {
  const start = Date.now();
  const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "gobble-uptime-probe" } });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok !== true) throw new Error(`/health answered ${res.status}`);
  return Date.now() - start;
}

// Opens the game connection and closes it straight away, without joining, so the probe never
// shows up as a player or plays a round.
function checkGameConnection(base) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/play`);
    const timer = setTimeout(() => { ws.close(); reject(new Error("game connection timed out")); }, TIMEOUT_MS);
    ws.onopen = () => { clearTimeout(timer); ws.close(1000); resolve(Date.now() - start); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("game connection refused")); };
  });
}

async function checkOnce(base) {
  try {
    return { ok: true, healthMs: await checkHealth(base), connectMs: await checkGameConnection(base) };
  } catch (err) {
    // fetch reports a refused or unreachable server as "fetch failed"; the cause says which.
    const reason = err.name === "TimeoutError" ? "/health timed out"
      : err.message === "fetch failed" ? `can't reach the server (${err.cause?.code ?? "no answer"})`
      : err.message;
    return { ok: false, reason };
  }
}

// A minute is bad only if the check fails twice, 2 seconds apart. One dropped packet shouldn't
// spend error budget; a real outage fails both.
export async function probe(event = {}) {
  // testAlert sends one clearly marked test email, to prove the alert path works end to end.
  if (event.testAlert) {
    await sns.send(new PublishCommand({
      TopicArn: ALERT_TOPIC,
      Subject: "[TEST] Gobble Royale alerts are working",
      Message: `This is a test. If you can read it, PAGE and TICKET alerts will reach you.\n\nStatus: ${TARGET}/status\nSent ${new Date().toISOString()}.`,
    }));
    return { sent: "test alert" };
  }
  // dryRun lets you test against any URL (including a broken one) without writing a result.
  const base = (event.dryRun && event.url) || TARGET;
  let result = await checkOnce(base);
  if (!result.ok) {
    await new Promise((r) => setTimeout(r, 2_000));
    const retry = await checkOnce(base);
    result = retry.ok ? { ...retry, retried: true } : retry;
  }
  const at = new Date().toISOString();
  if (event.dryRun) return { at, target: base, ...result };

  const ttl = Math.floor(Date.now() / 1000) + KEEP_DAYS * 86_400;
  // One row per hour holds the counts; one row per bad minute says what went wrong.
  await db.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: "HOUR", sk: at.slice(0, 13) }, // e.g. 2026-11-02T14
    UpdateExpression: "ADD #total :one, #good :good SET #ttl = :ttl",
    ExpressionAttributeNames: { "#total": "total", "#good": "good", "#ttl": "ttl" },
    ExpressionAttributeValues: { ":one": 1, ":good": result.ok ? 1 : 0, ":ttl": ttl },
  }));
  if (!result.ok) {
    await db.send(new PutCommand({ TableName: TABLE, Item: { pk: "BAD", sk: at, reason: result.reason, ttl } }));
    console.warn("Bad minute", result.reason);
  }

  // Recording the minute matters most, so alerting runs after it. If alerting throws, the
  // function reports an error and the "checker is broken" CloudWatch alarm notices.
  const alerts = await runAlerts(result);
  return { at, ...result, alerts };
}

// The latency SLOs, as the server reports them. Only asked when the server is up.
async function latencyReport() {
  try {
    const res = await fetch(`${TARGET}/api/status`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? (await res.json()).slos : null;
  } catch {
    return null;
  }
}

async function runAlerts(result) {
  const now = Date.now();
  const [badRows, saved, hours, slos] = await Promise.all([
    queryAll({ TableName: TABLE, KeyConditionExpression: "pk = :p AND sk >= :s", ExpressionAttributeValues: { ":p": "BAD", ":s": new Date(now - 6 * 3_600_000).toISOString() } }),
    db.send(new GetCommand({ TableName: TABLE, Key: { pk: "ALERT", sk: "STATE" } })),
    queryAll({ TableName: TABLE, KeyConditionExpression: "pk = :p AND sk >= :s", ExpressionAttributeValues: { ":p": "HOUR", ":s": new Date(now - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 13) } }),
    result.ok ? latencyReport() : null,
  ]);
  const badMinutes = hours.reduce((n, h) => n + (h.total ?? 0) - (h.good ?? 0), 0);
  const prev = saved.Item?.state ?? {};

  const { state, notifications } = decide({
    now, badTimes: badRows.map((b) => Date.parse(b.sk)), slos, prev, slo: SLO,
    budgetLeftMinutes: Math.round(BUDGET_MINUTES - badMinutes), budgetMinutes: Math.round(BUDGET_MINUTES),
    lastReason: badRows[badRows.length - 1]?.reason, statusUrl: `${TARGET}/status`, budgetUrl: process.env.BUDGET_URL,
  });

  for (const n of notifications) {
    await sns.send(new PublishCommand({ TopicArn: ALERT_TOPIC, Subject: n.subject, Message: n.body }));
    console.log("Alert sent", n.subject);
  }
  if (JSON.stringify(state) !== JSON.stringify(prev)) {
    await db.send(new PutCommand({ TableName: TABLE, Item: { pk: "ALERT", sk: "STATE", state, updatedAt: new Date(now).toISOString() } }));
  }
  return { firing: Object.entries(state).filter(([, s]) => s.firing).map(([id]) => id), sent: notifications.map((n) => n.subject) };
}

// --- The error budget, for the status page ---

async function queryAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await db.send(new QueryCommand({ ...params, ExclusiveStartKey }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// Burn rate: how fast the budget is being spent compared with the pace that would use it up
// exactly at the end of the window. 1 = right on pace. 14.4 sustained for an hour would burn
// 2% of the month's budget in that hour and empty it in about 2 days: that's worth waking someone up for.
function burnRate(badMinutes, windowMinutes) {
  return badMinutes / windowMinutes / (1 - SLO / 100);
}

let cache = null;

export async function budget() {
  if (cache && Date.now() - cache.at < 30_000) return respond(cache.body);

  const now = Date.now();
  const since = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();
  const [hours, bad] = await Promise.all([
    queryAll({ TableName: TABLE, KeyConditionExpression: "pk = :p AND sk >= :s", ExpressionAttributeValues: { ":p": "HOUR", ":s": since.slice(0, 13) } }),
    queryAll({ TableName: TABLE, KeyConditionExpression: "pk = :p AND sk >= :s", ExpressionAttributeValues: { ":p": "BAD", ":s": since }, ScanIndexForward: false }),
  ]);

  const total = hours.reduce((n, h) => n + (h.total ?? 0), 0);
  const good = hours.reduce((n, h) => n + (h.good ?? 0), 0);
  const badMinutes = total - good;
  const badSince = (ms) => bad.filter((b) => Date.parse(b.sk) >= now - ms).length;

  // The last 48 hours, one entry per hour (null = no checks ran that hour)
  const byHour = new Map(hours.map((h) => [h.sk, h]));
  const last48 = [];
  for (let i = 47; i >= 0; i--) {
    const key = new Date(now - i * 3_600_000).toISOString().slice(0, 13);
    const h = byHour.get(key);
    last48.push({ hour: key, total: h?.total ?? 0, good: h?.good ?? 0 });
  }

  const body = {
    slo: SLO,
    windowDays: WINDOW_DAYS,
    dataSince: hours[0] ? `${hours[0].sk}:00:00Z` : null,
    minutesChecked: total,
    goodMinutes: good,
    badMinutes,
    availability: total ? Math.round((good / total) * 100_000) / 1000 : null,
    budgetMinutes: Math.round(BUDGET_MINUTES),
    budgetLeftMinutes: Math.round(BUDGET_MINUTES - badMinutes),
    budgetLeftPercent: Math.round((1 - badMinutes / BUDGET_MINUTES) * 1000) / 10,
    burnRate1h: Math.round(burnRate(badSince(60 * MINUTE), 60) * 10) / 10,
    burnRate6h: Math.round(burnRate(badSince(360 * MINUTE), 360) * 10) / 10,
    recentBadMinutes: bad.slice(0, 10).map((b) => ({ at: b.sk, reason: b.reason })),
    last48,
  };
  cache = { at: Date.now(), body };
  return respond(body);
}

const respond = (body) => ({
  statusCode: 200,
  headers: { "content-type": "application/json", "cache-control": "public, max-age=30" },
  body: JSON.stringify(body),
});
