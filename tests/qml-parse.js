// Parse-checks a QML file by reading qmldom's dump on stdin.
//
// qmllint is unusable without the shell's import paths, and qmlformat rejects
// typed function signatures (`function open(): void`) that qs.Ui's own Panel.qml
// relies on, so qmldom's parse tree is the check that actually means something.
//
// Usage: qmldom -d Panel.qml | node tests/qml-parse.js Panel.qml

const label = process.argv[2] || "input"
let raw = ""

process.stdin.on("data", (chunk) => { raw += chunk })
process.stdin.on("end", () => {
  const item = JSON.parse(raw).currentItem
  const errors = Object.keys(item.errors || {})
  if (!item.isValid || errors.length > 0) {
    console.error(label + ": " + JSON.stringify(item.errors, null, 2))
    process.exit(1)
  }
  console.log(label + ": parses clean")
})
