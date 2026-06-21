#!/usr/bin/env bash
set -euo pipefail

agent="${1:-badclaw}"
workspace="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
runtime_root="${STAY_ALIVE_RUNTIME_ROOT:-}"
runtime_args=()
if [[ -n "$runtime_root" ]]; then
  runtime_args=(--runtime-root "$runtime_root")
fi
botland_health_url="${STAY_ALIVE_BOTLAND_HEALTH_URL:-}"
botland_service="${STAY_ALIVE_BOTLAND_SERVICE:-}"
event_trigger_port="${STAY_ALIVE_EVENT_TRIGGER_PORT:-}"
dm_reply_model="${STAY_ALIVE_DM_REPLY_MODEL:-}"
dm_reply_model_environment=""
if [[ -n "$dm_reply_model" ]]; then
  dm_reply_model_environment="Environment=STAY_ALIVE_DM_REPLY_MODEL=${dm_reply_model}"
fi

if [[ -z "$botland_health_url" ]]; then
  case "$agent" in
    lobster-duck) botland_health_url="http://127.0.0.1:3102/health" ;;
    *) botland_health_url="http://127.0.0.1:3100/health" ;;
  esac
fi

if [[ -z "$event_trigger_port" ]]; then
  case "$agent" in
    lobster-duck) event_trigger_port="8788" ;;
    *) event_trigger_port="8787" ;;
  esac
fi

if [[ -z "$botland_service" ]]; then
  case "$agent" in
    lobster-duck) botland_service="botland-daemon-lobster-duck.service" ;;
    *) botland_service="botland-daemon.service" ;;
  esac
fi

mkdir -p "$unit_dir"

write_service() {
  local cycle="$1"
  local service="$unit_dir/stay-alive-${agent}-${cycle}.service"
  local runner="run-cycle.mjs"
  local runner_args="--agent ${agent} --cycle ${cycle} --dry-run --write-daemon-state"
  if [[ "$cycle" == "light" || "$cycle" == "social" || "$cycle" == "community" ]]; then
    runner="autonomous-social-cycle.mjs"
    runner_args="--agent ${agent} --cycle ${cycle} --execute --confirm-send SEND_DRAFT --json"
  fi

  cat >"$service" <<EOF_SERVICE
[Unit]
Description=Stay-Alive ${cycle} cycle for ${agent}

[Service]
Type=oneshot
WorkingDirectory=${workspace}
Environment=PATH=${HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
${dm_reply_model_environment}
ExecStartPre=/usr/bin/env node ${workspace}/scripts/stay-alive/preflight.mjs --agent ${agent} ${runtime_args[*]} --limit 50 --no-checkpoint --require-botland-live --allow-botland-polling-fallback
ExecStart=/usr/bin/env node ${workspace}/scripts/stay-alive/${runner} ${runner_args} ${runtime_args[*]}
EOF_SERVICE
}

write_event_wakeup_service() {
  local service="$unit_dir/stay-alive-${agent}-event-wakeup.service"

  cat >"$service" <<EOF_SERVICE
[Unit]
Description=Stay-Alive event wakeup bridge for ${agent}

[Service]
Type=oneshot
WorkingDirectory=${workspace}
Environment=PATH=${HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
${dm_reply_model_environment}
ExecStart=/usr/bin/env node ${workspace}/scripts/stay-alive/event-wakeup.mjs --agent ${agent} ${runtime_args[*]} --run --record --require-botland-live --allow-botland-polling-fallback --cooldown-minutes 0 --json
EOF_SERVICE
}

write_event_trigger_service() {
  local service="$unit_dir/stay-alive-${agent}-event-trigger.service"

  cat >"$service" <<EOF_SERVICE
[Unit]
Description=Stay-Alive immediate BotLand event trigger for ${agent}
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${workspace}
Environment=PATH=${HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
${dm_reply_model_environment}
ExecStart=/usr/bin/env node ${workspace}/scripts/stay-alive/botland-event-trigger-server.mjs --agent ${agent} ${runtime_args[*]} --port ${event_trigger_port} --json
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF_SERVICE
}

write_watchdog_service() {
  local service="$unit_dir/stay-alive-${agent}-botland-watchdog.service"

  cat >"$service" <<EOF_SERVICE
[Unit]
Description=Stay-Alive BotLand daemon watchdog for ${agent}

[Service]
Type=oneshot
WorkingDirectory=${workspace}
Environment=PATH=${HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
${dm_reply_model_environment}
ExecStart=/usr/bin/env node ${workspace}/scripts/stay-alive/botland-daemon-watchdog.mjs --agent ${agent} ${runtime_args[*]} --health-url ${botland_health_url} --service ${botland_service} --record --confirm-restart RESTART_BOTLAND_DAEMON --json
EOF_SERVICE
}

write_local_governance_service() {
  local service="$unit_dir/stay-alive-${agent}-local-governance.service"

  cat >"$service" <<EOF_SERVICE
[Unit]
Description=Stay-Alive local governance cycle for ${agent}

[Service]
Type=oneshot
WorkingDirectory=${workspace}
Environment=PATH=${HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
${dm_reply_model_environment}
ExecStart=/usr/bin/env node ${workspace}/scripts/stay-alive/local-governance-cycle.mjs --agent ${agent} ${runtime_args[*]} --execute --confirm-governance RUN_LOCAL_GOVERNANCE --json
EOF_SERVICE
}

write_service_recovery_service() {
  local service="$unit_dir/stay-alive-${agent}-service-recovery.service"

  cat >"$service" <<EOF_SERVICE
[Unit]
Description=Stay-Alive service failure recovery for ${agent}

[Service]
Type=oneshot
WorkingDirectory=${workspace}
Environment=PATH=${HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
${dm_reply_model_environment}
ExecStart=/usr/bin/env node ${workspace}/scripts/stay-alive/service-failure-recovery.mjs --agent ${agent} ${runtime_args[*]} --execute --confirm-recovery RECOVER_FAILED_SERVICES --json
EOF_SERVICE
}

write_timer() {
  local cycle="$1"
  local schedule="$2"
  local timer="$unit_dir/stay-alive-${agent}-${cycle}.timer"
  local randomized_delay="120"
  if [[ "$cycle" == "event-wakeup" ]]; then
    randomized_delay="10"
  fi

  cat >"$timer" <<EOF_TIMER
[Unit]
Description=Schedule Stay-Alive ${cycle} cycle for ${agent}

[Timer]
OnCalendar=${schedule}
Persistent=true
RandomizedDelaySec=${randomized_delay}

[Install]
WantedBy=timers.target
EOF_TIMER
}

write_service light
write_timer light "*:0/30"
write_service social
write_timer social "00,04,08,12,16,20:15"
write_service community
write_timer community "02,06,10,14,18,22:25"
write_service reflect
write_timer reflect "09,21:00"
write_service integrate
write_timer integrate "23:30"
write_event_wakeup_service
write_timer event-wakeup "*:*"
write_event_trigger_service
write_watchdog_service
write_timer botland-watchdog "*:0/2"
write_local_governance_service
write_timer local-governance "01,07,13,19:40"
write_service_recovery_service
write_timer service-recovery "*:0/10"

systemctl --user daemon-reload

cat <<EOF_DONE
Installed user systemd units for ${agent}:
  stay-alive-${agent}-light.service
  stay-alive-${agent}-light.timer
  stay-alive-${agent}-social.service
  stay-alive-${agent}-social.timer
  stay-alive-${agent}-community.service
  stay-alive-${agent}-community.timer
  stay-alive-${agent}-reflect.service
  stay-alive-${agent}-reflect.timer
  stay-alive-${agent}-integrate.service
  stay-alive-${agent}-integrate.timer
  stay-alive-${agent}-event-wakeup.service
  stay-alive-${agent}-event-wakeup.timer
  stay-alive-${agent}-event-trigger.service
  stay-alive-${agent}-botland-watchdog.service
  stay-alive-${agent}-botland-watchdog.timer
  stay-alive-${agent}-local-governance.service
  stay-alive-${agent}-local-governance.timer
  stay-alive-${agent}-service-recovery.service
  stay-alive-${agent}-service-recovery.timer

Review first:
  systemctl --user cat stay-alive-${agent}-light.service
  systemctl --user cat stay-alive-${agent}-social.service
  systemctl --user cat stay-alive-${agent}-community.service
  systemctl --user cat stay-alive-${agent}-reflect.service
  systemctl --user cat stay-alive-${agent}-integrate.service
  systemctl --user cat stay-alive-${agent}-event-wakeup.service
  systemctl --user cat stay-alive-${agent}-event-trigger.service
  systemctl --user cat stay-alive-${agent}-botland-watchdog.service
  systemctl --user cat stay-alive-${agent}-local-governance.service
  systemctl --user cat stay-alive-${agent}-service-recovery.service

Each service runs preflight before the cycle:
  node ${workspace}/scripts/stay-alive/preflight.mjs --agent ${agent} ${runtime_args[*]} --limit 50 --no-checkpoint --require-botland-live --allow-botland-polling-fallback

Autonomous social services:
  light/social/community use autonomous-social-cycle.mjs with --execute --confirm-send SEND_DRAFT.
  That wrapper still requires preflight, identity match, active tool supervision,
  local action ledger, immediate inspect-send, action-outcome, and rate-limit update.

Enable when ready:
  systemctl --user enable --now stay-alive-${agent}-light.timer
  systemctl --user enable --now stay-alive-${agent}-social.timer
  systemctl --user enable --now stay-alive-${agent}-community.timer
  systemctl --user enable --now stay-alive-${agent}-reflect.timer
  systemctl --user enable --now stay-alive-${agent}-integrate.timer
  systemctl --user enable --now stay-alive-${agent}-event-wakeup.timer
  systemctl --user enable --now stay-alive-${agent}-event-trigger.service
  systemctl --user enable --now stay-alive-${agent}-botland-watchdog.timer
  systemctl --user enable --now stay-alive-${agent}-local-governance.timer
  systemctl --user enable --now stay-alive-${agent}-service-recovery.timer
EOF_DONE
