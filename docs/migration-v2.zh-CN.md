# v2 迁移与预发布策略

[English](./migration-v2.md) | [中文 README](../README.zh-CN.md)

v2 提供独立的结构化前端日志能力，采用 MIT 许可证。

| 版本      | 分支   | npm 标签          | API                       |
| --------- | ------ | ----------------- | ------------------------- |
| 稳定版 v1 | master | latest            | 构造函数与存储协议        |
| 实验版 v2 | v2     | 首次发布后为 next | TypeScript 命名导出与插件 |

## 分支与标签

默认分支维护 v2 beta，稳定 v1 保留在 [v1 分支](https://github.com/tellok/logline/tree/v1)。通过 `logline@beta` 安装 v2；普通安装继续使用已发布 v1 的最新子版本。

## 从 std-logging 迁移

| 原名称                                      | v2 名称                               |
| ------------------------------------------- | ------------------------------------- |
| std-logging 或实际发布的带 scope 包名       | logline                               |
| configureStdLogging                         | configureLogline                      |
| getStdLoggingConfig / resetStdLoggingConfig | getLoglineConfig / resetLoglineConfig |
| stdLoggingVitePlugin                        | loglineVitePlugin                     |
| createStdLoggingAutoImport                  | createLoglineAutoImport               |
| stdLoggingAutoImportResolvers               | loglineAutoImportResolvers            |
| StdLoggingConfig / StdLoggingPlugin         | LoglineConfig / LoglinePlugin         |
| STD_LOGGING_MODULE_ID                       | LOGLINE_MODULE_ID                     |

原有插件子路径保留在 logline 下。createIndexedDBLoggingPlugin、createClickLogPlugin 和五级日志函数保留名称。

默认数据库名改为 logline 前缀，HTML Interop 全局入口改为 `__LOGLINE_*`。不会自动导入历史数据库；需要读取旧数据库时应显式设置原 databaseName。从 v1 迁移还需调整构造函数与存储调用；v2 不提供 WebSQL 与 localStorage 协议。

## 发布策略

Changesets 生成供审阅的版本 PR，只有经核验的合并提交才能以 beta 标签发布，latest 保持在最新稳定 v1。详见[发布流程](./release-flow.zh-CN.md)。
