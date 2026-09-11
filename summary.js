// Prints what the widget has collected so far, without opening the panel.
//
// Usage: node summary.js  (or `make state`)

const fs = require("fs")
const path = require("path")
const Model = require("./Model.js")

const file = path.join(process.env.HOME, ".local/state/io.github.mvaled.battery-health/history.json")

if (!fs.existsSync(file)) {
  console.log("no history yet at " + file)
  process.exit(0)
}

const state = Model.parseHistory(fs.readFileSync(file, "utf8"))
const now = Math.floor(Date.now() / 1000)
const stats = Model.wearStats(state.health, now)
const charge = Model.chargeSeries(state.charge, 24 * Model.HOUR_SEC, now)

const rows = [
  ["file", file],
  ["battery", state.battery + " (" + state.unit + ")"],
  ["health", Model.formatPercent(stats.current) + " over " + Model.formatSpan(stats.spanDays)],
  ["samples", stats.points + " health, " + state.charge.length + " charge (" + charge.length + " in last 24h)"],
  ["tracked since", stats.points > 0 ? Model.formatDate(stats.firstT) : "—"],
  ["cycles", stats.cycles >= 0 ? String(stats.cycles) : "—"],
  ["wear rate", Model.formatRate(stats.perMonth)],
  ["last 30 days", Model.formatDelta(stats.delta30)],
  ["last 90 days", Model.formatDelta(stats.delta90)],
  ["reaches 80%", stats.eolEpoch ? Model.formatMonthYear(stats.eolEpoch) : "—"]
]

const width = Math.max(...rows.map((row) => row[0].length))
rows.forEach((row) => console.log(row[0].padEnd(width) + "  " + row[1]))

// The tail of the charge log. The summary above says how the pack is aging
// over months; these rows say what it has been doing in the last hours, which
// is what a sampling or wattage question actually needs.
const TAIL = 35

function statusName(code) {
  if (code === Model.CHARGING) return "charging"
  if (code === Model.DISCHARGING) return "discharging"
  return "idle"
}

const recent = state.charge.slice(-TAIL)
if (recent.length > 0) {
  // hoverTimeLabel drops the date when the span fits in a day, so the tail
  // gets dated rows only when it really straddles more than one.
  const span = recent[recent.length - 1].t - recent[0].t
  const cells = recent.map((entry) => [
    Model.hoverTimeLabel(entry.t, span),
    Model.formatPercent(entry.p),
    Model.formatWatts(entry.w),
    statusName(entry.s)
  ])
  const widths = cells[0].map((_, column) => Math.max(...cells.map((row) => row[column].length)))
  console.log("")
  console.log("last " + cells.length + " charge samples")
  cells.forEach((row) => console.log(
    "  " + row[0].padEnd(widths[0]) +
    "  " + row[1].padStart(widths[1]) +
    "  " + row[2].padStart(widths[2]) +
    "  " + row[3]
  ))
}
