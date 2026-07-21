export const severityValues = [
  "DEFAULT",
  "DEBUG",
  "INFO",
  "NOTICE",
  "WARNING",
  "ERROR",
  "CRITICAL",
  "ALERT",
  "EMERGENCY"
] as const;

export type LogSeverity = (typeof severityValues)[number];
export type LogOrder = "asc" | "desc";
export type ServicePlatform = "auto" | "cloud_run" | "gke" | "app_engine" | "generic";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ServiceSelector {
  name: string;
  platform?: ServicePlatform;
  namespace?: string;
  cluster?: string;
  location?: string;
}

export interface BaseQueryInput {
  projectIds?: string[];
  startTime?: string;
  endTime?: string;
  lookbackMinutes?: number;
  traceId?: string;
  service?: ServiceSelector;
  minSeverity?: LogSeverity;
  resourceTypes?: string[];
  searchText?: string;
}

export interface QueryLogsInput extends BaseQueryInput {
  limit?: number;
  order?: LogOrder;
  pageToken?: string;
  includePayload?: boolean;
}

export interface GetTraceLogsInput extends Omit<BaseQueryInput, "traceId"> {
  traceId: string;
  limit?: number;
  order?: LogOrder;
  pageToken?: string;
  includePayload?: boolean;
}

export interface ScanLogsInput extends BaseQueryInput {
  scanLimit?: number;
}

export interface AggregateExceptionsInput extends ScanLogsInput {
  includeNonErrorSeverity?: boolean;
  groupLimit?: number;
  samplesPerGroup?: number;
}

export interface SummarizeLogsInput extends ScanLogsInput {
  topServices?: number;
}

export interface TimeRange {
  startTime: string;
  endTime: string;
}

export interface RawLogEntry {
  metadata: Record<string, unknown>;
  data: unknown;
}

export interface ListLogEntriesRequest {
  projectIds: string[];
  filter: string;
  order: LogOrder;
  pageSize: number;
  pageToken?: string;
  timeoutMs: number;
}

export interface ListLogEntriesPage {
  entries: RawLogEntry[];
  nextPageToken?: string;
}

export interface LogRepository {
  getDefaultProjectId(): Promise<string>;
  listEntries(request: ListLogEntriesRequest): Promise<ListLogEntriesPage>;
  close?(): Promise<void>;
}

export interface NormalizedLogEntry {
  timestamp: string | null;
  receiveTimestamp: string | null;
  severity: string;
  insertId?: string;
  logName?: string;
  resource: {
    type?: string;
    labels: Record<string, string>;
  };
  labels: Record<string, string>;
  trace?: string;
  spanId?: string;
  traceSampled?: boolean;
  errorGroupIds?: string[];
  exception?: {
    type?: string;
    stack?: string;
  };
  service?: string;
  message?: string;
  httpRequest?: JsonValue;
  sourceLocation?: JsonValue;
  payload?: JsonValue;
  payloadOmitted?: boolean;
  entryTruncated?: boolean;
}

export interface QueryMetadata {
  projects: string[];
  timeRange: TimeRange;
  filter: string;
  returnedEntries: number;
  responseTruncated: boolean;
  droppedEntries: number;
  paginationInvalidated?: boolean;
  nextPageToken?: string;
}

export interface QueryLogsResult {
  metadata: QueryMetadata;
  entries: NormalizedLogEntry[];
}
