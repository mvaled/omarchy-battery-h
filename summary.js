// Prints what the widget has collected so far, without opening the panel.
//
// Usage: node summary.js  (or `make state`)

const fs = require("fs")
const path = require("path")
const Model = require("./Model.js")

const file = path.join(process.env.HOME, ".local/state/manu.battery-health/history.json")

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
