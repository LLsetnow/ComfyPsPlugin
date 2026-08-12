# Navigation background and icon scale design

## Goal

Restore a single visual background for the four global navigation destinations
without restoring individual button boxes, dividers, or borders. Improve the
Settings icon's legibility in the compact UXP panel.

## Navigation treatment

The navigation remains one horizontal component:

```
工作流   任务队列   ▤   ⚙
```

- `.topbar` owns one continuous `--bg-card` background and the existing
  six-pixel corner radius.
- `.topbar` has a small three-pixel inner padding but no border or outline.
- All four `.topbar-tab` controls remain transparent with no individual
  background, border, divider, radius, or persistent box.
- The active destination keeps the current accent text and three-pixel blue
  underline. Hover changes only the text or icon color.
- Workflow and Queue keep sharing the flexible width. Logs and Settings remain
  fixed-width icon-only controls.
- The Logs icon uses 18px type. The Settings icon uses 20px type through a
  page-specific selector, so the visually smaller gear glyph has equal visual
  weight.

## Non-goals

- Do not alter navigation routing, keyboard semantics, tooltips, ARIA labels,
  queue-badge behavior, page spacing, or scrollbar clipping.
- Do not introduce a border around the navigation background or an independent
  active-item background.

## Verification

1. The four destinations sit on one rounded, continuous dark background.
2. No destination is enclosed by a separate box or divider.
3. The active page is identified only by accent text and the blue underline.
4. The Settings gear is visibly larger than the Logs icon and remains centered.
5. Check narrow-width behavior, static compatibility checks, preview delivery,
   and synchronization to the Photoshop external-plugin directory.
