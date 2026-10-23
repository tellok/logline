# v2 迁移与预发布策略

[English](./migration-v2.md) | [中文 README](../README.zh-CN.md)

v2 提供独立的结构化前端日志能力，采用 MIT 许可证。

## 分支与标签

默认分支维护 v2 beta，稳定 v1 保留在 [v1 分支](https://github.com/tellok/logline/tree/v1)。通过 `logline@beta` 安装 v2；普通安装继续使用已发布 v1 的最新子版本。

## 从 v1 迁移

v2 重写了 Logline 的公开 API。请将 v1 的构造函数和存储协议调用替换为具名日志函数与插件；v2 不提供 WebSQL 和 localStorage 协议。

- 从 `logline` 引入 `TRACE`、`DEBUG`、`LOG`、`WARN` 和 `ERROR`。
- 使用 `configureLogline` 配置日志，通过 `getLoglineConfig` 和 `resetLoglineConfig` 读取或重置配置。
- 使用 `logline/vite-plugin` 导出的 `loglineVitePlugin` 注入源码位置前缀并按构建等级过滤日志。
- 使用 `logline/auto-import` 导出的 `createLoglineAutoImport` 按需接入自动导入。
- 使用 `logline/plugin/indexeddb` 导出的 `createIndexedDBLoggingPlugin` 配置持久化。历史数据库不会自动导入。

完整示例见 [README](../README.zh-CN.md)，持久化选项见 [IndexedDB 参考](./indexeddb.zh-CN.md)。

## 发布策略

Changesets 生成供审阅的版本 PR，只有经核验的合并提交才能以 beta 标签发布，latest 保持在最新稳定 v1。详见[发布流程](./release-flow.zh-CN.md)。
