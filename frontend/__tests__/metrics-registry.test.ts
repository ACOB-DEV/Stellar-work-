import { beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_INACTIVITY_TTL_MS,
  normalizePath,
  pruneSessions,
  recordActiveSession,
  recordContractTx,
  recordLayoutShift,
  recordPageView,
  recordWebVital,
  renderMetrics,
  resetMetrics,
  sanitizeLabel,
} from "@/lib/metrics";

beforeEach(() => {
  resetMetrics();
});

describe("metrics registry", () => {
  it("renders counters in the Prometheus exposition format", () => {
    recordPageView("/dashboard");
    recordPageView("/dashboard");

    const output = renderMetrics();
    expect(output).toContain("# TYPE stellarwork_page_views_total counter");
    expect(output).toContain('stellarwork_page_views_total{path="/dashboard"} 2');
  });

  it("renders histogram buckets, sum and count", () => {
    recordWebVital("lcp", 150, "/");

    const output = renderMetrics();
    expect(output).toContain("# TYPE stellarwork_web_vital_milliseconds histogram");
    expect(output).toContain(
      'stellarwork_web_vital_milliseconds_bucket{le="100",metric="lcp",path="/"} 0',
    );
    expect(output).toContain(
      'stellarwork_web_vital_milliseconds_bucket{le="200",metric="lcp",path="/"} 1',
    );
    expect(output).toContain(
      'stellarwork_web_vital_milliseconds_bucket{le="+Inf",metric="lcp",path="/"} 1',
    );
    expect(output).toContain('stellarwork_web_vital_milliseconds_sum{metric="lcp",path="/"} 150');
    expect(output).toContain('stellarwork_web_vital_milliseconds_count{metric="lcp",path="/"} 1');
  });

  it("splits contract transactions by outcome and records latency", () => {
    recordContractTx("post_job", "success", "testnet", 1200);
    recordContractTx("post_job", "error", "testnet", 800);

    const output = renderMetrics();
    expect(output).toContain(
      'stellarwork_contract_tx_total{method="post_job",network="testnet",outcome="success"} 1',
    );
    expect(output).toContain(
      'stellarwork_contract_tx_total{method="post_job",network="testnet",outcome="error"} 1',
    );
    expect(output).toContain(
      'stellarwork_contract_tx_duration_milliseconds_count{method="post_job",network="testnet"} 2',
    );
  });

  it("tracks layout shift on its own unitless histogram", () => {
    recordLayoutShift(0.04, "/");

    const output = renderMetrics();
    expect(output).toContain('stellarwork_layout_shift_score_bucket{le="0.05",path="/"} 1');
    expect(output).toContain('stellarwork_layout_shift_score_bucket{le="0.01",path="/"} 0');
  });

  it("strips characters that would break the exposition format", () => {
    expect(sanitizeLabel('job"1\n')).toBe("job1");
    expect(sanitizeLabel("")).toBe("unknown");
    expect(sanitizeLabel(42)).toBe("unknown");
    expect(sanitizeLabel(undefined, "/")).toBe("/");
  });

  it("resets every series", () => {
    recordPageView("/");
    resetMetrics();
    expect(renderMetrics()).not.toContain("stellarwork_page_views_total{");
  });

  // ── BUG-77: Dynamic Route Normalization Tests ──────────────────────────────
  it("normalizes dynamic job and profile paths into template labels", () => {
    for (let id = 1; id <= 100; id++) {
      recordPageView(`/job/${id}`);
    }
    for (let i = 1; i <= 50; i++) {
      recordPageView(`/profile/GBZXN7PIRZGNMHGA728R46OHAZSEINQU2Y2355GY25WUVFYZQGASB5ES${i}`);
    }

    const output = renderMetrics();
    // All 100 job paths should collapse to exactly one series
    expect(output).toContain('stellarwork_page_views_total{path="/job/[id]"} 100');
    // All 50 profile paths should collapse to exactly one series
    expect(output).toContain('stellarwork_page_views_total{path="/profile/[id]"} 50');

    // And new normal routes remain recordable without capacity exhaustion
    recordPageView("/settings");
    expect(renderMetrics()).toContain('stellarwork_page_views_total{path="/settings"} 1');
  });

  // ── BUG-78: Finite Sample Bounds & Histogram Sum Overflow Prevention ────────
  it("rejects non-finite or oversized samples to prevent histogram sum overflowing to Infinity", () => {
    // Attempt to submit two huge numbers that would cause Number.MAX_VALUE overflow
    recordWebVital("lcp", Number.MAX_VALUE, "/");
    recordWebVital("lcp", 1e12, "/"); // Above ceiling
    recordWebVital("lcp", 500, "/");  // Normal sample

    const output = renderMetrics();
    expect(output).not.toContain("Infinity");
    expect(output).toContain('stellarwork_web_vital_milliseconds_sum{metric="lcp",path="/"} 500');
    expect(output).toContain('stellarwork_web_vital_milliseconds_count{metric="lcp",path="/"} 1');
  });

  // ── BUG-80: Active Sessions Gauge & Inactivity Expiry ───────────────────────
  it("tracks concurrent active visitors via gauge and sliding window expiry instead of lifetime pings", () => {
    const t0 = 1700000000000;
    // Visitor 1 sends 5 pings over 30s
    recordActiveSession("visitor-1", t0);
    recordActiveSession("visitor-1", t0 + 10000);
    recordActiveSession("visitor-1", t0 + 20000);
    recordActiveSession("visitor-1", t0 + 30000);

    // Visitor 2 sends 1 ping
    recordActiveSession("visitor-2", t0 + 15000);

    let output = renderMetrics();
    // 2 concurrent active sessions
    expect(output).toContain("# TYPE stellarwork_active_sessions gauge");
    expect(output).toContain("stellarwork_active_sessions 2");
    // Lifetime pings count is 5
    expect(output).toContain("# TYPE stellarwork_session_pings_total counter");
    expect(output).toContain("stellarwork_session_pings_total 5");

    // Advance time past inactivity window for visitor 1 and 2
    pruneSessions(t0 + SESSION_INACTIVITY_TTL_MS + 40000);

    output = renderMetrics();
    // Both sessions expired due to inactivity
    expect(output).toContain("stellarwork_active_sessions 0");
    // Lifetime pings remain preserved
    expect(output).toContain("stellarwork_session_pings_total 5");
  });
});
