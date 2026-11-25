# Design: manual 80% / 100% charge-limit toggle

## Why

On 2026-11-25 we measured what the Framework 13 EC does when the charge limit drops below the current charge while on AC: it does not just stop charging, it runs the whole laptop from the battery (about 1 A, 17–18 W, adapter still negotiated at 20 V / 3 A) until the pack is down to the limit.  The drain started one second after `framework_tool --charge-limit 80` at 99% and was still going 20 minutes later at 92%.

The "charge to 100% once" feature restores the old limit automatically, and any automatic restore at the wrong moment throws the top-up away and spends a partial cycle for nothing.  It also misread sysfs `Discharging` (the EC draining on AC) as an unplug, restored on AC, and looped the polkit prompt when dismissed.  Choosing when to go back to 80% is a decision only the user can make well, so the widget should stop making it.

## Goals

- A header button that switches the EC charge limit between the standard limit (80% here) and 100%, one privileged write per click.
- The button always shows which position the limit is in, as well as the widget can know without root.
- Nothing changes the limit except a click (or the IPC equivalent).

## Non-goals

- No automatic restore of any kind: not on unplug, not on full, not on a timer.
- No limits other than the standard one and 100%.
- Fixing the header's "ON BATTERY" label, which also trusts the battery status over the AC state, is a separate change.

## Anti-goals

- A prompt the user did not ask for.  Every `pkexec` prompt must be the direct result of a click.

## Approaches considered (for knowing the position without root)

1. Remember the value the widget last wrote.  Simple, but wrong after an EC reset or a write from outside the widget, both of which happened in the last two days.
2. **Remember it, and correct it from sysfs (chosen).**  On AC, a pack charging past the standard limit means the limit is 100%; a pack held at `Not charging` at the standard limit (or a point or two under it) means the limit is the standard one.  On battery, or below the standard limit while charging, nothing is inferred and the remembered value stands.
3. Read the EC every time the panel opens.  Always right, but needs root, so a prompt each time.  Kept instead as an explicit refresh button (see Design), so the authoritative read is there when the user wants it.

## Design

- **State.**  `charge-limit.json` (the pending top-up) goes away.  A new `charge-limit` file holds the last known limit as a bare number; `standard-limit` stays as it is and keeps being learned the same two ways.  The widget's view of the limit is the remembered value, overridden by the sysfs inference of approach 2 whenever that inference applies; an inferred value that differs is written back to `charge-limit`.  When nothing is remembered and nothing can be inferred, the position is unknown.
- **AC detection.**  "On AC" comes from `UPower.onBattery` / `ACAD/online`, never from the battery status, because the EC reports `Discharging` while draining on AC.
- **Click.**  Unknown or standard → set 100.  100 → set the standard limit (80 when still unknown).  `charge-limit.sh set <N>` stays the only privileged part; a new unprivileged `charge-limit.sh apply <N> <state-dir>` runs it through `pkexec` and, on success, records `N` in `charge-limit` and the reported previous limit in `standard-limit` when that previous value was below 100.  A dismissed prompt changes nothing and is not retried.
- **Refresh.**  A second, smaller header button (Lucide [`refresh-cw`](https://lucide.dev/icons/refresh-cw)) reads the limit from the EC on demand, for when the remembered position is unknown or doubted.  Reading needs root too, so it is a privileged `charge-limit.sh read` behind `pkexec`, wrapped by an unprivileged `charge-limit.sh refresh <state-dir>` that records the result in `charge-limit`, and in `standard-limit` when it is below 100.  The EC's answer overrides both the remembered value and the sysfs inference.  It never runs on its own; it is the user's choice to pay a prompt for certainty.  IPC: `refreshChargeLimit`.
- **Visibility.**  The toggle button shows whenever `framework_tool` is installed, regardless of AC or level, since going back to 80% on battery is the normal way to use it.
- **Look.**  Lucide [`battery-full`](https://lucide.dev/icons/battery-full) when the limit is 100%, [`battery-medium`](https://lucide.dev/icons/battery-medium) when it is the standard one, the medium one dimmed when unknown.  The tooltip states the current limit and what a click does; when the click would lower the limit below the current charge while on AC, it adds that the laptop will then run from the battery down to that level.
- **IPC.**  `chargeFull` is replaced by `toggleChargeLimit`.
- **Removed.**  `topUpSpent`, `topUpOffered`, `parseTopUp`, the claim/rename logic, the `topup` and `restore` actions, the auto-restore on every sample, and the uncommitted restore-on-any-unplug change.
- **Docs.**  README's "Charge to 100% once" section becomes "Charge limit toggle", including the measured drain on AC.

## Left to the builder

- Exact tooltip wording and the dimmed style for the unknown position.
- Whether the refresh button is always visible or only beside the toggle on hover; it shows whenever the toggle does unless that crowds the header.
- How many points under the standard limit still count as "held at it" (the existing `heldLimit` logic is the starting point).
- No new tests are to be written; existing tests that cover removed code are to be raised with the user before changing them.
