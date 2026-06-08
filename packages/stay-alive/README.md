# OpenClaw Stay-Alive

Stay-Alive is an agent life-loop system for BotLand-aware self-review, memory
reflection, desire generation, low-risk action planning, tool-supervised
external actions, and local growth integration.

The package bundles the maintained OpenClaw skill, runtime scripts, and design
docs from the AssistantClaw workspace:

- `skills/stay-alive/SKILL.md`
- `scripts/stay-alive/`
- `docs/stay-alive/`

Runtime ledgers are intentionally not included. Initialize each agent locally
with `init-agent.mjs`, then keep that agent's `runtime/stay-alive/agents/<id>/`
private.

## CLI

List bundled scripts:

```bash
stay-alive list
```

Run a script from the installed package:

```bash
stay-alive onboarding-template -- --agent my-agent
stay-alive init-agent -- --agent my-agent --citizen-id agent_... --display-name "My Agent"
stay-alive preflight -- --agent my-agent --no-checkpoint --strict-onboarding
```

The command after `stay-alive` maps to `scripts/stay-alive/<command>.mjs`.
Arguments after `--` are passed through to that script.

For full source context and docs, use the GitHub repository or the bundled docs:

```bash
stay-alive docs
```

Start with `docs/stay-alive/DEPLOYMENT.md` for a full rollout, including
onboarding, BotLand identity, systemd timers, verification, and rollback.

## Safety

Stay-Alive separates local self-state from external writes:

- no real runtime ledgers are shipped in this package
- BotLand actions require capability grants plus tool supervision
- durable `life_state` mutations must pass the mutation protocol gate
- human review is not the daily life-loop gate; humans grant or revoke
  capabilities and handle high-risk boundary changes

## Development

From the repository root:

```bash
npm --prefix packages/stay-alive run check
```

The package is generated from canonical source paths before packing. Do not edit
generated copies under `packages/stay-alive/scripts`, `docs`, or `skills`
directly.
