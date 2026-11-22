# Logline Server 运维指南

[English](./server-operations.md) · [上传与限制](./server-ingestion.zh-CN.md) · [管理 API](./server-admin.zh-CN.md) · [日志浏览器](./server-explorer.zh-CN.md) · [MCP](./server-mcp.zh-CN.md)

## 本地启动

在仓库根目录将 `.env.example` 复制为权限为 `0600` 的 `.env`。运行 **两次** `openssl rand -hex 32`，将两个不同的随机值分别填入 `LOGLINE_ADMIN_TOKEN` 与 `POSTGRES_PASSWORD`。不提供默认凭据；不要使用 PAT 代替管理令牌、把文件提交到仓库、开启 shell 跟踪或公开 `docker compose config` 输出。Compose 用十六进制密码构建数据库 URL。数据库初始化密码仅在数据卷首次创建时生效，修改环境变量并不会自动改库内密码。

```sh
docker compose up --build --detach --wait
curl --fail http://127.0.0.1:4318/ready
docker compose logs --tail=50 server
docker compose down  # 保留数据库卷
```

本地部署包括一个非 root API 容器和一个 PostgreSQL 主库，数据库不发布端口，HTTP 默认只监听宿主机回环地址。用 `LOGLINE_PORT` 修改端口；`LOGLINE_MCP_ENABLED=true` 启用带认证的 `/mcp`。用[管理 API](./server-admin.zh-CN.md)创建项目，并为该项目签发有名称的上传密钥。上传时用项目密钥作为 bearer，发送 `{projectId, events}`；Explorer 和 MCP 则用带 `logs:read` 范围且用户具有该项目读权限的 PAT。管理员令牌不得交给应用或浏览器。对外使用时必须在入口终止 TLS，限制连接数，并将管理和指标接口置于可信网络。本地数据库的引导账户权限较高，不应与其他工作负载共用。

浏览器直传时，将 `LOGLINE_INGEST_ORIGINS` 设为逗号分隔的精确来源列表（协议、主机及端口，不含路径），例如 `https://app.example.com`。默认列表为空，接受任意浏览器来源；填入精确来源后可限制浏览器上传。不带 `Origin` 的服务端上报始终不受影响。这项配置不是来源身份证明：拿到公开 DSN 的人仍可向对应项目写入。公开客户端与可信服务端应使用不同密钥，通过服务端写入的 `ingestKeyId` 区分来源。**同一项目的不同密钥共享项目配额**；若必须避免公开流量挤占可信写入，请使用独立项目或在网关另设预算。公开客户端不得持有管理员或读取凭据。

## Kubernetes

集群清单对接**已有持久化 PostgreSQL 主库**（16 或 17）；提前建立专用数据库，数据库账户应能创建/迁移其 schema。生产环境校验数据库 TLS 证书并配置信任链。所有 API 副本必须使用同一个主库；不要使用可能有复制延迟的只读库。清单不部署数据库、公共 Ingress、默认 Secret 或集群级权限。

1. 创建命名空间，用私有 `logline-secrets.env` 提供 `DATABASE_URL=postgresql://…` 和 `LOGLINE_ADMIN_TOKEN=…`，或由 Secret 管理系统注入。Kubernetes Secret 不等于加密：约束 RBAC、启用 etcd 静态加密并轮换凭据。通过环境变量注入的管理令牌需重启所有副本后才完全切换；滚动过程中两个令牌可能短暂并存。若必须立即禁用旧令牌，先停所有旧副本。撤销用户 PAT 或项目密钥都不需要重启。
2. 在工作副本的 `deploy/kubernetes/server.yaml` 中将 `ghcr.io/tellok/logline-server:replace-with-release-tag` 替换为**精确**发布标签或索引摘要。Release 部署附件已固定摘要。在 `kustomization.yaml` 修改配额、保留期等 ConfigMap 参数；`apply -k` 后名称哈希变化会触发滚动更新。
3. 创建资源，确认就绪。Service 仅为 ClusterIP；自行设置 TLS 网关、请求体限额、超时、网络策略。转发 `Authorization` 时不得记录其值。

```sh
kubectl create namespace logline
kubectl -n logline create secret generic logline-server-secrets --from-env-file=logline-secrets.env
kubectl -n logline apply -k deploy/kubernetes
kubectl -n logline rollout status deployment/logline-server
kubectl -n logline port-forward service/logline-server 4318:4318
```

默认两个无状态副本，无粘性会话、无消费者。每副本请求 250m CPU / 128 MiB，限制 1 CPU / 384 MiB，这是**起始配置**而非生产容量保证。跨节点尽量分散；中断预算至少保留一副本。滚动更新 `maxSurge: 1`、`maxUnavailable: 0`。启动探针等待数据库迁移完成；`/health` 查看进程存活，`/ready` 另查主库。SIGTERM 后停止接单，连接最多排空 15 秒，Pod 宽限期 30 秒。切换时用原 ID 重试未确认批次，不能假设所有请求都收到优雅响应。

## 选型依据

| 方案                                   | 确认及可见性                                                                                 | 运维代价                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **当前方案：PostgreSQL 直接批量事务**  | 主库鉴权、预留配额、去重并 INSERT，提交后确认，授权查询可立即看到。                          | 只运维一个存储。读、写、维护有独立的连接池，但共享主库 CPU、WAL、IOPS 及磁盘；主库故障时必须重试。           |
| 持久化消息队列 → 独立消费者 → 分析存储 | 可在复制队列成功后确认，索引可能滞后；须处理分区键、幂等写入、重放、消费延迟和有限保留窗口。 | 可分别扩容入口、写入和分析，却增加组件及新的确认边界。无界队列不能解决长期供需失衡。本次未实现或实测该拓扑。 |
| Redis/Valkey 缓存、限流或缓冲          | 过时的权限缓存会破坏即时撤权；易失队列不能保存已确认日志。                                   | 当前主库按项目加锁执行配额，暂未发现必须增加组件的证据。只有测到争用且撤权安全性可证明时再评估。             |

参考 [Snuba](https://getsentry.github.io/snuba/architecture/overview.html) 的消费与分析分离，以及 [Vector](https://vector.dev/docs/architecture/buffering-model/) 对有界缓冲和持久性的区分。此处限制请求、事件、并发与存储操作，超载时显式要求重试。没有服务端积压，但**不保证主库不可用期间仍可写入**。同一热点项目的配额锁仍是串行点，增加 Pod 并不能无限提高该项目吞吐。客户端有界队列不等于磁盘缓冲。需要断库时继续接单，或批量调优后 WAL、查询或 I/O 争用仍占主导时，再评估复制队列和独立消费者；不能推断本方案优于队列或随 Pod 数线性扩容。

## 容量、保留与恢复

- 数据库连接预算为 `(INGEST_CONCURRENCY + QUERY_CONCURRENCY + 2) × (副本数 + 滚动额外副本)`，另留管理和数据库预留连接。默认两个副本滚动时最多 54 个 API 连接。根据持续的在途请求、p95/p99、CPU、429（项目配额）、503（过载/存储）以及主库剩余容量决定扩容，并监视 WAL 刷盘延迟、自动清理、IOPS 和可用空间。主库饱和时先扩主库或约束昂贵查询。
- 使用管理员 bearer 分别采集每个 Pod 的 `/metrics`（不能只采集负载均衡后的 Service）。将采集器作为管理员保护。区分插入事件/字节与确认 ID（含重放），观察拒绝/重试、延迟直方图及在途数。服务端没有异步队列，须另外监控客户端重试与丢弃。
- 用**实测每条占用磁盘字节数** × 持续吞吐 × 保留期估算，并另留 WAL、索引、备份、复制及 vacuum 空间。保留期按接收时间分批删除，并非严格磁盘上限；监视最早接收时间与删除速率。缩短保留期会删除数据，也将结束对应 ID 的去重保护。
- 开启 `fsync`、`synchronous_commit` 并使用持久盘。要求数据库节点故障 RPO=0 时应配置同步复制与 HA。备份**整个库**（包括权限、项目密钥和 PAT 元数据、HMAC 密钥和保存视图），建立 WAL 归档/PITR。恢复到隔离环境，验证查询和权限后再切流；历史备份可能复活已撤销的授权、PAT 或项目密钥，上线前须重新对账和轮换密钥。应用 Pod 滚动实测并不是数据库 HA、灾备或 PITR 实测。

## 可复现压测

仅针对可丢弃的独立数据库运行 `packages/logline-server/bench/load.mjs`。每轮新建一个读用户、一枚只读 PAT 和多个项目（每个项目有独立的上传密钥）；设置 `BENCH_DISPOSABLE=yes`、`LOGLINE_ADMIN_TOKEN`、以逗号分隔副本 URL 的 `BENCH_URLS`。服务启用 MCP 时用 `BENCH_MCP=1` 加入认证工具查询。驱动限速且不会无限排队；遵守 `Retry-After`，最多重试两次，单列未确认工作。输出 HTTP 状态、尝试延迟和确认延迟、确认事件数/秒及 JSON 请求体字节/秒（非网络总字节）、确认至详情可见时间抽样及读回的 `ingestKeyId` 与真实写入密钥是否匹配、重放后每项目确认数与存储行数比较，以及分别针对只读 PAT 与项目密钥的跨副本撤权验证。非零退出或缺失证据不得作为成功结果。

**预设本地目标，非 SLA：** 24 个活跃项目、6 个写客户端、50 条/批，每条约 350–400 JSON 字节；持续 120 秒，目标发送 1,000 条/秒；3 个并发读客户端间隔 100 毫秒，轮转过滤搜索、时序、聚合、增量刷新、有限导出和可选 MCP 调用。目标确认 ≥950 条/秒、≥320 KiB/s，上传和读取 p95 <150 毫秒、p99 <500 毫秒，确认后可见时间 p99 <500 毫秒，错误确认/重复/已确认数据丢失均为零。对照同速无读负载及单入口。60 秒突发以 4,000 条/秒发送，75% 写客户端集中一个热点项目；应显式返回限流，冷项目仍能写入，不应误读为热点每分钟配额 60,000 时仍可确认 4,000 条/秒。断库目标为 503/重试、有界在途工作、数据库恢复后 15 秒内可写。负载生成器与集群共享硬件时禁止直接外推。

```sh
export BENCH_DISPOSABLE=yes BENCH_MCP=1
# 安全导出 LOGLINE_ADMIN_TOKEN 并设置 BENCH_URLS 为实际副本地址。
node packages/logline-server/bench/load.mjs > steady.json
READERS=0 node packages/logline-server/bench/load.mjs > control.json
BENCH_URLS=http://127.0.0.1:4318 node packages/logline-server/bench/load.mjs > single.json
HOT=1 RATE=4000 WRITERS=8 SECONDS_TO_RUN=60 node packages/logline-server/bench/load.mjs > hot.json
```

本机多副本：编写包含 `services: {server: {ports: !override ['127.0.0.1::4318']}}` 的 Compose override，用 `docker compose -f compose.yml -f override.yml up --build -d --scale server=2 --wait` 启动；同样的 `-f` 参数配合 `port --index 1 server 4318` 和 `--index 2` 查实际地址。45 秒故障注入中，在 `load-start` 后只对**测试项目**的 `db` 服务停机 8 秒再启动，计时到 `/ready` 恢复；不要操作其他容器。用 `docker stats` 抽样 CPU/内存，记录每轮前后的 `pg_total_relation_size('log_events')`，说明共享宿主和抽样误差。

真实滚动测试须在以 `logline-bench-` 开头、已部署两个副本的专用测试命名空间中运行：

```sh
BENCH_DISPOSABLE=yes KUBE_CONTEXT=kind-logline-test BENCH_NAMESPACE=logline-bench-test \
  bash packages/logline-server/bench/kubernetes-rollout.sh
```

临时探针 Pod 在一个副本写入、另一副本读取；`rollout restart` 时继续通过 Service 上传。在替换 Pod 上逐条验证已确认 ID、重放检查去重，然后删除读授权，确认两个新副本都拒绝原 PAT，项目密钥却仍可重放；最后撤销项目密钥，确认两个新副本都拒绝写入。探针在测试命名空间有管理员令牌；记录结果后清理测试资源及数据卷。

## 验证证据

[原始 JSON 与测试驱动](https://github.com/tellok/logline/tree/master/packages/logline-server/bench)提供按操作的延迟、每项目计数与各容器资源采样。用 `node packages/logline-server/bench/qualify.mjs steady.json` 检验两副本混合持续负载，各预设门槛分别输出 PASS/FAIL，未达标则非零退出。未带当前 `project-dsn-v2` 协议标记的旧报告不能参与达标验证。仅正确性通过不等于性能达标。

### 当前 DSN 协议：双副本混合负载

[本轮原始 DSN 报告](https://github.com/tellok/logline/blob/master/packages/logline-server/bench/results/dsn-v2-mixed.json)。**正确性通过，9 项中 6 项达标，不能算性能验证通过。** 在全新专属 PostgreSQL 17.12 卷与两个原生 arm64 API 容器（Node 24.22.1）上运行默认 24 个项目、120 秒的负载；发压器与其他活动共享 Docker Desktop 宿主。包括 500 次 MCP 读取；生成的 113,450 个事件全部确认，重放后各项目计数相符，57 次详情抽样的服务端 `ingestKeyId` 均匹配实际写入密钥。跨项目写入返回 403，撤销只读 PAT 和撤销项目密钥后两副本均各自返回 401。

确认吞吐 **944.76 条/秒**（目标 ≥950）、**338.06 KiB/s**（目标 ≥320）。上传 p95/p99 为 **232.83/786.93 毫秒**，未达 <150/<500 毫秒目标；查询 p95/p99 **52.63/182.85 毫秒**、确认至可见 p99 **97.36 毫秒**均达标。驱动退出码 0，达标检查退出码 1。本轮未复测热点突发、数据库故障或 Kubernetes 滚动替换。不能由非隔离的前后运行推断性能回退。

## 发布镜像

只有经验证合并的版本发布才构建镜像，准备版本 PR 不构建或发布。发布作业将 `linux/amd64` 和 `linux/arm64` 合为一个 OCI 索引，推送至 `ghcr.io/tellok/logline-server:<精确发布标签>`，检查标签摘要和两个平台描述符，分别实际拉取，再将同一索引和 blobs 复制为 OCI 归档。Release 附件含归档、部署包和 SHA-256 校验，说明中有精确的 `docker pull` 命令。部署包内含固定摘要的 Compose、环境变量模板、Kubernetes 清单及双语运维文档。解包部署请使用 `docker compose up -d --wait`（不构建）或 `kubectl apply -k kubernetes`。

```sh
docker pull ghcr.io/tellok/logline-server:<exact-release-tag>
docker buildx imagetools inspect ghcr.io/tellok/logline-server:<exact-release-tag>
sha256sum -c logline-server.sha256
# 将 OCI 附件解压到空目录 image，再复制到隔离环境的仓库：
oras cp --recursive --from-oci-layout ./image:<exact-release-tag> registry.example/logline-server:<exact-release-tag>
```

不要猜测 `latest` 标签。已发布 GHCR 标签的可拉取性和 Release 附件只能在实际发布后验证；PR 构建不是发布凭证。仓库管理员须允许 Actions 写入 GHCR 并授予使用方读取权限。
