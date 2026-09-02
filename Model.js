// Parsing, history bookkeeping and stats for the Battery Health widget.
//
// Everything here is pure JavaScript with no QML imports, so the whole data
// contract — probe parsing, retention, the wear projection, axis ticks — is
// exercised from node by tests/model.test.js without a running shell. Panel.qml
// keeps only rendering and the Quickshell wiring.

var SCHEMA = 1

var DAY_SEC = 86400
var HOUR_SEC = 3600
// Average Gregorian month. Wear is reported per month, and a 30-day month would
// drift the projection by five days a year for no reason.
var MONTH_SEC = 2629800

// Hard ceilings on what the history file may hold, independent of the
// retention settings. A malformed or hand-edited file cannot make the shell
// chew through an unbounded array on every repaint.
var MAX_HEALTH_ENTRIES = 10000
// A week of samples: every ten minutes while current flows, plus a sample per
// whole percent crossed. A heavy week lands in the low thousands; the ceiling
// leaves room above that and still caps the file well under a megabyte.
var MAX_CHARGE_ENTRIES = 12000

// The capacity retention conventionally treated as end of useful life, and the
// floor the projection extrapolates down to.
var DEFAULT_CHARGE_WINDOW_SEC = 7 * DAY_SEC

var END_OF_LIFE_PCT = 80

// Below this many points, or this short a span, a least-squares slope through
// health samples says more about sysfs rounding than about the battery.
var MIN_TREND_POINTS = 4
var MIN_TREND_SPAN_SEC = 14 * DAY_SEC

var CHARGING = 1
var IDLE = 0
var DISCHARGING = -1

var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                   "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// The battery ramp Omarchy's own power panel uses, indexed by tenth of charge.
var LEVEL_GLYPHS = ["󰁺", "󰁻", "󰁼", "󰁽", "󰁾", "󰁿", "󰂀", "󰂁", "󰂂", "󰁹"]
var GLYPH_CHARGING = "󰂄"
var GLYPH_FULL = "󰂅"

// Every text field here comes from firmware, so treat it as hostile before it
// reaches a label: drop control characters and angle brackets, collapse
// whitespace, and cap the length so an odd status string cannot stretch the
// panel.
function safeText(value, limit) {
  var text = value === null || value === undefined ? "" : String(value)
  text = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>]/g, "")
  text = text.split(/\s+/).join(" ").trim()
  var cap = limit || 48
  return text.length > cap ? text.slice(0, cap).replace(/\s+\S*$/, "") : text
}

function num(value, fallback) {
  var parsed = Number(value)
  return isFinite(parsed) ? parsed : (fallback === undefined ? 0 : fallback)
}

// ------------------------------------------------------------------ probing

function defaultProbe() {
  return {
    ok: false,
    present: false,
    battery: "",
    unit: "Ah",
    full: 0,
    design: 0,
    now: 0,
    cycles: -1,
    pct: -1,
    volt: 0,
    voltDesign: 0,
    current: 0,
    power: 0,
    status: "",
    t: 0
  }
}

var PROBE_NUMERIC = {
  full: "full",
  design: "design",
  now: "now",
  cycles: "cycles",
  pct: "pct",
  volt: "volt",
  voltdesign: "voltDesign",
  current: "current",
  power: "power",
  t: "t"
}

var PROBE_TEXT = {
  battery: "battery",
  unit: "unit",
  status: "status"
}

function assignProbeField(probe, key, value) {
  if (key === "present") {
    probe.present = value === "1"
  } else if (PROBE_NUMERIC[key]) {
    probe[PROBE_NUMERIC[key]] = num(value, key === "cycles" || key === "pct" ? -1 : 0)
  } else if (PROBE_TEXT[key]) {
    probe[PROBE_TEXT[key]] = safeText(value)
  }
}

function splitPair(line) {
  var idx = String(line).indexOf("\t")
  return idx <= 0 ? null : [line.substring(0, idx), line.substring(idx + 1)]
}

// Turns probe.sh's TSV into a probe object. Unknown keys are ignored rather
// than rejected so a newer probe script stays readable by an older panel.
function parseProbe(raw) {
  var probe = defaultProbe()
  var pairs = String(raw || "").split("\n").map(splitPair).filter(function (pair) {
    return pair !== null
  })
  pairs.forEach(function (pair) { assignProbeField(probe, pair[0], pair[1]) })

  if (probe.unit !== "Wh") probe.unit = "Ah"
  if (probe.t <= 0) probe.t = Math.floor(Date.now() / 1000)
  // A design capacity of zero is what a battery that has not been read yet
  // looks like, and dividing by it would report an infinite health.
  probe.ok = probe.present && probe.design > 0 && probe.full > 0
  if (probe.pct < 0 && probe.ok && probe.now > 0) {
    probe.pct = Math.round((probe.now / probe.full) * 100)
  }
  return probe
}

function healthPercent(full, design) {
  return design > 0 ? (full / design) * 100 : 0
}

function probeHealth(probe) {
  return probe && probe.ok ? healthPercent(probe.full, probe.design) : 0
}

// sysfs spells the charge direction several ways across drivers; everything
// that is not explicitly moving current counts as idle.
function statusCode(status) {
  var text = String(status || "").toLowerCase()
  if (text === "charging") return CHARGING
  if (text === "discharging") return DISCHARGING
  return IDLE
}

// Signed draw in watts: positive charging, negative discharging, zero when no
// current is flowing. sysfs reports a magnitude and leaves the direction to
// `status`, so the sign is taken from there rather than from the number — a few
// drivers do sign current_now, which is why the magnitude is taken absolute
// first instead of trusted.
//
// power_now is microwatts and authoritative where the driver offers it.
// Otherwise the pack reports current_now in microamperes, and watts are its
// product with the present voltage.
function watts(probe) {
  if (!probe || !probe.ok) return 0
  var magnitude = 0
  if (probe.power > 0) {
    magnitude = probe.power / 1e6
  } else if (probe.volt > 0 && probe.current !== 0) {
    magnitude = (probe.volt / 1e6) * (Math.abs(probe.current) / 1e6)
  }
  if (!isFinite(magnitude) || magnitude <= 0) return 0

  var code = statusCode(probe.status)
  if (code === CHARGING) return magnitude
  if (code === DISCHARGING) return -magnitude
  // Idle, full, or held at a charge threshold: whatever trickle the driver
  // reports is not charge moving in or out of the pack in a way worth drawing.
  return 0
}

// ------------------------------------------------------------------ history

function defaultHistory() {
  return { v: SCHEMA, battery: "", unit: "Ah", health: [], charge: [] }
}

function byTime(a, b) { return a.t - b.t }

function isFiniteEntry(entry) {
  return !!entry && isFinite(Number(entry.t)) && Number(entry.t) > 0
}

function normalizeHealthEntry(entry) {
  return {
    t: Math.floor(num(entry.t)),
    full: num(entry.full),
    design: num(entry.design),
    cyc: entry.cyc === undefined || entry.cyc === null ? -1 : Math.floor(num(entry.cyc, -1))
  }
}

// `w` is clamped to a range no laptop pack can leave honestly, so one absurd
// reading cannot flatten the power axis for the whole window.
var MAX_ABS_WATTS = 300

function normalizeChargeEntry(entry) {
  return {
    t: Math.floor(num(entry.t)),
    p: Math.max(0, Math.min(100, num(entry.p))),
    s: Math.max(-1, Math.min(1, Math.round(num(entry.s)))),
    w: Math.max(-MAX_ABS_WATTS, Math.min(MAX_ABS_WATTS, num(entry.w)))
  }
}

// Reads the on-disk history, tolerating anything: absent file, truncated JSON,
// a hand-edited array, entries from a future schema. Anything unusable degrades
// to an empty history rather than throwing inside a QML signal handler.
function parseHistory(raw) {
  var state = defaultHistory()
  var parsed = null
  try {
    parsed = JSON.parse(String(raw || ""))
  } catch (error) {
    return state
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return state

  state.battery = safeText(parsed.battery)
  state.unit = parsed.unit === "Wh" ? "Wh" : "Ah"
  if (Array.isArray(parsed.health)) {
    state.health = parsed.health.filter(isFiniteEntry).map(normalizeHealthEntry)
      .filter(function (entry) { return entry.design > 0 && entry.full > 0 })
      .sort(byTime)
  }
  if (Array.isArray(parsed.charge)) {
    state.charge = parsed.charge.filter(isFiniteEntry).map(normalizeChargeEntry).sort(byTime)
  }
  return state
}

function serializeHistory(state) {
  return JSON.stringify({
    v: SCHEMA,
    battery: state.battery || "",
    unit: state.unit === "Wh" ? "Wh" : "Ah",
    health: state.health || [],
    charge: state.charge || []
  }) + "\n"
}

// Health samples keep their real timestamp. `charge_full` only moves when the
// firmware recalibrates, so storing every poll would be thousands of identical
// rows — but bucketing to a day throws away *when* the capacity actually
// changed, which is the interesting part. The compromise is change-point
// storage: a sample is kept when a value differs from the last one on record,
// and otherwise only often enough to prove the gap was observed rather than
// unmonitored.
var HEALTH_HEARTBEAT_SEC = 6 * HOUR_SEC

function sameHealthReading(a, b) {
  return !!a && !!b && a.full === b.full && a.design === b.design && a.cyc === b.cyc
}

// Whether this reading earns a row: the first one always does, a changed one
// always does, and an unchanged one only once the heartbeat has elapsed.
function shouldRecordHealth(list, entry, heartbeatSec) {
  var entries = Array.isArray(list) ? list : []
  if (entries.length === 0) return true
  var last = entries[entries.length - 1]
  if (!sameHealthReading(last, normalizeHealthEntry(entry))) return true
  var heartbeat = heartbeatSec === undefined ? HEALTH_HEARTBEAT_SEC : heartbeatSec
  return entry.t - last.t >= heartbeat
}

function appendHealth(list, entry, retentionDays, now) {
  var incoming = normalizeHealthEntry(entry)
  var kept = (Array.isArray(list) ? list : []).slice()
  kept.push(incoming)
  kept.sort(byTime)

  var cutoff = now - Math.max(1, retentionDays) * DAY_SEC
  var pruned = kept.filter(function (existing) { return existing.t >= cutoff })
  return pruned.length > MAX_HEALTH_ENTRIES
    ? pruned.slice(pruned.length - MAX_HEALTH_ENTRIES)
    : pruned
}

// How long to wait before the next poll. Capacity and charge only move while
// current is flowing, so a pack sitting on AC at its charge limit is polled
// far less often than one actively charging or draining.
function sampleIntervalFor(probe, activeSec, idleSec) {
  var active = Math.max(60, num(activeSec, 600))
  var idle = Math.max(60, num(idleSec, 1800))
  if (!probe || !probe.ok) return idle
  return statusCode(probe.status) === IDLE ? idle : active
}

function appendCharge(list, entry, windowSec, now) {
  var incoming = normalizeChargeEntry(entry)
  var kept = (Array.isArray(list) ? list : []).slice()
  kept.push(incoming)
  kept.sort(byTime)

  var cutoff = now - Math.max(HOUR_SEC, windowSec)
  var pruned = kept.filter(function (existing) { return existing.t >= cutoff })
  return pruned.length > MAX_CHARGE_ENTRIES
    ? pruned.slice(pruned.length - MAX_CHARGE_ENTRIES)
    : pruned
}

// Rows older than a week are compacted. At one heartbeat every six hours, two
// years of an untouched battery is 2920 rows against a plot about 500 pixels
// wide — six points per pixel, rebuilt on every hover repaint, to draw a line
// whose shape a hundred points describe exactly as well.
//
// What survives is chosen so the compacted curve is not an approximation of the
// full one but an exact record of it: capacity only changes at discrete moments,
// so keeping both sides of every change preserves the value *and* the moment it
// moved, and a month with no change is fully described by any single reading
// from it.
var HEALTH_FULL_DETAIL_SEC = 7 * DAY_SEC

function healthMoved(a, b) {
  return a.full !== b.full || a.design !== b.design
}

// Local calendar month, matching dayStart's local-time convention.
function monthKey(epoch) {
  var date = new Date(epoch * 1000)
  return date.getFullYear() + "-" + date.getMonth()
}

function compactHealth(list, now, fullDetailSec) {
  var entries = Array.isArray(list) ? list : []
  if (entries.length < 3) return entries

  var detail = fullDetailSec === undefined ? HEALTH_FULL_DETAIL_SEC : fullDetailSec
  var boundary = now - Math.max(DAY_SEC, detail)
  var older = entries.filter(function (entry) { return entry.t < boundary })
  var recent = entries.filter(function (entry) { return entry.t >= boundary })
  if (older.length < 3) return entries

  // Both sides of every movement: the last reading at the old value and the
  // first at the new one, which is what pins down when the change happened.
  var keep = {}
  var movedMonths = {}
  older.forEach(function (entry, index) {
    if (index > 0 && healthMoved(older[index - 1], entry)) {
      keep[index - 1] = true
      keep[index] = true
      movedMonths[monthKey(older[index - 1].t)] = true
      movedMonths[monthKey(entry.t)] = true
    }
  })

  // A quiet month contributes its last reading, so a long flat stretch still
  // anchors the curve instead of disappearing from it.
  var lastOfMonth = {}
  older.forEach(function (entry, index) { lastOfMonth[monthKey(entry.t)] = index })
  Object.keys(lastOfMonth).forEach(function (month) {
    if (!movedMonths[month]) keep[lastOfMonth[month]] = true
  })

  return older.filter(function (entry, index) { return keep[index] }).concat(recent)
}

// A probe folded into the stored history. Returns a fresh state object so the
// QML side can assign it in one go and let property bindings re-evaluate.
function recordProbe(state, probe, options) {
  if (!probe || !probe.ok) return state
  var opts = options || {}
  var now = probe.t
  var retentionDays = num(opts.historyDays, 730)
  var windowSec = num(opts.chargeWindowSec, DEFAULT_CHARGE_WINDOW_SEC)

  // A different battery pack means the old curve describes hardware that is no
  // longer in the machine. Keeping it would draw a cliff that reads as sudden
  // failure, so the history restarts instead.
  var replaced = state.battery && probe.battery && state.battery !== probe.battery
  var health = replaced ? [] : state.health
  var charge = replaced ? [] : state.charge
  var reading = { t: now, full: probe.full, design: probe.design, cyc: probe.cycles }

  var nextHealth = shouldRecordHealth(health, reading, num(opts.healthHeartbeatSec, HEALTH_HEARTBEAT_SEC))
    ? appendHealth(health, reading, retentionDays, now)
    : health

  return {
    v: SCHEMA,
    battery: probe.battery,
    unit: probe.unit,
    health: compactHealth(nextHealth, now, num(opts.healthDetailSec, HEALTH_FULL_DETAIL_SEC)),
    charge: probe.pct < 0 ? charge : appendCharge(charge, {
      t: now,
      p: probe.pct,
      s: statusCode(probe.status),
      w: watts(probe)
    }, windowSec, now)
  }
}

// The bar is drawn once per monitor, so on a two-screen machine two instances
// of this widget are alive at once — both sampling, both persisting to the same
// file. Each holds its own in-memory history, so a plain last-writer-wins
// overwrite silently drops whatever the other one had just recorded. Merging by
// timestamp on every read makes the two writers converge instead.
function dedupeByTime(list) {
  var byTimestamp = {}
  list.forEach(function (entry) { byTimestamp[entry.t] = entry })
  return Object.keys(byTimestamp)
    .map(function (key) { return byTimestamp[key] })
    .sort(byTime)
}

function capTail(list, limit) {
  return list.length > limit ? list.slice(list.length - limit) : list
}

function mergeHistories(local, incoming) {
  if (!incoming) return local || defaultHistory()
  if (!local) return incoming
  // A pack swap resets the history. Whichever instance noticed the new battery
  // first is right, and merging the old pack's curve back in would undo it.
  if (local.battery && incoming.battery && local.battery !== incoming.battery) return local

  return {
    v: SCHEMA,
    battery: local.battery || incoming.battery,
    unit: local.unit || incoming.unit,
    health: capTail(dedupeByTime((local.health || []).concat(incoming.health || [])),
                    MAX_HEALTH_ENTRIES),
    charge: capTail(dedupeByTime((local.charge || []).concat(incoming.charge || [])),
                    MAX_CHARGE_ENTRIES)
  }
}

// --------------------------------------------------------------------- stats

function healthAt(entry) {
  return healthPercent(entry.full, entry.design)
}

// Least-squares slope of health against time, in percent per month. Returns
// null when the sample is too thin or too short for the slope to mean anything.
function trendPerMonth(points) {
  if (points.length < MIN_TREND_POINTS) return null
  var span = points[points.length - 1].t - points[0].t
  if (span < MIN_TREND_SPAN_SEC) return null

  var base = points[0].t
  var n = points.length
  var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0
  points.forEach(function (point) {
    var x = (point.t - base) / MONTH_SEC
    var y = point.pct
    sumX += x
    sumY += y
    sumXY += x * y
    sumXX += x * x
  })
  var denominator = n * sumXX - sumX * sumX
  if (Math.abs(denominator) < 1e-9) return null
  return (n * sumXY - sumX * sumY) / denominator
}

// Health as it stood `days` ago, taken from the newest sample at or before that
// boundary. Null when the history does not reach back that far, so the panel
// can say "not yet" instead of quietly comparing against the oldest point it
// happens to have.
function healthDaysAgo(points, days, now) {
  var boundary = now - days * DAY_SEC
  if (points.length === 0 || points[0].t > boundary) return null
  var candidates = points.filter(function (point) { return point.t <= boundary })
  return candidates.length === 0 ? null : candidates[candidates.length - 1]
}

// When the next health row falls due if the capacity does not move before then.
// The empty state shows this so a curve that has not appeared yet reads as
// "waiting" rather than "broken" — the complaint the heartbeat exists to
// answer is precisely that capacity alone almost never moves.
function nextHealthSampleAt(health, heartbeatSec) {
  var entries = Array.isArray(health) ? health : []
  if (entries.length === 0) return 0
  var heartbeat = heartbeatSec === undefined ? HEALTH_HEARTBEAT_SEC : heartbeatSec
  return entries[entries.length - 1].t + heartbeat
}

function healthSeries(health) {
  return (Array.isArray(health) ? health : []).map(function (entry) {
    return { t: entry.t, pct: healthAt(entry), cyc: entry.cyc }
  })
}

function wearStats(health, now) {
  var points = healthSeries(health)
  var stats = {
    points: points.length,
    current: null,
    firstT: 0,
    spanDays: 0,
    delta30: null,
    delta90: null,
    perMonth: null,
    eolEpoch: null,
    cycles: -1
  }
  if (points.length === 0) return stats

  var last = points[points.length - 1]
  var first = points[0]
  stats.current = last.pct
  stats.firstT = first.t
  stats.spanDays = Math.max(0, Math.round((last.t - first.t) / DAY_SEC))
  stats.cycles = last.cyc

  var older30 = healthDaysAgo(points, 30, now)
  if (older30) stats.delta30 = last.pct - older30.pct
  var older90 = healthDaysAgo(points, 90, now)
  if (older90) stats.delta90 = last.pct - older90.pct

  stats.perMonth = trendPerMonth(points)

  // Only project forward on a slope that is actually downward and steeper than
  // the noise floor of integer sysfs capacities. An improving or flat battery
  // gets no date rather than a nonsense one centuries out.
  if (stats.perMonth !== null && stats.perMonth < -0.05 && last.pct > END_OF_LIFE_PCT) {
    var months = (last.pct - END_OF_LIFE_PCT) / -stats.perMonth
    stats.eolEpoch = Math.round(last.t + months * MONTH_SEC)
  }
  return stats
}

function chargeSeries(charge, windowSec, now) {
  var cutoff = now - Math.max(HOUR_SEC, windowSec)
  return (Array.isArray(charge) ? charge : []).filter(function (entry) {
    return entry.t >= cutoff
  })
}

// The horizontal extent of the charge graph: a week by default, but no wider
// than the data actually goes, so a fresh install fills the frame with the few
// hours it has instead of drawing a hairline against six empty days.
function chargeWindowRange(series, windowSec, now) {
  var width = Math.max(HOUR_SEC, windowSec)
  if (!series || series.length === 0) return { from: now - width, to: now }
  // An axis with no width would divide by zero, so a lone sample still gets an
  // hour of frame to sit in.
  var from = Math.min(Math.max(now - width, series[0].t), now - HOUR_SEC)
  return { from: from, to: now }
}

// --------------------------------------------------------------- formatting

function formatPercent(value, decimals) {
  if (value === null || !isFinite(value)) return "—"
  return value.toFixed(decimals === undefined ? 1 : decimals) + "%"
}

function formatDelta(value) {
  if (value === null || !isFinite(value)) return "—"
  var sign = value > 0 ? "+" : (value < 0 ? "−" : "±")
  return sign + Math.abs(value).toFixed(1) + "%"
}

function formatRate(perMonth) {
  if (perMonth === null || !isFinite(perMonth)) return "—"
  var sign = perMonth > 0 ? "+" : "−"
  return sign + Math.abs(perMonth).toFixed(2) + "%/mo"
}

// Capacities arrive in the microunits sysfs uses: microampere-hours for a
// charge_* battery, microwatt-hours for an energy_* one.
function formatCapacity(microValue, unit) {
  if (!isFinite(microValue) || microValue <= 0) return "—"
  if (unit === "Wh") return (microValue / 1e6).toFixed(1) + " Wh"
  return Math.round(microValue / 1000) + " mAh"
}

// A charge_* battery reports no energy at all, so pair its milliampere-hours
// with the design voltage to give the reading a familiar watt-hour scale.
function energyWh(microValue, unit, microVolts) {
  if (unit === "Wh") return microValue / 1e6
  if (!(microVolts > 0)) return null
  return (microValue / 1e6) * (microVolts / 1e6)
}

function formatEnergy(microValue, unit, microVolts) {
  var wh = energyWh(microValue, unit, microVolts)
  return wh === null || !isFinite(wh) || wh <= 0 ? "" : wh.toFixed(1) + " Wh"
}

function formatDate(epoch) {
  if (!epoch) return "—"
  var date = new Date(epoch * 1000)
  return date.getDate() + " " + MONTH_NAMES[date.getMonth()] + " " + date.getFullYear()
}

function formatMonthYear(epoch) {
  if (!epoch) return "—"
  var date = new Date(epoch * 1000)
  return MONTH_NAMES[date.getMonth()] + " " + date.getFullYear()
}

function formatSpan(days) {
  if (!isFinite(days) || days <= 0) return "today"
  if (days < 60) return days + (days === 1 ? " day" : " days")
  var months = Math.round(days / 30.44)
  if (months < 24) return months + " months"
  return (days / 365.25).toFixed(1) + " years"
}

function formatClock(epoch) {
  var date = new Date(epoch * 1000)
  var hours = date.getHours()
  var minutes = date.getMinutes()
  return (hours < 10 ? "0" : "") + hours + ":" + (minutes < 10 ? "0" : "") + minutes
}

// How wide the charge graph currently is, in words. The window shrinks to the
// available data, so the header states what is actually drawn rather than the
// configured maximum.
function formatWindowSpan(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return "no data"
  if (seconds < 2 * HOUR_SEC) return Math.max(1, Math.round(seconds / 60)) + " min"
  if (seconds < 2 * DAY_SEC) return Math.round(seconds / HOUR_SEC) + " hours"
  return Math.round(seconds / DAY_SEC) + " days"
}

// A time-axis label sized to the span it sits on: a clock time reads better
// across hours, a date across days.
function axisTimeLabel(epoch, spanSec) {
  return spanSec > 2 * DAY_SEC ? shortDate(epoch) : formatClock(epoch)
}

// The label for a hover chip, which names one sample rather than an axis
// position and so cannot be as terse: across a window wider than a day the
// clock alone repeats itself, and the date alone cannot place a sample within
// the day it came from.
function hoverTimeLabel(epoch, spanSec) {
  if (spanSec > DAY_SEC) return shortDate(epoch) + " " + formatClock(epoch)
  return formatClock(epoch)
}

function statusLabel(probe) {
  var code = statusCode(probe.status)
  if (code === CHARGING) return "Charging"
  if (code === DISCHARGING) return "On battery"
  if (probe.pct >= 99) return "Fully charged"
  return probe.status ? probe.status : "Idle"
}

function batteryGlyph(probe) {
  if (!probe || !probe.ok) return LEVEL_GLYPHS[LEVEL_GLYPHS.length - 1]
  var code = statusCode(probe.status)
  if (code === CHARGING) return GLYPH_CHARGING
  if (probe.pct >= 100) return GLYPH_FULL
  var pct = Math.max(0, Math.min(100, probe.pct < 0 ? 100 : probe.pct))
  var index = Math.min(LEVEL_GLYPHS.length - 1, Math.floor(pct / 10))
  return LEVEL_GLYPHS[index]
}

// The bar readout is text only. omarchy.power already carries a battery glyph,
// and this widget normally sits right next to it, so a second one would just be
// two battery icons in a row.
//
// "charge" is the live charge level, which is what the bar is watched for
// minute to minute; "health" and "cycles" surface the slow numbers this widget
// actually collects. Right-click cycles between them.
function barText(probe, stats, mode) {
  if (!probe || !probe.ok) return "\u2014"
  if (mode === "cycles") {
    return probe.cycles >= 0 ? probe.cycles + " cyc" : "\u2014"
  }
  if (mode === "health") {
    var health = stats && stats.current !== null ? stats.current : probeHealth(probe)
    return Math.round(health) + "%"
  }
  return probe.pct >= 0 ? Math.round(probe.pct) + "%" : "\u2014"
}

function barTooltip(probe, stats) {
  if (!probe || !probe.ok) return "Battery health: no battery detected"
  var lines = []
  if (probe.pct >= 0) lines.push("Charge " + Math.round(probe.pct) + "%")
  lines.push("Health " + formatPercent(probeHealth(probe)))
  if (probe.cycles >= 0) lines.push(probe.cycles + " cycles")
  if (stats && stats.points > 1) lines.push(formatSpan(stats.spanDays) + " of history")
  return lines.join(" \u00b7 ")
}

// ------------------------------------------------------------ graph geometry

// Axis bounds that keep the curve off the frame edge and stay stable as points
// arrive: whole-percent gridlines, never narrower than `minSpan` so a battery
// sitting at a flat 100% does not get its rounding noise magnified into a
// dramatic-looking cliff.
function niceBounds(values, minSpan) {
  var span = minSpan === undefined ? 4 : minSpan
  if (!values || values.length === 0) return { min: 90, max: 100 }
  var min = Math.min.apply(null, values)
  var max = Math.max.apply(null, values)
  var lo = Math.floor(min - 0.5)
  var hi = Math.ceil(max + 0.5)
  if (hi - lo < span) {
    var pad = (span - (hi - lo)) / 2
    lo = Math.floor(lo - pad)
    hi = Math.ceil(hi + pad)
  }
  return { min: lo, max: hi }
}

// Symmetric bound for the power axis. Zero watts sits on the charge axis' 50%
// line, so the same number of pixels has to cover the charging half and the
// discharging half; a single bound gives both the same scale and keeps the two
// directions visually comparable. Snapped to a round step so the axis label
// stays legible, and floored so a quiet pack does not get a hair-trigger axis
// where a 0.2 W trickle looks like a spike.
var POWER_STEPS = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 300]

function powerScale(series, minimum) {
  var floorWatts = minimum === undefined ? 5 : minimum
  var peak = 0
  ;(Array.isArray(series) ? series : []).forEach(function (entry) {
    var magnitude = Math.abs(num(entry.w))
    if (magnitude > peak) peak = magnitude
  })
  if (peak <= floorWatts) return floorWatts
  var fitted = POWER_STEPS.filter(function (step) { return step >= peak })
  return fitted.length > 0 ? fitted[0] : MAX_ABS_WATTS
}

function formatWatts(value) {
  if (!isFinite(value) || Math.abs(value) < 0.05) return "0 W"
  return (value > 0 ? "+" : "\u2212") + Math.abs(value).toFixed(1) + " W"
}

function axisTicks(min, max, count) {
  var steps = Math.max(2, count === undefined ? 4 : count)
  var ticks = []
  for (var i = 0; i <= steps; i++) {
    ticks.push(min + ((max - min) * i) / steps)
  }
  return ticks
}

function shortDate(epoch) {
  var date = new Date(epoch * 1000)
  return date.getDate() + " " + MONTH_NAMES[date.getMonth()]
}

// Time labels sized to the span on screen: days while the history is young,
// months once it covers a season or more.
function timeTicks(from, to, count) {
  var span = Math.max(1, to - from)
  var steps = Math.max(1, count === undefined ? 3 : count)
  var useMonths = span > 90 * DAY_SEC
  var ticks = []
  for (var i = 0; i <= steps; i++) {
    var t = from + (span * i) / steps
    ticks.push({
      t: t,
      label: useMonths ? formatMonthYear(t) : shortDate(t)
    })
  }
  return ticks
}

if (typeof module !== "undefined") {
  module.exports = {
    DAY_SEC: DAY_SEC,
    HOUR_SEC: HOUR_SEC,
    MONTH_SEC: MONTH_SEC,
    END_OF_LIFE_PCT: END_OF_LIFE_PCT,
    MAX_CHARGE_ENTRIES: MAX_CHARGE_ENTRIES,
    CHARGING: CHARGING,
    IDLE: IDLE,
    DISCHARGING: DISCHARGING,
    safeText: safeText,
    defaultProbe: defaultProbe,
    parseProbe: parseProbe,
    probeHealth: probeHealth,
    statusCode: statusCode,
    watts: watts,
    MAX_ABS_WATTS: MAX_ABS_WATTS,
    defaultHistory: defaultHistory,
    parseHistory: parseHistory,
    serializeHistory: serializeHistory,
    HEALTH_HEARTBEAT_SEC: HEALTH_HEARTBEAT_SEC,
    shouldRecordHealth: shouldRecordHealth,
    appendHealth: appendHealth,
    compactHealth: compactHealth,
    HEALTH_FULL_DETAIL_SEC: HEALTH_FULL_DETAIL_SEC,
    sampleIntervalFor: sampleIntervalFor,
    appendCharge: appendCharge,
    recordProbe: recordProbe,
    mergeHistories: mergeHistories,
    healthSeries: healthSeries,
    nextHealthSampleAt: nextHealthSampleAt,
    wearStats: wearStats,
    chargeSeries: chargeSeries,
    chargeWindowRange: chargeWindowRange,
    DEFAULT_CHARGE_WINDOW_SEC: DEFAULT_CHARGE_WINDOW_SEC,
    formatPercent: formatPercent,
    formatDelta: formatDelta,
    formatRate: formatRate,
    formatCapacity: formatCapacity,
    formatEnergy: formatEnergy,
    formatDate: formatDate,
    formatMonthYear: formatMonthYear,
    formatSpan: formatSpan,
    formatWindowSpan: formatWindowSpan,
    axisTimeLabel: axisTimeLabel,
    hoverTimeLabel: hoverTimeLabel,
    statusLabel: statusLabel,
    batteryGlyph: batteryGlyph,
    barText: barText,
    barTooltip: barTooltip,
    niceBounds: niceBounds,
    powerScale: powerScale,
    formatWatts: formatWatts,
    axisTicks: axisTicks,
    timeTicks: timeTicks,
    shortDate: shortDate
  }
}
