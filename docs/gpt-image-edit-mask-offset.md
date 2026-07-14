# GPT Image 图像编辑：图层与蒙版错位记录

## 现象

GPT Image「图像编辑」完成后，返回图层的尺寸与输入图层基本一致，但在画布中的位置发生偏移，导致返回图层的蒙版区域与提交时的选区位置不一致。

## 输入坐标系

图像编辑模式提交的输入由两部分组成：

- 活动图层导出的 PNG。该 PNG 保留整张 Photoshop 文档画布，活动图层的透明区域也被保留；
- 当前选区导出的蒙版 PNG。蒙版与输入图像使用相同的文档画布尺寸和坐标。

因此，返回图像必须先对齐到文档画布坐标，才能让选区蒙版正确覆盖返回图层。

## 根因

回贴逻辑通过 Photoshop `placeEvent` 创建结果图层。原实现存在三个问题：

1. `placement` 在整张画布编辑流程中为空，回贴依赖 `placeEvent` 的默认位置；
2. `placeEvent` 使用默认中心定位，结果图层的实际边界不一定与文档左上角重合；
3. 当返回分辨率与文档尺寸不同时，缩放操作完成后没有重新校正图层的左、上坐标，随后直接创建蒙版。

结果是图层和蒙版使用了不同的实际画布原点，出现整体错位。

## 修复方案

当前回贴流程按以下顺序执行：

1. 使用 Photoshop Action Manager 标准的 `"null"` 文件目标字段调用 `placeEvent`；
2. 显式设置 `freeTransformCenterState: QCSAverage`，使放置偏移语义稳定；
3. 按文档尺寸缩放返回图层；
4. 重新读取返回图层的实际边界，将其平移到文档坐标 `(0, 0)`；
5. 恢复提交任务时保存的选区；
6. 在已经对齐的结果图层上创建图层蒙版。

对齐优先使用 Photoshop 23+ 的 `Layer.translate()`，并保留 Action Manager `move` 作为回退路径。

## 相关代码

- `plugin/main.js`：`_alignPlacedLayerToCanvas()`
- `plugin/main.js`：`_placeImageBytesAsLayer()` 中的 GPT Image 回贴和蒙版创建流程
- `dev/static/mock_photoshop.js`：`placeEvent` / `move` 的开发预览模拟

## 验证方式

1. 在 Photoshop 中重新加载插件；
2. 选择 GPT Image →「图像编辑」；
3. 选择活动图层并创建一个不在画布中心的矩形选区；
4. 提交生成后检查返回图层的内容和蒙版边界是否与原选区重合；
5. 使用不同输出分辨率重复测试，确认缩放不会再次引入偏移。

参考： [Adobe UXP `placeEvent` 示例](https://forums.creativeclouddeveloper.com/t/how-do-you-place-an-image-from-the-local-file-system-using-batchplay/2407)

