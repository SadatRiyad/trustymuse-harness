#!/usr/bin/env bash
# Telegram bot watchdog for the TrustyMUSE harness.
#
# Polls the bot pid file and heartbeat file and wakes a worker agent
# ONLY when the bot is dead or unresponsive. The worker restarts the
# bot through scripts/telegram-bot-supervisor.sh, never by launching
# node directly, and the supervisor never starts a second bot while
# one is running.
#
# The watchdog NEVER restarts a bot the user stopped on purpose.
# telegram-stop writes state/telegram-bot.stopped before killing the
# bot, and the supervisor removes the pid file on stop, so a missing
# pid file or a present stopped marker both mean deliberately stopped
# and this script stays silent. A manual start clears the marker.
#
# This script never reads or logs a token, never kills anything, never
# starts anything, and never writes to any harness state file. It only
# reads the pid and the heartbeat lastPollAt, and keeps a small
# wake watermark under the hook state dir so one dead bot does not
# wake a worker on every poll.
set -euo pipefail

[[ ${HATCH_HOOK_ID-} =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]]
# shellcheck source=/dev/null
source "${HATCH_HOOK_RUNTIME:?Use the registered hook runtime}"
umask 077
exec 9>"${HATCH_HOOK_STATE_DIR:?}/${HATCH_HOOK_ID}.lock"
flock -x -w 5 9

HOME_DIR="${HOME:-/home/hatch}"
HARNESS_STATE="${TELEGRAM_BOT_STATE_DIR:-$HOME_DIR/workspace/trustymuse-harness/state}"
PID_FILE="${TELEGRAM_BOT_PID_PATH:-$HARNESS_STATE/telegram-bot.pid}"
HEARTBEAT_FILE="${TELEGRAM_HEARTBEAT_PATH:-$HARNESS_STATE/telegram-heartbeat.json}"
STOPPED_FILE="${TELEGRAM_BOT_STOPPED_PATH:-$HARNESS_STATE/telegram-bot.stopped}"
DISABLED_FILE="${TELEGRAM_WATCHDOG_DISABLED_PATH:-$HARNESS_STATE/telegram-bot-watchdog-disabled}"
DRY_RUN="${HATCH_HOOK_DRY_RUN:-0}"

# A heartbeat older than this means the bot stopped polling.
HEARTBEAT_STALE_SECS=90
# Do not wake twice for the same failure inside this window: the
# worker needs time to restart and verify.
DEDUP_SECS=300
# A bot that started moments ago may not have its first heartbeat
# yet. Do not call a missing heartbeat stale inside this window.
FRESH_START_GRACE_SECS=120

now="$(date +%s)"

# The user stopped the bot on purpose. Never restart it.
if [[ -f "$STOPPED_FILE" ]]; then
  silent "bot stopped on purpose" '{}'
  exit 0
fi

# The watchdog worker gave up after repeated failed restarts. It
# stays down until the user starts it again by hand, which clears
# this marker through the supervisor.
if [[ -f "$DISABLED_FILE" ]]; then
  silent "auto-restart disabled by watchdog" '{}'
  exit 0
fi

# No pid file: the bot was never started, or it was stopped on
# purpose (stop removes the pid file). Either way, stay silent.
if [[ ! -f "$PID_FILE" ]]; then
  silent "no bot pid file" '{}'
  exit 0
fi

raw_pid="$(tr -d '[:space:]' < "$PID_FILE" 2>/dev/null || true)"
case "$raw_pid" in
  ''|*[!0-9]*)
    reason="unreadable pid file"
    last_pid=0
    heartbeat_age=""
    ;;
  *)
    last_pid="$raw_pid"
    # Alive right now? A zombie still answers kill -0 but is already
    # dead, so the process state tells the truth.
    pid_state="$(ps -o stat= -p "$last_pid" 2>/dev/null | tr -d '[:space:]' || true)"
    case "$pid_state" in
      ""|Z*)
        reason="bot crashed"
        ;;
      *)
        reason=""
        ;;
    esac
    heartbeat_age=""
    if [[ -n "$reason" ]]; then
      :
    elif [[ ! -f "$HEARTBEAT_FILE" ]]; then
      # No heartbeat yet. A bot that started moments ago has not
      # polled yet, so give it a grace window before calling it
      # unresponsive.
      pid_age=$(( now - $(stat -c %Y "$PID_FILE" 2>/dev/null || echo "$now") ))
      if [[ "$pid_age" -lt "$FRESH_START_GRACE_SECS" ]]; then
        silent "bot just started, no heartbeat yet" '{}'
        exit 0
      fi
      reason="bot unresponsive"
    else
      last_poll="$(jq -r '.lastPollAt // empty' "$HEARTBEAT_FILE" 2>/dev/null || true)"
      poll_epoch="$(date -d "$last_poll" +%s 2>/dev/null || echo "")"
      if [[ -z "$poll_epoch" ]]; then
        reason="bot unresponsive"
      else
        heartbeat_age=$(( now - poll_epoch ))
        if [[ "$heartbeat_age" -gt "$HEARTBEAT_STALE_SECS" ]]; then
          reason="bot unresponsive"
        fi
      fi
    fi
    ;;
esac

if [[ -z "${reason:-}" ]]; then
  silent "bot healthy" '{}'
  exit 0
fi

# Do not wake twice for the same failure inside the cooldown window.
state_json="$(hook_state_get 2>/dev/null || echo '{}')"
if ! echo "$state_json" | jq -e . >/dev/null 2>&1; then
  state_json='{}'
fi
wake_key="${reason}:${last_pid}"
last_wake_key="$(echo "$state_json" | jq -r '.lastWake.key // empty')"
last_wake_at="$(echo "$state_json" | jq -r '.lastWake.at // 0')"
if [[ "$last_wake_key" == "$wake_key" ]] && [[ $(( now - last_wake_at )) -lt $DEDUP_SECS ]]; then
  silent "already woken for this failure" '{}'
  exit 0
fi

if [[ "$heartbeat_age" == "" ]]; then
  heartbeat_json="null"
else
  heartbeat_json="$heartbeat_age"
fi
payload="$(jq -n -c --arg reason "$reason" --argjson lastPid "$last_pid" --argjson heartbeatAgeSecs "$heartbeat_json" \
  '{reason: $reason, lastPid: $lastPid, heartbeatAgeSecs: $heartbeatAgeSecs}')"

# A dry run must never consume a detection: decide wake, but do not
# write the watermark, so the next real poll wakes for the same failure.
if [[ "$DRY_RUN" == "1" ]]; then
  wake "$reason" "$payload"
  exit 0
fi

merged="$(jq -n -c --arg key "$wake_key" --argjson at "$now" '{lastWake: {key: $key, at: $at}}')"
hook_state_set "$merged"
log "waking bot watchdog worker" "$payload"
wake "$reason" "$payload"
exit 0
