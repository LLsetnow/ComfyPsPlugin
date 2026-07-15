# Borderless navigation and clipped scrollbar design

## Goal

Remove all visible boxes from the four global navigation destinations while
retaining a clear active state. Remove every visible native scrollbar in the
UXP panel and Logs terminal without removing scrolling.

## Navigation

The top navigation remains a single horizontal component with these four
destinations:

```
工作流   任务队列   ▤   ⚙
```

- Remove the top bar border, radius, background card, and all internal button
  borders and separators.
- Workflow and Queue share the flexible remaining width.
- Logs and Settings are fixed-width, icon-only buttons at the right, with no
  surrounding square, border, or persistent background.
- The active destination uses accent-colored text and a three-pixel blue
  underline. Inactive destinations use the existing muted text color.
- Hover preserves the borderless treatment by changing only text/icon color.
- Existing `title` and `aria-label` values for the Logs and Settings icons,
  narrow-width labels, page routing, and queue badge behavior remain unchanged.

## Scrollbars

The current CSS pseudo-element rules alone do not hide the scrollbar rendered
by the UXP host. Use containment as a fallback so a native scrollbar, if
rendered, lies outside the visible panel.

- `html` and `body` remain fixed, non-scrolling clipping layers.
- `.app-shell` becomes the single outer page scroll container. It uses a width
  and right padding expanded by a fixed hidden-scrollbar gutter, so its content
  retains the current usable width while any native vertical track lies beyond
  the clipped viewport.
- `.log-terminal` continues to clip overflow. `.log-list` receives the same
  expanded-width and compensating-padding treatment, so its history stays
  scrollable but its native scrollbar cannot be seen.
- Retain the existing WebKit, Firefox, and legacy scrollbar-hiding selectors as
  a first line of defense. The gutter clipping is the UXP fallback.
- Do not change page content, bottom safety spacing, log auto-follow behavior,
  or keyboard, mouse-wheel, trackpad, and programmatic scrolling.

## Scope

- Modify only `plugin/index.html`.
- Do not add a custom scrollbar, JavaScript scroll handlers, new controls, or
  change workflow, queue, logging, or page-routing logic.
- Keep flexbox layout and UXP-compatible CSS.

## Verification

1. At normal and narrow panel widths, all four top destinations appear as one
   borderless row; none has an outer box or divider.
2. Each page has a visible active blue underline and accent text; Logs and
   Settings remain icon-only with tooltip and accessible names.
3. Overflow the Workflow, Queue, Settings, and Logs pages. Each scrolls with
   wheel and trackpad input, yet no native scrollbar is visible at the panel
   edge or inside the Logs terminal.
4. Confirm log history remains auto-following when already at its end.
5. Run diff, HTML delivery, and UXP ES5 compatibility checks, then synchronize
   `plugin/index.html` into the Photoshop external-plugin directory.
