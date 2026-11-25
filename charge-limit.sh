#!/usr/bin/env bash
# Sets and reads the battery charge limit through framework_tool, for the
# widget's 80% / 100% toggle.
#
#   charge-limit.sh apply <percent> <state-dir>   set the limit, record it
#   charge-limit.sh refresh <state-dir>           read the limit, record it
#   charge-limit.sh set <percent>                 privileged; see below
#   charge-limit.sh read                          privileged; see below
#
# The widget that calls this runs at the shell's privilege level, and so do
# `apply` and `refresh`.  Only `set` and `read` run as root, re-entered through
# pkexec, so each password or fingerprint prompt guards exactly one EC call and
# nothing else.  framework_tool needs root even to read the limit, which is why
# the widget cannot simply look it up and keeps its own record instead.
#
# Two files in the state directory carry that record, each a bare number:
#
#   charge-limit     the limit last written or read here
#   standard-limit   the limit the pack is normally held at (the non-100% one)
#
# Nothing here ever changes the limit on its own: lowering it below the current
# charge makes the Framework EC run the laptop from the battery, even on AC,
# until the pack is down to the new limit, so when to do that is the user's call.
#
# Exit codes: 0 done, 2 usage, 3 the EC said something this script cannot
# parse, 4 the write did not stick, 126/127 the prompt was dismissed or failed
# to authenticate (pkexec's own codes, passed through).

set -uo pipefail

self=$(readlink -f -- "${BASH_SOURCE[0]}")

# The EC refuses nothing between 0 and 100, and framework_tool only warns below
# 25%.  The floor here is deliberately higher: a value low enough to leave the
# laptop unable to charge for a trip is far more likely to be a bug than an
# intent, and the prompt must not be usable to write an arbitrary value.
min_limit=50

read_limit() {
  # Prints e.g. "Minimum 0%, Maximum 80%".  Only the maximum is the limit.
  framework_tool --driver cros-ec --charge-limit 2>/dev/null |
    sed -n 's/.*Maximum[^0-9]*\([0-9][0-9]*\)%.*/\1/p' | head -n1
}

valid_limit() {
  [[ $1 =~ ^[0-9]+$ ]] && (($1 >= min_limit && $1 <= 100))
}

set_limit() {
  local target=$1 previous current
  if ! valid_limit "$target"; then
    printf 'refusing charge limit %s (allowed: %d-100)\n' "$target" "$min_limit" >&2
    exit 2
  fi
  # The previous value is the only chance to learn the standard limit when the
  # toggle goes to 100%, so a failed read aborts before anything is written.
  previous=$(read_limit)
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

print_limit() {
  local limit
  limit=$(read_limit)
  if [[ -z $limit ]]; then
    printf 'could not read the current charge limit from framework_tool\n' >&2
    exit 3
  fi
  printf '%s\n' "$limit"
}

write_number() {
  local file=$1 value=$2
  mkdir -p -- "$(dirname -- "$file")"
  printf '%d\n' "$value" > "$file.tmp.$$" && mv -f -- "$file.tmp.$$" "$file"
}

apply() {
  local target=$1 dir=$2 previous status
  valid_limit "$target" || exit 2
  previous=$(pkexec "$self" set "$target")
  status=$?
  ((status == 0)) || exit "$status"
  write_number "$dir/charge-limit" "$target"
  if ((target < 100)); then
    write_number "$dir/standard-limit" "$target"
  elif valid_limit "$previous" && ((previous < 100)); then
    write_number "$dir/standard-limit" "$previous"
  fi
}

refresh() {
  local dir=$1 limit status
  limit=$(pkexec "$self" read)
  status=$?
  ((status == 0)) || exit "$status"
  valid_limit "$limit" || exit 3
  write_number "$dir/charge-limit" "$limit"
  ((limit < 100)) && write_number "$dir/standard-limit" "$limit"
  exit 0
}

case ${1:-} in
  set) set_limit "${2:-}" ;;
  read) print_limit ;;
  apply) [[ -n ${2:-} && -n ${3:-} ]] || exit 2; apply "$2" "$3" ;;
  refresh) [[ -n ${2:-} ]] || exit 2; refresh "$2" ;;
  *)
    printf 'usage: %s apply <percent> <state-dir> | refresh <state-dir> | set <percent> | read\n' "${0##*/}" >&2
    exit 2
    ;;
esac
