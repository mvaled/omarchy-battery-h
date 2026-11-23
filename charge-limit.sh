#!/usr/bin/env bash
# Lifts the battery charge limit to 100% for one charge and puts the previous
# limit back afterwards, through framework_tool.
#
#   charge-limit.sh topup <state-file>     raise to 100%, remember the old limit
#   charge-limit.sh restore <state-file>   put the remembered limit back
#   charge-limit.sh set <percent>          the only privileged part; see below
#
# The widget that calls this runs at the shell's privilege level, and so do
# `topup` and `restore`.  Only `set` runs as root, re-entered through pkexec, so
# the password or fingerprint prompt guards exactly one EC write and nothing
# else.  framework_tool cannot even read the limit without root, which is why
# `set` also reports the limit it replaced: that is the only moment the old
# value is visible to anyone.
#
# The state file is the single source of truth for "a top-up is pending", shared
# by every widget instance (one per monitor).  It holds two numbers, the limit to
# restore and the time from which a full charge counts as having happened:
#
#   {"restore": 80, "since": 1795400000}
#
# Next to it, `standard-limit` holds the limit the pack is normally kept at,
# as a bare number.  It outlives the top-up, because the widget needs it to tell
# a pack charging past its usual limit from one still charging up to it, and
# without root the limit itself cannot be read.  The value framework_tool
# reports from inside `set` is authoritative and overwrites whatever is there.
#
# Exit codes: 0 done (or nothing to do), 2 usage, 3 the EC said something this
# script cannot parse, 4 the write did not stick, 126/127 the prompt was
# dismissed or failed to authenticate (pkexec's own codes, passed through).

set -uo pipefail

self=$(readlink -f -- "${BASH_SOURCE[0]}")

# The EC refuses nothing between 0 and 100, and framework_tool only warns below
# 25%.  The floor here is deliberately higher: this script exists to raise the
# limit, and a value low enough to leave the laptop unable to charge for a trip
# is far more likely to be a bug than an intent.
min_limit=50

read_limit() {
  # Prints e.g. "Minimum 0%, Maximum 80%".  Only the maximum is the limit.
  framework_tool --driver cros-ec --charge-limit 2>/dev/null |
    sed -n 's/.*Maximum[^0-9]*\([0-9][0-9]*\)%.*/\1/p' | head -n1
}

set_limit() {
  local target=$1 previous current
  if [[ ! $target =~ ^[0-9]+$ ]] || ((target < min_limit || target > 100)); then
    printf 'refusing charge limit %s (allowed: %d-100)\n' "$target" "$min_limit" >&2
    exit 2
  fi
  previous=$(read_limit)
  # Without the old value there is nothing to restore to later, so a failed
  # read aborts before anything is written.
  if [[ -z $previous ]]; then
    printf 'could not read the current charge limit from framework_tool\n' >&2
    exit 3
  fi
  if ((previous != target)); then
    framework_tool --driver cros-ec --charge-limit "$target" >/dev/null 2>&1
    current=$(read_limit)
    if [[ $current != "$target" ]]; then
      printf 'charge limit reads %s after setting %s\n' "${current:-?}" "$target" >&2
      exit 4
    fi
  fi
  printf '%s\n' "$previous"
}

write_state() {
  local file=$1 restore=$2 since=$3
  mkdir -p -- "$(dirname -- "$file")"
  printf '{"restore": %d, "since": %d}\n' "$restore" "$since" > "$file.tmp.$$" &&
    mv -f -- "$file.tmp.$$" "$file"
}

write_standard_limit() {
  local file=$1 limit=$2
  file=$(dirname -- "$file")/standard-limit
  printf '%d\n' "$limit" > "$file.tmp.$$" && mv -f -- "$file.tmp.$$" "$file"
}

read_state_field() {
  sed -n "s/.*\"$2\"[^0-9]*\([0-9][0-9]*\).*/\1/p" "$1" | head -n1
}

topup() {
  local file=$1 previous status
  previous=$(pkexec "$self" set 100)
  status=$?
  ((status == 0)) || exit "$status"
  # Already at 100% means there is no lower limit to come back to, and a state
  # file would only make the widget restore 100% to itself later.
  if ((previous < 100)); then
    write_state "$file" "$previous" "$(date +%s)"
    write_standard_limit "$file" "$previous"
  fi
}

restore() {
  local file=$1 claim restore status
  claim=$file.claim.$$
  # Every widget instance sees the same unplug, and each would otherwise raise
  # its own prompt.  rename(2) is atomic, so exactly one of them wins the file;
  # the rest find it gone and quietly stand down.
  mv -- "$file" "$claim" 2>/dev/null || exit 0
  restore=$(read_state_field "$claim" restore)
  if [[ -z $restore ]]; then
    rm -f -- "$claim"
    exit 0
  fi
  pkexec "$self" set "$restore" >/dev/null
  status=$?
  if ((status == 0)); then
    rm -f -- "$claim"
    write_standard_limit "$file" "$restore"
  else
    # A dismissed prompt must not turn into the same prompt again at the next
    # sample.  Moving `since` to now disarms the automatic restore until the
    # pack reaches full again; a click still restores at any time.
    write_state "$file" "$restore" "$(date +%s)"
    rm -f -- "$claim"
  fi
  exit "$status"
}

case ${1:-} in
  set) set_limit "${2:-}" ;;
  topup) [[ -n ${2:-} ]] || exit 2; topup "$2" ;;
  restore) [[ -n ${2:-} ]] || exit 2; restore "$2" ;;
  *)
    printf 'usage: %s topup|restore <state-file> | set <percent>\n' "${0##*/}" >&2
    exit 2
    ;;
esac
