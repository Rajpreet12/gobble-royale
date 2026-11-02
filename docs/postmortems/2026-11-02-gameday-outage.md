# Game day: planned 5-minute outage

**Date:** 2026-11-02 · **Duration:** 5 min 17 s · **Budget spent:** 5 of 216 minutes (2.3%) · **Severity:** PAGE (planned)
**Plan:** [gameday-2026-11-02.md](../gameday-2026-11-02.md) · **Format:** blameless

## Summary

We deliberately stopped the game server in production to test detection, paging and the runbook before Thanksgiving. Every planned step worked: the outage was detected in 28 seconds, paged at the 5th bad minute, fixed with the runbook in under a minute, and cleared with exactly two emails. The test also found two real problems, which are now fixed: the status page goes down with the game, and players saw a blank error page.

## Impact

No real players (0 online, checked before starting). Anyone visiting during the 5 minutes would have seen a blank `502` page and been unable to play. 5 minutes of the month's 216-minute error budget were spent, on purpose.

## Timeline (UTC)

| Time | What happened |
|---|---|
| 16:43:52 | Go/no-go: 0 players online, error budget 100%. **Go.** |
| 16:44:35 | Experiment 1: `kill -9` the game process (hard crash) |
| 16:44:38 | systemd restarted it by itself, **2.4 s** later. No bad minute, no alert. ✅ |
| 16:46:59 | Experiment 2: `systemctl stop gobble`. **Outage starts.** |
| 16:47:27 | First bad minute recorded (`/health answered 502`). **Detected in 28 s.** |
| 16:51:27 | 5th bad minute: 1-hour burn rate 16.7×, over the 14.4× threshold |
| 16:51:28 | **[PAGE] sent**, 4 min 29 s after the outage began |
| 16:52:03 | Responder acknowledges and runs the runbook checks |
| 16:52:14 | Runbook table: "gobble inactive → restart". `systemctl restart gobble` |
| 16:52:16 | **Game back.** `/health` 200. Outage over: 5 min 17 s. |
| 16:57:26 | **[RESOLVED] sent** after 5 clean minutes. Two emails in total. ✅ |

**Key numbers:** time to detect 28 s · time to page 4 min 29 s · time from page to fix 48 s · total 5 min 17 s.

## Root cause

Planned: the game service was stopped by hand. The interesting question is what *else* the outage exposed:

1. **The status page is served by the game server.** When the game is down, `/status` is down too, so the alert email's first step ("Look: /status") pointed the responder to a `502`. A status page has to live somewhere other than the thing it reports on.
2. **No error page.** With the game down, Caddy returned an empty `502`. Players would have had no idea whether to wait or leave, and the page never retried by itself.

## What went well

- **Every alert behaved exactly as the unit tests predicted:** page at the 5th bad minute, resolve 5 clean minutes after recovery, two emails. Testing the alert rules as code paid off.
- **A hard crash healed itself in 2.4 s** with no page. systemd's `Restart=always` handles the most common failure without waking anyone up.
- **The runbook's check table pointed straight at the fix:** 11 seconds from first command to restart.
- **No scores were lost.** The service saves scores when it stops.
- **The error budget policy made this a non-event to approve:** spending 2.3% of the budget on learning is what the budget is for.
- **Validating config before reloading caught a mistake before production.** The first friendly-error-page config used syntax the server's Caddy 2.6 doesn't support; `caddy validate` rejected it, and the live site never saw it.

## What went badly

- The status page was unreachable during the outage (root cause 1).
- Players got a blank `502` (root cause 2).
- **Availability showed 87.8%,** which looks alarming but covered only 41 minutes of history. Early on, "5 of 216 budget minutes used" is the honest number; the percentage isn't.
- **The responder's temporary SSH certificate expired mid-session.** Lightsail's laptop SSH certificates are short-lived. The runbook already says to use the browser SSH in the Lightsail console, which doesn't have this problem, but it slowed down the follow-up work.

## Where we got lucky

- **The responder was already at the keyboard, waiting for the page.** The 48 seconds from page to fix doesn't include waking up, finding a phone and logging in, which in a real 3 AM outage is the slowest part. Time to acknowledge for a real person is still unmeasured.
- The slow-burn ticket never crossed its threshold (6-hour burn rate 2.8×, alert at 6×), so the "one outage, one conversation" rule was only proven by the unit test, not live.

## Action items

| # | Action | Status | Owner | Due |
|---|---|---|---|---|
| 1 | Alert emails link to the error budget page (works when the game is down) instead of `/status` | ✅ Done today, with a regression test | Rajpreet | 2026-11-02 |
| 2 | Caddy serves a friendly "the farm is restarting" page (503, retries every 10 s) when the game is down | ✅ Done today; also in `infra/lightsail-setup.sh` | Rajpreet | 2026-11-02 |
| 3 | Host the status page outside the game server (an S3 page reading `/api/status` and the budget API) | Open | Rajpreet | 2026-11-16 |
| 4 | Status page: show "budget minutes used" first and mark availability as early data while under 7 days of history | Open | Rajpreet | 2026-11-09 |
| 5 | Run an unannounced game day at a random time, and measure when the page actually reached the phone and when it was acknowledged | Open | Rajpreet | 2026-11-20 |
| 6 | Decide whether a total outage should page faster (for example, 3 bad minutes in a row) or keep the 5-minute burn rule. Trade-off: faster pages vs more false pages. | Open: decision needed | Rajpreet | 2026-11-09 |
