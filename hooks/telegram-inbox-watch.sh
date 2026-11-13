#!/usr/bin/env bash
# Live Telegram relay watcher for the TrustyMUSE harness.
#
# Polls the Telegram inbox file and wakes the relay worker the moment a
# new message lands, instead of waiting for the 5-minute relay cron.
# The 5-minute cron stays as a safety net: it still picks up anything
# this hook misses, for example a message that arrived while a relay
# run was already working.
#
# This script never reads message text, never touches a credential,
# never sends anything to Telegram, and never writes to any harness
# state file. It only reads messageIds and keeps a watermark of the
# ids it already woke for, under the hook state dir.
set -euo pipefail

[[ ${HATCH_HOOK_ID-} =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]]
# shellcheck source=/dev/null
source "${HATCH_HOOK_RUNTIME:?Use the registered hook runtime}"
umask 077
exec 9>"${HATCH_HOOK_STATE_DIR:?}/${HATCH_HOOK_ID}.lock"
flock -x -w 5 9

HOME_DIR="${HOME:-/home/hatch}"
INBOX="${TELEGRAM_INBOX_PATH:-$HOME_DIR/workspace/trustymuse-harness/state/telegram-inbox.jsonl}"
RELAY_LOCK="${TELEGRAM_RELAY_LOCK_PATH:-$HOME_DIR/workspace/trustymuse-harness/state/telegram-relay.lock}"
RELAY_LOCK_DIR="${TELEGRAM_RELAY_LOCK_DIR_PATH:-$HOME_DIR/workspace/trustymuse-harness/state/telegram-relay.lock.d}"
DRY_RUN="${HATCH_HOOK_DRY_RUN:-0}"

# No inbox file yet: nothing to watch.
if [[ ! -f "$INBOX" ]]; then
  silent "no inbox file" '{}'
  exit 0
fi

# A relay run is already working: do not wake a second one. The new
# message stays unwatermarked, so the next poll after the lock clears
# wakes for it. The lock directory is the atomic claim, so a run that
# just claimed it counts as running even before it writes the lock
# file: that window is where a hook wake and a cron run raced and
# both answered the same message on 2026-11-14.
if [[ -d "$RELAY_LOCK_DIR" ]]; then
  silent "relay already running" '{}'
  exit 0
fi
if [[ -f "$RELAY_LOCK" ]] && [[ -n "$(find "$RELAY_LOCK" -mmin -10 2>/dev/null)" ]]; then
  silent "relay already running" '{}'
  exit 0
fi

# Message ids with status new, oldest first. A corrupt line is
# skipped, never fatal.
new_ids=""
while IFS= read -r line; do
  id="$(echo "$line" | jq -r 'select(.status == "new") | .messageId' 2>/dev/null || true)"
  if [[ -n "$id" && "$id" != "null" ]]; then
    new_ids="${new_ids}${id}"$'\n'
  fi
done < "$INBOX"

if [[ -z "${new_ids//[$'\n']/}" ]]; then
  silent "no new inbox messages" '{}'
  exit 0
fi

new_ids_json="$(printf '%s' "$new_ids" | jq -s -c 'map(select(. != null and . != "") | tonumber)')"

# Ids this hook already woke for.
state_json="$(hook_state_get 2>/dev/null || echo '{}')"
if ! echo "$state_json" | jq -e . >/dev/null 2>&1; then
  state_json='{}'
fi

unseen_json="$(jq -n -c --argjson current "$new_ids_json" --argjson state "$state_json" \
  '[ $current[] | select(. as $id | ($state.seen // []) | index($id) == null) ]')"

if [[ "$(echo "$unseen_json" | jq -r 'length')" == "0" ]]; then
  silent "new messages already seen" '{}'
  exit 0
fi

payload="$(jq -n -c --argjson ids "$unseen_json" '{newMessageIds: $ids, count: ($ids | length)}')"

# A dry run must never consume a detection: decide wake, but do not
# write the watermark, so the next real poll wakes for the same ids.
if [[ "$DRY_RUN" == "1" ]]; then
  wake "new telegram message" "$payload"
  exit 0
fi

# Record the ids just woken for, pruning ids that are no longer new,
# so the watermark stays small and a failed worker is not hidden
# forever from the cron safety net.
merged="$(jq -n -c --argjson state "$state_json" --argjson new "$unseen_json" --argjson current "$new_ids_json" \
  '{seen: ((($state.seen // []) + $new) | unique | map(select(. as $id | $current | index($id) != null)))}')"
hook_state_set "$merged"
log "waking relay for new telegram message" "$payload"
wake "new telegram message" "$payload"
exit 0
