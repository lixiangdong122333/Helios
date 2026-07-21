import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HELIOS_VERSION } from "../src/version.js";

describe("release version", () => {
  it("keeps the MCP server version aligned with package.json", () => {
    const packageMetadata = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      version?: unknown;
    };
    expect(packageMetadata.version).toBe(HELIOS_VERSION);
  });
});
