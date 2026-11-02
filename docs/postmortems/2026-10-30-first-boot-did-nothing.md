# First Lightsail boot silently did nothing

**Date:** 2026-10-30 · **Duration:** about 12 minutes · **Budget spent:** none (before launch, before SLOs) · **Severity:** would have been PAGE
**Format:** blameless

## Summary

The new $5 Lightsail server booted, but its setup script stopped on its first command. Nothing was installed, so nothing answered on port 80 or 443. No error showed up anywhere obvious; it was found only because a manual check timed out. The cause was one bash-only line in a script that Lightsail runs with `sh`.

## Impact

None for players: this happened while moving the game from ECS to Lightsail, before anyone had the new link. It delayed the move by about 12 minutes.

## Timeline (UTC)

| Time | What happened |
|---|---|
| 20:12 | Server created with `infra/lightsail-setup.sh` as its launch script |
| 20:13:32 | cloud-init logs a warning that the launch script failed. Nobody is watching cloud-init logs. |
| 20:13 to 20:20 | Waiting for HTTPS to come up; the wait loop times out after 7 minutes |
| 20:20 | Port 80 and 443 both refuse connections: Caddy was never installed. Opened SSH to look. |
| 20:22 | `/var/log/cloud-init-output.log`: `set: Illegal option -o pipefail` |
| 20:24 | Fixed the script, copied it to the server, ran it with `sh` |
| 20:26 | HTTPS up with a valid certificate. Resolved. |

## Root cause (5 whys)

1. **Why was the site down?** Caddy and the game were never installed.
2. **Why weren't they installed?** The setup script stopped on its first command.
3. **Why did it stop?** `set -euxo pipefail` is bash syntax, and the script was run by `sh` (dash on Ubuntu), which rejects `-o pipefail`.
4. **Why was it run by `sh` when it starts with `#!/bin/bash`?** Lightsail adds its own lines to the top of the launch script, so the `#!` line is no longer first and is ignored. The combined script runs under `/bin/sh`.
5. **Why didn't we catch it before running it?** The script was only syntax-checked with `bash -n`, which accepts bash syntax. Nothing checked it as `sh`, and nothing tested it on a real Lightsail boot first.

## What went well

- The wait loop had a timeout, so the problem surfaced in 7 minutes instead of hanging forever.
- The failure was in a log (`cloud-init-output.log`) with a clear message, once someone looked.
- The fix was small and easy to rerun: the script is safe to run twice.

## What went badly

- **The failure was silent.** The server reported "running" to Lightsail; only the application was missing. A health check that says "the machine is up" isn't the same as "the game works".
- **We tested with the wrong shell** (`bash -n` instead of `sh -n`).
- **The script's download link expired** (S3 links last at most 15 minutes) while debugging, so a new one had to be made to rerun it.

## Where we got lucky

No players yet. The same failure while rebuilding a server during Thanksgiving week would have been a full outage, and at the time nothing would have alerted us.

## Action items

| # | Action | Status |
|---|---|---|
| 1 | Make the setup script plain `sh` (no bash-only syntax) and note why at the top | ✅ Done |
| 2 | Check the setup script with `sh -n` and ShellCheck in `sh` mode (`shellcheck -s sh`) on every change: `sh -n` alone misses runtime-only options like `pipefail` | Open: phase 5 CI |
| 3 | Outside uptime checks with alerts, so a "running but broken" server is noticed in minutes | ✅ Done (phases 2 and 3) |
| 4 | Have the setup script fail loudly: end with a check that `/health` answers through Caddy, and log a clear "SETUP FAILED" line otherwise | Open |
