# Browser and UXP UI diagnostics design

## Goal

Provide one developer-only snapshot function that can be run in both the
browser preview console and the UXP Developer Tool console. Its JSON output
makes layout/runtime differences measurable without changing the visible UI or
recording user content.

## Public developer interface

- Define a global `dumpUiDiagnostics()` function in `plugin/main.js`.
- Calling it returns a plain JSON-serializable object and writes the same object
  to the developer console.
- It does not run automatically, add controls, mutate the DOM, or add entries
  to the plugin's in-panel log reader.

## Snapshot contents

The result has four layout-only groups:

1. `runtime`: user-agent, viewport width/height, `devicePixelRatio`, and the
   dev-preview flag.
2. `document`: body and root client/scroll dimensions and current scroll
   offset.
3. `activePage`: the active page identifier plus its rectangle, scroll values,
   and selected computed styles.
4. `elements`: snapshots for stable selectors when they exist: app shell,
   topbar, workflow grid, workflow input area, run actions, queue cards,
   terminal container, and terminal log list.

Each element snapshot includes `getBoundingClientRect()`, client/scroll
dimensions, and a small allow-list of computed styles: display, position,
box-sizing, width, height, min-height, margin, padding, overflow/overflow-y,
font family, font size, line height, and visibility.

## Privacy and runtime behavior

- Do not read element text, prompts, form values, task metadata, image data, or
  settings/API keys.
- Do not use clipboard, network, filesystem, timers, or Photoshop APIs.
- Missing elements are represented explicitly as `null`, so the output remains
  comparable across pages and runtimes.
- The implementation uses existing ES5-compatible syntax and DOM APIs already
  used by the panel.

## Use

1. Open the same page and resize browser and UXP panels to the same dimensions.
2. In each developer console, run `dumpUiDiagnostics()`.
3. Copy both returned JSON objects and compare the `runtime`, `document`,
   `activePage`, and matching `elements` entries.
4. Use the first differing rectangle, scroll value, or computed style to narrow
   the CSS/runtime incompatibility.

## Verification

1. `typeof dumpUiDiagnostics === "function"` in browser preview and UXP.
2. Invoking it on Workflow, Queue, and Logs returns valid JSON with no DOM
   mutation or visible UI change.
3. On Logs, the snapshot includes both terminal and terminal-list geometry.
4. Verify no prompt, form value, or API-key string appears in the serialized
   output.
5. Run the repository's UXP ES5 compatibility check and JavaScript syntax
   check.

## Non-goals

- Automatic screenshot capture or pixel comparison.
- Persisting diagnostic snapshots.
- End-user settings or visible diagnostic controls.
