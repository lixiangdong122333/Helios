# Helios Cloud Logging MCP

Helios 是一个面向服务监控和故障排查的 Google Cloud Logging MCP Server。它通过统一的 MCP 工具查询一个或多个 Google Cloud 项目中的日志，支持时间范围、Trace ID、服务名、日志摘要和异常聚合。

项目同时支持两种传输方式：

- `stdio`：适合由本地 MCP 客户端拉起的单用户进程。
- 无状态 Streamable HTTP：适合团队或远程部署；HTTP 模式强制启用静态 Bearer Token 或 OIDC/JWKS 身份认证。

Helios 只读访问 Cloud Logging，不写入、修改或删除日志。Google Cloud 身份认证完全采用 Application Default Credentials（ADC），不实现自定义 Google 凭据体系。

## 技术栈

- Node.js 20 或更高版本
- TypeScript、ESM、严格类型检查
- `@modelcontextprotocol/sdk` `1.29.0`
- `@google-cloud/logging` `11.3.0`
- Express `5.2.1`
- JOSE `6.2.3`
- Zod `4.4.3`
- Vitest `4.1.10`

依赖版本由 `package-lock.json` 锁定，项目使用 npm。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `query_logs` | 按项目、时间范围、服务、Trace、严重级别、资源类型和全文条件查询日志 |
| `get_trace_logs` | 获取指定 Trace ID 的关联日志，并按时间整理调用链上下文 |
| `summarize_logs` | 对受限日志样本生成确定性的严重级别、服务、资源类型和观测时间范围摘要 |
| `aggregate_exceptions` | 对异常日志进行指纹分组，返回频次、首次/末次出现时间和代表性样本 |

`summarize_logs` 和 `aggregate_exceptions` 在 Helios 进程内进行确定性计算，不调用大模型。所有工具都会受到服务端时间窗口、扫描条数、返回条数、响应体大小和超时上限约束，调用者不能通过请求扩大这些上限。

成功结果以 JSON `TextContent` 返回，兼容 MCP v1 客户端；响应预算按最终 JSON-RPC 字符串转义后的线缆大小预留空间。错误结果同时带有稳定的 Helios 错误码。

### 通用查询参数

四个工具共享以下筛选模型：

| 参数 | 说明 |
| --- | --- |
| `projectIds` | 可选项目 ID 数组，只能是 `HELIOS_DEFAULT_PROJECTS` 允许列表的子集 |
| `startTime` / `endTime` | 带时区的 RFC 3339 绝对时间；`startTime` 与 `lookbackMinutes` 互斥 |
| `lookbackMinutes` | 相对 `endTime` 或当前时间向前回溯的分钟数 |
| `service` | `{ name, platform, namespace?, cluster?, location? }`；平台为 `auto`、`cloud_run`、`gke`、`app_engine` 或 `generic` |
| `traceId` | 32 位十六进制 ID，或 `projects/PROJECT_ID/traces/TRACE_ID` |
| `minSeverity` | `DEFAULT` 到 `EMERGENCY` 的最低严重级别 |
| `resourceTypes` | Cloud Logging monitored resource type 数组 |
| `searchText` | 编译为 Cloud Logging `SEARCH(...)` 的全文条件，最长 500 个字符 |

工具专用参数：

- `query_logs` 和 `get_trace_logs`：`limit`、`order`（`asc`/`desc`）、`pageToken`、`includePayload`；`get_trace_logs` 必须提供 `traceId`。
- `summarize_logs`：`scanLimit`、`topServices`。
- `aggregate_exceptions`：`scanLimit`、`includeNonErrorSeverity`、`groupLimit`、`samplesPerGroup`。

未提供时间参数时默认查询最近 60 分钟。`query_logs` 默认返回 100 条、按时间倒序且不包含完整 payload；`get_trace_logs` 默认按时间正序。摘要默认最多列出 20 个服务；异常聚合默认只扫描 `ERROR` 及以上日志，最多返回 50 组、每组 3 个样本。继续分页时，将首个响应 `metadata.timeRange` 中的绝对 `startTime`、`endTime` 与 `nextPageToken` 一起原样传回，确保 Google 分页参数保持一致。若响应包含 `paginationInvalidated: true`，应使用更小的 `limit` 重试当前页，不能继续使用上游 Token。

例如，查询 Cloud Run 服务最近 30 分钟的错误日志：

```json
{
  "projectIds": ["my-gcp-project"],
  "lookbackMinutes": 30,
  "service": {
    "name": "payments-api",
    "platform": "cloud_run",
    "location": "us-central1"
  },
  "minSeverity": "ERROR",
  "limit": 100,
  "order": "desc",
  "includePayload": false
}
```

## 快速开始

### 1. 安装和检查

```powershell
npm ci
npm run check
npm test
npm run build
```

### 2. 启用 Cloud Logging API

```powershell
$ProjectId = "my-gcp-project"
gcloud services enable logging.googleapis.com --project $ProjectId
```

### 3. 配置 ADC

本地开发推荐使用用户 ADC：

```powershell
gcloud auth application-default login
gcloud auth application-default set-quota-project $ProjectId
```

这与 `gcloud auth login` 的 CLI 登录凭据不是同一套凭据。Helios 不需要也不推荐在 `.env` 中放置 Google 私钥。生产环境应使用运行平台附加的服务账号、Workload Identity 或 Workload Identity Federation；只有遗留环境才考虑服务账号密钥文件。

如果进程环境中存在 `GOOGLE_APPLICATION_CREDENTIALS`，ADC 会优先使用该文件并覆盖本地用户 ADC。切换凭据后必须重启 Helios；排查时可通过 `npm run smoke:adc` 和 `npm run smoke:mcp` 确认实际项目及端到端读取能力。

ADC 的官方查找顺序和配置方式见 [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)。

### 4. 创建本地配置

```powershell
Copy-Item -LiteralPath ".env.example" -Destination ".env"
```

至少修改 `HELIOS_DEFAULT_PROJECTS`。HTTP 模式还必须替换示例静态 Token，或切换到 OIDC。`.env` 已被 Git 和 Docker 构建上下文忽略，不要提交真实凭据。

### 5. 启动

STDIO：

```powershell
node --env-file=.env dist/index.js --transport stdio
```

Streamable HTTP：

```powershell
node --env-file=.env dist/index.js --transport http
```

默认 HTTP 地址为 `http://127.0.0.1:48080/mcp`。应用配置从进程环境读取；上面的 Node.js `--env-file` 参数和 Docker Compose 的 `env_file` 会加载 `.env`。直接使用 npm 启动脚本时，需要先由 IDE、进程管理器或 PowerShell 注入环境变量。

开发模式：

```powershell
$env:HELIOS_DEFAULT_PROJECTS = "my-gcp-project"
npm run dev -- --transport stdio
```

CLI 参数 `--transport stdio|http` 的优先级高于 `HELIOS_TRANSPORT`。

## MCP 客户端配置

### STDIO

构建后，让 MCP 客户端执行 `node` 并传入 Helios 的绝对路径：

```json
{
  "mcpServers": {
    "helios": {
      "command": "node",
      "args": [
        "D:\\Helios\\dist\\index.js",
        "--transport",
        "stdio"
      ],
      "env": {
        "HELIOS_DEFAULT_PROJECTS": "my-gcp-project"
      }
    }
  }
}
```

本地客户端进程需要能够继承 ADC。STDIO 模式没有额外的 MCP 身份认证层，其安全边界是本机账号、客户端配置和进程权限。协议输出只写入 `stdout`；诊断信息写入 `stderr`，以免破坏 MCP 消息流。

### Streamable HTTP

远程 MCP 客户端应配置：

- URL：`http://127.0.0.1:48080/mcp`，生产环境必须使用 HTTPS。
- Header：`Authorization: Bearer <token>`。
- 浏览器客户端的 `Origin` 必须与 `HELIOS_HTTP_ALLOWED_ORIGINS` 的允许项精确匹配。

HTTP 服务是无状态的：每个请求独立处理，不分配 MCP Session ID，不提供跨请求状态、断线恢复或服务端主动通知。日志查询是请求/响应型工作负载，因此该模式便于水平扩展。

HTTP 路由契约：

| 路由 | 行为 |
| --- | --- |
| `POST ${HELIOS_HTTP_PATH}` | 经过认证的无状态 Streamable HTTP MCP 请求 |
| `GET ${HELIOS_HTTP_PATH}` | 认证后返回 `405 Method Not Allowed`，不建立 SSE Session |
| `DELETE ${HELIOS_HTTP_PATH}` | 认证后返回 `405 Method Not Allowed`，没有可删除的 Session |
| `GET /healthz` | 供编排器使用的轻量存活探针 |
| `GET /readyz` | 供编排器使用的就绪探针 |
| `GET /.well-known/oauth-protected-resource${HELIOS_HTTP_PATH}` | 仅 OIDC 模式发布的受保护资源元数据；默认路径为 `/.well-known/oauth-protected-resource/mcp` |

健康和 OIDC 元数据端点不返回日志内容或秘密。静态 Token 模式由客户端预配置 Token，不发布不可用的 OAuth discovery 挑战。只有 MCP POST 路由接受业务调用。

## HTTP 身份认证

HTTP 模式不允许关闭认证。

### 静态 Bearer Token

```dotenv
HELIOS_HTTP_AUTH_MODE=static
HELIOS_HTTP_STATIC_TOKENS_JSON={"local-operator":"replace-with-a-long-random-secret"}
```

JSON 的键是调用者标识，值是至少 32 个字符的 Bearer Token。每个调用者使用不同的高熵随机 Token；通过 Secret Manager 或部署平台的 Secret 注入环境变量，定期轮换。不要把 Token 放在 URL、日志或源码中。

静态模式适合本地和小规模受控网络。生产团队环境优先选择 OIDC，并在入口层配置 TLS、请求大小限制和速率限制。

### OIDC/JWKS

```dotenv
HELIOS_HTTP_AUTH_MODE=oidc
HELIOS_OIDC_ISSUER=https://issuer.example.com/
HELIOS_OIDC_AUDIENCE=https://helios.example.com/mcp
HELIOS_OIDC_JWKS_URI=https://issuer.example.com/.well-known/jwks.json
HELIOS_OIDC_ALGORITHMS=RS256,ES256
```

Helios 将传入 JWT 作为资源服务器进行校验，包括签名、允许的非对称算法、`iss`、`aud`、有效期，以及可选的必需 scope。`HELIOS_OIDC_AUDIENCE` 必须与 `HELIOS_HTTP_PUBLIC_URL` 完全一致。JWKS 地址必须使用可信 HTTPS 端点，并需要从运行环境出站访问；只有显式 loopback 地址可使用 HTTP。Helios 不负责用户登录、颁发 Token、动态客户端注册或完整 OAuth 授权服务器能力；Token 由现有身份提供商签发。

## IAM 最小权限

运行 Helios 的 ADC 主体需要在每个目标项目上拥有读取日志的权限：

- 一般日志：`roles/logging.viewer`（Logs Viewer）。
- 需要读取 Data Access 审计日志时：仅向确有需要的主体授予 `roles/logging.privateLogViewer`（Private Logs Viewer）。
- 使用限定 Log View 的组织模型时，Google Cloud 提供 `roles/logging.viewAccessor`；但当前 Helios 只接受项目 ID，并把项目作为 `entries.list` 的 resource name，尚不接受 Bucket/View resource name，因此该角色不是当前版本的直接替代方案。

不要授予 `Editor`、`Owner` 或日志写入角色。跨项目查询必须逐项目授权。用户 ADC 的 quota project 还可能需要 `serviceusage.services.use` 权限；出现 `USER_PROJECT_DENIED` 时应检查 quota project 和 Service Usage Consumer 权限。

示例，仅授予一般日志读取权限：

```powershell
$ProjectId = "my-gcp-project"
$RuntimeServiceAccount = "helios@$ProjectId.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$RuntimeServiceAccount" --role="roles/logging.viewer"
```

完整角色权限以 [Cloud Logging IAM roles](https://cloud.google.com/iam/docs/roles-permissions/logging) 为准。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HELIOS_DEFAULT_PROJECTS` | 无 | 逗号分隔的 GCP 项目允许列表；未提供时尝试从 ADC/环境发现项目 |
| `HELIOS_MAX_QUERY_WINDOW_HOURS` | `168` | 单次查询允许的最大时间窗口 |
| `HELIOS_MAX_QUERY_ENTRIES` | `200` | 查询工具最多返回的日志条数；可配置上限为 1000 |
| `HELIOS_MAX_SCAN_ENTRIES` | `5000` | 摘要和聚合最多扫描的日志条数 |
| `HELIOS_MAX_RESPONSE_BYTES` | `1000000` | MCP 工具结果的最大序列化字节数 |
| `HELIOS_MAX_ENTRY_BYTES` | `16000` | 单条日志超过该序列化阈值时压缩为排查所需字段 |
| `HELIOS_QUERY_TIMEOUT_MS` | `30000` | 单次 Cloud Logging 查询超时 |
| `HELIOS_REDACT_KEYS` | 内置敏感键 | 追加的逗号分隔 payload 脱敏键 |
| `HELIOS_LOG_LEVEL` | `info` | `debug`、`info`、`warn` 或 `error` |
| `HELIOS_MAX_CONCURRENT_QUERIES` | `4` | STDIO 与 HTTP 共享的全局查询并发上限 |
| `HELIOS_RATE_LIMIT_REQUESTS` | `60` | 每个身份、每个工具在固定窗口内的调用上限 |
| `HELIOS_RATE_LIMIT_WINDOW_SECONDS` | `60` | 工具调用限流窗口秒数 |
| `HELIOS_TRANSPORT` | `stdio` | `stdio` 或 `http` |
| `HELIOS_HTTP_HOST` | `127.0.0.1` | HTTP 监听地址；容器内需要 `0.0.0.0` |
| `HELIOS_HTTP_PORT` | `48080` | HTTP 监听端口 |
| `HELIOS_HTTP_PATH` | `/mcp` | Streamable HTTP 路径 |
| `HELIOS_HTTP_PUBLIC_URL` | 由 host/port/path 生成 | 对外公开的 MCP URL；绑定全部网卡时必需 |
| `HELIOS_HTTP_ALLOWED_HOSTS` | 无 | 逗号分隔 Host 允许列表；绑定全部网卡时必需 |
| `HELIOS_HTTP_ALLOWED_ORIGINS` | 空 | 逗号分隔的浏览器 Origin 允许列表；模板允许本地 Origin |
| `HELIOS_HTTP_PREAUTH_RATE_LIMIT_REQUESTS` | `120` | 每个来源地址在认证前的 HTTP 请求上限 |
| `HELIOS_HTTP_PREAUTH_RATE_LIMIT_WINDOW_SECONDS` | `60` | HTTP 认证前限流窗口秒数 |
| `HELIOS_HTTP_AUTH_MODE` | 无 | 必需的 HTTP 认证模式：`static` 或 `oidc` |
| `HELIOS_HTTP_STATIC_TOKENS_JSON` | 无 | 调用者标识到 Token 的 JSON 映射 |
| `HELIOS_OIDC_ISSUER` | 无 | OIDC Token 的预期签发者 |
| `HELIOS_OIDC_AUDIENCE` | 无 | OIDC Token 的预期受众 |
| `HELIOS_OIDC_JWKS_URI` | 无 | 签名公钥 JWKS 地址 |
| `HELIOS_OIDC_ALGORITHMS` | `RS256,ES256` | 允许的 JWT 签名算法 |
| `HELIOS_OIDC_REQUIRED_SCOPES` | 无 | JWT 必须包含的逗号分隔 scope |

以 `.env.example` 为完整模板。启动时会严格校验配置，HTTP 认证配置缺失或不安全时进程应直接失败。

## Docker 部署

镜像默认为 HTTP 模式，以非 root 用户运行，并使用只包含生产依赖的多阶段构建。

先完成用户 ADC，然后配置 Compose 使用的宿主机凭据路径：

```powershell
gcloud auth application-default login
$env:HELIOS_ADC_FILE = Join-Path $env:APPDATA "gcloud\application_default_credentials.json"
Copy-Item -LiteralPath ".env.example" -Destination ".env"
docker compose up --build
```

Compose 将 ADC 文件作为只读 Docker Secret 挂载到 `/run/secrets/gcp_adc`。默认端口只发布到宿主机 `127.0.0.1`。停止服务：

```powershell
docker compose down
```

直接构建和运行 STDIO 镜像：

```powershell
docker build --tag helios-cloud-logging-mcp:local .
docker run --rm --interactive --env HELIOS_DEFAULT_PROJECTS=my-gcp-project --mount "type=bind,source=$env:HELIOS_ADC_FILE,target=/run/secrets/gcp_adc,readonly" --env GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/gcp_adc helios-cloud-logging-mcp:local --transport stdio
```

在 Cloud Run、GKE 或其他云运行环境中，不要挂载本地 ADC 文件；将最小权限服务账号附加到工作负载，并让 ADC 自动使用元数据服务或 Workload Identity。

## 查询成本和安全边界

- 默认查询窗口不超过 7 天、返回不超过 200 条、聚合扫描不超过 5000 条、响应不超过约 1 MB。调低这些值可以进一步保护延迟、Cloud Logging API 配额和模型上下文。
- 这些上限不是费用保证。日志摄取、保留、路由和 Log Analytics 等费用取决于 Google Cloud 配置；部署前查看 [Cloud Logging pricing](https://cloud.google.com/logging/pricing) 和 [quotas and limits](https://cloud.google.com/logging/quotas)。
- 使用尽可能窄的项目、时间范围、服务名、Trace ID、严重级别和资源类型。宽泛的全文搜索可能查询较慢，并消耗更多 API 配额。
- 日志可能包含个人信息、访问 Token 或业务秘密。Helios 不会自动判断所有敏感字段；调用者和下游 MCP 客户端必须实施数据最小化、脱敏和访问审计。
- 服务端上限触发时，摘要和异常聚合是受限样本的结果，而不是整个时间范围的精确全量统计。调用方应检查返回的截断元数据。

## 已知限制

- 不提供实时 tail、订阅、告警规则管理、日志写入或删除。
- 查询范围当前只接受最多 20 个项目 ID，不接受 organization、folder、billing account、Log Bucket 或 Log View resource name。
- 无状态 HTTP 不支持跨请求 Session、可恢复 SSE 和服务器主动通知。
- Trace 查询依赖日志条目正确填充 `trace` 字段；只有文本中出现 Trace ID 的日志不会自动成为关联日志。
- 服务名匹配依赖受支持的资源标签或结构化字段；命名不一致时可改用 `resourceTypes` 和 `searchText` 缩小查询，当前版本不接受任意原始 Logging filter。
- 异常指纹是启发式归一化，动态 ID、行号或包装异常可能造成拆分或合并误差。
- Cloud Logging 日志到达可能延迟或乱序，临近当前时间的结果可能尚不完整。

## 开发命令

```powershell
npm run check
npm test
npm run test:coverage
npm run build
npm run smoke:adc
npm run smoke:mcp
npm run start:stdio
npm run start:http
```

`npm run smoke:adc` 使用 ADC 对其默认项目执行一次只读查询，时间窗为最近 5 分钟且最多读取 1 条；脚本只输出项目 ID 和返回条数，不输出日志 payload、访问令牌或凭据。它需要 `logging.logEntries.list` 权限。

完成构建后，`npm run smoke:mcp` 会分别启动生产构建的 STDIO 与本地临时 HTTP 服务，通过真实 MCP 客户端各执行一次同样的只读查询；HTTP 使用仅存在于子进程内的随机 Bearer Token。输出只包含项目、工具数量和返回条数。

## 分支与发布

分支、Pull Request、提交格式和发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。项目使用单主干 GitHub Flow：`main` 保持可发布，功能通过短生命周期分支和 Pull Request 合并。将与 `package.json` 版本一致的 SemVer 标签（例如 `v0.1.0`）推送到 GitHub 后，Release 工作流会重新验证、构建并自动创建 GitHub Release。

架构、安全模型和验证策略见 [docs/architecture.md](docs/architecture.md)。

## 官方参考

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP transport specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP authorization specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Cloud Logging documentation](https://cloud.google.com/logging/docs)
- [Cloud Logging query language](https://cloud.google.com/logging/docs/view/logging-query-language)
- [Google Cloud ADC](https://cloud.google.com/docs/authentication/application-default-credentials)
- [Cloud Logging Node.js API reference](https://cloud.google.com/nodejs/docs/reference/logging/latest)
