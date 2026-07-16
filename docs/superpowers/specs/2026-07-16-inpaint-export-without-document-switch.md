# 局部编辑导出避免切换当前文档

## 背景

RunningHub 局部编辑目前会导出活动图层的选区外接矩形，以减少上传体积。当前实现通过复制 Photoshop 文档、裁切副本、保存 PNG、关闭副本完成图片和蒙版导出。

在这一过程中，Photoshop 会短暂激活副本文档，造成用户当前画布瞬间切换。该视觉闪动不影响结果，但影响交互体验。

## 目标

在保持“仅上传活动图层的选区外接矩形”和“结果按原坐标贴回”能力的前提下，避免或显著减轻 Photoshop 当前文档的可见切换。

## 已确认事实

- `exportActiveLayerSelectionPNG()` 与 `exportSelectionMaskPNG()` 当前依赖临时副本文档。
- `executeAsModal` 只保证 Photoshop 操作的模态性，不能保证副本文档不被界面激活。
- 在本地桥裁切可避免 Photoshop 切换，但会先把完整图片传至桥，不能减少插件到桥的传输量。

## 方案

### 推荐：导出后在插件侧裁切

1. 在不复制文档的情况下导出当前可见画面，或在短暂隔离活动图层可见性后导出整画布 PNG。
2. 在 UXP 面板侧读取 PNG，并通过 Canvas 或 Photoshop Imaging 像素 API 裁切选区外接矩形。
3. 生成同尺寸的图片与蒙版 PNG 后提交给桥。
4. 保留现有 `placement`、选区快照和原位贴回流程。

优点是仍减少网络上传，且不需要激活临时文档。风险是需要确认 UXP Canvas/Imaging API 对目标 Photoshop 版本的 PNG 解码、裁切与编码支持。

### 备选：Photoshop Imaging 像素 API

直接读取活动图层的选区像素，并生成裁切图片。该路径理论上最干净，但需要实现或引入可靠的 PNG 编码，且必须验证 UXP 宿主版本兼容性。

### 不推荐：在本地桥裁切

插件先导出并上传整图，桥再裁切后提交到 RunningHub。它能消除 Photoshop 切换，但不减少插件到桥的传输，不满足主要性能目标。

## 明日实施顺序

1. 在开发预览与目标 Photoshop 版本中验证 Canvas 和 `photoshop.imaging` 的可用能力。
2. 做一个仅导出、裁切和检查 PNG 尺寸的原型，不接入 RunningHub。
3. 比较导出图像是否保留活动图层语义、透明度及选区坐标。
4. 将验证通过的路径接入 QwenImage / Boogu 局部编辑。
5. 验证没有当前文档闪切，且图片与蒙版尺寸一致、返图位置与图层蒙版正确。

## 验收标准

- 局部编辑提交期间不再可见地切换到临时文档。
- 上传图片与蒙版的像素尺寸完全相同。
- 上传数据仍仅覆盖选区外接矩形。
- QwenImage、Boogu、队列导入和即时贴回均保持原位对齐。

## 验证结果 (2026-07-16)

### API 能力核实（官方 UXP 文档）

- **UXP Canvas 不可行**：`HTMLCanvasElement` 仅支持 `2d` 上下文的基础路径绘制
  (`moveTo`/`lineTo`/`stroke`)，无 `putImageData`、无 `toDataURL`/`toBlob`，无法解码/
  裁切/编码 PNG。因此 spec 原“推荐”的 Canvas 裁切路径在真实宿主上不成立。
- **`imaging.encodeImageData` 仅输出 JPEG**（有损、无 alpha），不能用于图片/蒙版 PNG。
- **`imaging.getPixels({ layerID, sourceBounds })` 可行**：直接按外接矩形读取活动
  图层像素，无需复制文档、无需切换图层可见性 → 无闪切。
- **`imaging.getSelection({ sourceBounds })` 可行**：直接读取选区蒙版像素，替代
  “复制文档 + 建临时图层 + 填充”整套流程。

### 落地方案

采用 **imaging 读取 + 插件内置纯 JS PNG 编码器**（固定 Huffman + 贪心 LZ77，
无损，支持 RGBA/灰度）。旧的“复制文档 + 裁切”路径保留为回退，宿主缺少 imaging
能力或 imaging 调用异常时自动降级，行为不变。无论走哪条路径，图片与蒙版都补齐到
同一个 `_normalizeSelectionCropBounds` 外接矩形，尺寸严格一致。

### 已验证

- PNG 编码器：Node(zlib inflate) + macOS(sips/ImageIO) 双解码器逐字节校验——
  尺寸、CRC、像素往返、alpha、采样数全部正确；真实图像内容压缩率约 0.01–0.04。
- 尺寸不变量：即便 imaging 返回被裁切/偏移的 sourceBounds，图片与 RH 蒙版、GPT
  蒙版仍全部等于选区外接矩形（已覆盖满矩形/内缩/1px/3 通道等场景）。
- 真实 main.js 代码在浏览器 JS 引擎 + imaging mock 下端到端运行：图片=RGBA、
  RH 蒙版=灰度、GPT 蒙版=RGBA(选区透明)，三者同尺寸；亚像素选区向外取整正确；
  选区极性 选中=255(白)/未选=0(黑)；控制台零错误。

### 仍需在真实 Photoshop 确认（无法在 CLI 侧验证）

- **无闪切**：真实宿主中不再瞬间切到临时副本文档。
- **`getSelection` 极性**：本实现假设“选中=255=白”。首次真实运行时用返图/蒙版调试
  肉眼确认 RH 蒙版未反相；若某宿主版本相反，只需翻转极性。
- 贴回 placement 与图层蒙版在真实文档坐标下的对齐。
