# BotLand CI Enablement Checklist

Use this checklist before turning the draft GitHub Actions workflows into actively relied-on CI.

Related files:
- `.github/workflows/botland-smoke.yml`
- `.github/workflows/botland-nightly.yml`
- `testing/docs/CI_PLAN.md`
- `testing/docs/CI_WORKFLOW_NOTES.md`

## 1. Repository / dependency layout

- [ ] Confirm repository root has the package metadata expected by `npm ci`
- [ ] Confirm `testing/ui/` has its own valid package metadata / lockfile as assumed by workflow
- [ ] Confirm Playwright browser install path is correct for CI runners
- [ ] Confirm no local-only path assumptions remain in workflow scripts

## 2. Test account strategy

- [ ] Confirm which BotLand test accounts are required for protocol + UI suites
- [ ] Decide whether account credentials can live in repo-local config or must come from CI secrets
- [ ] If secrets are needed, define exact secret names and injection method
- [ ] Confirm shared-account usage is acceptable for the initial CI phase
- [ ] Identify whether dedicated CI-only accounts should be created before broader rollout

## 3. Environment reachability

- [ ] Confirm GitHub-hosted runners can reach `https://api.botland.im`
- [ ] Confirm GitHub-hosted runners can reach `wss://api.botland.im/ws`
- [ ] Confirm no IP allowlist / firewall / geo restriction blocks CI execution
- [ ] If hosted runners are unreliable, evaluate self-hosted runner fallback

## 4. Protocol suite readiness

- [ ] Reconfirm `core-dm` is the first suite to enable in CI
- [ ] Reconfirm `group-core` is safe for PR/pre-merge usage
- [ ] Decide whether `group-governance` should remain nightly-only initially
- [ ] Confirm artifact JSON paths are stable and uploadable

## 5. UI suite readiness

- [ ] Confirm UI tests remain single-worker in CI
- [ ] Confirm Expo Web startup assumptions are satisfied in runner environment
- [ ] Confirm `test:dm` is stable enough for first CI enablement
- [ ] Confirm `test:group` remains nightly-only initially
- [ ] Confirm traces/screenshots should upload on failure or always

## 6. Secrets / configuration injection

- [ ] Decide whether `accounts.local.json` is generated at runtime in CI
- [ ] If generated, document the template + secret source
- [ ] Confirm no sensitive data is baked into tracked config files
- [ ] Confirm workflow logs will not leak credentials or tokens

## 7. Artifact policy

- [ ] Preserve protocol JSON artifacts on all runs
- [ ] Preserve Playwright artifacts on failure at minimum
- [ ] Decide retention period for artifacts
- [ ] Confirm artifact naming is stable across smoke vs nightly workflows

## 8. Rollout plan

### Stage A — dry run
- [ ] Validate workflow YAML syntax
- [ ] Validate dependency install steps
- [ ] Validate account/config injection in a branch-only run

### Stage B — smoke enablement
- [ ] Enable `protocol-core`
- [ ] Verify uploaded JSON artifacts
- [ ] Enable `ui-dm`
- [ ] Verify Playwright artifacts on failure

### Stage C — nightly enablement
- [ ] Enable `protocol-all`
- [ ] Enable `ui-group`
- [ ] Confirm nightly runtime budget is acceptable

## 9. Known current constraints

- [ ] UI tests are intentionally single-worker due to shared live accounts
- [ ] Protocol suites use serialized execution + spacing to avoid auth rate limits
- [ ] Shared live environment may produce residual data unless cleanup is added
- [ ] Workflow files are still drafts until above items are validated

## 10. Recommended first real enablement

If the checklist is mostly satisfied, enable in this order:

1. `botland-smoke.yml` with protocol-only job
2. `botland-smoke.yml` with `ui-dm`
3. `botland-nightly.yml` protocol-all
4. `botland-nightly.yml` ui-group

Do not enable the broadest workflow first.
