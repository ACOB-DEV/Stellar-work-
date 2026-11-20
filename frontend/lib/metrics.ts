/**
 * Minimal in-process Prometheus registry (server side only).
 *
 * Browsers POST samples to /api/metrics; Prometheus scrapes the same route with
 * GET. Values live in module scope, so each Next.js server instance exposes its
 * own counters — scrape every replica and aggregate in PromQL.
 */

export const WEB_VITALS = ["lcp", "inp", "fcp", "ttfb"] as const;
export type WebVitalName = (typeof WEB_VITALS)[number];

export type TxOutcome = "success" | "error";

/** Cap on distinct label combinations per metric, so untrusted labels can't grow memory without bound. */
const MAX_SERIES_PER_METRIC = 500;

/** Realistic ceiling for finite metric observations to prevent aggregate sum overflow. */
const MAX_METRIC_VALUE = 1e9;

/** Session inactivity window for concurrent visitor estimation (1 minute). */
export const SESSION_INACTIVITY_TTL_MS = 60_000;

const WEB_VITAL_BUCKETS_MS = [50, 100, 200, 400, 800, 1600, 2500, 4000, 6000, 10000];
const CLS_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1];
const TX_DURATION_BUCKETS_MS = [250, 500, 1000, 2500, 5000, 10000, 20000, 40000];

type Labels = Record<string, string>;

type CounterMetric = {
  kind: "counter";
  help: string;
  series: Map<string, { labels: Labels; value: number }>;
};

type GaugeMetric = {
  kind: "gauge";
  help: string;
  series: Map<string, { labels: Labels; value: number }>;
};

type HistogramMetric = {
  kind: "histogram";
  help: string;
  buckets: number[];
  series: Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>;
};

type Metric = CounterMetric | HistogramMetric | GaugeMetric;

const registry = new Map<string, Metric>();

function counter(name: string, help: string): CounterMetric {
  const existing = registry.get(name);
  if (existing) return existing as CounterMetric;
  const metric: CounterMetric = { kind: "counter", help, series: new Map() };
  registry.set(name, metric);
  return metric;
}

function gauge(name: string, help: string): GaugeMetric {
  const existing = registry.get(name);
  if (existing) return existing as GaugeMetric;
  const metric: GaugeMetric = { kind: "gauge", help, series: new Map() };
  registry.set(name, metric);
  return metric;
}

function setGauge(metric: GaugeMetric, labels: Labels, value: number) {
  const key = seriesKey(labels);
  metric.series.set(key, { labels, value });
}

function histogram(name: string, help: string, buckets: number[]): HistogramMetric {
  const existing = registry.get(name);
  if (existing) return existing as HistogramMetric;
  const metric: HistogramMetric = { kind: "histogram", help, buckets, series: new Map() };
  registry.set(name, metric);
  return metric;
}

function seriesKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(",");
}

function incCounter(metric: CounterMetric, labels: Labels, delta = 1) {
  const key = seriesKey(labels);
  const existing = metric.series.get(key);
  if (existing) {
    existing.value += delta;
    return;
  }
  if (metric.series.size >= MAX_SERIES_PER_METRIC) return;
  metric.series.set(key, { labels, value: delta });
}

function observe(metric: HistogramMetric, labels: Labels, value: number) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_METRIC_VALUE
  ) {
    return;
  }
  const key = seriesKey(labels);
  let entry = metric.series.get(key);
  if (!entry) {
    if (metric.series.size >= MAX_SERIES_PER_METRIC) return;
    entry = { labels, counts: new Array(metric.buckets.length).fill(0), sum: 0, count: 0 };
    metric.series.set(key, entry);
  }
  if (!Number.isFinite(entry.sum + value)) {
    return;
  }
  entry.sum += value;
  entry.count += 1;
  for (let i = 0; i < metric.buckets.length; i += 1) {
    if (value <= metric.buckets[i]) entry.counts[i] += 1;
  }
}

// ── metric definitions ──────────────────────────────────────────────────────

const webVital = histogram(
  "stellarwork_web_vital_milliseconds",
  "Core Web Vitals reported by browsers, in milliseconds.",
  WEB_VITAL_BUCKETS_MS,
);

const layoutShift = histogram(
  "stellarwork_layout_shift_score",
  "Cumulative Layout Shift reported by browsers (unitless).",
  CLS_BUCKETS,
);

const pageViews = counter("stellarwork_page_views_total", "Page views reported by browsers.");

const contractTx = counter(
  "stellarwork_contract_tx_total",
  "Soroban contract invocations by method and outcome.",
);

const contractTxDuration = histogram(
  "stellarwork_contract_tx_duration_milliseconds",
  "End-to-end Soroban contract invocation latency, in milliseconds.",
  TX_DURATION_BUCKETS_MS,
);

const rpcErrors = counter(
  "stellarwork_rpc_errors_total",
  "Stellar RPC failures grouped by coarse error kind.",
);

const clientErrors = counter(
  "stellarwork_client_errors_total",
  "Unhandled frontend errors reported by browsers.",
);

const httpRequests = counter(
  "stellarwork_http_requests_total",
  "HTTP requests handled by the Next.js server, by route and status code.",
);

const httpRequestDuration = histogram(
  "stellarwork_http_request_duration_milliseconds",
  "HTTP request processing latency in milliseconds, by route.",
  [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
);

const httpErrors = counter(
  "stellarwork_http_errors_total",
  "HTTP responses with 4xx or 5xx status codes, by route.",
);

const activeSessions = counter(
  "stellarwork_active_sessions_total",
  "Lifetime beacon requests received (proxy for session ping activity).",
);

const sessionPingsTotal = counter(
  "stellarwork_session_pings_total",
  "Total number of session beacon pings received.",
);

const activeSessionsGauge = gauge(
  "stellarwork_active_sessions",
  "Estimated concurrent active visitor sessions within the inactivity window.",
);

const jobViews = counter(
  "stellarwork_job_views_total",
  "Job detail page views reported by browsers.",
);

const fontTiming = histogram(
  "stellarwork_font_load_milliseconds",
  "Time from navigation start to font woff2 response end, in milliseconds.",
  [0, 50, 100, 200, 400, 800, 1600, 3000, 6000],
);

const fontCacheHits = counter(
  "stellarwork_font_cache_hits_total",
  "Font woff2 requests served from browser cache (transferSize === 0).",
);

const fontCacheMisses = counter(
  "stellarwork_font_cache_misses_total",
  "Font woff2 requests that required a network fetch.",
);

// Active session tracking state
const activeSessionMap = new Map<string, number>();

// ── recording API ───────────────────────────────────────────────────────────

/** Keeps label values low-cardinality and safe to render in the exposition format. */
export function sanitizeLabel(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[^a-zA-Z0-9_\-./:[\]]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Normalizes dynamic URL paths to static route templates to prevent label cardinality explosion.
 * E.g. /job/123 -> /job/[id], /profile/GB... -> /profile/[id].
 */
export function normalizePath(path: unknown, fallback = "/"): string {
  if (typeof path !== "string" || !path.trim()) return fallback;
  let p = path.split("?")[0].split("#")[0].trim();
  if (!p.startsWith("/")) p = `/${p}`;

  // Canonicalize dynamic segments
  p = p.replace(/\/job\/[^/]+/g, "/job/[id]");
  p = p.replace(/\/profile\/[^/]+/g, "/profile/[id]");

  return sanitizeLabel(p, fallback);
}

export function recordWebVital(metric: WebVitalName, valueMs: number, path: string) {
  observe(webVital, { metric, path: normalizePath(path) }, valueMs);
}

export function recordLayoutShift(score: number, path: string) {
  observe(layoutShift, { path: normalizePath(path) }, score);
}

export function recordPageView(path: string) {
  incCounter(pageViews, { path: normalizePath(path) });
}

export function recordContractTx(
  method: string,
  outcome: TxOutcome,
  network: string,
  durationMs?: number,
) {
  const labels = {
    method: sanitizeLabel(method),
    network: sanitizeLabel(network),
  };
  incCounter(contractTx, { ...labels, outcome });
  if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
    observe(contractTxDuration, labels, durationMs);
  }
}

export function recordRpcError(kind: string, network: string) {
  incCounter(rpcErrors, { kind: sanitizeLabel(kind), network: sanitizeLabel(network) });
}

export function recordClientError(kind: string, path: string) {
  incCounter(clientErrors, { kind: sanitizeLabel(kind), path: normalizePath(path) });
}

export function recordHttpRequest(route: string, statusCode: number, durationMs: number) {
  const routeLabel = normalizePath(route);
  const statusLabel = String(statusCode);
  incCounter(httpRequests, { route: routeLabel, status: statusLabel });
  observe(httpRequestDuration, { route: routeLabel }, durationMs);
  if (statusCode >= 400) {
    incCounter(httpErrors, { route: routeLabel });
  }
}

export function pruneSessions(now = Date.now()) {
  for (const [id, lastSeen] of activeSessionMap.entries()) {
    if (now - lastSeen > SESSION_INACTIVITY_TTL_MS) {
      activeSessionMap.delete(id);
    }
  }
  setGauge(activeSessionsGauge, {}, activeSessionMap.size);
}

export function recordActiveSession(sessionId?: string, now = Date.now()) {
  incCounter(sessionPingsTotal, {});
  incCounter(activeSessions, { type: "beacon" });

  const id =
    sessionId && typeof sessionId === "string" && sessionId.trim()
      ? sessionId.trim().slice(0, 64)
      : "anonymous-session";

  activeSessionMap.set(id, now);
  pruneSessions(now);
}

export function recordJobView(jobId: string) {
  incCounter(jobViews, { job_id: sanitizeLabel(jobId) });
}

export function recordFontTiming(
  name: string,
  durationMs: number,
  cached: boolean,
  path: string,
) {
  const labels = {
    font: sanitizeLabel(name),
    path: normalizePath(path),
  };
  observe(fontTiming, labels, durationMs);
  if (cached) {
    incCounter(fontCacheHits, { font: sanitizeLabel(name) });
  } else {
    incCounter(fontCacheMisses, { font: sanitizeLabel(name) });
  }
}

/** Test hook — drops every recorded sample. */
export function resetMetrics() {
  for (const metric of registry.values()) metric.series.clear();
  activeSessionMap.clear();
  setGauge(activeSessionsGauge, {}, 0);
}

// ── exposition ──────────────────────────────────────────────────────────────

function renderLabels(labels: Labels, extra?: Labels): string {
  const merged = { ...labels, ...extra };
  const pairs = Object.keys(merged)
    .sort()
    .map((key) => `${key}="${merged[key]}"`);
  return pairs.length > 0 ? `{${pairs.join(",")}}` : "";
}

/** Renders the whole registry in the Prometheus text exposition format (v0.0.4). */
export function renderMetrics(): string {
  const lines: string[] = [];

  for (const [name, metric] of registry) {
    lines.push(`# HELP ${name} ${metric.help}`);
    lines.push(`# TYPE ${name} ${metric.kind}`);

    if (metric.kind === "counter" || metric.kind === "gauge") {
      for (const { labels, value } of metric.series.values()) {
        lines.push(`${name}${renderLabels(labels)} ${value}`);
      }
      continue;
    }

    for (const entry of metric.series.values()) {
      metric.buckets.forEach((bucket, index) => {
        lines.push(
          `${name}_bucket${renderLabels(entry.labels, { le: String(bucket) })} ${entry.counts[index]}`,
        );
      });
      lines.push(`${name}_bucket${renderLabels(entry.labels, { le: "+Inf" })} ${entry.count}`);
      lines.push(`${name}_sum${renderLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${name}_count${renderLabels(entry.labels)} ${entry.count}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
