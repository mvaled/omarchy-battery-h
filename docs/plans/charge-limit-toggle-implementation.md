# Charge-limit toggle: implementation plan

**Goal:** replace the "charge to 100% once" auto-restore with a manual 80%/100% toggle plus an on-demand EC refresh, as approved in [the design](charge-limit-toggle.md).

**Architecture:** `charge-limit.sh` keeps one privileged entry per EC call (`set`, `read`) and gains two unprivileged wrappers (`apply`, `refresh`) that run them through `pkexec` and record the outcome in the state directory.  `Model.js` holds the pure logic (inference, next limit, tooltip, errors, icons).  `Panel.qml` wires files, processes, IPC and the two header buttons.

**Constraints:** no new tests and no commits (user rules); `make check` must stay green; every `pkexec` prompt follows a click or an IPC call.

## Task 1: `charge-limit.sh`

- Keep `set <N>` (50–100, prints the previous limit).
- Add privileged `read`: prints the EC's limit, exit 3 when it cannot be parsed.
- Add `apply <N> <state-dir>`: `pkexec "$self" set N`; on success write `N` to `<state-dir>/charge-limit`, and to `standard-limit` the value that is not 100 among `N` and the reported previous limit (`N` first).  Pass `pkexec`'s exit code through.
- Add `refresh <state-dir>`: `pkexec "$self" read`; on success write the result to `charge-limit`, and to `standard-limit` when below 100.
- Remove `topup`, `restore`, `write_state`, the claim logic and the JSON state; rewrite the header comment and usage line.
- Check: `bash -n charge-limit.sh` (part of `make lint`).

## Task 2: `Model.js`

Remove `TOPUP_FULL_PCT` (renamed `FULL_PCT`, still used by `heldLimit`), `parseTopUp`, `topUpSpent`, `topUpOffered`, `topUpTooltip`, `topUpError`, `batteryFullSvg`.  Rename `parseStandardLimit` to `parseLimit` (used for both files).  Add:

- `inferLimit(probe, onBattery, standardLimit) -> int`: 0 on battery, with no probe or with `standardLimit` unknown; 100 when charging and `probe.pct > standardLimit`; `standardLimit` when `heldLimit(probe, onBattery)` is within 2 points under it (inclusive); otherwise 0.
- `nextLimit(current, standardLimit) -> int`: `current === 100` → `standardLimit` if within 50–99, else 80; anything else → 100.
- `chargeLimitTooltip(busy, current, next, probe, onBattery, error) -> string`: busy → "Waiting for authentication…"; otherwise "Charge limit: N%" (or "unknown"), "Click to set N%", and, when `next < probe.pct` while on AC, "The laptop will then run from the battery down to N%".  Error appended.
- `chargeLimitError(code) -> string`: the old `topUpError` messages, unchanged.
- `lucideSvg(name, cssColor) -> string` for `battery-full`, `battery-medium`, `refresh-cw`, carrying the existing licence comment.
- Check: `make check`.

## Task 3: `Panel.qml`

- State: drop `topUp`, `topUpPath`, `topUpFile`, `restoreSpentTopUp`, the top-up check in `learnStandardLimit`.  Add `chargeLimitFilePath` (`stateDir + "/charge-limit"`), `rememberedLimit`, a watched `FileView` for it, `inferredLimit` (from `Model.inferLimit` with `UPower.onBattery`), and `chargeLimit: inferredLimit || rememberedLimit`.  When `inferredLimit` becomes non-zero and differs from `rememberedLimit`, write it to the file.
- Actions: `runChargeLimit(args)`, `toggleChargeLimit()` (`apply <next> <stateDir>`), `refreshChargeLimit()` (`refresh <stateDir>`); the process' `onExited` sets the error text and reloads both limit files.
- IPC: `chargeFull` → `toggleChargeLimit`, add `refreshChargeLimit`.
- Header: the limit button always visible when `framework_tool` is present, `battery-full` at 100%, `battery-medium` otherwise, dimmed when unknown or busy; a smaller `refresh-cw` button to its left with tooltip "Read the charge limit from the EC (asks for authentication)".
- Check: `make check` (qmldom parse), then `make reload` and verify the shell start time moved before trying it live.

## Task 4: docs

- README: "Charge to 100% once" becomes "Charge limit toggle": the two positions, how the position is known (remembered, sysfs inference, refresh), the measured drain on AC when lowering below the current charge, privileges, the state files.  Update the controls table and file table rows.
- Revert nothing separately: the uncommitted restore-on-unplug edits are superseded by the removals above.
