import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { afterEach, describe, expect, it } from "vitest";
import { createTokenVerifier } from "../src/auth/token-verifier.js";

let jwksServer: Server | undefined;

afterEach(async () => {
  if (jwksServer !== undefined) {
    await new Promise<void>((resolve, reject) => jwksServer!.close(error => error === undefined ? resolve() : reject(error)));
    jwksServer = undefined;
  }
});

describe("token verifier", () => {
  it("maps a static bearer token to a principal", async () => {
    const verifier = createTokenVerifier(
      { mode: "static", tokens: { operator: "a".repeat(40) } },
      "https://helios.example/mcp"
    );
    await expect(verifier.verifyAccessToken("a".repeat(40))).resolves.toMatchObject({
      clientId: "operator",
      scopes: ["logs.read"]
    });
    await expect(verifier.verifyAccessToken("b".repeat(40))).rejects.toThrow("Invalid bearer token");
  });

  it("verifies OIDC signature, issuer, audience, expiry, and scopes through JWKS", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    Object.assign(jwk, { kid: "test-key", alg: "RS256", use: "sig" });
    jwksServer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve, reject) => {
      jwksServer!.listen(0, "127.0.0.1", resolve);
      jwksServer!.once("error", reject);
    });
    const address = jwksServer.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP address");
    const issuer = "https://issuer.example/";
    const audience = "https://helios.example/mcp";
    const verifier = createTokenVerifier(
      {
        mode: "oidc",
        issuer,
        audience,
        jwksUri: `http://127.0.0.1:${address.port}/jwks`,
        algorithms: ["RS256"],
        requiredScopes: ["logs.read"]
      },
      audience
    );
    const token = await new SignJWT({ scope: "logs.read logs.aggregate" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("operator@example.com")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifier.verifyAccessToken(token)).resolves.toMatchObject({
      clientId: "https://issuer.example/#operator@example.com",
      scopes: ["logs.read", "logs.aggregate"]
    });

    const wrongAudience = await new SignJWT({ scope: "logs.read" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("https://other.example/mcp")
      .setSubject("operator@example.com")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifier.verifyAccessToken(wrongAudience)).rejects.toBeInstanceOf(InvalidTokenError);

    const disallowedAlgorithm = await new SignJWT({ scope: "logs.read" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("operator@example.com")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("a-secret-that-is-long-enough-for-testing"));
    await expect(verifier.verifyAccessToken(disallowedAlgorithm)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});
