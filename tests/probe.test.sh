#!/usr/bin/env bash
# Drives probe.sh against synthetic /sys/class/power_supply trees, so the sysfs
# shapes this plugin has to cope with — charge_* packs, energy_* packs, several
# batteries, no battery at all, hostile attribute contents — are covered on any
# machine regardless of what hardware is actually in it.
#
# Run with `make test`.

set -uo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
probe=$here/../probe.sh
failures=0

fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT

make_supply() {
  local root=$1 name=$2 type=$3
  mkdir -p "$root/$name"
  printf '%s\n' "$type" > "$root/$name/type"
}

put() {
  printf '%s\n' "$2" > "$1"
}

check() {
  local label=$1 expected=$2 actual=$3
  if [[ $expected == "$actual" ]]; then
    printf 'ok   %s\n' "$label"
  else
    printf 'FAIL %s\n       expected: %s\n       actual:   %s\n' "$label" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

field() {
  awk -F'\t' -v key="$2" '$1 == key { print $2 }' <<< "$1"
}

# ---------------------------------------------------------- a charge_* pack

charge_root=$fixture/charge
make_supply "$charge_root" ACAD Mains
make_supply "$charge_root" BAT0 Battery
put "$charge_root/BAT0/charge_full" 4004000
put "$charge_root/BAT0/charge_full_design" 3915000
put "$charge_root/BAT0/charge_now" 2002000
put "$charge_root/BAT0/cycle_count" 42
put "$charge_root/BAT0/capacity" 50
put "$charge_root/BAT0/voltage_now" 17745000
put "$charge_root/BAT0/voltage_min_design" 15480000
put "$charge_root/BAT0/current_now" 1200000
put "$charge_root/BAT0/status" Discharging
put "$charge_root/BAT0/technology" Li-ion
put "$charge_root/BAT0/manufacturer" NVT
put "$charge_root/BAT0/model_name" FRANGWA

out=$(OMARCHY_BATTERY_HEALTH_SUPPLY_DIR=$charge_root bash "$probe")
check "charge pack is present" 1 "$(field "$out" present)"
check "charge pack is named" BAT0 "$(field "$out" battery)"
check "charge pack reports Ah" Ah "$(field "$out" unit)"
check "charge pack full capacity" 4004000 "$(field "$out" full)"
check "charge pack design capacity" 3915000 "$(field "$out" design)"
check "charge pack cycles" 42 "$(field "$out" cycles)"
check "charge pack status" Discharging "$(field "$out" status)"
check "charge pack vendor" NVT "$(field "$out" vendor)"
check "the mains supply is not mistaken for a battery" BAT0 "$(field "$out" battery)"

check "charge pack current" 1200000 "$(field "$out" current)"
# power_now is absent on this shape, so the panel derives watts from volts times
# amps; the probe must not invent a value.
check "absent power_now is omitted" "" "$(field "$out" power)"

# ---------------------------------------------------------- an energy_* pack

energy_root=$fixture/energy
make_supply "$energy_root" BAT1 Battery
put "$energy_root/BAT1/energy_full" 50000000
put "$energy_root/BAT1/energy_full_design" 56000000
put "$energy_root/BAT1/energy_now" 25000000
put "$energy_root/BAT1/status" Charging
put "$energy_root/BAT1/power_now" 15000000

out=$(OMARCHY_BATTERY_HEALTH_SUPPLY_DIR=$energy_root bash "$probe")
check "energy pack reports Wh" Wh "$(field "$out" unit)"
check "energy pack full capacity" 50000000 "$(field "$out" full)"
check "energy pack design capacity" 56000000 "$(field "$out" design)"
# Absent attributes are omitted entirely rather than emitted empty, so the
# parser's own defaults decide what "unknown" means.
check "absent cycle_count is omitted" "" "$(field "$out" cycles)"
check "energy pack reports power_now" 15000000 "$(field "$out" power)"

# --------------------------------------------------- picking among several

multi_root=$fixture/multi
make_supply "$multi_root" ACAD Mains
# A battery with no design capacity — some docks and UPS devices look like
# this — must not win the pick over a real pack.
make_supply "$multi_root" BAT0 Battery
put "$multi_root/BAT0/capacity" 90
make_supply "$multi_root" BAT2 Battery
put "$multi_root/BAT2/charge_full" 3000000
put "$multi_root/BAT2/charge_full_design" 3000000

out=$(OMARCHY_BATTERY_HEALTH_SUPPLY_DIR=$multi_root bash "$probe")
check "a pack without a design capacity loses the pick" BAT2 "$(field "$out" battery)"

# An explicit name wins even when another battery sorts first.
make_supply "$multi_root" BAT3 Battery
put "$multi_root/BAT3/charge_full" 1000000
put "$multi_root/BAT3/charge_full_design" 1000000
out=$(OMARCHY_BATTERY_HEALTH_SUPPLY_DIR=$multi_root bash "$probe" BAT3)
check "an explicit battery name is honored" BAT3 "$(field "$out" battery)"

# A name that does not resolve reports no battery rather than silently
# falling back to a different pack whose history would then be merged in.
out=$(OMARCHY_BATTERY_HEALTH_SUPPLY_DIR=$multi_root bash "$probe" NOPE)
check "an unknown battery name reports absent" 0 "$(field "$out" present)"

# ------------------------------------------------------------- no battery

empty_root=$fixture/empty
make_supply "$empty_root" ACAD Mains
out=$(OMARCHY_BATTERY_HEALTH_SUPPLY_DIR=$empty_root bash "$probe")
check "a machine with no battery reports absent" 0 "$(field "$out" present)"

out=$(OMARCHY_BATTERY_HEALTH_SUPPLY_DIR=$fixture/does-not-exist bash "$probe")
check "a missing power_supply tree reports absent" 0 "$(field "$out" present)"

# ------------------------------------------------------ hostile attributes

nasty_root=$fixture/nasty
make_supply "$nasty_root" BAT0 Battery
put "$nasty_root/BAT0/charge_full" 4000000
put "$nasty_root/BAT0/charge_full_design" 4000000
printf 'ACME\tCorp\nsecond line\n' > "$nasty_root/BAT0/manufacturer"

out=$(OMARCHY_BATTERY_HEALTH_SUPPLY_DIR=$nasty_root bash "$probe")
# A tab or a second line in an attribute would split one record into two and
# desynchronise every field after it, so both are stripped at the source.
check "an embedded tab cannot forge a field" "ACMECorp" "$(field "$out" vendor)"
check "only the first line of an attribute is read" 1 "$(grep -c '^vendor' <<< "$out")"

# ------------------------------------------------------------------ result

if (( failures > 0 )); then
  printf '\n%d probe assertion(s) failed\n' "$failures"
  exit 1
fi
printf '\nprobe.sh: all assertions passed\n'
