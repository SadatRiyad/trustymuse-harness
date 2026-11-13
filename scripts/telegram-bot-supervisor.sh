#!/bin/bash
# TrustyMUSE Harness Telegram bot supervisor, V2.1.
#
# One way to start the bot, so the dashboard Start button and the CLI
# telegram-start do the same thing. The panel change that calls this
# script comes after the CLI work; the contract is in
# docs/V2-1-BOT-START-FROM-PANEL.md.
#
# Usage: telegram-bot-supervisor.sh <start|stop|status|restart> [rootDir] [tenantId]
#   rootDir defaults to the harness root (the parent of scripts/).
#   tenantId is passed to telegram-run on start; empty means the default tenant.
#
# The bot process is `node dist/index.js telegram-run`. An older bot
# started by hand as `node dist/index.js telegram-start` is adopted,
# never duplicated: start writes an already-running bot into the pid
# file instead of starting a second one. The script never prints the
# token: the token check runs telegram-token-status, which prints only
# set or not set.
#
# State files, all under the harness root:
#   state/telegram-bot.pid        pid of the supervised bot
#   state/telegram-heartbeat.json written by the bot on every poll
#   logs/telegram-bot.log         bot stdout and stderr

set -u

COMMAND="${1:-}"
ROOT="${2:-$(cd "$(dirname "$0")/.." && pwd)}"
TENANT="${3:-}"
PID_FILE="$ROOT/state/telegram-bot.pid"
LOG_FILE="$ROOT/logs/telegram-bot.log"
DIST_INDEX="$ROOT/dist/index.js"

# Pids of this script and every ancestor, so the bot search never
# mistakes the shell or the CLI that invoked the supervisor for the bot
# itself. The invoking shell's own command line can hold the words
# telegram-start, for example when the user runs telegram-start from
# the terminal.
ancestor_pids() {
  local pid="$$"
  local out=""
  while [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "1" ]; do
    out="$out $pid"
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')
  done
  echo "$out"
}

# Pids of running bot processes for this harness root, newest last.
# A candidate counts only when its working directory is this root, so
# one install never adopts another install's bot. The script itself
# and its ancestors are excluded, see ancestor_pids above.
find_bot_pids() {
  if ! command -v pgrep >/dev/null 2>&1; then
    return 0
  fi
  local exclude
  exclude=$(ancestor_pids)
  pgrep -f "dist/index.js telegram-(start|run)" 2>/dev/null | while read -r candidate; do
    case " $exclude " in
      *" $candidate "*) ;;
      *)
        local cwd
        cwd=$(readlink "/proc/$candidate/cwd" 2>/dev/null) || continue
        if [ "$cwd" = "$ROOT" ] && pid_is_bot "$candidate"; then
          echo "$candidate"
        fi
        ;;
    esac
  done
}

# True when the pid is a telegram bot process: its argv must be
# exactly `node <path>/dist/index.js telegram-start|telegram-run`.
# A substring match is not enough: a parent shell that launched the
# bot holds the same words in its own command line (the shell's
# command string contains the launch command), and pgrep would match
# the shell too. The argv check reads /proc directly, so only the
# node process itself counts.
pid_is_bot() {
  local pid="$1"
  local arg0 arg1 arg2
  {
    IFS= read -r -d '' arg0 || return 1
    IFS= read -r -d '' arg1 || return 1
    IFS= read -r -d '' arg2 || return 1
  } < "/proc/$pid/cmdline" 2>/dev/null || return 1
  case "$arg0" in
    node|*/node) ;;
    *) return 1 ;;
  esac
  case "$arg1" in
    dist/index.js|*/dist/index.js) ;;
    *) return 1 ;;
  esac
  case "$arg2" in
    telegram-start|telegram-run) return 0 ;;
    *) return 1 ;;
  esac
}

# True when the pid is alive right now. A zombie still answers kill -0
# but is already dead: its parent has not reaped it yet. That happens
# exactly when the caller spawned the bot and is blocked waiting for
# this script, so the zombie stays unreaped for the whole stop. The
# process state from ps tells the truth: Z means zombie, dead.
pid_is_live() {
  local pid="$1"
  local state
  state=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]') || return 1
  case "$state" in
    ""|Z*) return 1 ;;
    *) return 0 ;;
  esac
}

recorded_pid() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(tr -d '[:space:]' < "$PID_FILE" 2>/dev/null)
    case "$pid" in
      ''|*[!0-9]*) echo "" ;;
      *) echo "$pid" ;;
    esac
  else
    echo ""
  fi
}

# Prints the reason and returns 1 when no token is set. Returns 2 when
# the harness is not built. Returns 0 when a token is set. The token
# value is never printed.
check_token() {
  if [ ! -f "$DIST_INDEX" ]; then
    echo "Telegram bot was not started. The harness is not built: dist/index.js is missing. Run npm run build first."
    return 2
  fi
  local out
  out=$(node "$DIST_INDEX" telegram-token-status 2>&1) || {
    echo "Telegram bot was not started. The token check failed: $out"
    return 1
  }
  case "$out" in
    *"not set"*)
      echo "Telegram bot was not started. No Telegram bot token found. Create a bot with @BotFather in Telegram, copy the token it gives you, then set TELEGRAM_BOT_TOKEN in the environment, or save the token from the TrustyHarness panel box, before starting the bot. Never put the token in config.yaml or in chat."
      return 1
      ;;
  esac
  return 0
}

cmd_start() {
  local recorded existing
  recorded=$(recorded_pid)
  if [ -n "$recorded" ] && pid_is_bot "$recorded" && pid_is_live "$recorded"; then
    echo "Telegram bot is already running (pid $recorded). Adopted into state/telegram-bot.pid."
    return 0
  fi
  existing=$(find_bot_pids | head -n 1)
  if [ -n "$existing" ]; then
    mkdir -p "$(dirname "$PID_FILE")"
    echo "$existing" > "$PID_FILE"
    echo "Telegram bot is already running (pid $existing). Adopted into state/telegram-bot.pid."
    return 0
  fi
  if ! check_token; then
    return 1
  fi
  mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"
  local run_args=(telegram-run)
  if [ -n "$TENANT" ]; then
    run_args+=(--tenant "$TENANT")
  fi
  cd "$ROOT" || {
    echo "Telegram bot was not started. Could not change to $ROOT."
    return 1
  }
  nohup node "$DIST_INDEX" "${run_args[@]}" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  # Give it a moment to fail fast on a bad token or a bad tenant.
  sleep 2
  if ! pid_is_live "$pid" 2>/dev/null; then
    echo "Telegram bot failed to start. See logs/telegram-bot.log for the error."
    rm -f "$PID_FILE"
    return 1
  fi
  echo "Telegram bot started (pid $pid). Log: logs/telegram-bot.log. Stop it with: node dist/index.js telegram-stop"
  return 0
}

cmd_stop() {
  local recorded target
  recorded=$(recorded_pid)
  if [ -n "$recorded" ] && pid_is_bot "$recorded" && pid_is_live "$recorded"; then
    target="$recorded"
  else
    # No live pid in the file. Fall back to a running bot found by
    # command line, but only a telegram bot process is ever killed.
    if [ -n "$recorded" ]; then
      rm -f "$PID_FILE"
    fi
    target=$(find_bot_pids | head -n 1)
  fi
  if [ -z "$target" ]; then
    echo "Telegram bot is not running."
    return 0
  fi
  kill "$target" 2>/dev/null
  local waited=0
  while pid_is_live "$target" && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if pid_is_live "$target"; then
    kill -9 "$target" 2>/dev/null
    sleep 1
  fi
  rm -f "$PID_FILE"
  if pid_is_live "$target"; then
    echo "Telegram bot (pid $target) could not be stopped."
    return 1
  fi
  echo "Telegram bot stopped (pid $target)."
  return 0
}

cmd_status() {
  # The CLI telegram-status is the single source of truth for the
  # status text, so the script delegates to it when the build exists.
  if [ -f "$DIST_INDEX" ]; then
    node "$DIST_INDEX" telegram-status
    return $?
  fi
  echo "Telegram bot status is unknown: the harness is not built (dist/index.js is missing). Run npm run build first."
  return 1
}

cmd_restart() {
  cmd_stop
  cmd_start
}

case "$COMMAND" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  restart) cmd_restart ;;
  *)
    echo "Usage: telegram-bot-supervisor.sh <start|stop|status|restart> [rootDir] [tenantId]"
    exit 1
    ;;
esac
