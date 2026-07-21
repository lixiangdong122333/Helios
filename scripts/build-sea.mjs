#!/usr/bin/env node

import { chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import postject from "postject";

const { build } = esbuild;
const { inject } = postject;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const outputDir = resolve(repositoryRoot, readOutputDirectory());
const target = getTarget();
const spdxLicenseCache = new Map();
const releaseVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

if (Number(process.versions.node.split(".")[0]) !== 24) {
  throw new Error(`SEA builds require Node.js 24.x; found ${process.version}.`);
}
if (typeof packageMetadata.version !== "string" || !releaseVersionPattern.test(packageMetadata.version)) {
  throw new Error("package.json must contain a SemVer version before building a SEA.");
}

const artifactName = `helios-cloud-logging-mcp-v${packageMetadata.version}-${target}`;
const artifactDir = join(outputDir, artifactName);
const workDir = join(outputDir, `.sea-work-${target}`);
const bundlePath = join(workDir, "bundle.cjs");
const metafilePath = join(workDir, "meta.json");
const blobPath = join(workDir, "sea-prep.blob");
const configPath = join(workDir, "sea-config.json");
const executableName = process.platform === "win32" ? "helios-cloud-logging-mcp.exe" : "helios-cloud-logging-mcp";
const executablePath = join(artifactDir, executableName);

await rm(artifactDir, { recursive: true, force: true });
await rm(workDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
await mkdir(workDir, { recursive: true });

const bundleResult = await build({
  entryPoints: [join(repositoryRoot, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  outfile: bundlePath,
  metafile: true,
  legalComments: "inline",
  logLevel: "info"
});
await writeFile(metafilePath, JSON.stringify(bundleResult.metafile), "utf8");
assertOnlyBuiltinExternals(bundleResult.metafile);

await writeFile(
  configPath,
  JSON.stringify({
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
  }, null, 2),
  "utf8"
);

await runNode(["--experimental-sea-config", configPath], workDir);
await copyFile(process.execPath, executablePath);
if (process.platform !== "win32") {
  await chmod(executablePath, 0o755);
}

if (process.platform === "darwin") {
  await tryRemoveMacSignature(executablePath);
}

await inject(executablePath, "NODE_SEA_BLOB", await readFile(blobPath), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {})
});

if (process.platform === "darwin") {
  await runCommand("codesign", ["--sign", "-", "--force", executablePath]);
}

if (process.platform !== "win32") {
  await chmod(executablePath, 0o755);
}

await copyFile(join(repositoryRoot, "README.md"), join(artifactDir, "README.md"));
await writeFile(join(artifactDir, "NODE-LICENSE.txt"), await fetchNodeLicense(), "utf8");
await writeFile(
  join(artifactDir, "THIRD_PARTY_NOTICES.txt"),
  await buildThirdPartyNotices(bundleResult.metafile),
  "utf8"
);

await rm(workDir, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ artifact: executablePath, target, version: packageMetadata.version })}\n`);

function readOutputDirectory() {
  const separator = process.argv.indexOf("--output-dir");
  if (separator === -1) return "release-assets";
  const value = process.argv[separator + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--output-dir requires a directory path.");
  }
  return value;
}

function getTarget() {
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
    const glibcVersion = process.report.getReport().header.glibcVersionRuntime;
    if (typeof glibcVersion !== "string" || glibcVersion.length === 0) {
      throw new Error("SEA builds require a glibc-based Linux distribution; musl/Alpine is unsupported.");
    }
    return `linux-${process.arch}-glibc`;
  }
  if (process.platform === "darwin" && process.arch === "arm64") return "macos-arm64";
  throw new Error(
    `Unsupported SEA target ${process.platform}-${process.arch}. ` +
    "Supported targets are windows-x64, linux-x64-glibc, linux-arm64-glibc, and macos-arm64."
  );
}

function assertOnlyBuiltinExternals(metafile) {
  const builtins = new Set([
    ...builtinModules,
    ...builtinModules.map(moduleName => `node:${moduleName}`)
  ]);
  const external = new Set();
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const imported of output.imports ?? []) {
      if (imported.external && !builtins.has(imported.path)) external.add(imported.path);
    }
  }
  if (external.size > 0) {
    throw new Error(`SEA bundle has non-builtin external imports: ${[...external].sort().join(", ")}`);
  }
}

async function runNode(arguments_, cwd) {
  await runCommand(process.execPath, arguments_, cwd);
}

async function runCommand(command, arguments_, cwd = repositoryRoot) {
  const { execFile } = await import("node:child_process");
  await new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(command, arguments_, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, error => {
      if (error === null) resolvePromise();
      else rejectPromise(error);
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  });
}

async function tryRemoveMacSignature(path) {
  try {
    await runCommand("codesign", ["--remove-signature", path]);
  } catch {
    process.stderr.write("codesign --remove-signature was not needed or was unavailable; continuing.\n");
  }
}

async function fetchNodeLicense() {
  const url = `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to fetch the Node.js license from ${url}: HTTP ${response.status}.`);
  }
  return `Node.js ${process.version}\nSource: ${url}\n\n${await response.text()}`;
}

async function buildThirdPartyNotices(metafile) {
  const packageRoots = new Set();
  for (const input of Object.keys(metafile.inputs ?? {})) {
    const absolutePath = resolve(repositoryRoot, input);
    const packageRoot = findPackageRoot(absolutePath);
    if (packageRoot !== undefined) packageRoots.add(packageRoot);
  }

  const notices = [
    "Helios Cloud Logging MCP - bundled third-party notices",
    "",
    "This file lists packages whose code is included in the SEA executable.",
    ""
  ];
  const sortedRoots = [...packageRoots].sort((left, right) => left.localeCompare(right));
  for (const packageRoot of sortedRoots) {
    const metadataPath = join(packageRoot, "package.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (typeof metadata.name !== "string" || typeof metadata.version !== "string") {
      throw new Error(`Invalid package metadata at ${metadataPath}.`);
    }
    const licenseFiles = (await readdir(packageRoot, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^(license|licence|copying|notice)(\..*)?$/i.test(entry.name))
      .map(entry => entry.name)
      .sort();
    notices.push(`${metadata.name ?? relative(repositoryRoot, packageRoot)}@${metadata.version ?? "unknown"}`);
    notices.push(`Declared license: ${formatLicense(metadata.license)}`);
    if (metadata.homepage !== undefined) notices.push(`Homepage: ${metadata.homepage}`);
    if (licenseFiles.length === 0) {
      const fallback = await fetchSpdxLicense(metadata);
      notices.push(`--- SPDX fallback: ${fallback.url} ---`);
      notices.push(fallback.text.trim());
    } else {
      for (const licenseFile of licenseFiles) {
        notices.push(`--- ${licenseFile} ---`);
        notices.push((await readFile(join(packageRoot, licenseFile), "utf8")).trim());
      }
    }
    notices.push("", "");
  }
  return `${notices.join("\n").trim()}\n`;
}

function findPackageRoot(inputPath) {
  const parts = inputPath.split(sep);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1 || parts[nodeModulesIndex + 1] === undefined) return undefined;
  const packageName = parts[nodeModulesIndex + 1];
  const packageEnd = packageName.startsWith("@") ? nodeModulesIndex + 3 : nodeModulesIndex + 2;
  if (parts.length < packageEnd) return undefined;
  return parts.slice(0, packageEnd).join(sep);
}

function formatLicense(license) {
  if (typeof license === "string") return license;
  if (license === null || license === undefined) return "not declared";
  return JSON.stringify(license);
}

async function fetchSpdxLicense(metadata) {
  const license = metadata.license;
  const supported = new Set(["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT"]);
  if (typeof license !== "string" || !supported.has(license)) {
    throw new Error(
      `${metadata.name ?? "Unknown package"}@${metadata.version ?? "unknown"} has no license file ` +
      `and its declared license cannot use the SPDX fallback: ${formatLicense(license)}`
    );
  }
  const url = `https://raw.githubusercontent.com/spdx/license-list-data/v3.28.0/text/${license}.txt`;
  if (!spdxLicenseCache.has(license)) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Unable to fetch the SPDX ${license} text from ${url}: HTTP ${response.status}.`);
    }
    spdxLicenseCache.set(license, await response.text());
  }
  const author = formatAuthor(metadata.author, metadata.name);
  const text = spdxLicenseCache.get(license)
    .replaceAll("<year>", "")
    .replace(/<copyright holders?>/gi, author)
    .replace(/<owner>/gi, author)
    .replace(/Copyright \(c\)\s{2,}/g, "Copyright (c) ");
  return { text, url };
}

function formatAuthor(author, packageName) {
  if (typeof author === "string" && author.trim().length > 0) return author.trim();
  if (author !== null && typeof author === "object") {
    const parts = [author.name, author.email].filter(value => typeof value === "string" && value.length > 0);
    if (parts.length > 0) return parts.join(" ");
  }
  return `${packageName ?? "package"} contributors`;
}
