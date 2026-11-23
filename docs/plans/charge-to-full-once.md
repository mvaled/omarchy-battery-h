# Plan: charge to 100% once

## Goal

A panel button ([Lucide `battery-full`](https://lucide.dev/icons/battery-full)) that lifts the charge limit to 100% for one charge, such as the night before a long train trip, and then puts back whatever limit was there before (80% today).  The widget keeps running at the shell's privilege level.  Only the single write that changes the limit is elevated, and it asks for the password through `pkexec`.

## What this machine has today

Checked on 2026-11-23 (Framework Laptop 13, AMD Ryzen AI 300, kernel 7.2.15-1-omarchy):

- **No sysfs threshold yet.**  `BAT1` has no `charge_control_end_threshold`.  The upstream driver that would provide it, `cros_charge_control`, is loaded but stands down on purpose: its `probe_with_fwk_charge_control` parameter is `N`.  The kernel turns it off by default on Framework boards because Framework's EC has its own charge-limit command, and the two can fight each other.  Turning it on means setting `options cros_charge_control probe_with_fwk_charge_control=1` in `/etc/modprobe.d/`.  Even then, the attribute is `root:root 0644`, so the user still can't write it without a udev rule or `pkexec`.
- **`framework_tool` needs root for everything, reads included.**  Run as the user, it fails at the SMBIOS read and then reports "Not a Framework Laptop".  `/dev/cros_ec` is `crw------- root`.  `cros_ec_lpcs` is loaded, so `--driver cros-ec` is available and should be used instead of the default raw `portio`.
- **`pkexec` works without extra setup.**  `/usr/bin/pkexec` is present and `omarchy-shell` has its own polkit agent (`/usr/share/omarchy/shell/plugins/polkit/`), so the password dialog appears inside the shell's own UI.  `manu` is in `wheel`, so the default `auth_admin` rule accepts the user's own password.

## Design

### Privilege model

The widget never runs as root.  A new script, `charge-limit.sh`, does all charge-limit work and has two halves:

- `charge-limit.sh detect` runs unprivileged.  It prints the backend and, where it can read one without root, the current limit.
- `charge-limit.sh set <N>` is the only part that may run elevated.  When the backend needs root, the widget runs it as `pkexec /abs/path/charge-limit.sh set <N>`.  The script checks that `N` is an integer between 50 and 100 before it touches anything, so a polkit prompt can never be used to write an arbitrary value.  It prints the limit that was in place before the write, which is the value the widget restores later.

Running `pkexec` on a script that lives in a user-writable checkout means a password-protected escalation runs code the user owns.  That's acceptable here: the password prompt is the boundary, and the user owns that code anyway.  The plugin's `make install` symlinks the checkout, so the path `pkexec` sees is stable.

### Backend detection (in order)

| Backend | Detected when | Read | Write |
|---|---|---|---|
| `sysfs` | `charge_control_end_threshold` exists and is writable by the user (a udev rule granted it) | direct | direct, no prompt |
| `sysfs-pkexec` | the attribute exists but is root-only | direct | `pkexec charge-limit.sh set N` |
| `framework_tool` | no attribute, `framework_tool` on `PATH` | needs root, only done inside the privileged `set` call | `pkexec charge-limit.sh set N` → `framework_tool --driver cros-ec --charge-limit N` |
| `none` | neither | — | button hidden |

Detection runs once at startup and again on `refresh`, through the existing single-`Process` discipline: the detect call uses a second `Process`, and that one only ever runs on demand, never on a timer.

With `framework_tool`, the current limit is unknown until the first privileged call.  The panel therefore can't show "limit: 80%" up front.  It learns the value from what `set` returns and stores it in `state.json`, described below.

### The "once" semantics

1. **Click** (not already topped up): `set 100`.  The returned previous limit goes into `~/.local/state/io.github.mvaled.battery-health/charge-limit.json` as `{"restore": 80, "since": <t>}`.  The button switches to its active look, and the tooltip says "Charging to 100% — restores 80% when unplugged".
2. **Restore trigger**: the first UPower transition to unplugged *after* the pack has reached ≥ 99% or `Full`.  The widget then runs `set <restore>` and deletes the state file.  A `pkexec` prompt that shows up at unplug time is acceptable because unplugging means the user is at the machine.
3. **Click again** while active: restore right away (this is the escape hatch, such as when the trip is cancelled).
4. **Shell restart mid-cycle**: the state file outlives the restart, so the button comes back in its active look and the restore trigger still works.
5. **Cancelled prompt** (`pkexec` exits 126 or 127): nothing changes, and the state file is neither written nor removed.

Open point: if the EC or BIOS puts its own limit back on reboot, a reboot while topped up may restore 80% on its own.  The state file then claims a top-up that is no longer in effect.  Fix: on `detect`, if the backend can read the limit (sysfs) and it already equals `restore`, drop the state file.  The `framework_tool` backend can't read without root, so the stale state stays until the next restore, which then writes 80% again and does no harm.

### UI

- A small icon button next to the hero header in `Panel.qml`, using `PanelActionButton` from `qs.Ui`.
- `PanelActionButton` takes a font glyph (`iconText`), and Lucide isn't installed as a font.  Options:
  - **(Recommended)** Ship Lucide's `battery-full.svg` (ISC licence, credited in the README) as `icons/battery-full.svg`.  Draw it in a variant of the button with `Image` and recolour it from the theme foreground by templating the SVG's `stroke` into a `data:` URL, so it follows the theme.
  - Use the Nerd Font battery-full glyph (`󰁹`), which matches the rest of the shell but isn't the Lucide icon you asked for.
- The button is hidden when the backend is `none`.  It shows an active (accent-tinted) state while a top-up is pending, and a tooltip names the backend in use.
- Add an IPC entry `chargeFull` (toggle), so the action can also be bound to a key or a script.

### Files touched

| File | Change |
|---|---|
| `charge-limit.sh` | new: `detect` / `set N`, value validation, backend dispatch |
| `Panel.qml` | detect `Process`, set `Process`, state `FileView`, restore-on-unplug hook in the existing UPower connections, button, IPC `chargeFull` |
| `Model.js` | pure helpers: parse `detect` output, decide whether the restore trigger fired (keeps the logic testable from node) |
| `icons/battery-full.svg` | Lucide icon (if the SVG option is chosen) |
| `Makefile` | `lint`: `bash -n charge-limit.sh` |
| `README.md` | new section: backends, the privilege model, the modprobe option for sysfs and why it's off by default; the "needs no root" sentence under *Install* becomes "needs no root except for the one charge-limit write, which asks" |
| `manifest.json` | bump version to 1.4.0, mention the feature in the description |

No new tests unless you ask.  The `Model.js` helpers are pure and would be easy to cover later.

## Verification

1. `make check`.
2. `! sudo framework_tool --driver cros-ec --charge-limit` to see the real output format before writing the parser (it can't be read without root here, so the format in this plan is unconfirmed).
3. `omarchy restart shell` (per [Live plugin code check](../../README.md#development), `make reload` isn't enough).  Then click the button, enter the password in the shell's polkit dialog, and confirm with `sudo framework_tool --driver cros-ec --charge-limit` that the limit reads 100.
4. Cancel the prompt once and check that nothing changed.
5. Plug in, let the pack reach full, unplug, enter the password, and check that the limit is back at 80.
6. Restart the shell mid-cycle and check that the button comes back in its active state.

## Questions before implementing

1. Restore trigger: is "first unplug after reaching full" right, or would you rather restore only by hand (a second click)?
2. Icon: embedded Lucide SVG (recommended) or the Nerd Font glyph?
3. Should the README suggest the `probe_with_fwk_charge_control=1` route at all, given the kernel disables it on Framework for a reason?  Or should it document only `framework_tool` for Framework machines and keep sysfs for other vendors, such as ThinkPads, ASUS and recent Dells, which expose the threshold natively?
