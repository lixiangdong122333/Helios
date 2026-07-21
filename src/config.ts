import { HeliosError } from "./errors.js";
import type { LogLevel } from "./logger.js";

export type TransportMode = "stdio" | "http";

export interface LoggingConfig {
  defaultProjects: string[];
  maxQueryWindowMs: number;
  maxQueryEntries: number;
  maxScanEntries: number;
  maxResponseBytes: number;
  maxEntryBytes: number;
  queryTimeoutMs: number;
  redactedKeys: string[];
}

export interface InvocationLimitsConfig {
  maxConcurrentQueries: number;
  requestsPerWindow: number;
  windowMs: number;
}

export interface StaticAuthConfig {
  mode: "static";
  tokens: Record<string, string>;
}

export interface OidcAuthConfig {
  mode: "oidc";
  issuer: string;
  audience: string;
  jwksUri: string;
  algorithms: string[];
  requiredScopes: string[];
}

export type HttpAuthConfig = StaticAuthConfig | OidcAuthConfig;

export interface HttpConfig {
  host: string;
  port: number;
  path: string;
  publicUrl: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  preAuthRateLimitRequests: number;
  preAuthRateLimitWindowMs: number;
  auth: HttpAuthConfig;
}

export interface AppConfig {
  transport: TransportMode;
  logLevel: LogLevel;
  logging: LoggingConfig;
  limits: InvocationLimitsConfig;
  http?: HttpConfig;
}

export interface LoadConfigOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  const transport = parseTransport(argv, env.HELIOS_TRANSPORT);
  const defaultProjects = splitList(env.HELIOS_DEFAULT_PROJECTS);
  validateDefaultProjects(defaultProjects);
  const maxResponseBytes = parsePositiveInteger(env.HELIOS_MAX_RESPONSE_BYTES, 1_000_000, "HELIOS_MAX_RESPONSE_BYTES", 10_000_000);
  const maxEntryBytes = parsePositiveInteger(env.HELIOS_MAX_ENTRY_BYTES, 16_000, "HELIOS_MAX_ENTRY_BYTES", 1_000_000);
  if (maxResponseBytes < 4_096) {
    throw new HeliosError("INVALID_ARGUMENT", "HELIOS_MAX_RESPONSE_BYTES must be at least 4096.");
  }
  if (maxEntryBytes < 512) {
    throw new HeliosError("INVALID_ARGUMENT", "HELIOS_MAX_ENTRY_BYTES must be at least 512.");
  }
  const logging: LoggingConfig = {
    defaultProjects,
    maxQueryWindowMs: parsePositiveNumber(env.HELIOS_MAX_QUERY_WINDOW_HOURS, 168, "HELIOS_MAX_QUERY_WINDOW_HOURS") * 3_600_000,
    maxQueryEntries: parsePositiveInteger(env.HELIOS_MAX_QUERY_ENTRIES, 200, "HELIOS_MAX_QUERY_ENTRIES", 1_000),
    maxScanEntries: parsePositiveInteger(env.HELIOS_MAX_SCAN_ENTRIES, 5_000, "HELIOS_MAX_SCAN_ENTRIES", 50_000),
    maxResponseBytes,
    maxEntryBytes,
    queryTimeoutMs: parsePositiveInteger(env.HELIOS_QUERY_TIMEOUT_MS, 30_000, "HELIOS_QUERY_TIMEOUT_MS", 300_000),
    redactedKeys: splitList(env.HELIOS_REDACT_KEYS)
  };

  const config: AppConfig = {
    transport,
    logLevel: parseLogLevel(env.HELIOS_LOG_LEVEL),
    logging,
    limits: {
      maxConcurrentQueries: parsePositiveInteger(
        env.HELIOS_MAX_CONCURRENT_QUERIES,
        4,
        "HELIOS_MAX_CONCURRENT_QUERIES",
        1_000
      ),
      requestsPerWindow: parsePositiveInteger(
        env.HELIOS_RATE_LIMIT_REQUESTS,
        60,
        "HELIOS_RATE_LIMIT_REQUESTS",
        100_000
      ),
      windowMs: parsePositiveNumber(
        env.HELIOS_RATE_LIMIT_WINDOW_SECONDS,
        60,
        "HELIOS_RATE_LIMIT_WINDOW_SECONDS"
      ) * 1_000
    }
  };
  if (transport === "http") {
    config.http = loadHttpConfig(env);
  }
  return config;
}

export function requestedHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

export const helpText = `Helios Cloud Logging MCP

Usage:
  helios-cloud-logging-mcp [--transport stdio|http]

Options:
  --transport <mode>  Override HELIOS_TRANSPORT (default: stdio)
  --help, -h          Show this help
`;

function parseTransport(argv: string[], envValue: string | undefined): TransportMode {
  let value = envValue ?? "stdio";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--transport") {
      value = argv[index + 1] ?? "";
      index += 1;
    } else if (argument?.startsWith("--transport=")) {
      value = argument.slice("--transport=".length);
    } else if (argument !== "--help" && argument !== "-h") {
      throw new HeliosError("INVALID_ARGUMENT", `Unknown command-line argument: ${argument}`);
    }
  }
  if (value !== "stdio" && value !== "http") {
    throw new HeliosError("INVALID_ARGUMENT", "Transport must be stdio or http.");
  }
  return value;
}

function loadHttpConfig(env: NodeJS.ProcessEnv): HttpConfig {
  const host = env.HELIOS_HTTP_HOST ?? "127.0.0.1";
  const port = parsePositiveInteger(env.HELIOS_HTTP_PORT, 48_080, "HELIOS_HTTP_PORT", 65_535);
  const path = normalizeHttpPath(env.HELIOS_HTTP_PATH ?? "/mcp");
  const isWildcardHost = host === "0.0.0.0" || host === "::";
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const publicUrl = env.HELIOS_HTTP_PUBLIC_URL ?? `http://${urlHost}:${port}${path}`;
  const publicResourceUrl = validateSecureUrl(publicUrl, "HELIOS_HTTP_PUBLIC_URL");
  if (
    publicResourceUrl.username !== "" ||
    publicResourceUrl.password !== "" ||
    publicResourceUrl.search !== "" ||
    publicResourceUrl.hash !== "" ||
    normalizeHttpPath(publicResourceUrl.pathname) !== path
  ) {
    throw new HeliosError(
      "INVALID_ARGUMENT",
      "HELIOS_HTTP_PUBLIC_URL must have the same path as HELIOS_HTTP_PATH and contain no credentials, query, or fragment."
    );
  }
  if (isWildcardHost && env.HELIOS_HTTP_PUBLIC_URL === undefined) {
    throw new HeliosError(
      "INVALID_ARGUMENT",
      "HELIOS_HTTP_PUBLIC_URL is required when binding Streamable HTTP to all interfaces."
    );
  }

  const allowedHosts = splitList(env.HELIOS_HTTP_ALLOWED_HOSTS);
  if (isWildcardHost && allowedHosts.length === 0) {
    throw new HeliosError(
      "INVALID_ARGUMENT",
      "HELIOS_HTTP_ALLOWED_HOSTS is required when binding Streamable HTTP to all interfaces."
    );
  }

  return {
    host,
    port,
    path,
    publicUrl,
    allowedHosts,
    allowedOrigins: splitList(env.HELIOS_HTTP_ALLOWED_ORIGINS),
    preAuthRateLimitRequests: parsePositiveInteger(
      env.HELIOS_HTTP_PREAUTH_RATE_LIMIT_REQUESTS,
      120,
      "HELIOS_HTTP_PREAUTH_RATE_LIMIT_REQUESTS",
      100_000
    ),
    preAuthRateLimitWindowMs: parsePositiveNumber(
      env.HELIOS_HTTP_PREAUTH_RATE_LIMIT_WINDOW_SECONDS,
      60,
      "HELIOS_HTTP_PREAUTH_RATE_LIMIT_WINDOW_SECONDS"
    ) * 1_000,
    auth: loadHttpAuth(env, publicUrl)
  };
}

function loadHttpAuth(env: NodeJS.ProcessEnv, publicUrl: string): HttpAuthConfig {
  const mode = env.HELIOS_HTTP_AUTH_MODE;
  if (mode === "static") {
    const rawTokens = required(env.HELIOS_HTTP_STATIC_TOKENS_JSON, "HELIOS_HTTP_STATIC_TOKENS_JSON");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawTokens);
    } catch (error) {
      throw new HeliosError("INVALID_ARGUMENT", "HELIOS_HTTP_STATIC_TOKENS_JSON must be valid JSON.", undefined, { cause: error });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HeliosError("INVALID_ARGUMENT", "HELIOS_HTTP_STATIC_TOKENS_JSON must map principal names to tokens.");
    }
    const tokens: Record<string, string> = {};
    for (const [principal, token] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9._@-]{1,128}$/.test(principal) || typeof token !== "string" || token.length < 32) {
        throw new HeliosError(
          "INVALID_ARGUMENT",
          "Each static token needs a safe principal name and at least 32 characters."
        );
      }
      if (token.includes("replace-with")) {
        throw new HeliosError("INVALID_ARGUMENT", "Replace the example HTTP bearer token before starting Helios.");
      }
      tokens[principal] = token;
    }
    if (Object.keys(tokens).length === 0) {
      throw new HeliosError("INVALID_ARGUMENT", "At least one static HTTP bearer token is required.");
    }
    if (new Set(Object.values(tokens)).size !== Object.keys(tokens).length) {
      throw new HeliosError("INVALID_ARGUMENT", "Static HTTP bearer tokens must be unique per principal.");
    }
    return { mode, tokens };
  }
  if (mode === "oidc") {
    const issuer = required(env.HELIOS_OIDC_ISSUER, "HELIOS_OIDC_ISSUER");
    const audience = required(env.HELIOS_OIDC_AUDIENCE, "HELIOS_OIDC_AUDIENCE");
    const jwksUri = required(env.HELIOS_OIDC_JWKS_URI, "HELIOS_OIDC_JWKS_URI");
    const issuerUrl = validateSecureUrl(issuer, "HELIOS_OIDC_ISSUER");
    const jwksUrl = validateSecureUrl(jwksUri, "HELIOS_OIDC_JWKS_URI");
    if (
      issuerUrl.username !== "" || issuerUrl.password !== "" || issuerUrl.search !== "" || issuerUrl.hash !== ""
    ) {
      throw new HeliosError("INVALID_ARGUMENT", "HELIOS_OIDC_ISSUER must not contain credentials, query, or fragment.");
    }
    if (jwksUrl.username !== "" || jwksUrl.password !== "" || jwksUrl.hash !== "") {
      throw new HeliosError("INVALID_ARGUMENT", "HELIOS_OIDC_JWKS_URI must not contain credentials or a fragment.");
    }
    if (audience !== publicUrl) {
      throw new HeliosError(
        "INVALID_ARGUMENT",
        "HELIOS_OIDC_AUDIENCE must exactly match HELIOS_HTTP_PUBLIC_URL."
      );
    }
    const algorithms = splitList(env.HELIOS_OIDC_ALGORITHMS ?? "RS256,ES256");
    const allowedAlgorithms = new Set([
      "RS256", "RS384", "RS512",
      "PS256", "PS384", "PS512",
      "ES256", "ES384", "ES512",
      "EdDSA"
    ]);
    if (algorithms.length === 0 || algorithms.some(algorithm => !allowedAlgorithms.has(algorithm))) {
      throw new HeliosError(
        "INVALID_ARGUMENT",
        "HELIOS_OIDC_ALGORITHMS must contain only asymmetric RS*, PS*, ES*, or EdDSA algorithms."
      );
    }
    return {
      mode,
      issuer,
      audience,
      jwksUri,
      algorithms,
      requiredScopes: splitList(env.HELIOS_OIDC_REQUIRED_SCOPES)
    };
  }
  throw new HeliosError(
    "INVALID_ARGUMENT",
    "HTTP mode requires HELIOS_HTTP_AUTH_MODE=static or HELIOS_HTTP_AUTH_MODE=oidc."
  );
}

function parsePositiveNumber(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HeliosError("INVALID_ARGUMENT", `${name} must be a positive number.`);
  }
  return parsed;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum: number
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new HeliosError("INVALID_ARGUMENT", `${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const candidate = value ?? "info";
  if (candidate !== "debug" && candidate !== "info" && candidate !== "warn" && candidate !== "error") {
    throw new HeliosError("INVALID_ARGUMENT", "HELIOS_LOG_LEVEL must be debug, info, warn, or error.");
  }
  return candidate;
}

function normalizeHttpPath(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#") || value.length > 128) {
    throw new HeliosError("INVALID_ARGUMENT", "HELIOS_HTTP_PATH must be an absolute URL path.");
  }
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

function splitList(value: string | undefined): string[] {
  return value === undefined
    ? []
    : [...new Set(value.split(",").map(item => item.trim()).filter(item => item.length > 0))];
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new HeliosError("INVALID_ARGUMENT", `${name} is required.`);
  }
  return value.trim();
}

function validateSecureUrl(value: string, name: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported scheme");
    }
    if (url.protocol !== "https:" && !isLoopbackHostname(url.hostname)) {
      throw new Error("TLS is required for non-loopback URLs");
    }
    return url;
  } catch (error) {
    throw new HeliosError(
      "INVALID_ARGUMENT",
      `${name} must be HTTPS, except for an explicit loopback URL.`,
      undefined,
      { cause: error }
    );
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function validateDefaultProjects(projectIds: string[]): void {
  if (projectIds.length > 20) {
    throw new HeliosError("INVALID_ARGUMENT", "HELIOS_DEFAULT_PROJECTS supports at most 20 project IDs.");
  }
  for (const projectId of projectIds) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
      throw new HeliosError("INVALID_ARGUMENT", `Invalid project ID in HELIOS_DEFAULT_PROJECTS: ${projectId}`);
    }
  }
}
