import { Logging } from "@google-cloud/logging";

async function main(): Promise<void> {
  const logging = new Logging();
  const projectId = await logging.auth.getProjectId();
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 5 * 60_000);
  const [entries] = await logging.getEntries({
    autoPaginate: false,
    resourceNames: [`projects/${projectId}`],
    filter: `timestamp >= ${JSON.stringify(startTime.toISOString())}\nAND timestamp < ${JSON.stringify(endTime.toISOString())}`,
    orderBy: "timestamp desc",
    pageSize: 1,
    gaxOptions: { timeout: 10_000 }
  });
  process.stdout.write(`${JSON.stringify({ projectId, returnedEntries: entries.length })}\n`);
}

main().catch(error => {
  process.stderr.write(
    `${JSON.stringify({
      status: "failed",
      message: error instanceof Error ? error.message : String(error)
    })}\n`
  );
  process.exitCode = 1;
});
