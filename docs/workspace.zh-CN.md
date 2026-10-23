# Workspace 开发

[English](./workspace.md) | 简体中文

仓库采用 pnpm workspace 和 Nx。`packages/logline` 是可发布的 v2 beta 库，根包为私有包。`apps/*` 为未来应用保留，包括 [logline-server（#53）](https://github.com/tellok/logline/issues/53)，本次不实现服务端。

## 工具链

开发基线为 Node.js **24.22.1 LTS** 与 **pnpm 11.25.0**。`.node-version` 供 fnm、mise 等版本管理器识别；`packageManager` 固定 pnpm，`pmOnFail: download` 支持自动切换。`engines.runtime` 为 pnpm 脚本和 `pnpm exec` 选择 Node.js，不替换交互式终端的 Node.js。单独安装并启用 Corepack 后，也可自动选择固定的 pnpm。

根包通过 pnpm 的 `engines.runtime` 选择运行时，避免 npm 将其作为严格开发版本校验；engine 校验为提示性质，pnpm 通过 `download` 选择固定工具而不因版本不一致报错，版本配置用于自动选择工具链，不会因兼容的宿主版本不同而拒绝执行。升级时需同步 `.node-version` 与 `engines.runtime`。CI 从 `.node-version` 与根包的 `packageManager` 读取版本。

```sh
pnpm install --frozen-lockfile
pnpm run type-check
pnpm run lint
pnpm run test
pnpm run test:release
pnpm run build
pnpm run verify
pnpm run docs:build
pnpm run pack:logline
node scripts/check-package.mjs
```

`verify` 审核产品测试实际执行数量及发布契约测试，再检查格式、构建库、准备公开文档副本并验证导出。审核中的产品测试直接执行，避免缓存命中导致临时报告文件缺失。`pack:logline` 在库目录执行 `pnpm pack`，产出根目录下的压缩包。打包生命周期通过 Nx 检查类型与构建，再从根目录刷新 README、许可证、文档和消费端 Skill 副本。生成副本已忽略，应修改根目录源文件。

## 目录与任务缓存

- `packages/logline`：库源码、Vite 配置、严格 TypeScript 配置、包清单和双语更新日志。
- `scripts`、`docs`、`skills`、`.vitepress`：共享工具和维护的公开内容。
- `tsconfig.base.json`、`eslint.config.ts`：共享类型与 lint 配置。
- `pnpm-workspace.yaml`、`pnpm-lock.yaml`：workspace 设置和统一锁文件。

根目录构建、类型检查、lint 和测试命令委托给 Nx，目标由包脚本推导。构建等待依赖构建和自身类型检查，类型检查等待依赖的类型检查。新增包之间通过 `workspace:*` 声明依赖，并采用相同任务名称、明确声明构建输出。

Nx 本地缓存位于 `.nx/cache`。输入涵盖包源码与配置、根清单、锁文件、workspace 设置、共享 TypeScript/ESLint 配置、Nx 配置、实际 Node.js/pnpm 版本及相关构建环境变量。库构建可恢复 `packages/logline/dist`，检查任务回放执行结果。构建输出和文档副本不参与输入计算。发布、版本准备、打包生命周期、含提交信息的文档构建和发布验证均不缓存。

CI 通过 GitHub Actions cache 持久化 `.nx/cache`，按机器身份、平台、工作流事件、PR、锁文件、工具链及 Nx 配置隔离。Nx 数据库元数据与产物一同保存，本地缓存限定同一机器复用，独立 runner 会建立自己的缓存。发布任务不恢复 PR 缓存。Nx Cloud 已禁用，无需远程缓存凭据。

```sh
pnpm exec nx run logline:build
pnpm exec nx run logline:build # 输入不变时复用结果。
pnpm exec nx run logline:build --skip-nx-cache
pnpm exec nx reset
pnpm run clean
```

`nx reset` 清除 Nx 状态和缓存；`clean` 还移除库产物和生成的公开内容。可在成功构建后删除 `packages/logline/dist` 并再次运行相同构建，验证缓存恢复。相关输入变化会触发重新执行。

## 发布

Changesets 从根目录运行，更新 `packages/logline/package.json` 与库内更新日志，私有根包没有发布版本。版本 PR 准备只更新发布元数据，不构建或发布产品。原有 beta 约束仍遵循[发布契约](./release-flow.zh-CN.md)。
