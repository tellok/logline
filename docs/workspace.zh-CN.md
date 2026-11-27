# Workspace 开发

[English](./workspace.md) | 简体中文

workspace 包含三个公开 beta 包：`packages/logline`（日志库和可选上报调度器）、`packages/logline-server-reporter`（HTTP 上传包）、`packages/logline-server-cli`（[终端查询](./cli.zh-CN.md)）。`packages/logline-server` 为基于 PostgreSQL 的私有服务包，部署步骤见[运维指南](./server-operations.zh-CN.md)。

## 工具链

开发基线为 Node.js **24.22.1 LTS** 与 **pnpm 11.25.0**。`.node-version` 供 fnm、mise 等版本管理器识别；`packageManager` 固定 pnpm，`pmOnFail: download` 支持自动切换。`engines.runtime` 为 pnpm 脚本和 `pnpm exec` 选择 Node.js，不替换交互式终端的 Node.js。单独安装并启用 Corepack 后，也可自动选择固定的 pnpm。

根包通过 pnpm 的 `engines.runtime` 选择运行时，避免 npm 将其作为严格开发版本校验；engine 校验为提示性质，pnpm 通过 `download` 选择固定工具而不因版本不一致报错，版本配置用于自动选择工具链，不会因兼容的宿主版本不同而拒绝执行。升级时需同步 `.node-version` 与 `engines.runtime`。CI 从 `.node-version` 与根包的 `packageManager` 读取版本。

执行 `test` 和 `verify` 前，将 `TEST_DATABASE_URL` 设为可丢弃的 PostgreSQL 16 数据库连接串。上传包集成测试使用真实服务和构建后的包。

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
pnpm run pack:reporter
pnpm run pack:cli
node scripts/check-package.mjs --reporter --cli
```

`verify` 要求核心库、服务端、上传包、CLI 和发布契约测试全部执行，不得跳过。它检查格式、构建公开包、检查 CLI 可执行文件并准备公开文档副本，随后将两个真实的压缩包解包到临时消费项目中，检查上传包发布时的 peer 依赖版本，以及 ESM、CommonJS 和严格 TypeScript 导入。审核中的产品测试直接执行，避免缓存命中导致临时报告文件缺失。`pack:logline` 在库目录执行 `pnpm pack`，产出根目录下的压缩包。打包生命周期通过 Nx 检查类型与构建，再从根目录刷新 README、许可证、文档和消费端 Skill 副本。生成副本已忽略，应修改根目录源文件。

## OpenSpec

[基线规格](https://github.com/tellok/logline/tree/master/openspec/specs)记录默认分支已实现的行为。变更行为或公开 API 时，先用 `npm install -g @fission-ai/openspec@2.2.0` 安装 CLI，再使用仓库内的 OpenSpec 技能。归档已实现的变更时，将其需求同步到基线，并将变更移入 `openspec/changes/archive/`。

在仓库根目录验证当前基线：

```sh
npm exec --yes --package=@fission-ai/openspec@2.2.0 -- openspec validate --specs --strict
```

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

Changesets 独立维护公开包的版本：变更集只声明它影响的包，上传包的 `workspace:*` peer 依赖会在核心包变化时按 patch 级联升级。打包时 pnpm 将上传包的 workspace peer 替换为交付的 beta 范围。版本与发布检查请参阅[发布契约](./release-flow.zh-CN.md)。
