# v2 迁移与预发布策略

[English](./migration-v2.md) | [中文 README](../README.zh-CN.md)

v2 提供独立的结构化前端日志能力，采用 MIT 许可证。

| 版本      | 分支   | npm 标签          | API                       |
| --------- | ------ | ----------------- | ------------------------- |
| 稳定版 v1 | master | latest            | 构造函数与存储协议        |
| 实验版 v2 | v2     | 首次发布后为 next | TypeScript 命名导出与插件 |

v2 保留 Git 历史，在独立分支替换旧构建、产物、示例与测试，不向 master 合并 v2 代码。初始版本为 `2.0.0-alpha.0`，创建分支不代表 npm 包已经发布。

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

## 发布实验版本

1. 切换到 v2，选择未发布的 2.x 预发布版本号。
2. 安装锁定依赖并执行类型检查、ESLint、测试、格式检查和打包验证。
3. 完成 npm 身份认证后，在 v2 分支本地执行 `pnpm run release:next`，该命令显式设置 `--publish-branch v2 --tag next`。
4. 查询 npm dist-tags，确认 next 指向实验版，latest 仍指向 v1。

GitHub 手动工作流要求默认分支存在对应文件，因此本实验分支采用本地发布与仅验证的分支 CI，参见[官方说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。

不要以 latest 标签发布实验版，也不要改变默认分支。正式 v2 发布需要另行决定。
