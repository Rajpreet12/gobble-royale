// Alert rules: when to wake someone up, when to leave a note for tomorrow, and when to stay quiet.
//
// No AWS code in here on purpose: decide() takes what happened and returns what to send, so the
// rules can be tested with a fake timeline (see test/alerts.test.mjs) instead of a real outage.
//
// Two ideas from Google's SRE workbook:
//   Multi-window burn rate: an alert fires only if the budget is burning fast over a LONG window
//     (so one blip can't trigger it) AND a SHORT window (so it's still happening, and it clears
//     soon after the problem does).
//   Page vs ticket: a page means act now, even at 3 AM. A ticket means look tomorrow.

export const RULES = [
  {
    id: "page", kind: "PAGE", longMin: 60, shortMin: 5, burn: 14.4,
    title: "Players can't reach Gobble Royale",
    meaning: "At this rate the whole month's error budget is gone in about 2 days.",
  },
  {
    id: "ticket", kind: "TICKET", longMin: 360, shortMin: 30, burn: 6,
    title: "Gobble Royale is slowly burning its error budget",
    meaning: "At this rate the whole month's error budget is gone in about 5 days.",
    // Inhibition: a big outage also trips the slow rule. While the page is firing, this one stays
    // quiet so one problem sends one email.
    inhibitedBy: "page",
  },
];

// Latency SLOs (from the server's /api/status) open a ticket if missed for 10 checks in a row,
// and clear after 3 good checks in a row, so a borderline number doesn't flap open and shut.
export const LATENCY = { missesToFire: 10, oksToClear: 3 };

// While an alert keeps firing, remind once an hour so it isn't forgotten.
export const REMIND_EVERY_MS = 60 * 60_000;

export const burnRate = (badMinutes, windowMinutes, slo) => badMinutes / windowMinutes / (1 - slo / 100);

const round1 = (v) => Math.round(v * 10) / 10;

// now: ms · badTimes: ms timestamps of bad minutes (last 6 hours is enough) · slos: the server's
// latency report, or null if the server couldn't be reached · prev: alert state from last minute.
// Returns the new state and the notifications to send.
export function decide({ now, badTimes, slos, prev, slo, budgetLeftMinutes, budgetMinutes, lastReason, statusUrl, budgetUrl }) {
  const state = structuredClone(prev ?? {});
  const notifications = [];
  const badIn = (min) => badTimes.filter((t) => t > now - min * 60_000).length;

  function transition(id, firing, info) {
    const cur = state[id] ?? { firing: false };
    const inhibited = info.inhibitedBy && state[info.inhibitedBy]?.firing;
    const send = (event) => {
      notifications.push(message({ id, event, now, since: cur.since ?? now, ...info, budgetLeftMinutes, budgetMinutes, lastReason, statusUrl, budgetUrl }));
      cur.notified = true;
      cur.lastNotified = now;
    };
    if (firing && !cur.firing) {
      // If it starts while the page is firing, it's part of the same outage: mark it covered and
      // keep it quiet until it clears, even after the page resolves. One outage, two emails.
      Object.assign(cur, { firing: true, since: now, notified: false, covered: Boolean(inhibited) });
      if (!inhibited) send("firing");
    } else if (firing && cur.firing && !inhibited && !cur.covered) {
      if (now - cur.lastNotified >= REMIND_EVERY_MS) send("reminder");
    } else if (!firing && cur.firing) {
      if (cur.notified) send("resolved");
      Object.assign(cur, { firing: false, notified: false, covered: false });
      delete cur.since;
    }
    state[id] = cur;
  }

  // Availability rules, page first so the ticket can see whether it's inhibited
  for (const r of RULES) {
    const longBurn = burnRate(badIn(r.longMin), r.longMin, slo);
    const shortBurn = burnRate(badIn(r.shortMin), r.shortMin, slo);
    transition(r.id, longBurn >= r.burn && shortBurn >= r.burn, {
      kind: r.kind, title: r.title, meaning: r.meaning, inhibitedBy: r.inhibitedBy,
      detail: `${badIn(r.longMin)} bad minutes in the last ${r.longMin} (burn rate ${round1(longBurn)}×, alert at ${r.burn}×), ${badIn(r.shortMin)} in the last ${r.shortMin}.`,
    });
  }

  // Latency rules. No report (server unreachable) means no change: the availability page covers that.
  for (const s of slos ?? []) {
    const id = `latency:${s.id}`;
    const cur = state[id] ?? { firing: false, misses: 0, oks: 0 };
    if (s.met === false) { cur.misses = (cur.misses ?? 0) + 1; cur.oks = 0; }
    else if (s.met === true) { cur.oks = (cur.oks ?? 0) + 1; cur.misses = 0; }
    state[id] = cur;
    const firing = cur.firing ? cur.oks < LATENCY.oksToClear : cur.misses >= LATENCY.missesToFire;
    const value = s[s.percentile];
    transition(id, firing, {
      kind: "TICKET", title: `Gobble Royale feels slow: ${s.name}`,
      meaning: "Players can still play, but it feels worse. No error budget is spent.",
      detail: `${s.name} ${s.percentile} is ${value ?? "unknown"} ms (target under ${s.targetMs} ms), missed for ${Math.max(cur.misses, LATENCY.missesToFire)}+ checks in a row.`,
    });
  }

  return { state, notifications };
}

// The email. It says what's wrong, how bad, and the first things to try, because whoever reads it
// may have just been woken up.
function message({ id, event, now, since, kind, title, meaning, detail, budgetLeftMinutes, budgetMinutes, lastReason, statusUrl, budgetUrl }) {
  const minutes = Math.round((now - since) / 60_000);
  // Email subjects must be plain ASCII (an SNS rule), so the tags are words, not emoji.
  const tag = event === "resolved" ? "[RESOLVED]" : kind === "PAGE" ? "[PAGE]" : "[TICKET]";
  const subject = `${tag}: ${title}${event === "reminder" ? ` (still firing, ${minutes} min)` : ""}`.slice(0, 99);
  const lines = event === "resolved"
    ? [
        `Resolved after ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        ``,
        `Error budget: ${budgetLeftMinutes} of ${budgetMinutes} minutes left.`,
        `If it spent budget, write a short postmortem: what happened, why, and what will stop it happening again.`,
      ]
    : [
        `WHAT: ${detail}`,
        `MEANS: ${meaning}`,
        `ERROR BUDGET: ${budgetLeftMinutes} of ${budgetMinutes} minutes left.`,
        ...(id.startsWith("latency") || !lastReason ? [] : [`LAST FAILURE: ${lastReason}`]),
        ``,
        `FIRST STEPS`,
        // Game day 2026-11-02: /status is served by the game server, so it's down exactly when
        // you need it. The error budget link runs elsewhere and keeps working.
        `1. Look: ${budgetUrl ?? statusUrl} (works even when the game is down; ${statusUrl} won't load if the game is down)`,
        `2. Connect: Lightsail console > gobble-royale > Connect using SSH`,
        `3. Check: systemctl status gobble caddy   and   journalctl -u gobble -n 50`,
        `4. Quick fix if it's down: sudo systemctl restart gobble caddy`,
        `Full steps: docs/RUNBOOK.md in the project.`,
      ];
  return { id, event, kind, subject, body: `${lines.join("\n")}\n\nSent ${new Date(now).toISOString()} by the Gobble Royale uptime checker.` };
}
