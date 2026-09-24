# 本地构建与分阶段发布

普通代码发布继续使用本地 Docker BuildKit、SSH 镜像传输和原来的固定生产端口。
这是单写者交接，不是双活。日常 `backup-configs.sh CONFIG_DIR BACKUP_DIR KEEP`
及其 cron 保持原行为；数据库迁移不走此流程。

## 构建一次，复用基础镜像

在 Git Bash/Linux Bash 中，从仓库根目录执行：

```bash
RELEASE_BUILD_DIR=/absolute/protected/release-build \
  bash scripts/ops/build-image.sh <full-commit> aiclient2api:release-<short-commit>
```

- 构建门禁在 `git archive` 导出的提交中运行，宿主 `package-lock.json` 必须与目标一致。
  先为对应提交执行 `npm ci`。宿主 node_modules 只提供测试工具，不进入镜像。
- 相同 RELEASE_BUILD_DIR 内，提交、宿主锁文件、已安装依赖锁文件、Node 版本、平台、架构及测试集合
  均相同时复用成功门禁。目录仅属于一次发布；不要把成功标记复制给其他环境。
- `.git/yyn-build.lock` 阻止并发构建。异常退出遗留锁时先检查进程，不自动删锁。
- 先使用已存在的 Node 父镜像；不存在时明确准备一次，不在每次发布隐式拉取。
  基础构建镜像按父镜像 ID、架构、镜像源及 `Dockerfile.build-base` 内容寻址。
- 内部基础镜像仅用于编译阶段。运行阶段不包含 g++、make、Python、Jest；仍验证
  better-sqlite3 和 sharp。Go/npm BuildKit 缓存保留，禁止发布后全局 prune。
- 系统/依赖层不引用 APP_REVISION/APP_BUILD_DATE。源码或版本变化不重装依赖；锁文件或基础镜像变化重新构建。
- `BUILD_HTTP_PROXY=` 可显式禁用代理；不要将认证代理 URL 写入命令或构建日志。
  冷构建与热构建分别记录，`stage=... elapsed=...s` 是实测耗时。

## 镜像传输

Windows PowerShell 7：

```powershell
./scripts/ops/ship-image.ps1 -Image <tag> -Revision <full-commit> `
  -Target <ssh-alias> -ExpectedHost <verified-hostname> `
  -IdentityFile <existing-key-path> -OutputDirectory <new-local-artifact-directory> `
  -RemoteDirectory <new-remote-artifact-directory>
```

默认只核验镜像和主机。已获该次远程写入授权后加 `-Apply`，依次导出、快速压缩、传输、
校验 SHA-256、加载、核对 image ID，输出 `delivery.json`。不会切换容器。
传输失败保留完整归档；复用归档前重新核对哈希，不重新构建同一镜像。
发布完成后单独清理本次精确传输文件，保留计时和 SHA-256 报告。

## 私有发布说明文件

生产主机需要已有 Python 3、Docker CLI、Nginx CLI。无需安装 Python 包。
把 spec 和发布状态放在仓库、configs 挂载卷之外，目录 700，文件 600。
不同发布共享同一 state-dir 父目录，使部署锁覆盖同一主机上的并发发布。

以下仅为字段说明。镜像、daemon ID、完整参数和允许备份文件必须从当前部署核验后填写；
不可将示例直接用于生产。`docker info --format '{{.ID}}'` 提供 daemon ID。

```json
{
  "expectedHost": "verified-hostname",
  "dockerId": "verified-docker-daemon-id",
  "revision": "0000000000000000000000000000000000000000",
  "image": "aiclient2api:release-shortsha",
  "activeContainer": "aiclient2api",
  "databaseChange": "none",
  "executionWorkers": 3,
  "configDir": "/root/ai_client_configs",
  "configFiles": ["config.json", "provider_pools.json", "api-potluck-keys.json", "codex/credential.json"],
  "nginxConfig": "/etc/nginx/conf.d/actual-service.conf",
  "candidateUrl": "http://127.0.0.1:13001",
  "activeUrl": "http://127.0.0.1:13000",
  "publicUrl": "https://your-service.example",
  "candidateArgs": [
    "--network", "aiclient2api-prod-net",
    "--env-file", "/root/private-release/runtime.env",
    "--env", "RUNTIME_MULTI_WORKER_ENABLED=true",
    "--env", "RUNTIME_EXECUTION_WORKERS=3",
    "--volume", "/root/releases/release-YYYYMMDD-HHMMSS/candidate-snapshot/configs:/app/configs",
    "--publish", "127.0.0.1:13001:3000",
    "--log-driver", "json-file", "--log-opt", "max-size=50m", "--log-opt", "max-file=5",
    "--cpus", "2", "--memory", "2g"
  ],
  "finalArgs": [
    "--network", "aiclient2api-prod-net",
    "--env-file", "/root/private-release/runtime.env",
    "--volume", "/root/ai_client_configs:/app/configs",
    "--publish", "127.0.0.1:13000:3000"
  ]
}
```

`finalArgs` 必须包含实际的全部挂载、端口（包括 OAuth）、资源限额、日志、重启策略等。
脚本在停服前比较旧容器与预创建容器的实际 Docker 设置及环境；只允许 epoch 变化。
不支持的拓扑变化直接阻断，不能静默丢弃旧设置。
候选仅发布 loopback API，必须挂载本次独立快照，不能写 canonical configs。

`configFiles` 是相对 configDir 的文件清单，不接受目录、符号链接或越界路径。
已存在的核心配置和 `_FILE_PATH` 引用不得遗漏；卷外引用需先设计单独恢复方案。
数据库、WAL/SHM、审计、日志、账本、spool、历史备份被拒绝加入普通发布清单。
备份所有必需文件，超过 500 MiB 只警告，输出最大的文件尺寸，具体文件清单留在私有 snapshot.json。
完整容器 inspect 与 Nginx 原配置单独保存于受保护状态目录，不出现在普通报告里。

## 执行阶段

```bash
python3 scripts/ops/release.py --spec /root/private-release/spec.json \
  --state-dir /root/releases/release-YYYYMMDD-HHMMSS --phase preflight
```

每阶段默认 dry-run，确认本次已授权后加 `--apply`。也可使用原入口：
`blue-green-deploy.sh --release-spec <spec> --state-dir <dir> --phase <phase>`。

| 阶段 | 行为 |
| --- | --- |
| preflight | 核对主机、daemon、镜像 revision、旧服务、挂载、Nginx、清单与预算；保存原容器 ID 和限权恢复资料 |
| prepare | 配置快照、启动隔离候选、检查 worker/Redis/积压；预创建最终容器并比较设置，旧服务继续运行 |
| cutover | 重新校验，要求 `--writes-paused` 表示已暂停管理/OAuth 写入；停止候选及旧服务，抓取最终配置，改名并启动新服务 |
| verify | 检查 active ID、镜像、REVISION、epoch、worker、Redis、spool、积压趋势、公网和 Nginx；服务恢复后压缩并逐文件校验备份 |
| rollback | 按原 ID 恢复旧容器；先停止新写入者，不删除旧容器，不覆盖数据库或整卷配置 |
| cleanup | 成功发布且备份校验通过后清理停止的候选；保留两次成功发布的备份与回滚点，只删除登记且复核一致的对象 |

普通发布复用固定端口，Nginx 配置不变；无需将候选端口安装为生产 upstream。
Nginx/edge-auth/网络拓扑调整需要单独方案。本脚本不自动启用 EDGE_ADMISSION_REQUIRED。
部分 prepare 失败保留证据，不自动重跑创建；检查后清理精确的本次候选对象并使用新 release 目录。
cutover/active 验证失败尝试回滚，回滚失败明确记录 manual_attention_required。
备份压缩失败只阻止完成/清理，不把已验证健康的服务切回旧版，可重跑 verify。

120 秒 stop 超时、exit 137、OOM 或非正常退出均阻断继续交接并恢复旧服务，保留退出状态。
不缩短 timeout，不把进程停止等同于事件持久化成功。历史超时原因仍需结合 master/worker
日志、PID 1 信号传递及 spool/Redis 状态单独定位；本轮不修改应用关闭行为。

## 代码验证、推送和结果

```bash
python3 -m unittest discover -s tests -p ops_release_test.py -v
python3 scripts/ops/fork-push.py --report /absolute/private/fork-audit.json
```

fork 审计实时核对远程，只检查 `fork → refs/heads/yyn/customized-branch` 的完整新增历史。
扫描 blob/凭据模式、敏感路径、本地产物及超过 10 MiB 的文件；报告仅包含路径、对象 ID、原因，
不输出匹配内容。发现项必须复核，不是扫描命中就认定泄漏，也不是没有命中就保证无泄漏。
确认是无敏感内容的既有文档或测试数据后，可用 `--reviewed <private-json>` 提供逐项
`blob/path/reasons/reviewNote` 记录；只匹配完全相同的对象及原因，不支持路径通配放行。
若远端提交在本地不存在，先显式 fetch 该分支再审计。工作树干净、审计无待决项且已获推送授权后加
`--apply`；只推固定 SHA 到固定分支，不 force，不推其他分支/tags，并复查远端 SHA。

并发开发使用独立 worktree。发布始终锁定已验证 SHA，不把新 HEAD 自动带入发布。
`state.json` 中 report 分开记录 codeValidation/imageBuild/localRuntime/productionRuntime/
businessValidation/gitPush；没有证据的字段保持 not_recorded/not_run。
真实付费推理需要本次单独授权，健康检查通过不代表业务验证通过。
`timings`、`interruptionSeconds`、构建阶段输出、delivery.json 分别记录各阶段及切换窗口，
比较时应注明冷热缓存和机器条件，不承诺固定中断秒数。
