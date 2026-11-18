# Token 说明（当前风格）

> 状态: v2.0 | 创建: 2026-11-18 | 最后更新: 2026-11-18 | 关联: ../layout/agents-order.json, tokens.json

当前风格不是一套自定义主题文件，而是：**agents-order 布局 + Herdr 内置默认主题（浅色 `paper` / 深色 `graphite`）+ Maple Mono NF CN**。

## 颜色

| Token | 值 | 语义 | 使用位置 |
|---|---|---|---|
| `canvas` | `#ffffff` | 主背景 | 终端、内容区 |
| `chrome` | `#f1f1ee` | 外壳 | 侧栏、标签栏 |
| `selected` | `#e0e0dd` | 选中 | 当前 Space / 任务行 |
| `border` | `#e3e3e3` | 边界 | 1px 分隔线、面板边框 |
| `text` | `#1b1b1e` | 主文字 | 标题、任务名 |
| `muted` | `#69696b` | 次要 | 分区标题、图标 |
| `dim` | `#969698` | 弱化 | 分支名、时间 |
| `accent` | `#668ce8` | 强调 | 激活指示、品牌蓝 |

### 身份色

Space 徽标与状态使用一组克制的功能色：

`teal #52a69a`、`orange #d68659`、`red #ec6a5e`、`yellow #f4bf4f`、`green #61c554`。

用途：区分 Space 身份与运行状态，不作为装饰性渐变或大面积底色。

## 采样方法

1. 截取当前运行窗口（浅色外观）。
2. 从侧栏、标签栏、内容区取主要纯色区域统计众数。
3. 记录到 `tokens.json`；应用升级后重新采样。

说明：

- `paper` / `graphite` 是内置主题，仓库不包含其 JSON。
- 采样值用于设计与复刻参考，不是 Herdr 的官方常量；不同版本/显示器可能略有差异。
- 深色外观对应 `graphite`，本仓库未采集其色值。

## 排版

| 项 | 值 |
|---|---|
| UI 字体 | Maple Mono NF CN |
| 终端字体 | Maple Mono NF CN |
| 连字 | 关闭 |
| 层级 | 字重 + `text/muted/dim` 亮度，不使用第二套字体 |
