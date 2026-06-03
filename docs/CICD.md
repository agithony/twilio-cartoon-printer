# CI/CD

Production-grade CI for `twilio-cartoon-printer`. Code-quality gating lives in
`ci.yml`; deployment lives in `deploy.yml`. They compose through one seam: a CI
job named exactly **`Validate`**.

## Pipeline at a glance

```
PR opened ──▶ ci.yml (pull_request)
                ├─ Node Tests   (pnpm i + unit tests + /healthz smoke)
                ├─ Relay App     (npm ci + syntax check, relay-app/)
                ├─ Security      (pnpm/npm audit [soft] + gitleaks [hard])
                └─ Validate      (fails unless all three succeed)

merge to main ─▶ deploy.yml (push)
                ├─ ci  →  uses: ./.github/workflows/ci.yml   (same suite, re-run as the gate)
                └─ build-and-deploy   needs: ci, if success   (ACR build → Container App)
```

## Jobs (`.github/workflows/ci.yml`)

| Job | What it does | Gate |
|-----|--------------|------|
| **Node Tests** | `pnpm install --frozen-lockfile`, `pnpm test` (the `node --test` suite), then boots the prod server and curls `/healthz` on port 8080 | hard |
| **Relay App** | `npm ci` + `node --check` on `relay-app/*.js` (Electron GUI — not deployed, so install-integrity + syntax only) | hard |
| **Security** | `pnpm audit` + `npm audit` (advisory, `\|\| true`) and **gitleaks** secret scan (hard, via Docker CLI) | gitleaks hard; audits soft |
| **Validate** | Aggregator — succeeds only if all three jobs succeed | the gate |

Runtime is pinned to **Node 20** to match production (`Dockerfile: node:20-bullseye-slim`).

## Why a few things are the way they are

- **`pnpm test` uses `--test-force-exit`.** `axios` opens a keep-alive socket on
  `require`, so `node --test` would otherwise hang after the tests pass (the event
  loop never drains). The flag forces exit once tests complete. Backported to Node
  20.14, so it's available on the prod runtime.
- **`ci.yml` has NO `concurrency:` or `permissions:` blocks.** `deploy.yml` calls it
  via `workflow_call` under a read-only token; any such block makes a reusable
  workflow fail at startup. Concurrency lives on `deploy.yml` (`group: deploy-prod`).
- **gitleaks runs via the Docker CLI**, not `gitleaks-action` — the action needs a
  `pull-requests` permission scope, which would reintroduce a forbidden permissions
  block. The CLI scans the checkout with no token.
- **Validate is named exactly `Validate`.** The deploy gate (`needs: ci`) and the
  Dependabot auto-merge poller both key off this string. Do not rename it.

## Dependabot (`.github/dependabot.yml`)

Weekly updates, grouped minor/patch, for three ecosystems: root `npm` (`/`),
`relay-app` `npm` (`/relay-app`), and `github-actions` (`/`).

`.github/workflows/dependabot-auto-merge.yml` auto-approves and squash-merges
**minor/patch** updates once the `Validate` check passes (majors are left for manual
review). It uses `on: pull_request` with an explicit `permissions:` block — never
`pull_request_target` — and **polls** the `Validate` check (this private repo has no
required-status-checks to gate `--auto` on), fast-failing on any terminal non-success
state including `CANCELLED`.

## Deploy gate (`.github/workflows/deploy.yml`)

On push to `main`, the `ci` job re-runs the full suite; `build-and-deploy` runs only
`if: needs.ci.result == 'success'`. No secrets are forwarded to the CI call
(`GITHUB_TOKEN` is auto-provided). See the deploy workflow for the ACR build +
Container App update (with startup/readiness probes for zero-downtime deploys).
