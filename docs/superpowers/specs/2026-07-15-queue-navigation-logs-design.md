# Queue navigation and terminal log design

## Context

The `feat/ui-page-logic` interface renders task history as vertical cards,
but selecting a card currently rebuilds the entire list. That recreates image
elements and makes every thumbnail flash. The card copy also sits too close to
its thumbnail. Its four equal-width, text-only top-navigation buttons are
clipped in narrow panels. The log page renders list rows by clearing and
rebuilding its content, which makes it unsuitable for reviewing a long stream.

## Scope

This change improves the UI introduced by `feat/ui-page-logic`. It leaves the
existing RunningHub/OpenAI request formats and cache formats intact, except for
removing the standalone GPT Image reference-image mode from the panel.

## Navigation

Use the approved compact top-bar layout:

```
[ Workflow | Queue ]                         [ Logs ][ Settings ]
```

- Workflow and Queue remain the primary page tabs.
- Logs and Settings are always-visible utility icon buttons on the right.
- The active primary tab or utility button has the existing accent treatment.
- At narrow widths, primary labels compact from `工作流` / `任务队列` to
  `工作` / `队列`; the utility controls remain present with accessible titles.
- The layout uses flex sizing and `min-width: 0`, without CSS grid, so it
  remains compatible with the UXP panel runtime.

## Queue

- Place the action row (`导入`, `预览`, `停止`, `删除`) above the task cards.
- Sort all task records by `createdAt` descending. A new task is inserted at
  the front and becomes the selected task.
- Increase the card thumbnail-to-copy gap from 18px to 30px. On the narrow
  layout, use 24px to preserve readable copy width.
- Selecting a card updates only the previously selected and newly selected
  card classes plus the action/progress state. It does not clear/rebuild the
  card container or recreate thumbnail `img` elements.
- A structural task change (new, completed, cancelled, deleted) may render the
  list again. Selection alone must never invoke that structural renderer.

## Logs

Replace the visual list treatment with a terminal-style reader:

- A dark, monospaced scroll viewport contains timestamp, source, level, and
  message on each line. Info, warning, error, and success states use the
  existing semantic palette.
- The viewport has a native vertical scrollbar for inspecting the current
  session history. Log text is selectable.
- New log records append without clearing the existing DOM. Auto-follow is
  active only while the viewport is at its bottom; a manual upward scroll
  pauses it until the user returns to the bottom or explicitly re-enables it.
- Keep the existing maximum of 300 in-memory records and clear action. If
  `/logs` cannot be read, show one bridge-connection message for the current
  failure streak in the terminal instead of silently appearing empty. Allow a
  new message only after a successful poll resets that failure state.

## Data and error behavior

- Keep the existing bridge `/logs?since=` contract and local console capture.
- Never write prompts, images, image data, or API keys to the log view.
- Page navigation starts log polling when Logs opens and stops it on exit;
  local plugin messages continue accumulating for the session.

## GPT Image mode simplification

- Remove the standalone `添加参考图` option from the GPT Image generation-mode
  selector and remove its reference-layer controls and export branch.
- Keep `文生图` and `图像编辑（活动图层选区）` unchanged. The optional
  reference image within the edit flow remains an edit-specific control, not a
  standalone generation mode.
- Keep the bridge endpoint backward-compatible with existing `reference`
  requests; the panel simply no longer creates them.

## Shared RunningHub concurrency

- Treat API types containing `shared` or `enterprise` (case-insensitive) as
  parallel-capable RunningHub credentials.
- While such a credential is active, a new RunningHub task remains submittable
  while other RunningHub tasks are in progress. The panel does not impose a
  client-side concurrent-task cap.
- Consumer credentials retain the existing one-RunningHub-task limit. Local
  ComfyUI tasks still block conflicting task types, while GPT Image continues
  to use its own single-task guard.
- The settings badge identifies shared/enterprise credentials as supporting
  concurrent submissions.

## Verification

1. With multiple completed tasks, repeatedly change selection and confirm
   only the border/action state changes; thumbnails do not reload or flash.
2. Create tasks with increasing `createdAt` values and verify newest-first
   ordering, including a newly inserted task while Queue is visible.
3. Check standard and narrow panel widths: both Logs and Settings remain
   reachable and primary labels compact without clipping.
4. Feed info/warn/error bridge entries and plugin console entries, then scroll
   upward while new entries arrive. The scroll position remains stable until
   returning to the bottom.
5. Run the repository's UXP ES5 compatibility check and Python syntax check.
6. With a saved `SHARED` API type, start two RunningHub jobs before either one
   finishes and verify both queue entries are created and the Generate button
   remains enabled. Repeat with a consumer key and verify the second job is
   still blocked.
7. Verify the GPT Image mode selector exposes only `文生图` and `图像编辑`;
   selecting either never renders the former standalone reference-layer
   controls.

## Non-goals

- Persistent historical logs across plugin restarts.
- Live remote RunningHub node-level logs beyond the bridge's current events.
- Changing the edit-mode image data flow or the bridge's backwards-compatible
  GPT Image endpoint modes.
