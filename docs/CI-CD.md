# How changes reach players

```
git push ──► CI (every branch, every pull request)
              ├─ Unit tests ........ game rules, metrics, alert rules (simulated outages)
              ├─ Lint .............. ShellCheck (setup script as plain sh), cfn-lint, Caddyfile on Caddy 2.6.2
              └─ Load test ......... 60 players for 30 s; any SLO missed = red build
                     │
                     ▼ green, on main only
            Deploy
              ├─ Anything to deploy? ... skip if server/ and the Caddyfile are unchanged
              ├─ Deploy gate ........... error budget > 25% and not in a freeze, or "emergency" + reason
              ├─ AWS credentials ....... short-lived, via GitHub OIDC (no stored keys)
              ├─ Install ............... bundle + VERSION, gobble-update, Caddy only if changed and valid
              ├─ Smoke test ............ new version in /health, pages load, game connection opens
              └─ Failed? ............... roll back to /opt/gobble.prev automatically, then fail loudly
```

Workflows: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) and [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

## Why each check exists

Every check is there because of something that went wrong, or nearly did:

| Check | Because |
|---|---|
| `shellcheck -s sh infra/lightsail-setup.sh` | [2026-10-30](postmortems/2026-10-30-first-boot-did-nothing.md): a bash-only `set -o pipefail` killed the first boot. `sh -n` doesn't catch it; ShellCheck in sh mode reports SC3040. ShellCheck also found a dead `HOST` variable on its first run. |
| Validate the Caddyfile with **Caddy 2.6.2** | [Game day](postmortems/2026-11-02-gameday-outage.md): a config used syntax that only Caddy 2.7+ understands. CI uses the exact version production runs (checked against its published checksum). |
| Load test as a gate | [Phase 1](observability.md#what-phase-1-found): timer drift made the game run 20% slow, and only a load test showed it. Now a slower change can't merge unnoticed. |
| Alert-rule tests | They predicted the game day's page to the minute. If someone "simplifies" the burn-rate rules, the simulated outages catch it. |
| `.gitattributes` with `eol=lf` | Windows checkouts turn line endings into CRLF, which breaks shell scripts under `sh`. |

## The deploy gate

[`scripts/deploy-gate.mjs`](../scripts/deploy-gate.mjs) puts the [error budget policy](SLO.md#error-budget-policy) into code:

| Situation | Result |
|---|---|
| Budget above 25%, no freeze | ✅ Deploy |
| Budget at or below 25% | 🛑 Blocked: reliability fixes only |
| Nov 23 to 29 (Thanksgiving week) | 🛑 Blocked: freeze |
| Budget can't be read | 🛑 Blocked: don't deploy blind |
| Any of the above, run by hand with **emergency** and a **reason** | 🚨 Deploys, and prints what the gate would have said |

The emergency switch exists because a gate with no override gets deleted the first time it blocks an urgent fix.

## Proving the deploy worked

The bundle includes a `VERSION` file with the git commit. `/health` reports it. [`scripts/smoke.mjs`](../scripts/smoke.mjs) waits until `/health` reports the **new** commit (so it can't be fooled by the old version still answering), then checks the game page, the status page, the API, and that the game connection opens.

If any of that fails, [`scripts/deploy-lightsail-ci.sh`](../scripts/deploy-lightsail-ci.sh) swaps `/opt/gobble.prev` back in, checks the game is serving again, and fails the workflow with the failed version kept in `/opt/gobble.bad` for debugging.

## Security

- **No AWS keys in GitHub.** GitHub proves who it is with an OIDC token; AWS gives back credentials that last at most an hour.
- **Only `main` can deploy** ([`infra/github-deploy-role.yaml`](../infra/github-deploy-role.yaml)): the role trusts `repo:Rajpreet12@147854707/gobble-royale@1443637910:ref:refs/heads/main` and nothing else. GitHub's tokens name the repo with **permanent numeric IDs**, so a repo re-created under the same name by someone else can't inherit the access. (The first deploy failed because the trust used the older name-only form; CloudTrail's `AssumeRoleWithWebIdentity` event showed the exact subject GitHub sent.)
- **Changing a role parameter needs `--parameter-overrides`.** `aws cloudformation deploy` keeps a stack's previous parameter values, even when the template's default changes. A pull request from a fork can run CI but can never get credentials.
- **Least privilege:** five Lightsail actions on one instance. That's still powerful (an SSH certificate there means sudo), which is why the branch rule matters.
- **SSH is open only to the runner, only during the deploy.** The firewall is restored by a `trap`, even if the deploy fails halfway.
- **The server's host key is pinned** from Lightsail's API, so the connection can't be intercepted.
- **Only pushes to this repository deploy.** The deploy runs on `workflow_run`, which also fires when CI finishes on a pull request from a fork, and a fork's branch can be named `main`. The job checks `workflow_run.event == 'push'` and that the commit came from this repository. Without that, anyone could run their own script with our AWS role (a "pwn request"). Found when the repo turned out to be public.
- **Tool versions are pinned** (ShellCheck, cfn-lint, Caddy), so CI and a laptop give the same answer. The first CI run failed on a script that passed locally, because the runner's older ShellCheck reports some checks under different codes.
- **Inputs go through `env`**, never pasted into shell commands (`${{ inputs.reason }}` in a `run:` line would let anyone who can trigger the workflow run commands).

## Running it yourself

| Want to | Do |
|---|---|
| Run what CI runs | `cd server && npm test`, `node --test uptime/test/alerts.test.mjs`, and the load test in [observability.md](observability.md#load-testing) |
| Deploy | Merge to `main`. That's it. |
| Redeploy the same commit | Actions → Deploy → Run workflow |
| Urgent fix during a freeze or with a low budget | Actions → Deploy → Run workflow, tick **emergency**, give a reason |
| Deploy without GitHub | `bash update-lightsail.sh` (prints a command for the Lightsail browser SSH) |

The uptime checker (`uptime/`) and the deploy role are deployed by hand with SAM or CloudFormation; they change rarely, and the role deliberately can't modify itself.
