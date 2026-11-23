#!/usr/bin/env bash
# Reads the health-relevant attributes of one battery out of sysfs and prints
# them as TAB-separated key/value lines. One optional argument pins a specific
# power-supply name (BAT0, BAT1, ...); without it the first battery that
# reports a design capacity wins.
#
# The output is deliberately flat and line-oriented: Model.parseProbe() in this
# plugin is the only consumer, and keeping the contract dumb makes it testable
# from node without a running shell.
#
# Capacities are reported in the unit sysfs itself uses. Batteries expose
# either charge_* (microampere-hours, unit "Ah") or energy_* (microwatt-hours,
# unit "Wh"); both are passed through untouched so no precision is lost to a
# conversion the panel may not need.

set -uo pipefail

supply_dir=${OMARCHY_BATTERY_HEALTH_SUPPLY_DIR:-/sys/class/power_supply}
requested=${1:-}

# sysfs attributes are single-line, but a hostile or exotic driver could still
# hand back something multi-line or tab-bearing, which would corrupt the TSV.
read_attr() {
  local path=$1
  [[ -r $path ]] || return 0
  head -n1 -- "$path" 2>/dev/null | tr -d '\t\r' | sed -e 's/[[:cntrl:]]//g' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

emit() {
  local value=$2
  [[ -n $value ]] && printf '%s\t%s\n' "$1" "$value"
  return 0
}

is_battery() {
  local dir=$1
  [[ $(read_attr "$dir/type") == Battery ]] || return 1
  [[ -r $dir/charge_full_design || -r $dir/energy_full_design ]]
}

pick_battery() {
  local dir
  if [[ -n $requested ]]; then
    is_battery "$supply_dir/$requested" && printf '%s' "$requested"
    return 0
  fi
  for dir in "$supply_dir"/*; do
    if is_battery "$dir"; then
      printf '%s' "${dir##*/}"
      return 0
    fi
  done
  return 0
}

battery=$(pick_battery)
if [[ -z $battery ]]; then
  printf 'present\t0\n'
  exit 0
fi

dir=$supply_dir/$battery
if [[ -r $dir/charge_full_design ]]; then
  unit=Ah
  full=$(read_attr "$dir/charge_full")
  design=$(read_attr "$dir/charge_full_design")
  now=$(read_attr "$dir/charge_now")
else
  unit=Wh
  full=$(read_attr "$dir/energy_full")
  design=$(read_attr "$dir/energy_full_design")
  now=$(read_attr "$dir/energy_now")
fi

printf 'present\t1\n'
emit battery "$battery"
emit unit "$unit"
emit full "$full"
emit design "$design"
emit now "$now"
emit cycles "$(read_attr "$dir/cycle_count")"
emit pct "$(read_attr "$dir/capacity")"
emit volt "$(read_attr "$dir/voltage_now")"
# Draw is power_now (microwatts) where the driver offers it, and otherwise
# current_now (microamperes) to be multiplied by the voltage. Neither carries a
# reliable sign — most drivers report a magnitude — so direction comes from
# status, not from the number.
emit current "$(read_attr "$dir/current_now")"
emit power "$(read_attr "$dir/power_now")"
emit voltdesign "$(read_attr "$dir/voltage_min_design")"
emit status "$(read_attr "$dir/status")"
# Whether the charge limit can be lifted from the panel.  Reported here rather
# than by a probe of its own so detection rides on the one Process the widget
# already runs, and so installing the tool shows up at the next sample without
# a shell restart.
command -v framework_tool >/dev/null 2>&1 && emit limiter framework_tool
emit t "$(date +%s)"
