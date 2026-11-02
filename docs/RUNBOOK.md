# Gobble Royale runbook

For whoever is on call. Each alert has its own section: **what it means → check → fix → confirm**.
Keep it short enough to follow half-asleep. If a step here was wrong or missing, fix this file after the incident.

## The service in 30 seconds

```
Player ──https/wss──► Caddy (443) ──► Node game server (127.0.0.1:8080)   on Lightsail "gobble-royale"
                                                                          98.88.244.8, us-east-1a
Uptime checker (Lambda, every minute) ──► /health + /play ──► alerts by email (SNS)
```

| Thing | Where |
|---|---|
| Game | https://gobble.98-88-244-8.sslip.io |
| Status page | https://gobble.98-88-244-8.sslip.io/status (served by the game server, so it's down when the game is down) |
| Error budget (works even when the game is down) | https://i32t6oxkiufd3b7cziawfzfrsy0bkpyp.lambda-url.us-east-1.on.aws/ |
| Server shell | [Lightsail console → gobble-royale → Connect using SSH](https://lightsail.aws.amazon.com/ls/webapp/us-east-1/instances/gobble-royale/connect) |
| Game service | `gobble` (systemd), code in `/opt/gobble`, previous version in `/opt/gobble.prev` |
| Web server | `caddy` (systemd), config `/etc/caddy/Caddyfile` |
| Scores | `/var/lib/gobble/scores.json` (saved every 5 s and on stop) |
| SLOs and alert rules | [SLO.md](SLO.md) |

## First 5 minutes of any alert

1. **Acknowledge.** Reply "on it" wherever people would ask (for a solo project: note the time you started).
2. **Look at impact first, cause second.** Open the error budget link above: how many bad minutes, and is it still failing?
3. **Mitigate before you investigate.** Get players back (restart, roll back), *then* work out why. A root cause can wait 10 minutes; players can't.
4. **Write down times as you go:** when it started, when you noticed, what you tried, when it recovered. You'll need them for the postmortem.

---

## [PAGE] Players can't reach Gobble Royale

**Means:** the uptime checker failed for at least 5 of the last 60 minutes and is still failing. Players can't load the game or can't connect.

**Check** (in the Lightsail browser SSH):
```bash
systemctl status gobble caddy --no-pager      # both should say "active (running)"
curl -s localhost:8080/health                 # the game itself, skipping Caddy
journalctl -u gobble -n 50 --no-pager         # why did it stop or crash?
```

**Fix, by what you found:**

| You see | Do |
|---|---|
| `gobble` inactive or failed | `sudo systemctl restart gobble` |
| `gobble` keeps restarting (crash loop) after a recent update | Roll back: `sudo mv /opt/gobble /opt/gobble.bad && sudo mv /opt/gobble.prev /opt/gobble && sudo systemctl restart gobble` |
| `gobble` fine but `caddy` failed | `sudo systemctl restart caddy`, then `journalctl -u caddy -n 50` (certificate problems show up here) |
| Both fine, `curl localhost:8080/health` works, site still down | Check the firewall: Lightsail console → Networking → ports 80 and 443 must be open to everyone |
| You can't connect to SSH at all | Lightsail console → gobble-royale → **Reboot**. Wait 2 minutes. Both services start on boot. |
| Out of memory (`journalctl` shows `Killed` / `MemoryMax`) | `sudo systemctl restart gobble`; then check `free -m` and the memory tile on /status |
| Disk full (`df -h /` shows 100%) | `sudo journalctl --vacuum-size=100M`, then restart |

While the game is down, players see a friendly "The farm is restarting" page (Caddy, status 503) that retries every 10 seconds, so a fast fix needs no announcement.

**Confirm:** `curl -s https://gobble.98-88-244-8.sslip.io/health` returns `{"ok":true,...}`. The `[RESOLVED]` email arrives 5 clean minutes later. If it doesn't, the checker may be broken (see below).

**After:** write a postmortem (template at the end) if it spent more than 10 minutes of budget or happened twice in a week.

---

## [TICKET] Slowly burning the error budget

**Means:** short failures keep happening (at least 11 bad minutes in 6 hours), but never enough at once to page. It's often a flapping service, a crash that restarts quickly, or the server running out of memory.

**Check:**
```bash
systemctl show gobble -p NRestarts            # restarts since boot; climbing = crashing
journalctl -u gobble --since "6 hours ago" --no-pager | grep -iE "error|killed|exit" | tail -20
free -m; df -h /
```
Recent bad minutes and their reasons are on the error budget link.

**Fix:** depends on the cause. A crash loop after a deploy → roll back (see the PAGE table). Memory climbing → restart now, then find the leak in working hours. **No hurry:** this is a "today, not tonight" problem.

---

## [TICKET] The game feels slow (latency SLO missed)

**Means:** a latency SLO on /status has been missed for 10 minutes in a row. Players can play, but it feels laggy. No error budget is spent.

**Check /status:**
- **Game tick time high:** too many players for one server, or a slow change in the game loop. Check `players online` and the event loop busy %.
- **Tick lateness high:** the CPU is busy with something else, or garbage collection pauses. Run `top` in SSH; Lightsail nano CPUs are burstable and slow down when burst credits run out (Lightsail console → Metrics → CPU).
- **Round trip high:** usually players far from us-east-1, or their networks. If it's everyone, check Lightsail → Metrics → network.
- **Page response high:** same causes as tick time.

**Fix:** if CPU credits ran out, the short-term fix is a bigger plan (Lightsail → Snapshots → create new instance from snapshot on the $7 plan, move the static IP). Long-term: profile the slow code with a load test (`npm run loadtest`) before the next deploy.

---

## [TICKET] The uptime checker stopped / is failing

**Means:** no outage alerts can be sent until it's fixed. The game itself may be fine.

**Check:** Lambda console → `gobble-royale-uptime-ProbeFunction-…` → Monitor → Logs. Look for the error. Also check EventBridge Scheduler → the `EveryMinute` schedule is enabled.

**Fix:** a code bug → fix and `cd uptime && sam deploy`. A permissions error → the template is the source of truth: redeploy it. Then send a test alert:
```bash
aws lambda invoke --function-name gobble-royale-uptime-ProbeFunction-LKXOJYu7kqtb --cli-binary-format raw-in-base64-out --payload '{"testAlert":true}' out.json
```

---

## Shipping and rolling back

| Task | How |
|---|---|
| Ship a new version | `bash update-lightsail.sh`, then paste the printed command into the Lightsail browser SSH. The game restarts (about 2 s down). |
| Roll back the last update | `sudo mv /opt/gobble /opt/gobble.bad && sudo mv /opt/gobble.prev /opt/gobble && sudo systemctl restart gobble` |
| Restart the game | `sudo systemctl restart gobble` (scores are saved first) |
| Restart the web server | `sudo systemctl restart caddy` |

During Thanksgiving week (Nov 23 to 29), ship fixes only. See the error budget policy in [SLO.md](SLO.md).

## Past incidents

Read these before your first on-call shift: [postmortems/](postmortems/)

| Date | What | Lesson |
|---|---|---|
| 2026-10-30 | [First Lightsail boot silently did nothing](postmortems/2026-10-30-first-boot-did-nothing.md) | "Machine running" isn't "game working": check from outside |
| 2026-11-02 | [Game day: planned 5-minute outage](postmortems/2026-11-02-gameday-outage.md) | The status page must live outside the thing it reports on |

## Postmortem template

Copy into `docs/postmortems/YYYY-MM-DD-short-name.md`. **Blameless:** describe what the system and the process allowed to happen, not who made a mistake. People make mistakes; good systems catch them.

```markdown
# <Title>
**Date:** · **Duration:** · **Budget spent:** __ of 216 minutes · **Severity:** PAGE / TICKET

## Summary            (2 or 3 sentences anyone can understand)
## Impact             (who noticed what, for how long)
## Timeline (UTC)     (started, detected, acknowledged, mitigated, resolved)
## Root cause         (keep asking "why?" until you reach something you can change)
## What went well
## What went badly
## Where we got lucky
## Action items       (each one: what, owner, due date, ticket)
```
