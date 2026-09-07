# Helios Cloud Logging MCP

**English** | [简体中文](README_zh.md)

Helios is a Google Cloud Logging MCP Server designed for service monitoring and troubleshooting. Through unified MCP tools, it queries logs from one or more Google Cloud projects, supporting time ranges, Trace IDs, service names, log summaries, and exception aggregation.

The project supports two transport modes:

- `stdio`: a single-user process launched by a local MCP client.
- Stateless Streamable HTTP: suited for team or remote deployments; HTTP mode enforces either static Bearer Token or OIDC/JWKS authentication.

Helios accesses Cloud Logging read-only; it never writes, modifies, or deletes logs. Google Cloud authentication relies entirely on Application Default Credentials (ADC) — Helios does not implement its own Google credential system.

## Tech Stack

- Node.js 20 or later
- TypeScript, ESM, strict type checking
- `@modelcontextprotocol/sdk` `1.29.0`
- `@google-cloud/logging` `11.3.0`
- Express `5.2.1`
- JOSE `6.2.3`
- Zod `4.4.3`
- Vitest `4.1.10`

Dependency versions are locked by `package-lock.json`; the project uses npm.

## Release Executables

GitHub Releases provide both an npm `.tgz` package and standalone executables built with Node.js 24 SEA. SEA archives require no pre-installed Node.js or npm, but Google Cloud ADC, the Cloud Logging API, and IAM permission requirements remain unchanged.

| Archive target | Runtime environment |
| --- | --- |
| `windows-x64` | 64-bit Windows |
| `linux-x64-glibc` | 64-bit glibc Linux |
| `linux-arm64-glibc` | arm64 glibc Linux |
| `macos-arm64` | Apple Silicon macOS |

Example download and extraction in Windows PowerShell:

```powershell
$Version = "0.2.0"
$Target = "windows-x64"
$Archive = "helios-cloud-logging-mcp-v$Version-$Target.zip"
Invoke-WebRequest -Uri "https://github.com/lixiangdong122333/Helios/releases/download/v$Version/$Archive" -OutFile $Archive
Expand-Archive -LiteralPath $Archive -DestinationPath . -Force
Set-Location "helios-cloud-logging-mcp-v$Version-$Target"
.\helios-cloud-logging-mcp.exe --help
```

Example with PowerShell 7 on Linux or macOS:

```powershell
$Version = "0.2.0"
$Target = "linux-x64-glibc" # or linux-arm64-glibc, macos-arm64
$Archive = "helios-cloud-logging-mcp-v$Version-$Target.tar.gz"
Invoke-WebRequest -Uri "https://github.com/lixiangdong122333/Helios/releases/download/v$Version/$Archive" -OutFile $Archive
tar -xzf $Archive
Set-Location "helios-cloud-logging-mcp-v$Version-$Target"
chmod +x ./helios-cloud-logging-mcp
./helios-cloud-logging-mcp --help
```

After completing the ADC and environment variable configuration below, the executable can be launched directly as an MCP STDIO process, or as an HTTP service with `--transport http`. Each archive contains the README, licenses for the bundled Node.js version and the third-party dependencies actually bundled, and the `SHA256SUMS.txt` at the Release root verifies downloaded files.

Node.js SEA is still in active development, and its artifacts are platform- and architecture-specific. Node.js 24 officially does not support macOS x64 SEA, nor Alpine; on those environments use the npm `.tgz`, Docker, or build from source. Windows SEA binaries are unsigned when no project code-signing certificate is available; macOS SEA binaries use ad-hoc signing without Apple notarization.

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `query_logs` | Query logs by project, time range, service, trace, severity, resource type, and full-text condition |
| `get_trace_logs` | Fetch logs associated with a given Trace ID and organize the call-chain context by time |
| `summarize_logs` | Produce a deterministic summary of severity levels, services, resource types, and observed time range from a bounded log sample |
| `aggregate_exceptions` | Group exception logs by fingerprint, returning frequency, first/last occurrence times, and representative samples |

`summarize_logs` and `aggregate_exceptions` perform deterministic computation inside the Helios process and do not call any large language model. All tools are constrained by server-side limits on the time window, entries scanned, entries returned, response body size, and timeouts — callers cannot raise these limits via requests.

Successful results are returned as JSON `TextContent`, compatible with MCP v1 clients; response budgets reserve space based on the wire size after final JSON-RPC string escaping. Error results carry stable Helios error codes.

### Common Query Parameters

The four tools share the following filtering model:

| Parameter | Description |
| --- | --- |
| `projectIds` | Optional array of project IDs; must be a subset of the `HELIOS_DEFAULT_PROJECTS` allowlist |
| `startTime` / `endTime` | Absolute RFC 3339 timestamps with timezone; `startTime` and `lookbackMinutes` are mutually exclusive |
| `lookbackMinutes` | Minutes to look back relative to `endTime` or the current time |
| `service` | `{ name, platform, namespace?, cluster?, location? }`; platform is `auto`, `cloud_run`, `gke`, `app_engine`, or `generic` |
| `traceId` | 32-character hexadecimal ID, or `projects/PROJECT_ID/traces/TRACE_ID` |
| `minSeverity` | Minimum severity level from `DEFAULT` to `EMERGENCY` |
| `resourceTypes` | Array of Cloud Logging monitored resource types |
| `searchText` | Full-text condition compiled to a Cloud Logging `SEARCH(...)`, up to 500 characters |

Tool-specific parameters:

- `query_logs` and `get_trace_logs`: `limit`, `order` (`asc`/`desc`), `pageToken`, `includePayload`; `get_trace_logs` requires `traceId`.
- `summarize_logs`: `scanLimit`, `topServices`.
- `aggregate_exceptions`: `scanLimit`, `includeNonErrorSeverity`, `groupLimit`, `samplesPerGroup`.

When no time parameters are provided, the default queries the last 60 minutes. `query_logs` returns 100 entries by default, in descending time order, without full payloads; `get_trace_logs` defaults to ascending order. Summaries list at most 20 services by default; exception aggregation scans only `ERROR`-and-above logs by default, returning at most 50 groups with 3 samples per group. When paginating, pass back the absolute `startTime` and `endTime` from the first response's `metadata.timeRange` together with `nextPageToken` as-is, so Google pagination parameters stay consistent. If a response contains `paginationInvalidated: true`, retry the current page with a smaller `limit` instead of continuing with the upstream token.

For example, to query the last 30 minutes of error logs for a Cloud Run service:

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

## Quick Start

### 1. Install and Check

```powershell
npm ci
npm run check
npm test
npm run build
```

### 2. Enable the Cloud Logging API

```powershell
$ProjectId = "my-gcp-project"
gcloud services enable logging.googleapis.com --project $ProjectId
```

### 3. Configure ADC

For local development, user ADC is recommended:

```powershell
gcloud auth application-default login
gcloud auth application-default set-quota-project $ProjectId
```

These credentials are not the same as the CLI credentials from `gcloud auth login`. Helios does not need, and does not recommend, placing Google private keys in `.env`. Production environments should use the attached service account, Workload Identity, or Workload Identity Federation of the runtime platform; service account key files are a legacy-environment fallback only.

If `GOOGLE_APPLICATION_CREDENTIALS` exists in the process environment, ADC prefers that file and overrides local user ADC. Helios must be restarted after switching credentials; use `npm run smoke:adc` and `npm run smoke:mcp` to confirm the actual project and end-to-end read capability when troubleshooting.

See [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials) for the official ADC lookup order and configuration methods.

### 4. Create Local Configuration

```powershell
Copy-Item -LiteralPath ".env.example" -Destination ".env"
```

At minimum, modify `HELIOS_DEFAULT_PROJECTS`. For HTTP mode you must also replace the example static tokens or switch to OIDC. `.env` is ignored by both Git and the Docker build context; never commit real credentials.

### 5. Start

STDIO:

```powershell
node --env-file=.env dist/index.js --transport stdio
```

Streamable HTTP:

```powershell
node --env-file=.env dist/index.js --transport http
```

The default HTTP address is `http://127.0.0.1:48080/mcp`. Application configuration is read from the process environment; the Node.js `--env-file` flag above and Docker Compose `env_file` both load `.env`. When using the npm start scripts directly, environment variables must be injected beforehand by your IDE, process manager, or PowerShell.

Development mode:

```powershell
$env:HELIOS_DEFAULT_PROJECTS = "my-gcp-project"
npm run dev -- --transport stdio
```

The CLI argument `--transport stdio|http` takes precedence over `HELIOS_TRANSPORT`.

## MCP Client Configuration

### STDIO

After building, have your MCP client execute `node` with the absolute path to Helios:

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

When using an SEA release, change `command` to the absolute path of the extracted executable and keep `args: ["--transport", "stdio"]`; `node` and `dist/index.js` are no longer needed.

The local client process must be able to inherit ADC. STDIO mode has no additional MCP authentication layer; its security boundary is the local account, client configuration, and process permissions. Protocol output goes to `stdout` only; diagnostics go to `stderr` to avoid breaking the MCP message stream.

### Streamable HTTP

Remote MCP clients should configure:

- URL: `http://127.0.0.1:48080/mcp`; HTTPS is mandatory in production.
- Header: `Authorization: Bearer <token>`.
- Browser clients must send an `Origin` that exactly matches an entry in `HELIOS_HTTP_ALLOWED_ORIGINS`.

The HTTP service is stateless: each request is handled independently, with no MCP Session ID assignment, no cross-request state, no resumability, and no server-initiated notifications. Log querying is a request/response workload, so this mode scales horizontally with ease.

HTTP route contract:

| Route | Behavior |
| --- | --- |
| `POST ${HELIOS_HTTP_PATH}` | Authenticated stateless Streamable HTTP MCP request |
| `GET ${HELIOS_HTTP_PATH}` | Returns `405 Method Not Allowed` after authentication; no SSE session is established |
| `DELETE ${HELIOS_HTTP_PATH}` | Returns `405 Method Not Allowed` after authentication; there is no session to delete |
| `GET /healthz` | Lightweight liveness probe for orchestrators |
| `GET /readyz` | Readiness probe for orchestrators |
| `GET /.well-known/oauth-protected-resource${HELIOS_HTTP_PATH}` | Protected resource metadata published in OIDC mode only; the default path is `/.well-known/oauth-protected-resource/mcp` |

Health and OIDC metadata endpoints return no log content or secrets. In static token mode the client is pre-provisioned with its token, and no unusable OAuth discovery challenge is published. Only the MCP POST route accepts business calls.

## HTTP Authentication

Authentication cannot be disabled in HTTP mode.

### Static Bearer Token

```dotenv
HELIOS_HTTP_AUTH_MODE=static
HELIOS_HTTP_STATIC_TOKENS_JSON={"local-operator":"replace-with-a-long-random-secret"}
```

The JSON keys are caller identities and the values are Bearer tokens of at least 32 characters. Use a different high-entropy random token per caller; inject them via Secret Manager or your deployment platform's secret mechanism, and rotate them regularly. Never put tokens in URLs, logs, or source code.

Static mode suits local and small-scale controlled networks. For production team environments, prefer OIDC, and configure TLS, request size limits, and rate limiting at the ingress layer.

### OIDC/JWKS

```dotenv
HELIOS_HTTP_AUTH_MODE=oidc
HELIOS_OIDC_ISSUER=https://issuer.example.com/
HELIOS_OIDC_AUDIENCE=https://helios.example.com/mcp
HELIOS_OIDC_JWKS_URI=https://issuer.example.com/.well-known/jwks.json
HELIOS_OIDC_ALGORITHMS=RS256,ES256
```

Helios validates incoming JWTs as a resource server, including signature, allowed asymmetric algorithms, `iss`, `aud`, validity period, and optional required scopes. `HELIOS_OIDC_AUDIENCE` must exactly match `HELIOS_HTTP_PUBLIC_URL`. The JWKS URL must be a trusted HTTPS endpoint reachable via outbound access from the runtime environment; only explicit loopback addresses may use HTTP. Helios does not handle user login, token issuance, dynamic client registration, or full OAuth authorization server capabilities; tokens are issued by your existing identity provider.

## IAM Least Privilege

The ADC principal running Helios needs log read permission on each target project:

- General logs: `roles/logging.viewer` (Logs Viewer).
- To read Data Access audit logs: grant `roles/logging.privateLogViewer` (Private Logs Viewer) only to principals that genuinely need it.
- For organization models with scoped Log Views, Google Cloud offers `roles/logging.viewAccessor`; however, Helios currently accepts project IDs only and uses the project as the `entries.list` resource name — it does not yet accept Bucket/View resource names — so that role is not a direct substitute in the current version.

Do not grant `Editor`, `Owner`, or log-writing roles. Cross-project queries must be authorized per project. The user ADC's quota project may also need `serviceusage.services.use` permission; when you see `USER_PROJECT_DENIED`, check the quota project and Service Usage Consumer permissions.

Example, granting general log read permission only:

```powershell
$ProjectId = "my-gcp-project"
$RuntimeServiceAccount = "helios@$ProjectId.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$RuntimeServiceAccount" --role="roles/logging.viewer"
```

For the complete role permissions, refer to [Cloud Logging IAM roles](https://cloud.google.com/iam/docs/roles-permissions/logging).

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `HELIOS_DEFAULT_PROJECTS` | none | Comma-separated GCP project allowlist; if absent, projects are discovered from ADC/environment |
| `HELIOS_MAX_QUERY_WINDOW_HOURS` | `168` | Maximum time window per query |
| `HELIOS_MAX_QUERY_ENTRIES` | `200` | Maximum log entries returned by query tools; configurable up to 1000 |
| `HELIOS_MAX_SCAN_ENTRIES` | `5000` | Maximum log entries scanned by summaries and aggregation |
| `HELIOS_MAX_RESPONSE_BYTES` | `1000000` | Maximum serialized byte size of an MCP tool result |
| `HELIOS_MAX_ENTRY_BYTES` | `16000` | Entries exceeding this serialized threshold are condensed to troubleshooting-relevant fields |
| `HELIOS_QUERY_TIMEOUT_MS` | `30000` | Timeout for a single Cloud Logging query |
| `HELIOS_REDACT_KEYS` | built-in sensitive keys | Additional comma-separated payload redaction keys |
| `HELIOS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `HELIOS_MAX_CONCURRENT_QUERIES` | `4` | Global query concurrency cap shared by STDIO and HTTP |
| `HELIOS_RATE_LIMIT_REQUESTS` | `60` | Per-identity, per-tool call cap within a fixed window |
| `HELIOS_RATE_LIMIT_WINDOW_SECONDS` | `60` | Tool call rate-limit window in seconds |
| `HELIOS_TRANSPORT` | `stdio` | `stdio` or `http` |
| `HELIOS_HTTP_HOST` | `127.0.0.1` | HTTP listen address; containers need `0.0.0.0` |
| `HELIOS_HTTP_PORT` | `48080` | HTTP listen port |
| `HELIOS_HTTP_PATH` | `/mcp` | Streamable HTTP path |
| `HELIOS_HTTP_PUBLIC_URL` | derived from host/port/path | Publicly exposed MCP URL; required when binding all interfaces |
| `HELIOS_HTTP_ALLOWED_HOSTS` | none | Comma-separated Host allowlist; required when binding all interfaces |
| `HELIOS_HTTP_ALLOWED_ORIGINS` | empty | Comma-separated browser Origin allowlist; the template allows local origins |
| `HELIOS_HTTP_PREAUTH_RATE_LIMIT_REQUESTS` | `120` | Per-source-address HTTP request cap before authentication |
| `HELIOS_HTTP_PREAUTH_RATE_LIMIT_WINDOW_SECONDS` | `60` | Pre-auth HTTP rate-limit window in seconds |
| `HELIOS_HTTP_AUTH_MODE` | none | Required HTTP auth mode: `static` or `oidc` |
| `HELIOS_HTTP_STATIC_TOKENS_JSON` | none | JSON mapping of caller identity to token |
| `HELIOS_OIDC_ISSUER` | none | Expected issuer of OIDC tokens |
| `HELIOS_OIDC_AUDIENCE` | none | Expected audience of OIDC tokens |
| `HELIOS_OIDC_JWKS_URI` | none | JWKS URL of the signing public keys |
| `HELIOS_OIDC_ALGORITHMS` | `RS256,ES256` | Allowed JWT signature algorithms |
| `HELIOS_OIDC_REQUIRED_SCOPES` | none | Comma-separated scopes the JWT must contain |

Use `.env.example` as the complete template. Configuration is strictly validated at startup; the process should fail fast when HTTP authentication is missing or insecure.

## Docker Deployment

The image defaults to HTTP mode, runs as a non-root user, and uses a multi-stage build containing production dependencies only.

First complete user ADC, then configure the host credential path used by Compose:

```powershell
gcloud auth application-default login
$env:HELIOS_ADC_FILE = Join-Path $env:APPDATA "gcloud\application_default_credentials.json"
Copy-Item -LiteralPath ".env.example" -Destination ".env"
docker compose up --build
```

Compose mounts the ADC file as a read-only Docker Secret at `/run/secrets/gcp_adc`. The default port is published to the host's `127.0.0.1` only. Stop the service with:

```powershell
docker compose down
```

Build and run the STDIO image directly:

```powershell
docker build --tag helios-cloud-logging-mcp:local .
docker run --rm --interactive --env HELIOS_DEFAULT_PROJECTS=my-gcp-project --mount "type=bind,source=$env:HELIOS_ADC_FILE,target=/run/secrets/gcp_adc,readonly" --env GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/gcp_adc helios-cloud-logging-mcp:local --transport stdio
```

On Cloud Run, GKE, or other cloud runtimes, do not mount a local ADC file; attach a least-privilege service account to the workload and let ADC use the metadata server or Workload Identity automatically.

## Query Cost and Security Boundaries

- By default, queries cover at most 7 days, return at most 200 entries, aggregation scans at most 5000 entries, and responses stay under roughly 1 MB. Lower these values to further protect latency, Cloud Logging API quota, and model context.
- These caps are not a cost guarantee. Log ingestion, retention, routing, and Log Analytics costs depend on your Google Cloud configuration; review [Cloud Logging pricing](https://cloud.google.com/logging/pricing) and [quotas and limits](https://cloud.google.com/logging/quotas) before deploying.
- Use the narrowest possible project, time range, service name, Trace ID, severity, and resource types. Broad full-text searches can be slow and consume more API quota.
- Logs may contain personal information, access tokens, or business secrets. Helios does not automatically identify every sensitive field; callers and downstream MCP clients must enforce data minimization, redaction, and access auditing.
- When server-side caps are hit, summaries and exception aggregation reflect a bounded sample, not an exact full statistic over the entire time range. Callers should check the returned truncation metadata.

## Known Limitations

- No real-time tailing, subscriptions, alert rule management, log writing, or deletion.
- Query scope currently accepts at most 20 project IDs; organization, folder, billing account, Log Bucket, and Log View resource names are not accepted.
- Stateless HTTP does not support cross-request sessions, resumable SSE, or server-initiated notifications.
- Trace queries rely on log entries properly populating the `trace` field; logs that merely mention a Trace ID in their text are not automatically treated as associated logs.
- Service name matching depends on supported resource labels or structured fields; when naming is inconsistent, narrow the query with `resourceTypes` and `searchText` instead — the current version does not accept arbitrary raw Logging filters.
- Exception fingerprints use heuristic normalization; dynamic IDs, line numbers, or wrapped exceptions may cause splits or merges.
- Cloud Logging entries may arrive delayed or out of order; results near the current time may be incomplete.

## Development Commands

```powershell
npm run check
npm test
npm run test:coverage
npm run build
npm run build:sea
npm run smoke:sea -- <path-to-sea-executable>
npm run smoke:adc
npm run smoke:mcp
npm run start:stdio
npm run start:http
```

`npm run smoke:adc` performs one read-only query against its default project using ADC, with a 5-minute window and at most 1 entry; the script outputs only the project ID and returned entry count — no log payloads, access tokens, or credentials. It requires the `logging.logEntries.list` permission.

After building, `npm run smoke:mcp` launches both the production STDIO build and a local temporary HTTP service, executing the same read-only query through each with a real MCP client; HTTP uses a random Bearer token that exists only within the child process. Output contains only the project, tool count, and returned entry count.

`npm run smoke:sea -- <path>` verifies the SEA executable's help output, version, STDIO/HTTP MCP initialization, tool listing, and health endpoints, and points ADC at a deliberately non-existent file to cover the Google client's controlled error path; it does not connect to Cloud Logging or read real logs.

## Branching and Releases

See [CONTRIBUTING.md](CONTRIBUTING.md) for branching, pull requests, commit format, and the release process. The project uses single-trunk GitHub Flow: `main` stays releasable, and features merge via short-lived branches and pull requests. After pushing a SemVer tag matching the `package.json` version (e.g. `v0.2.0`) to GitHub, the Release workflow re-validates, builds and smoke-tests each platform's SEA on native runners, generates checksums, and then creates the GitHub Release automatically.

See [docs/architecture.md](docs/architecture.md) for architecture, the security model, and the verification strategy.

## Official References

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP transport specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP authorization specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Cloud Logging documentation](https://cloud.google.com/logging/docs)
- [Cloud Logging query language](https://cloud.google.com/logging/docs/view/logging-query-language)
- [Google Cloud ADC](https://cloud.google.com/docs/authentication/application-default-credentials)
- [Cloud Logging Node.js API reference](https://cloud.google.com/nodejs/docs/reference/logging/latest)
- [Node.js single executable applications](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html)
