import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.UPower
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar widget and popup for long-term battery health.
//
// The number this widget exists for is capacity retention: charge_full divided
// by charge_full_design, i.e. how much of the pack the firmware still believes
// it can hold. That value moves over weeks, not seconds, so the whole design is
// built around persistence rather than live streaming — one cheap sysfs read
// every few minutes, folded into ~/.local/state/io.github.mvaled.battery-health/history.json
// as a change-point series: a sample is stored when a value actually moves, and
// otherwise only often enough to prove the quiet stretch was observed.
//
// Sampling is event-driven first and polled second. UPower announces every
// plug-in, unplug and state change, and each one takes a sample immediately, so
// the exact moment a charge or discharge begins is on record. Between those
// events a timer fills in: every ten minutes while current is actually flowing,
// and half-hourly once the pack goes idle, since nothing moves in that state.
//
// Cost control is deliberate and is the reason this stays out of the way of the
// shell: exactly one Process, never re-armed while it is still running; polling
// that backs off when there is nothing to see; hard caps on both history arrays
// inside Model.js so a corrupt or hand-grown file cannot make a repaint
// unbounded; and canvases that only repaint while the panel is actually open.
//
// Settings (manifest defaults and schema, read through setting()):
// activeIntervalSec, idleIntervalSec, chargeWindowDays, historyDays,
// displayMode, battery. Set
// them with `omarchy bar set io.github.mvaled.battery-health <key> <value> --json` or
// inline in shell.json.
Panel {
  id: root
  moduleName: "io.github.mvaled.battery-health"
  ipcTarget: "io.github.mvaled.battery-health"
  // manageIpc: false so this panel can own the single IpcHandler the target
  // permits and still expose refresh/cycleDisplay alongside the lifecycle
  // methods the base class would otherwise register.
  manageIpc: false

  // ------------------------------------------------------------------ config

  // Number() coercion throughout because `omarchy bar set` without --json
  // stores every value as a string.
  readonly property int activeSeconds: Math.max(60, Math.round(Number(setting("activeIntervalSec", 600))))
  readonly property int idleSeconds: Math.max(60, Math.round(Number(setting("idleIntervalSec", 1800))))
  // Capacity and charge only move while current is flowing, so a pack sitting
  // on AC at its charge limit is polled far less often than one in use.
  readonly property int sampleSeconds: Model.sampleIntervalFor(root.probe, activeSeconds, idleSeconds)
  readonly property int chargeWindowDays: Math.max(1, Math.round(Number(setting("chargeWindowDays", 7))))
  readonly property int chargeWindowSec: chargeWindowDays * Model.DAY_SEC
  readonly property int historyDays: Math.max(1, Math.round(Number(setting("historyDays", 730))))
  readonly property string displayMode: String(setting("displayMode", "charge"))
  readonly property string batteryName: String(setting("battery", ""))

  readonly property string stateDir: Quickshell.env("HOME") + "/.local/state/" + root.moduleName
  readonly property string historyPath: stateDir + "/history.json"
  readonly property string probePath: Qt.resolvedUrl("probe.sh").toString().replace("file://", "")

  // ------------------------------------------------------------- live state

  property var probe: Model.defaultProbe()
  property var history: Model.defaultHistory()
  property var stats: Model.wearStats([], 0)
  // The state directory has to exist before FileView can write into it, and
  // sampling before the first history read would overwrite the file with a
  // single fresh point. Both gates have to clear before the timer runs.
  property bool dirReady: false
  property bool historyLoaded: false
  readonly property bool ready: dirReady && historyLoaded

  property real hoverX: -1

  readonly property color fg: bar ? bar.foreground : Color.foreground
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // Health is colored only once it says something: a pack still above the
  // conventional 80% end-of-life line is drawn in the ordinary foreground so
  // the panel does not cry wolf on a healthy battery.
  readonly property color healthColor: {
    if (stats.current === null) return fg
    if (stats.current < Model.END_OF_LIFE_PCT) return Color.urgent
    if (stats.current < 85) return Color.accent
    return fg
  }

  readonly property bool batteryPresent: probe.ok

  readonly property string readout: Model.barText(probe, stats, displayMode)
  readonly property string verticalReadout: readout.replace("%", "").replace(" cyc", "")
  readonly property bool vertical: bar ? bar.vertical === true : false

  // The width the charge graph is actually drawing, which is the configured
  // window or the whole series, whichever is shorter.
  readonly property var chargeRange: {
    var now = probe.t > 0 ? probe.t : Math.floor(Date.now() / 1000)
    return Model.chargeWindowRange(
      Model.chargeSeries(history.charge, chargeWindowSec, now), chargeWindowSec, now)
  }
  readonly property string chargeSpanLabel: Model.formatWindowSpan(chargeRange.to - chargeRange.from)

  readonly property string nextHealthLabel: {
    var due = Model.nextHealthSampleAt(history.health)
    if (due <= 0) return "shortly"
    var now = probe.t > 0 ? probe.t : Math.floor(Date.now() / 1000)
    return due <= now ? "shortly" : "in " + Model.formatWindowSpan(due - now)
  }
  readonly property bool collecting: stats.points < 2

  // --------------------------------------------------------------- sampling

  // UPower can fire several times in quick succession — a fast charger crosses
  // a whole percent every half minute or so — and each one would otherwise
  // spawn a probe. Timed and event-driven samples take a floor; an explicit
  // refresh (middle-click, IPC) bypasses it.
  readonly property int minSampleGapSec: 30
  property real lastSampleAt: 0

  function refresh(force) {
    if (!ready || probeProc.running) return
    var now = Date.now() / 1000
    if (!force && now - root.lastSampleAt < root.minSampleGapSec) return
    root.lastSampleAt = now
    probeProc.running = true
  }

  function applyProbe(raw) {
    var parsed = Model.parseProbe(raw)
    root.probe = parsed
    if (!parsed.ok) return

    var next = Model.recordProbe(root.history, parsed, {
      historyDays: root.historyDays,
      chargeWindowSec: root.chargeWindowSec
    })
    root.history = next
    root.stats = Model.wearStats(next.health, parsed.t)
    historyFile.setText(Model.serializeHistory(next))
    repaint()
  }

  // Merged, not replaced: the sibling instance on the other monitor writes this
  // same file, and taking its content wholesale would drop whatever this one
  // has sampled since its own last write.
  function loadHistory(raw) {
    var merged = Model.mergeHistories(root.history, Model.parseHistory(raw))
    root.history = merged
    root.stats = Model.wearStats(merged.health, Math.floor(Date.now() / 1000))
    root.historyLoaded = true
    repaint()
  }

  function repaint() {
    if (!opened) return
    healthCanvas.requestPaint()
    chargeCanvas.requestPaint()
  }

  function cycleDisplayMode() {
    var modes = ["charge", "health", "cycles"]
    var index = modes.indexOf(root.displayMode)
    var next = modes[(index < 0 ? 0 : index + 1) % modes.length]
    root.settings = Object.assign({}, root.settings, { displayMode: next })
    if (root.bar && root.bar.shell) root.bar.shell.updateEntryInline(root.moduleName, root.settings)
  }

  // ------------------------------------------------------------ graph paint

  // Shared frame geometry so the two canvases agree on where the plot starts
  // and the hover lookup maps back to the same x the curve was drawn at.
  function plotRect(canvas, padL, padT, padR, padB) {
    return {
      x: padL,
      y: padT,
      w: Math.max(1, canvas.width - padL - padR),
      h: Math.max(1, canvas.height - padT - padB)
    }
  }

  function paintHealth(ctx, canvas) {
    ctx.reset()
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    var series = Model.healthSeries(root.history.health)
    var frame = plotRect(canvas, Style.space(34), Style.space(6), Style.space(4), Style.space(16))
    var base = root.fg

    if (series.length === 0) return

    var values = series.map(function (point) { return point.pct })
    var bounds = Model.niceBounds(values, 4)
    var span = Math.max(1, bounds.max - bounds.min)
    var from = series[0].t
    var to = series[series.length - 1].t
    // A single day of history has no horizontal extent; give it one so the
    // point lands mid-frame instead of dividing by zero.
    var timeSpan = Math.max(1, to - from)

    function xAt(t) { return frame.x + (frame.w * (t - from)) / timeSpan }
    function yAt(pct) { return frame.y + frame.h * (1 - (pct - bounds.min) / span) }

    // Horizontal gridlines plus their percentage labels.
    ctx.font = Style.font.caption + "px " + root.fontFamily
    ctx.textBaseline = "middle"
    ctx.textAlign = "right"
    var ticks = Model.axisTicks(bounds.min, bounds.max, 4)
    ticks.forEach(function (tick) {
      var y = yAt(tick)
      ctx.beginPath()
      ctx.moveTo(frame.x, y)
      ctx.lineTo(frame.x + frame.w, y)
      ctx.strokeStyle = Qt.rgba(base.r, base.g, base.b, 0.10)
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = Qt.rgba(base.r, base.g, base.b, 0.55)
      ctx.fillText(Math.round(tick) + "%", frame.x - Style.space(5), y)
    })

    // The 80% end-of-life line, drawn only when it falls inside the view so a
    // healthy battery is not permanently reminded of its mortality.
    if (bounds.min <= Model.END_OF_LIFE_PCT && Model.END_OF_LIFE_PCT <= bounds.max) {
      var eolY = yAt(Model.END_OF_LIFE_PCT)
      ctx.beginPath()
      ctx.moveTo(frame.x, eolY)
      ctx.lineTo(frame.x + frame.w, eolY)
      ctx.strokeStyle = Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.45)
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // Filled area under the curve, then the curve itself.
    var accent = root.healthColor
    ctx.beginPath()
    ctx.moveTo(xAt(series[0].t), frame.y + frame.h)
    series.forEach(function (point) { ctx.lineTo(xAt(point.t), yAt(point.pct)) })
    ctx.lineTo(xAt(series[series.length - 1].t), frame.y + frame.h)
    ctx.closePath()
    ctx.fillStyle = Qt.rgba(accent.r, accent.g, accent.b, 0.14)
    ctx.fill()

    ctx.beginPath()
    series.forEach(function (point, index) {
      var x = xAt(point.t)
      var y = yAt(point.pct)
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = accent
    ctx.lineWidth = 2
    ctx.lineJoin = "round"
    ctx.lineCap = "round"
    ctx.stroke()

    // Latest reading, marked so a one-point history is still visible.
    var last = series[series.length - 1]
    ctx.beginPath()
    ctx.arc(xAt(last.t), yAt(last.pct), 3, 0, Math.PI * 2)
    ctx.fillStyle = accent
    ctx.fill()

    // Time axis.
    ctx.fillStyle = Qt.rgba(base.r, base.g, base.b, 0.55)
    ctx.textBaseline = "top"
    var labels = Model.timeTicks(from, to, timeSpan > Model.DAY_SEC ? 3 : 1)
    labels.forEach(function (tick, index) {
      ctx.textAlign = index === 0 ? "left" : (index === labels.length - 1 ? "right" : "center")
      ctx.fillText(tick.label, xAt(tick.t), frame.y + frame.h + Style.space(4))
    })

    paintHover(ctx, series, frame, xAt, yAt)
  }

  function paintHover(ctx, series, frame, xAt, yAt) {
    if (root.hoverX < frame.x || root.hoverX > frame.x + frame.w) return

    // Nearest sample to the cursor rather than an interpolated position: every
    // point on this curve is a real reading and the chip should name one.
    var nearest = series[0]
    series.forEach(function (point) {
      if (Math.abs(xAt(point.t) - root.hoverX) < Math.abs(xAt(nearest.t) - root.hoverX)) nearest = point
    })

    var hx = xAt(nearest.t)
    var hy = yAt(nearest.pct)
    var base = root.fg

    ctx.beginPath()
    ctx.moveTo(hx, frame.y)
    ctx.lineTo(hx, frame.y + frame.h)
    ctx.strokeStyle = Qt.rgba(base.r, base.g, base.b, 0.40)
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(hx, hy, 3.5, 0, Math.PI * 2)
    ctx.fillStyle = root.healthColor
    ctx.fill()

    var chipText = Model.formatPercent(nearest.pct) + "  " + Model.shortDate(nearest.t)
    ctx.font = Style.font.caption + "px " + root.fontFamily
    var chipW = ctx.measureText(chipText).width + Style.space(10)
    var chipH = Style.space(16)
    // Keep the chip inside the frame when the cursor is near either edge.
    var chipX = Math.max(frame.x, Math.min(frame.x + frame.w - chipW, hx - chipW / 2))

    var bg = Color.popups.background
    ctx.fillStyle = Qt.rgba(bg.r, bg.g, bg.b, 0.92)
    ctx.fillRect(chipX, frame.y, chipW, chipH)
    ctx.fillStyle = root.healthColor
    ctx.textBaseline = "middle"
    ctx.textAlign = "center"
    ctx.fillText(chipText, chipX + chipW / 2, frame.y + chipH / 2)
  }

  // The main graph: charge level and power draw on one time axis.
  //
  // Charge is a plain 0-100% axis. Power shares the frame on its own symmetric
  // scale, arranged so zero watts lands exactly on the charge axis' 50% line —
  // above it the pack is taking charge, below it the pack is giving it up, and
  // the distance from that line is how fast. One glance says both what the
  // charge is and which way it is going.
  function paintChargePower(ctx, canvas) {
    ctx.reset()
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    var now = root.probe.t > 0 ? root.probe.t : Math.floor(Date.now() / 1000)
    var series = Model.chargeSeries(root.history.charge, root.chargeWindowSec, now)
    var base = root.fg
    if (series.length < 2) return

    var range = Model.chargeWindowRange(series, root.chargeWindowSec, now)
    var from = range.from
    var timeSpan = Math.max(1, range.to - from)
    var frame = plotRect(canvas, Style.space(30), Style.space(8), Style.space(38), Style.space(16))
    var scale = Model.powerScale(series)

    function xAt(t) { return frame.x + (frame.w * (t - from)) / timeSpan }
    // Charge is capped at 100%, so the axis is fixed rather than fitted: the
    // height of the curve means the same thing every time the panel is opened.
    function yCharge(pct) {
      return frame.y + frame.h * (1 - Math.max(0, Math.min(100, pct)) / 100)
    }
    // Zero watts on the 50% line, +scale at the top, -scale at the bottom.
    function yPower(w) {
      var clamped = Math.max(-scale, Math.min(scale, w))
      return yCharge(50) - (clamped / scale) * (frame.h / 2)
    }

    var zeroY = yCharge(50)

    // Charge gridlines at every quarter. The 50% line is the shared one — it is
    // also the power zero — so it is drawn stronger than the rest.
    ctx.font = Style.font.caption + "px " + root.fontFamily
    ctx.textBaseline = "middle"
    ;[0, 25, 50, 75, 100].forEach(function (pct) {
      var y = yCharge(pct)
      var shared = pct === 50
      ctx.beginPath()
      ctx.moveTo(frame.x, y)
      ctx.lineTo(frame.x + frame.w, y)
      ctx.strokeStyle = Qt.rgba(base.r, base.g, base.b, shared ? 0.28 : 0.10)
      ctx.lineWidth = 1
      ctx.stroke()

      ctx.textAlign = "right"
      ctx.fillStyle = Qt.rgba(base.r, base.g, base.b, 0.55)
      ctx.fillText(pct + "%", frame.x - Style.space(5), y)
    })

    // Power axis on the right, labelled at both extremes and at zero.
    ctx.textAlign = "left"
    ctx.fillStyle = Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.8)
    ctx.fillText("+" + scale + "W", frame.x + frame.w + Style.space(4), yPower(scale))
    ctx.fillText("0 W", frame.x + frame.w + Style.space(4), zeroY)
    ctx.fillText("\u2212" + scale + "W", frame.x + frame.w + Style.space(4), yPower(-scale))

    // ---- charge: filled area, so it reads as the background quantity
    ctx.beginPath()
    ctx.moveTo(xAt(series[0].t), frame.y + frame.h)
    series.forEach(function (point) { ctx.lineTo(xAt(point.t), yCharge(point.p)) })
    ctx.lineTo(xAt(series[series.length - 1].t), frame.y + frame.h)
    ctx.closePath()
    ctx.fillStyle = Qt.rgba(base.r, base.g, base.b, 0.13)
    ctx.fill()

    ctx.beginPath()
    series.forEach(function (point, index) {
      var x = xAt(point.t)
      var y = yCharge(point.p)
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = Qt.rgba(base.r, base.g, base.b, 0.8)
    ctx.lineWidth = 1.5
    ctx.lineJoin = "round"
    ctx.stroke()

    // ---- power: a line on top, in the accent color
    ctx.beginPath()
    series.forEach(function (point, index) {
      var x = xAt(point.t)
      var y = yPower(point.w)
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = Color.accent
    ctx.lineWidth = 2
    ctx.lineJoin = "round"
    ctx.lineCap = "round"
    ctx.stroke()

    // Time axis.
    ctx.fillStyle = Qt.rgba(base.r, base.g, base.b, 0.55)
    ctx.textBaseline = "top"
    ctx.textAlign = "left"
    ctx.fillText(Model.axisTimeLabel(from, timeSpan), frame.x, frame.y + frame.h + Style.space(4))
    ctx.textAlign = "center"
    ctx.fillText(Model.axisTimeLabel(from + timeSpan / 2, timeSpan),
                 frame.x + frame.w / 2, frame.y + frame.h + Style.space(4))
    ctx.textAlign = "right"
    ctx.fillText("now", frame.x + frame.w, frame.y + frame.h + Style.space(4))
  }

  // ------------------------------------------------------------------ wiring

  IpcHandler {
    target: "io.github.mvaled.battery-health"

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): void { root.refresh(true) }
    function cycleDisplay(): void { root.cycleDisplayMode() }
  }

  Process {
    id: initProc
    command: ["mkdir", "-p", root.stateDir]
    running: true
    onExited: {
      root.dirReady = true
      historyFile.reload()
    }
  }

  Process {
    id: probeProc
    command: ["bash", root.probePath, root.batteryName]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyProbe(text)
    }
  }

  FileView {
    id: historyFile
    path: root.historyPath
    atomicWrites: true
    printErrors: false
    // Watched so the two per-monitor instances see each other's writes and
    // converge. loadHistory merges, so a reload never costs a sample, and
    // reading never writes, so the two cannot chase each other in a loop.
    watchChanges: true
    onFileChanged: reload()
    onLoaded: root.loadHistory(text())
    // No file yet on a fresh install, which is the normal first run rather
    // than an error worth surfacing.
    onLoadFailed: root.loadHistory("")
  }

  // No triggeredOnStart: `interval` is bound to the charge state, and Qt
  // restarts a Timer whose interval changes, so every plug-in and unplug would
  // re-fire it. The events below already cover those transitions, and
  // onReadyChanged covers the first sample.
  Timer {
    id: sampleTimer
    interval: root.sampleSeconds * 1000
    running: root.ready
    repeat: true
    onTriggered: root.refresh()
  }

  onReadyChanged: if (ready) refresh(true)

  // The event half of the sampling strategy. A plug-in or unplug changes both
  // the reading and the cadence it should be read at, and waiting out the
  // current interval would put the transition in the wrong place on the graph.
  Connections {
    target: UPower

    function onOnBatteryChanged() { root.refresh() }
  }

  Connections {
    target: UPower.displayDevice

    function onStateChanged() { root.refresh() }
    // Crossing a whole percent is the finest real movement the pack reports,
    // and on a battery that drains in well under a day those crossings are
    // frequent enough to draw a proper curve between the timed samples.
    function onPercentageChanged() { root.refresh() }
  }

  onOpenedChanged: {
    if (opened) {
      root.hoverX = -1
      refresh()
      repaint()
    }
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // WidgetButton rather than BarIconButton: the latter reserves a fixed
  // icon-sized slot, and a text readout either overflows it or — with the slot
  // widened to fit the longest mode — pads a short reading like "63%" out with
  // dead space on both sides. WidgetButton sizes to its own label, so the
  // widget takes exactly the width it paints.
  //
  // The margins are left at WidgetButton's defaults deliberately. Omarchy has
  // no shared margin token; every widget carries its own literal (5 for
  // indicators, 6 for workspaces, 7.5 for the menu, 8.75 for the clock), so
  // inheriting the component default is the closest thing to a shared value
  // and follows it if upstream ever retunes the bar.
  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.vertical ? "" : root.readout
    labelVisible: !root.vertical
    hasVisualContent: root.readout !== ""
    // The vertical form paints its own centred label, so there is no label
    // height to derive a slot from; take one standard icon slot instead.
    fixedHeight: root.vertical ? Style.bar.iconSlot : -1
    tooltipText: Model.barTooltip(root.probe, root.stats)
    onPressed: function(b) {
      if (b === Qt.RightButton) root.cycleDisplayMode()
      else if (b === Qt.MiddleButton) root.refresh(true)
      else root.toggle()
    }

    // A 28px vertical bar has no room for a percent sign beside three digits,
    // so the vertical form keeps the number and drops the unit.
    Text {
      anchors.centerIn: parent
      visible: root.vertical
      textFormat: Text.PlainText
      text: root.verticalReadout
      color: root.barForeground
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(400))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(14)

        // ---------- Hero: glyph · pack identity · health percentage ----------
        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight, heroValue.implicitHeight)

          Text {
            id: heroIcon
            textFormat: Text.PlainText
            text: Model.batteryGlyph(root.probe)
            color: root.healthColor
            font.family: root.fontFamily
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: heroValue.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: "Battery health"
              textFormat: Text.PlainText
              color: root.fg
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }

            Text {
              text: Model.statusLabel(root.probe).toUpperCase()
              textFormat: Text.PlainText
              color: Qt.darker(root.fg, 1.4)
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.1
              elide: Text.ElideRight
              width: parent.width
            }
          }

          Text {
            id: heroValue
            textFormat: Text.PlainText
            text: root.batteryPresent ? Model.formatPercent(Model.probeHealth(root.probe)) : "—"
            color: root.healthColor
            font.family: root.fontFamily
            font.pixelSize: Style.font.displayLarge
            font.bold: true
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
          }
        }

        // ---------- Retention bar, with the 80% end-of-life mark ----------
        Item {
          width: parent.width
          implicitHeight: Style.space(8)
          visible: root.batteryPresent

          Rectangle {
            id: wearTrack
            anchors.fill: parent
            radius: height / 2
            color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.12)
          }

          Rectangle {
            anchors.left: wearTrack.left
            anchors.verticalCenter: wearTrack.verticalCenter
            height: wearTrack.height
            radius: wearTrack.radius
            color: root.healthColor
            // Retention above 100% is real — firmware often rates a fresh pack
            // conservatively — but the bar has nowhere to put it, so it clamps.
            width: Math.max(wearTrack.height,
                            wearTrack.width * Math.max(0, Math.min(1, Model.probeHealth(root.probe) / 100)))
          }

          Rectangle {
            width: 1
            height: wearTrack.height + Style.space(4)
            anchors.verticalCenter: wearTrack.verticalCenter
            x: wearTrack.width * (Model.END_OF_LIFE_PCT / 100)
            color: Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.7)
          }
        }

        // ---------- Charge and power over the recent window ----------
        PanelSeparator { foreground: root.fg; visible: root.batteryPresent }

        Column {
          width: parent.width
          spacing: Style.space(6)
          visible: root.batteryPresent

          Item {
            width: parent.width
            implicitHeight: mainHeader.implicitHeight

            PanelSectionHeader {
              id: mainHeader
              text: "CHARGE & POWER \u00b7 " + root.chargeSpanLabel.toUpperCase()
              foreground: root.fg
              fontFamily: root.fontFamily
              anchors.left: parent.left
            }

            // Live readout of both series, so the current values are legible
            // without reading them off the curve.
            Text {
              anchors.right: parent.right
              anchors.baseline: mainHeader.baseline
              textFormat: Text.PlainText
              text: {
                var parts = []
                if (root.probe.pct >= 0) parts.push(root.probe.pct + "%")
                parts.push(Model.formatWatts(Model.watts(root.probe)))
                return parts.join("  \u00b7  ")
              }
              color: Qt.darker(root.fg, 1.4)
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }
          }

          Item {
            width: parent.width
            implicitHeight: Style.space(150)

            Canvas {
              id: chargeCanvas
              anchors.fill: parent
              onPaint: {
                var ctx = getContext("2d")
                if (ctx) root.paintChargePower(ctx, chargeCanvas)
              }
            }

            Text {
              anchors.centerIn: parent
              textFormat: Text.PlainText
              text: "Collecting \u2014 sampling every " + Math.round(root.sampleSeconds / 60) + " min"
              color: Qt.darker(root.fg, 1.4)
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              visible: Model.chargeSeries(root.history.charge, root.chargeWindowSec,
                                          root.probe.t > 0 ? root.probe.t : 0).length < 2
            }
          }
        }

        // ---------- Numbers ----------
        PanelSeparator { foreground: root.fg }

        Row {
          width: parent.width
          spacing: Style.space(20)
          visible: root.batteryPresent

          Column {
            width: (parent.width - parent.spacing) / 2
            spacing: Style.spacing.labelGap

            InfoPair {
              label: "Full charge"
              value: Model.formatCapacity(root.probe.full, root.probe.unit)
            }
            InfoPair {
              label: "Design"
              value: Model.formatCapacity(root.probe.design, root.probe.unit)
            }
            InfoPair {
              label: "Energy"
              value: {
                var text = Model.formatEnergy(root.probe.full, root.probe.unit, root.probe.voltDesign)
                return text ? text : "—"
              }
            }
            InfoPair {
              label: "Charge cycles"
              value: root.probe.cycles >= 0 ? String(root.probe.cycles) : "—"
            }
          }

          Column {
            width: (parent.width - parent.spacing) / 2
            spacing: Style.spacing.labelGap

            InfoPair {
              label: "Wear rate"
              value: Model.formatRate(root.stats.perMonth)
            }
            InfoPair {
              label: "Last 30 days"
              value: Model.formatDelta(root.stats.delta30)
            }
            InfoPair {
              label: "Last 90 days"
              value: Model.formatDelta(root.stats.delta90)
            }
            InfoPair {
              // Only an actually declining battery gets a date; a flat or
              // improving one would need a fabricated slope to produce it.
              label: root.stats.eolEpoch ? "Reaches 80%" : "Tracked since"
              value: root.stats.eolEpoch
                ? Model.formatMonthYear(root.stats.eolEpoch)
                : (root.stats.points > 0 ? Model.formatDate(root.stats.firstT) : "—")
            }
          }
        }

        // ---------- Health over time (the slow series) ----------
        PanelSeparator { foreground: root.fg }

        PanelSectionHeader {
          text: root.collecting ? "HEALTH OVER TIME" : "HEALTH OVER " + Model.formatSpan(root.stats.spanDays).toUpperCase()
          foreground: root.fg
          fontFamily: root.fontFamily
        }

        Item {
          width: parent.width
          implicitHeight: Style.space(92)

          Canvas {
            id: healthCanvas
            anchors.fill: parent
            visible: !root.collecting
            onPaint: {
              var ctx = getContext("2d")
              if (ctx) root.paintHealth(ctx, healthCanvas)
            }

            MouseArea {
              anchors.fill: parent
              hoverEnabled: true
              onPositionChanged: function(mouse) {
                root.hoverX = mouse.x
                healthCanvas.requestPaint()
              }
              onExited: {
                root.hoverX = -1
                healthCanvas.requestPaint()
              }
            }
          }

          // Health is a slow signal, so a fresh install genuinely has nothing
          // to draw. Say so, and say when it will have something, rather than
          // showing an empty frame that reads as a bug.
          Column {
            anchors.centerIn: parent
            width: parent.width
            spacing: Style.space(6)
            visible: root.collecting

            Text {
              text: root.batteryPresent ? "Collecting" : "No battery detected"
              textFormat: Text.PlainText
              color: root.fg
              font.family: root.fontFamily
              font.pixelSize: Style.font.subtitle
              font.bold: true
              horizontalAlignment: Text.AlignHCenter
              width: parent.width
            }

            Text {
              // Naming the schedule and the next due reading matters here:
              // capacity almost never moves on its own, so text that mentions
              // only the change-triggered write reads as "this may never
              // fill".
              text: {
                if (!root.batteryPresent)
                  return "No /sys/class/power_supply entry reports a design capacity."
                if (root.stats.points < 1)
                  return "Capacity retention moves over weeks, not hours."
                return "First reading " + Model.formatDate(root.stats.firstT)
                  + ".\nA reading is stored every " + Math.round(Model.HEALTH_HEARTBEAT_SEC / Model.HOUR_SEC)
                  + " hours, and immediately if the capacity moves."
                  + "\nNext reading due " + root.nextHealthLabel + "."
              }
              textFormat: Text.PlainText
              color: Qt.darker(root.fg, 1.4)
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              horizontalAlignment: Text.AlignHCenter
              wrapMode: Text.WordWrap
              width: parent.width
            }
          }
        }

      }
    }
  }

  component InfoPair: Row {
    property string label: ""
    property string value: ""

    width: parent.width
    spacing: Style.space(8)

    InfoLabel { text: label }
    Item {
      width: Math.max(0, parent.width - parent.children[0].implicitWidth
                         - parent.children[2].implicitWidth - parent.spacing * 2)
      height: 1
    }
    InfoValue { text: value }
  }

  component InfoLabel: Text {
    textFormat: Text.PlainText
    color: root.fg
    opacity: 0.6
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  component InfoValue: Text {
    textFormat: Text.PlainText
    color: root.fg
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }
}
