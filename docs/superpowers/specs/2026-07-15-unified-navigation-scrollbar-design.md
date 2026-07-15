# Unified navigation and invisible scrollbar design

## Goal

Make the four global destinations feel like one continuous navigation component
in the compact UXP panel, while preserving scrolling but removing every visible
native scrollbar from the panel.

## Navigation structure

The existing `.topbar` becomes the sole visual navigation container:

```
[ 工作流 | 任务队列 | ▤ | ⚙ ]
```

- `.topbar` owns the single border, background, radius, and clipping.
- The Workflow and Queue buttons remain the primary controls and divide the
  flexible remaining width equally.
- Logs and Settings remain fixed-width icon-only buttons. They are children of
  the same navigation component, not separately bordered controls.
- Internal one-pixel separators distinguish adjacent controls. There is no gap,
  external border, or separate radius around the icon buttons.
- Existing active, hover, accessibility label, tooltip, narrow-label, and queue
  badge behavior remains intact.

## Scrollbar behavior

- Keep the existing outer and inner scroll containers scrollable with mouse
  wheel, trackpad, keyboard, and programmatic scrolling.
- Hide every native scrollbar visual, including the global body scrollbar and
  the Logs terminal history scrollbar, using UXP/WebKit-compatible scrollbar
  selectors plus zero dimensions.
- Do not change overflow modes, content heights, bottom safety padding, or the
  log auto-follow behavior.
- Update the Logs terminal hint from dragging a right-side scrollbar to generic
  scrolling, because no visible scrollbar remains.

## Implementation boundaries

- Edit only `plugin/index.html`: navigation CSS/markup, scrollbar CSS, and the
  terminal hint text.
- Do not add JavaScript, custom-drawn scrollbars, new UI controls, or change
  page navigation logic.
- Retain flexbox layouts and ES5-compatible code paths for UXP.

## Verification

1. At standard and narrow widths, all four destinations sit inside one shared
   outer border with no gaps around Logs or Settings.
2. Workflow and Queue use the flexible space; Logs and Settings show icons only
   and retain keyboard-accessible labels/tooltips.
3. Overflow each page and the Logs terminal. Each remains scrollable, while no
   visible native scrollbar appears anywhere in the panel.
4. Confirm the active tab and queue badge styling still work.
5. Run HTML/diff checks and the UXP ES5 compatibility check.

## Non-goals

- A replacement custom scrollbar or permanent scroll-position indicator.
- Changes to task execution, logging data, page routing, or panel colors.
