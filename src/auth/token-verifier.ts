import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { HttpAuthConfig } from "../config.js";

export function createTokenVerifier(auth: HttpAuthConfig, resourceUrl: string): OAuthTokenVerifier {
  return auth.mode === "static"
    ? createStaticTokenVerifier(auth.tokens, resourceUrl)
    : createOidcTokenVerifier(auth, resourceUrl);
}

export function requiredScopes(auth: HttpAuthConfig): string[] {
  return auth.mode === "oidc" ? auth.requiredScopes : [];
}

export function protectedResourceMetadata(
  auth: HttpAuthConfig,
  resourceUrl: string
): Record<string, unknown> {
  return {
    resource: resourceUrl,
    ...(auth.mode === "oidc" ? { authorization_servers: [auth.issuer] } : {}),
    scopes_supported: auth.mode === "oidc" ? auth.requiredScopes : ["logs.read"],
    bearer_methods_supported: ["header"],
    resource_name: "Helios Cloud Logging MCP"
  };
}

function createStaticTokenVerifier(tokens: Record<string, string>, resourceUrl: string): OAuthTokenVerifier {
  const digests = Object.entries(tokens).map(([principal, token]) => ({
    principal,
    digest: tokenDigest(token)
  }));

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const candidate = tokenDigest(token);
      let principal: string | undefined;
      for (const configured of digests) {
        if (timingSafeEqual(candidate, configured.digest)) {
          principal = configured.principal;
        }
      }
      if (principal !== undefined) {
        return {
          token,
          clientId: principal,
          scopes: ["logs.read"],
          // The MCP SDK's bearer middleware requires a numeric expiry. Static
          // deployment tokens are rotated by configuration, so use year 9999.
          expiresAt: 253_402_300_799,
          resource: new URL(resourceUrl)
        };
      }
      throw new InvalidTokenError("Invalid bearer token.");
    }
  };
}

function createOidcTokenVerifier(
  auth: Extract<HttpAuthConfig, { mode: "oidc" }>,
  resourceUrl: string
): OAuthTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(auth.jwksUri), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000
  });

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer: auth.issuer,
          audience: auth.audience,
          algorithms: auth.algorithms,
          clockTolerance: 5,
          requiredClaims: ["exp"]
        }));
      } catch (error) {
        if (isInvalidJwt(error)) {
          throw new InvalidTokenError("The bearer token is invalid or expired.");
        }
        throw error;
      }
      const clientId = getPrincipal(payload);
      if (clientId === undefined) {
        throw new InvalidTokenError("The token has no subject or client identifier.");
      }
      return {
        token,
        clientId,
        scopes: getScopes(payload),
        ...(payload.exp === undefined ? {} : { expiresAt: payload.exp }),
        resource: new URL(resourceUrl),
        extra: {
          issuer: payload.iss,
          subject: payload.sub
        }
      };
    }
  };
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function getPrincipal(payload: JWTPayload): string | undefined {
  if (typeof payload.sub === "string" && payload.sub.length > 0) {
    return `${payload.iss ?? "unknown-issuer"}#${payload.sub}`;
  }
  for (const claim of [payload.client_id, payload.azp]) {
    if (typeof claim === "string" && claim.length > 0) {
      return claim;
    }
  }
  return undefined;
}

function getScopes(payload: JWTPayload): string[] {
  const scope = payload.scope;
  const scp = payload.scp;
  if (typeof scope === "string") {
    return scope.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(scope)) {
    return scope.filter((item): item is string => typeof item === "string");
  }
  if (typeof scp === "string") {
    return scp.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(scp)) {
    return scp.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function isInvalidJwt(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") {
    return false;
  }
  return (
    error.code.startsWith("ERR_JWT_") ||
    error.code.startsWith("ERR_JWS_") ||
    error.code === "ERR_JOSE_ALG_NOT_ALLOWED" ||
    error.code === "ERR_JOSE_NOT_SUPPORTED" ||
    error.code === "ERR_JWK_INVALID" ||
    error.code === "ERR_JWKS_NO_MATCHING_KEY"
  );
}
