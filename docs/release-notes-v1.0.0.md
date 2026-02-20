# Luker v1.0.0 Release Notes / 更新说明

## English

### Core Improvements
- Switched major save flows to a patch-first model (RFC 6902), significantly reducing repeated full-file rewrites and network traffic usage.
- Improved incremental save conflict handling and runtime stability.
- Decoupled chat preset and API selection for more flexible model routing.
- Added character-scoped bindings for user personas and presets without polluting global defaults.
- Character-scoped persona/preset bindings are exported and imported together with character cards (creator-friendly distribution).
- Added OAuth login support for GitHub and Discord.
- Added per-user storage quota controls and default user quota assignment.

### World Info
- Added a traceable World Info activation chain, so you can inspect why an entry was activated and what triggered it.
- World Info writes now follow patch-first incremental updates.

### Built-in Features
- Orchestrator (Multi-Agent): supports serial/parallel stages, AI-generated orchestration profiles, character-scoped configuration, profile import/export, and human-readable diff-based approval workflow.
- Memory Graph: improved graph-based memory extraction/linking, iterative recall, partial rebuild for recent turns, character-scoped schema settings, graph import/export for current chat, and better graph presentation.
- Character Editor Assistant: AI-assisted editing for character fields and lorebook content, with diff review, approval, and rollback history.
- During Character Card Replace/Update, a guided panel now asks whether to keep current worldbook, replace with the new worldbook, or use AI to compare old/new worldbooks and apply an updated result.
- Diff UX has been improved, including zoomable line-by-line diff view.

### Android App
- Added Android app support for Luker runtime usage.
- Improved WebView interoperability for file/media flows (SAF picker, blob/data download handling, permission bridge).
- Supports extension installation in the Android app.

### Backup & Restore
- Added built-in Backup/Restore with selectable data categories.

## 中文

### 核心优化
- 主要保存链路切换为patch-first(RFC 6902)模型，显著减少重复整文件重写，明显节省流量并提升可靠性。
- 增强了增量保存的冲突处理与整体运行稳定性。
- 聊天补全预设与API预设解耦，模型路由更灵活。
- 新增角色范围绑定能力，可绑定用户人设与预设，且不污染全局配置。
- 角色范围的人设与预设绑定会随角色卡一起导入导出，便于创作者分发。
- 新增GitHub / Discord OAuth登录支持。
- 新增用户存储限额控制与默认配额分配。

### 世界书
- 新增世界书激活链路追踪，可查看某条目为何被激活、由谁触发。
- 世界书保存流程升级为patch-first增量更新。

### 内置功能
- 多Agent编排器：支持串行/并行阶段编排，支持AI自动生成编排方案，并提供可读的差异审批流程。
- 多Agent编排配置支持角色卡范围，并支持导入导出。
- 记忆图插件：优化图结构记忆抽取与关联，支持迭代召回、最近轮次局部重建，并改进图展示效果。
- 记忆图支持角色卡范围的Schema设置，并支持当前聊天记忆图导入导出。
- 角色卡编辑助手：支持AI编辑角色字段与世界书内容，提供差异审阅、审批与历史回滚。
- 在“角色卡替换/更新”后，会弹出引导面板，询问你是保留当前世界书、直接替换为新世界书，还是使用AI对比新旧世界书后更新。
- diff体验增强，支持逐行差异放大查看。

### 安卓App
- 新增Luker安卓App运行支持。
- 提升WebView文件/媒体交互能力(SAF选取、blob/data下载处理、权限桥接)。
- 支持在安卓App内安装扩展插件。

### 备份与恢复
- 新增内置备份/恢复功能，支持按数据类别选择。
