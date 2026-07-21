#!/usr/bin/env node
import { LogQueryService } from "./application/log-query-service.js";
import { helpText, loadConfig, requestedHelp } from "./config.js";
import { CloudLoggingRepository } from "./infra/cloud-logging-repository.js";
import { createLogger } from "./logger.js";
import { QueryInvocationLimiter } from "./limits.js";
import { createHeliosMcpServer } from "./mcp/create-server.js";
import { startHttpServer } from "./transports/http.js";
import { startStdioServer } from "./transports/stdio.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (requestedHelp(argv)) {
    process.stdout.write(helpText);
    return;
  }

  const config = loadConfig({ argv });
  const logger = createLogger(config.logLevel);
  const repository = new CloudLoggingRepository();
  const queryService = new LogQueryService(repository, config.logging);
  const invocationLimiter = new QueryInvocationLimiter(config.limits);
  const serverFactory = () => createHeliosMcpServer({ queryService, logger, invocationLimiter });

  if (config.transport === "stdio") {
    const handle = await startStdioServer(serverFactory());
    logger.info("helios_started", { transport: "stdio" });
    installShutdownHandlers(() => closeResourcesSequentially([handle.close, () => repository.close()]), logger);
    return;
  }

  if (config.http === undefined) {
    throw new Error("HTTP configuration was not loaded.");
  }
  const handle = await startHttpServer(config.http, serverFactory, logger);
  const address = handle.server.address();
  logger.info("helios_started", {
    transport: "http",
    host: config.http.host,
    port: address !== null && typeof address === "object"
      ? address.port
      : config.http.port,
    path: config.http.path,
    authMode: config.http.auth.mode
  });
  installShutdownHandlers(() => closeResourcesSequentially([handle.close, () => repository.close()]), logger);
}

function installShutdownHandlers(close: () => Promise<void>, logger: ReturnType<typeof createLogger>): void {
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      logger.error("helios_forced_stop", { signal });
      process.exit(1);
    }
    closing = true;
    logger.info("helios_stopping", { signal });
    const forceTimer = setTimeout(() => {
      logger.error("helios_shutdown_timed_out");
      process.exit(1);
    }, 15_000);
    forceTimer.unref();
    try {
      await close();
      clearTimeout(forceTimer);
      logger.info("helios_stopped");
    } catch (error) {
      clearTimeout(forceTimer);
      logger.error("helios_shutdown_failed", { error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function closeResourcesSequentially(closers: Array<() => Promise<void>>): Promise<void> {
  const failures: unknown[] = [];
  for (const close of closers) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more Helios resources failed to close.");
  }
}

main().catch(error => {
  const logger = createLogger("error");
  logger.error("helios_start_failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
