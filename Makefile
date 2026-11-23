PLUGIN_ID := io.github.mvaled.battery-health
PLUGIN_DIR := $(HOME)/.config/omarchy/plugins/$(PLUGIN_ID)
STATE_DIR := $(HOME)/.local/state/$(PLUGIN_ID)
# Arch keeps the Qt 6 QML tools off the default PATH.
QMLDOM := $(shell command -v qmldom || echo /usr/lib/qt6/bin/qmldom)
SRC_DIR := $(CURDIR)

.DEFAULT_GOAL := check

.PHONY: help
help:
	@printf 'Targets:\n'
	@printf '  check      lint + test (default)\n'
	@printf '  test       run the Model.js and probe.sh test suites\n'
	@printf '  lint       syntax-check the shell, JavaScript and JSON sources\n'
	@printf '  install    symlink this checkout into the Omarchy plugin dir and rescan\n'
	@printf '  enable     add the widget to the bar\n'
	@printf '  disable    remove the widget from the bar\n'
	@printf '  uninstall  disable and remove the symlink\n'
	@printf '  reload     make the running shell re-read the plugin\n'
	@printf '  open       open the panel over IPC\n'
	@printf '  sample     run probe.sh against this machine\n'
	@printf '  state      show the persisted history summary and recent samples\n'
	@printf '  reset      delete the persisted history (irreversible)\n'

.PHONY: check
check: lint test

.PHONY: lint
lint:
	bash -n probe.sh charge-limit.sh tests/probe.test.sh
	node --check Model.js
	node --check summary.js
	node --check tests/model.test.js
	node -e 'JSON.parse(require("fs").readFileSync("manifest.json", "utf8"))'
	@# qmlformat rejects the typed function signatures qs.Ui's own Panel.qml
	@# uses, and qmllint needs import paths it cannot resolve here, so the QML
	@# parse check goes through qmldom.
	$(QMLDOM) -d Panel.qml | node tests/qml-parse.js Panel.qml

.PHONY: test
test:
	node tests/model.test.js
	bash tests/probe.test.sh

.PHONY: install
install:
	@if [ -e "$(PLUGIN_DIR)" ] && [ ! -L "$(PLUGIN_DIR)" ]; then \
		printf 'refusing to replace real directory %s\n' "$(PLUGIN_DIR)" >&2; exit 1; \
	fi
	mkdir -p "$(HOME)/.config/omarchy/plugins"
	ln -sfn "$(SRC_DIR)" "$(PLUGIN_DIR)"
	omarchy-shell shell rescanPlugins

.PHONY: uninstall
uninstall: disable
	@if [ -L "$(PLUGIN_DIR)" ]; then rm -- "$(PLUGIN_DIR)"; fi
	omarchy-shell shell rescanPlugins

# The readout is meant to sit beside the built-in battery glyph, and placement
# is an argument to enable rather than a command of its own, so the move is a
# second enable.  It is only attempted when omarchy.power is on the bar, and a
# failure to place the widget must not undo having enabled it.
.PHONY: enable
enable:
	omarchy plugin enable $(PLUGIN_ID)
	-@if omarchy plugin list --json | \
		jq -e 'any(.[]; .id == "omarchy.power" and .enabled)' >/dev/null; then \
		omarchy plugin enable $(PLUGIN_ID) --before omarchy.power; \
	fi

# uninstall depends on this, and omarchy-plugin-disable fails outright on an
# unknown id, so the failure is ignored to keep uninstall able to reach the
# symlink when the shell has already forgotten the plugin.
.PHONY: disable
disable:
	-omarchy plugin disable $(PLUGIN_ID)

# The shell only watches real paths under the plugin directory, and this
# checkout is reached through a symlink, so edits here need an explicit rescan.
.PHONY: reload
reload:
	omarchy-shell shell rescanPlugins

.PHONY: open
open:
	omarchy-shell $(PLUGIN_ID) open

.PHONY: sample
sample:
	@bash probe.sh

.PHONY: state
state:
	@node summary.js

.PHONY: reset
reset:
	rm -rf -- "$(STATE_DIR)"
