import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { HeliosError } from "../src/errors.js";

describe("configuration security", () => {
  it("refuses Streamable HTTP without an explicit authentication mode", () => {
    expect(() =>
      loadConfig({
        argv: ["--transport", "http"],
        env: {}
      })
    ).toThrowError(HeliosError);
    expect(() =>
      loadConfig({
        argv: ["--transport", "http"],
        env: {}
      })
    ).toThrowError(
      "HTTP mode requires HELIOS_HTTP_AUTH_MODE=static or HELIOS_HTTP_AUTH_MODE=oidc."
    );
  });

  it("does not require HTTP credentials for stdio mode", () => {
    const config = loadConfig({ argv: ["--transport", "stdio"], env: {} });

    expect(config.transport).toBe("stdio");
    expect(config).not.toHaveProperty("http");
  });

  it("defaults Streamable HTTP to port 48080", () => {
    const config = loadConfig({
      argv: ["--transport", "http"],
      env: {
        HELIOS_HTTP_AUTH_MODE: "static",
        HELIOS_HTTP_STATIC_TOKENS_JSON: JSON.stringify({ operator: "a".repeat(40) })
      }
    });

    expect(config.http).toMatchObject({
      port: 48_080,
      publicUrl: "http://127.0.0.1:48080/mcp"
    });
  });

  it("validates configured projects before serving readiness", () => {
    expect(() => loadConfig({ argv: [], env: { HELIOS_DEFAULT_PROJECTS: "INVALID" } })).toThrow(
      "Invalid project ID"
    );
  });

  it("requires TLS for non-loopback public URLs and exact MCP paths", () => {
    const base = {
      HELIOS_HTTP_AUTH_MODE: "static",
      HELIOS_HTTP_STATIC_TOKENS_JSON: JSON.stringify({ operator: "a".repeat(40) })
    };
    expect(() => loadConfig({
      argv: ["--transport", "http"],
      env: { ...base, HELIOS_HTTP_PUBLIC_URL: "http://logs.example.com/mcp" }
    })).toThrow("must be HTTPS");
    expect(() => loadConfig({
      argv: ["--transport", "http"],
      env: { ...base, HELIOS_HTTP_PUBLIC_URL: "https://logs.example.com/other" }
    })).toThrow("same path");
  });
});
