// Model.js carries the whole data contract of the widget, so it is exercised
// here from plain node: no QML, no shell, no battery required.
//
// Run with `make test`.

const assert = require("assert")
const Model = require("../Model.js")

const DAY = Model.DAY_SEC

function probeText(overrides) {
  const fields = Object.assign({
    present: "1",
    battery: "BAT1",
    unit: "Ah",
    full: "4004000",
    design: "3915000",
    now: "4004000",
    cycles: "2",
    pct: "100",
    volt: "17745000",
    voltdesign: "15480000",
    current: "0",
    power: null,
    status: "Not charging",
    tech: "Li-ion",
    t: "1788000000"
  }, overrides || {})
  return Object.keys(fields)
    .filter((key) => fields[key] !== null)
    .map((key) => key + "\t" + fields[key])
    .join("\n") + "\n"
}

// A synthetic history: `days` daily samples decaying linearly from `fromPct` to
// `toPct` of a fixed design capacity, ending at `end`.
function decayHistory(end, days, fromPct, toPct) {
  const design = 4000000
  return Array.from({ length: days }, (_, index) => {
    const share = days === 1 ? 0 : index / (days - 1)
    const pct = fromPct + (toPct - fromPct) * share
    return {
      t: end - (days - 1 - index) * DAY,
      full: Math.round((design * pct) / 100),
      design: design,
      cyc: index
    }
  })
}

// ------------------------------------------------------------------- probing

{
  const probe = Model.parseProbe(probeText())
  assert.strictEqual(probe.ok, true)
  assert.strictEqual(probe.battery, "BAT1")
  assert.strictEqual(probe.unit, "Ah")
  assert.strictEqual(probe.full, 4004000)
  assert.strictEqual(probe.cycles, 2)
  assert.strictEqual(probe.voltDesign, 15480000)
  assert.strictEqual(probe.t, 1788000000)
  // A pack rated conservatively at the factory really does exceed 100%, and
  // clamping it would hide a legitimate reading.
  assert.ok(Model.probeHealth(probe) > 100)
}

{
  // A machine with no battery: present=0 and nothing else.
  const probe = Model.parseProbe("present\t0\n")
  assert.strictEqual(probe.present, false)
  assert.strictEqual(probe.ok, false)
  assert.strictEqual(Model.probeHealth(probe), 0)
}

{
  // Garbage in must not throw and must not claim a reading.
  assert.strictEqual(Model.parseProbe("").ok, false)
  assert.strictEqual(Model.parseProbe(null).ok, false)
  assert.strictEqual(Model.parseProbe("not tsv at all").ok, false)
  // A zero design capacity would divide health by zero.
  assert.strictEqual(Model.parseProbe(probeText({ design: "0" })).ok, false)
}

{
  // capacity is missing on some drivers; charge_now/charge_full stands in.
  const probe = Model.parseProbe(probeText({ pct: null, now: "2002000" }))
  assert.strictEqual(probe.pct, 50)
}

{
  // energy_* batteries report microwatt-hours and need no voltage to show Wh.
  const probe = Model.parseProbe(probeText({ unit: "Wh", full: "50000000", design: "56000000" }))
  assert.strictEqual(Model.formatCapacity(probe.full, probe.unit), "50.0 Wh")
  assert.strictEqual(Model.formatEnergy(probe.full, probe.unit, 0), "50.0 Wh")
}

{
  // Firmware strings reach a label, so they are stripped of control characters
  // and markup and capped.
  const hostile = Model.parseProbe(probeText({ status: "<b>evil</b>" }))
  assert.strictEqual(hostile.status, "bevil/b")
  assert.strictEqual(Model.safeText("a".repeat(200)).length <= 48, true)
}

{
  assert.strictEqual(Model.statusCode("Charging"), Model.CHARGING)
  assert.strictEqual(Model.statusCode("discharging"), Model.DISCHARGING)
  assert.strictEqual(Model.statusCode("Not charging"), Model.IDLE)
  assert.strictEqual(Model.statusCode(""), Model.IDLE)
}

// ------------------------------------------------------------------- history

{
  // An unreadable file is an empty history, never an exception.
  assert.deepStrictEqual(Model.parseHistory("").health, [])
  assert.deepStrictEqual(Model.parseHistory("{ truncated").health, [])
  assert.deepStrictEqual(Model.parseHistory("[1,2,3]").health, [])
  assert.deepStrictEqual(Model.parseHistory(null).charge, [])
}

{
  // Entries that cannot describe a health reading are dropped rather than
  // poisoning the curve with NaN.
  const state = Model.parseHistory(JSON.stringify({
    v: 1,
    battery: "BAT0",
    unit: "Ah",
    health: [
      { t: 200, full: 100, design: 100, cyc: 1 },
      { t: 100, full: 90, design: 100, cyc: 0 },
      { t: 0, full: 90, design: 100 },
      { t: 300, full: 90, design: 0 },
      { t: 400, full: "x", design: "y" },
      null
    ],
    charge: [{ t: 10, p: 500, s: 9 }]
  }))
  assert.deepStrictEqual(state.health.map((entry) => entry.t), [100, 200])
  assert.strictEqual(state.charge[0].p, 100)
  assert.strictEqual(state.charge[0].s, 1)
}

{
  // A reading that repeats the last one stored earns no row until the
  // heartbeat elapses; a changed one always does.
  const now = 1788000000
  const reading = { t: now, full: 100, design: 100, cyc: 1 }
  assert.strictEqual(Model.shouldRecordHealth([], reading), true)

  const stored = Model.appendHealth([], reading, 730, now)
  assert.strictEqual(stored.length, 1)

  // Same values an hour later: nothing to say.
  assert.strictEqual(
    Model.shouldRecordHealth(stored, { t: now + Model.HOUR_SEC, full: 100, design: 100, cyc: 1 }), false)
  // Same values past the heartbeat: recorded, to prove the gap was observed.
  assert.strictEqual(
    Model.shouldRecordHealth(stored, { t: now + Model.HEALTH_HEARTBEAT_SEC, full: 100, design: 100, cyc: 1 }), true)
  // Capacity moved: recorded immediately, at the minute it moved.
  assert.strictEqual(
    Model.shouldRecordHealth(stored, { t: now + 60, full: 99, design: 100, cyc: 1 }), true)
  // So did the cycle count.
  assert.strictEqual(
    Model.shouldRecordHealth(stored, { t: now + 60, full: 100, design: 100, cyc: 2 }), true)
}

{
  // Two readings in the same day both survive — the point of dropping day
  // buckets is that the timestamp of a change is preserved.
  const now = 1788000000
  let health = Model.appendHealth([], { t: now, full: 100, design: 100, cyc: 1 }, 730, now)
  health = Model.appendHealth(health, { t: now + 3600, full: 99, design: 100, cyc: 1 }, 730, now + 3600)
  assert.strictEqual(health.length, 2)
  assert.deepStrictEqual(health.map((entry) => entry.t), [now, now + 3600])
}

{
  // recordProbe applies the same gate, so a quiet battery polled every ten
  // minutes does not accumulate a row per poll.
  const probe = Model.parseProbe(probeText())
  let state = Model.recordProbe(Model.defaultHistory(), probe, {})
  assert.strictEqual(state.health.length, 1)

  const later = Model.parseProbe(probeText({ t: String(probe.t + 600) }))
  state = Model.recordProbe(state, later, {})
  assert.strictEqual(state.health.length, 1, "an unchanged reading must not add a row")
  // But the charge series still gets every sample: that is what draws the graph.
  assert.strictEqual(state.charge.length, 2)

  const changed = Model.parseProbe(probeText({ t: String(probe.t + 1200), full: "3990000" }))
  state = Model.recordProbe(state, changed, {})
  assert.strictEqual(state.health.length, 2)
  assert.strictEqual(state.health[1].t, probe.t + 1200)
}

{
  // Retention drops what falls out of the window.
  const now = 1788000000
  const old = Model.appendHealth([], { t: now - 40 * DAY, full: 100, design: 100, cyc: 0 }, 30, now)
  assert.strictEqual(old.length, 0)
}

{
  // Both arrays are hard-capped regardless of the configured retention.
  const now = 1788000000
  const oversized = Array.from({ length: Model.MAX_CHARGE_ENTRIES + 500 }, (_, index) => ({
    t: now - index, p: 50, s: 0
  }))
  const charge = Model.appendCharge(oversized, { t: now + 1, p: 50, s: 0 },
                                    30 * Model.DAY_SEC, now + 1)
  assert.strictEqual(charge.length, Model.MAX_CHARGE_ENTRIES)
  // The cap keeps the newest samples, which are the ones the sparkline draws.
  assert.strictEqual(charge[charge.length - 1].t, now + 1)
}

{
  // The charge window prunes on time as well as on count.
  const now = 1788000000
  const list = [{ t: now - 30 * Model.HOUR_SEC, p: 40, s: 0 }]
  const charge = Model.appendCharge(list, { t: now, p: 60, s: 1 }, 24 * Model.HOUR_SEC, now)
  assert.strictEqual(charge.length, 1)
  assert.strictEqual(charge[0].p, 60)
}

{
  // Swapping the pack restarts the history: the old curve describes hardware
  // that is no longer in the machine.
  const probe = Model.parseProbe(probeText({ battery: "BAT0" }))
  const previous = {
    v: 1,
    battery: "BAT1",
    unit: "Ah",
    health: decayHistory(probe.t - 10 * DAY, 20, 100, 95),
    charge: [{ t: probe.t - 60, p: 40, s: 0 }]
  }
  const next = Model.recordProbe(previous, probe, {})
  assert.strictEqual(next.battery, "BAT0")
  assert.strictEqual(next.health.length, 1)
  assert.strictEqual(next.charge.length, 1)
}

{
  // The same pack keeps accumulating.
  const probe = Model.parseProbe(probeText())
  const previous = {
    v: 1,
    battery: "BAT1",
    unit: "Ah",
    health: decayHistory(probe.t - 5 * DAY, 10, 100, 98),
    charge: []
  }
  const next = Model.recordProbe(previous, probe, {})
  assert.strictEqual(next.health.length, 11)
  assert.strictEqual(next.charge.length, 1)
  assert.strictEqual(next.health[next.health.length - 1].t, probe.t)
}

{
  // A failed probe leaves the stored history exactly as it was.
  const state = Model.defaultHistory()
  assert.strictEqual(Model.recordProbe(state, Model.parseProbe("present\t0"), {}), state)
}

{
  // Round-tripping through the file format preserves every reading.
  const probe = Model.parseProbe(probeText())
  const state = Model.recordProbe(Model.defaultHistory(), probe, {})
  const reloaded = Model.parseHistory(Model.serializeHistory(state))
  assert.deepStrictEqual(reloaded.health, state.health)
  assert.deepStrictEqual(reloaded.charge, state.charge)
}

{
  // Draw is signed by `status`, not by the number: sysfs reports a magnitude on
  // most drivers, and signs it on a few.
  const idle = Model.parseProbe(probeText({ current: "0" }))
  assert.strictEqual(Model.watts(idle), 0)

  const draining = Model.parseProbe(probeText({ status: "Discharging", current: "1200000" }))
  assert.ok(Model.watts(draining) < 0, "discharging must be negative")
  assert.ok(Math.abs(Model.watts(draining) + 21.29) < 0.05, String(Model.watts(draining)))

  const charging = Model.parseProbe(probeText({ status: "Charging", current: "2000000" }))
  assert.ok(Model.watts(charging) > 0, "charging must be positive")

  // A driver that signs current_now must not end up with a flipped sign.
  const signed = Model.parseProbe(probeText({ status: "Discharging", current: "-1200000" }))
  assert.ok(Math.abs(Model.watts(signed) - Model.watts(draining)) < 1e-9)

  // Current flowing while neither charging nor discharging is not charge
  // moving in or out of the pack, so it is not drawn.
  const held = Model.parseProbe(probeText({ status: "Not charging", current: "500000" }))
  assert.strictEqual(Model.watts(held), 0)

  // power_now wins where the driver offers it.
  const viaPower = Model.parseProbe(probeText({ status: "Discharging", power: "15000000", current: "1200000" }))
  assert.ok(Math.abs(Model.watts(viaPower) + 15) < 1e-9, String(Model.watts(viaPower)))

  // No battery, no draw, and no exception.
  assert.strictEqual(Model.watts(Model.parseProbe("present\t0")), 0)
  assert.strictEqual(Model.watts(null), 0)
}

{
  // The power axis is symmetric so charging and discharging share a scale, and
  // floored so a quiet pack does not get a hair-trigger axis.
  assert.strictEqual(Model.powerScale([]), 5)
  assert.strictEqual(Model.powerScale([{ w: 0 }, { w: -0.2 }]), 5)
  assert.strictEqual(Model.powerScale([{ w: -21.3 }, { w: 8 }]), 30)
  // The bound covers the peak in either direction.
  const scale = Model.powerScale([{ w: -64 }, { w: 12 }])
  assert.ok(scale >= 64, String(scale))
  // An absurd reading cannot blow the axis past the clamp.
  assert.strictEqual(Model.powerScale([{ w: 100000 }]), Model.MAX_ABS_WATTS)

  assert.strictEqual(Model.formatWatts(0), "0 W")
  assert.strictEqual(Model.formatWatts(-21.28), "−21.3 W")
  assert.strictEqual(Model.formatWatts(35.5), "+35.5 W")
}

{
  // Watts are stored per charge sample and survive the file round-trip, and a
  // reading beyond what any laptop pack can do is clamped rather than kept.
  const probe = Model.parseProbe(probeText({ status: "Discharging", current: "1200000" }))
  const state = Model.recordProbe(Model.defaultHistory(), probe, {})
  assert.ok(state.charge[0].w < 0)

  const reloaded = Model.parseHistory(Model.serializeHistory(state))
  assert.ok(Math.abs(reloaded.charge[0].w - state.charge[0].w) < 1e-9)

  const absurd = Model.parseHistory(JSON.stringify({
    v: 1, battery: "BAT1", unit: "Ah", health: [],
    charge: [{ t: 1788000000, p: 50, s: -1, w: -99999 }]
  }))
  assert.strictEqual(absurd.charge[0].w, -Model.MAX_ABS_WATTS)

  // An older file with no `w` reads as zero draw, not NaN.
  const legacy = Model.parseHistory(JSON.stringify({
    v: 1, battery: "BAT1", unit: "Ah", health: [],
    charge: [{ t: 1788000000, p: 50, s: 0 }]
  }))
  assert.strictEqual(legacy.charge[0].w, 0)
}

{
  // Two monitors means two live instances writing one file. A merge on read is
  // what stops the second writer from dropping the first one's samples.
  const now = 1788000000
  const a = {
    v: 1, battery: "BAT1", unit: "Ah",
    health: [{ t: now, full: 100, design: 100, cyc: 1 }],
    charge: [{ t: now, p: 50, s: 0, w: 0 }, { t: now + 60, p: 51, s: 1, w: 12 }]
  }
  const b = {
    v: 1, battery: "BAT1", unit: "Ah",
    health: [{ t: now + 600, full: 99, design: 100, cyc: 2 }],
    charge: [{ t: now, p: 50, s: 0, w: 0 }, { t: now + 120, p: 52, s: 1, w: 13 }]
  }

  const merged = Model.mergeHistories(a, b)
  assert.deepStrictEqual(merged.health.map((e) => e.t), [now, now + 600])
  // The sample both instances hold appears once, not twice.
  assert.deepStrictEqual(merged.charge.map((e) => e.t), [now, now + 60, now + 120])

  // Order-independent, so it does not matter which instance reloads first.
  const other = Model.mergeHistories(b, a)
  assert.deepStrictEqual(other.charge.map((e) => e.t), merged.charge.map((e) => e.t))
  assert.deepStrictEqual(other.health.map((e) => e.t), merged.health.map((e) => e.t))

  // Merging an empty local state is just adopting the file.
  const fresh = Model.mergeHistories(Model.defaultHistory(), a)
  assert.deepStrictEqual(fresh.charge.map((e) => e.t), a.charge.map((e) => e.t))
  assert.strictEqual(fresh.battery, "BAT1")

  // A pack swap must not be undone by merging the old pack's curve back in.
  const swapped = Model.mergeHistories(
    { v: 1, battery: "BAT0", unit: "Ah", health: [], charge: [] }, a)
  assert.strictEqual(swapped.battery, "BAT0")
  assert.strictEqual(swapped.health.length, 0)

  // The caps still hold after a merge, so two instances cannot grow the file
  // past what one of them would.
  const flood = {
    v: 1, battery: "BAT1", unit: "Ah", health: [],
    charge: Array.from({ length: Model.MAX_CHARGE_ENTRIES + 200 },
                       (_, i) => ({ t: now + i, p: 50, s: 0, w: 0 }))
  }
  assert.strictEqual(Model.mergeHistories(flood, a).charge.length, Model.MAX_CHARGE_ENTRIES)
}

// --------------------------------------------------------------------- stats

{
  // A year of steady decay from 100% to 88% is a shade under -1%/month.
  const now = 1788000000
  const stats = Model.wearStats(decayHistory(now, 365, 100, 88), now)
  assert.strictEqual(stats.points, 365)
  assert.ok(Math.abs(stats.current - 88) < 0.01)
  assert.ok(stats.perMonth < -0.9 && stats.perMonth > -1.1, "perMonth=" + stats.perMonth)
  assert.ok(stats.delta30 !== null && stats.delta30 < 0)
  assert.ok(stats.delta90 !== null && stats.delta90 < stats.delta30)
  // Eight more points of decline before it crosses 80%.
  const monthsOut = (stats.eolEpoch - now) / Model.MONTH_SEC
  assert.ok(monthsOut > 6 && monthsOut < 10, "monthsOut=" + monthsOut)
}

{
  // Too few points, or too short a span, yields no slope rather than a
  // confident-looking number derived from sysfs rounding.
  const now = 1788000000
  assert.strictEqual(Model.wearStats(decayHistory(now, 3, 100, 99), now).perMonth, null)
  assert.strictEqual(Model.wearStats(decayHistory(now, 10, 100, 99), now).perMonth, null)
  assert.strictEqual(Model.wearStats([], now).points, 0)
  assert.strictEqual(Model.wearStats([], now).current, null)
}

{
  // A history shorter than the comparison window reports no delta instead of
  // silently comparing against its own oldest point.
  const now = 1788000000
  const stats = Model.wearStats(decayHistory(now, 20, 100, 99), now)
  assert.strictEqual(stats.delta30, null)
  assert.strictEqual(stats.delta90, null)
}

{
  // A flat or improving battery gets no end-of-life date.
  const now = 1788000000
  assert.strictEqual(Model.wearStats(decayHistory(now, 200, 95, 95), now).eolEpoch, null)
  assert.strictEqual(Model.wearStats(decayHistory(now, 200, 90, 95), now).eolEpoch, null)
}

{
  // Neither does one already past the line, since there is nothing to project.
  const now = 1788000000
  assert.strictEqual(Model.wearStats(decayHistory(now, 200, 82, 76), now).eolEpoch, null)
}

{
  // Cycle rate needs two known counts and a meaningful span; a counter that
  // resets (pack swap mid-history) reports nothing rather than a negative rate.
  const now = 1788000000
  const points = Model.healthSeries(decayHistory(now, 60, 100, 98))
  assert.ok(Model.cycleRatePerMonth(points) > 0)
  assert.strictEqual(Model.cycleRatePerMonth([]), null)
  assert.strictEqual(Model.cycleRatePerMonth([
    { t: 0, pct: 100, cyc: 90 },
    { t: 100 * DAY, pct: 99, cyc: 10 }
  ]), null)
}

{
  const now = 1788000000
  const charge = [
    { t: now - 40 * Model.HOUR_SEC, p: 10, s: 1 },
    { t: now - 2 * Model.HOUR_SEC, p: 80, s: 0 }
  ]
  assert.strictEqual(Model.chargeSeries(charge, 24 * Model.HOUR_SEC, now).length, 1)
  assert.strictEqual(Model.chargeSeries(charge, 48 * Model.HOUR_SEC, now).length, 2)
}

{
  // Polling follows the charge state: fast while current flows, slow when it
  // does not, and slow when there is no battery to watch at all.
  const charging = Model.parseProbe(probeText({ status: "Charging" }))
  const draining = Model.parseProbe(probeText({ status: "Discharging" }))
  const idle = Model.parseProbe(probeText({ status: "Not charging" }))
  const absent = Model.parseProbe("present\t0")

  assert.strictEqual(Model.sampleIntervalFor(charging, 600, 1800), 600)
  assert.strictEqual(Model.sampleIntervalFor(draining, 600, 1800), 600)
  assert.strictEqual(Model.sampleIntervalFor(idle, 600, 1800), 1800)
  assert.strictEqual(Model.sampleIntervalFor(absent, 600, 1800), 1800)
  // Nonsense settings cannot produce a hot loop.
  assert.strictEqual(Model.sampleIntervalFor(draining, 0, 0), 60)
  assert.strictEqual(Model.sampleIntervalFor(draining, "x", "y"), 600)
}

{
  // The axis is a week wide, but never wider than the data: a fresh install
  // fills the frame with the hours it has instead of drawing a hairline against
  // six empty days.
  const now = 1788000000
  const week = Model.DEFAULT_CHARGE_WINDOW_SEC
  assert.strictEqual(week, 7 * Model.DAY_SEC)

  const full = Model.chargeWindowRange([{ t: now - week }, { t: now }], week, now)
  assert.strictEqual(now - full.from, week)

  const partial = Model.chargeWindowRange(
    [{ t: now - 3 * Model.HOUR_SEC }, { t: now }], week, now)
  assert.strictEqual(now - partial.from, 3 * Model.HOUR_SEC)

  // Data older than the window never widens the axis past it.
  const older = Model.chargeWindowRange(
    [{ t: now - 30 * Model.DAY_SEC }, { t: now }], week, now)
  assert.strictEqual(now - older.from, week)

  // A single sample would give the axis no width at all, which would divide by
  // zero in the paint; it gets an hour instead.
  assert.strictEqual(now - Model.chargeWindowRange([{ t: now }], week, now).from,
                     Model.HOUR_SEC)
  assert.strictEqual(now - Model.chargeWindowRange([], week, now).from, week)

  assert.strictEqual(Model.formatWindowSpan(week), "7 days")
  assert.strictEqual(Model.formatWindowSpan(3 * Model.HOUR_SEC), "3 hours")
  assert.strictEqual(Model.formatWindowSpan(45 * 60), "45 min")
  assert.strictEqual(Model.formatWindowSpan(0), "no data")

  // Retention has to reach as far as the axis does, or the graph can never
  // fill: a week-wide window must keep week-old samples.
  const kept = Model.appendCharge(
    [{ t: now - 6 * Model.DAY_SEC, p: 40, s: 0, w: 0 }],
    { t: now, p: 60, s: 1, w: 10 }, week, now)
  assert.strictEqual(kept.length, 2, "a six-day-old sample must survive a week-wide window")
}

// ---------------------------------------------------------------- formatting

{
  assert.strictEqual(Model.formatPercent(null), "—")
  assert.strictEqual(Model.formatPercent(102.34), "102.3%")
  assert.strictEqual(Model.formatDelta(null), "—")
  assert.strictEqual(Model.formatDelta(-1.25), "−1.3%")
  assert.strictEqual(Model.formatDelta(0), "±0.0%")
  assert.strictEqual(Model.formatRate(null), "—")
  assert.strictEqual(Model.formatRate(-0.4), "−0.40%/mo")
  assert.strictEqual(Model.formatCapacity(4004000, "Ah"), "4004 mAh")
  assert.strictEqual(Model.formatCapacity(0, "Ah"), "—")
  assert.strictEqual(Model.formatEnergy(4004000, "Ah", 15480000), "62.0 Wh")
  assert.strictEqual(Model.formatEnergy(4004000, "Ah", 0), "")
  assert.strictEqual(Model.formatSpan(1), "1 day")
  assert.strictEqual(Model.formatSpan(45), "45 days")
  assert.strictEqual(Model.formatSpan(365), "12 months")
  assert.strictEqual(Model.formatSpan(1000), "2.7 years")
}

{
  // The bar readout carries no glyph: omarchy.power already shows one, and this
  // widget normally sits right beside it.
  const probe = Model.parseProbe(probeText({ pct: "63" }))
  assert.strictEqual(Model.barText(probe, null, "charge"), "63%")
  assert.strictEqual(Model.barText(probe, null, "health"), "102%")
  assert.strictEqual(Model.barText(probe, null, "cycles"), "2 cyc")
  // An unknown mode falls back to the charge level, which is the default.
  assert.strictEqual(Model.barText(probe, null, ""), "63%")
  assert.ok(!/[\u{F0000}-\u{FFFFD}]/u.test(Model.barText(probe, null, "charge")),
            "the bar readout must contain no private-use glyph")

  // health prefers the stored curve's latest point over the raw probe, so the
  // bar and the panel cannot disagree.
  assert.strictEqual(Model.barText(probe, { current: 88.4, points: 9 }, "health"), "88%")

  const noCycles = Model.parseProbe(probeText({ cycles: null }))
  assert.strictEqual(Model.barText(noCycles, null, "cycles"), "—")

  const absent = Model.parseProbe("present\t0")
  assert.strictEqual(Model.barText(absent, null, "charge"), "—")
  assert.strictEqual(Model.barText(absent, null, "health"), "—")
  assert.ok(Model.barTooltip(absent, null).indexOf("no battery") >= 0)

  // The tooltip keeps whatever the bar is not currently showing reachable.
  const tooltip = Model.barTooltip(probe, null)
  assert.ok(tooltip.indexOf("Charge 63%") >= 0, tooltip)
  assert.ok(tooltip.indexOf("Health 102.3%") >= 0, tooltip)
  assert.ok(tooltip.indexOf("2 cycles") >= 0, tooltip)
}

{
  assert.strictEqual(Model.batteryGlyph(Model.parseProbe(probeText({ status: "Charging" }))), "󰂄")
  assert.strictEqual(Model.batteryGlyph(Model.parseProbe(probeText({ pct: "100" }))), "󰂅")
  // Each tenth of charge maps to its own glyph in the ramp.
  const low = Model.batteryGlyph(Model.parseProbe(probeText({ pct: "5", status: "Discharging" })))
  const mid = Model.batteryGlyph(Model.parseProbe(probeText({ pct: "55", status: "Discharging" })))
  assert.notStrictEqual(low, mid)
}

// ------------------------------------------------------------ graph geometry

{
  // A battery sitting at a flat 100% must not have its rounding noise blown up
  // into a dramatic cliff: the axis never gets narrower than the minimum span.
  const flat = Model.niceBounds([100, 100, 100], 4)
  assert.ok(flat.max - flat.min >= 4)
  assert.ok(flat.min <= 100 && flat.max >= 100)

  const wide = Model.niceBounds([80.2, 99.8], 4)
  assert.ok(wide.min <= 80.2 && wide.max >= 99.8)

  // No data still yields a drawable frame instead of NaN bounds.
  const empty = Model.niceBounds([], 4)
  assert.ok(isFinite(empty.min) && isFinite(empty.max) && empty.max > empty.min)
}

{
  const ticks = Model.axisTicks(80, 100, 4)
  assert.strictEqual(ticks.length, 5)
  assert.strictEqual(ticks[0], 80)
  assert.strictEqual(ticks[4], 100)
}

{
  // Short spans are labelled by day, long ones by month.
  const now = 1788000000
  const short = Model.timeTicks(now - 10 * DAY, now, 3)
  assert.strictEqual(short.length, 4)
  assert.ok(/^\d+ [A-Z][a-z]{2}$/.test(short[0].label), short[0].label)

  const long = Model.timeTicks(now - 400 * DAY, now, 3)
  assert.ok(/^[A-Z][a-z]{2} \d{4}$/.test(long[0].label), long[0].label)
}

console.log("Model.js: all assertions passed")
