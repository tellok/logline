# 变更记录

## 2.0.0-beta.1

- 新增双语在线文档，在经核验的 beta 版本发布后部署到 GitHub Pages。
- 端到端新增 Sentry 风格事件标签：支持全局与单次调用的扁平字符串标签、setTag/setTags/removeTag 命令式管理及 withScope 局部作用域，标签随 IndexedDB 记录与上报快照持久化，服务端 tags 列通过 GIN 索引覆盖所有标签对，日志查询支持按标签过滤与聚合，并按项目自动发现标签键、随保留期过期清理。
- 新增可选的异步上报插件、基于项目 DSN 的自托管服务上传包，以及日志接收、管理、查询和 MCP 服务。
- 支持 Vite 5.2.8 及以上版本，使用与消费者兼容的 esbuild 类型，并在 CI 中测试打包产物对 Vite 5、6、7、8 最新版本的兼容性。
- 修复 Vite 8 开发模式启动失败，改用原生 Rolldown 依赖转换，同时保留依赖来源标注、按部署路径隔离的 IndexedDB 名称以及 Vite 6/7 支持。
- 将库迁移至 pnpm workspace，配置 Nx 任务缓存与固定开发工具链，适配打包和发布验证，并为未来 logline-server 保留应用目录约定。

## 2.0.0-beta.0

- 推出 TypeScript v2 beta，提供结构化日志、Vite 集成、IndexedDB 持久化、启动阶段捕获与自动导入。

[English](./CHANGELOG.md)

版本条目在版本准备阶段根据变更集生成。
