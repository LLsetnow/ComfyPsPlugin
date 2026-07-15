# Hide global body scrollbar design

## Goal

Keep all panel pages vertically scrollable while hiding the native scrollbar
drawn for the global `body` scroll container. This gives the compact Photoshop
panel a cleaner edge without removing mouse-wheel, trackpad, keyboard, or
programmatic scrolling.

## Scope

- Apply the change globally to the existing `body { overflow-y: auto; }`
  container.
- Use the browser/WebKit scrollbar rule supported by the UXP runtime to make
  the body scrollbar visually absent.
- Preserve the existing bottom safety padding and every page's current scroll
  range.
- Preserve the visible, independently scrollable history control inside the
  Logs terminal (`.log-list`).

## Implementation

Add a CSS rule adjacent to the existing body scrolling rules in
`plugin/index.html`:

- Do not change `overflow-y: auto`.
- Set the global `body::-webkit-scrollbar` dimensions to zero so it does not
  take visual space or render a thumb.
- Do not add JavaScript, page-state classes, or layout changes.

## Verification

1. At a height that overflows, each page can still be scrolled with a mouse
   wheel or trackpad while no outer right-edge scrollbar is shown.
2. Switch among Workflow, Queue, Settings, and Logs; confirm no content is
   clipped and the bottom safety space remains reachable.
3. Open Logs and confirm its `.log-list` history scrollbar remains visible and
   usable.
4. Run the UXP ES5 compatibility check and verify the plugin HTML has no
   malformed style markup.

## Non-goals

- Replacing scrolling with a custom scrollbar.
- Changing scrolling containers, page heights, or queue/log behavior.
