/**
 * Canonical-count metrics (04 §7): the props type is exactly
 * `{received, verified, rejected}` so a records array cannot be passed in —
 * replay rows (`replayOfId IS NOT NULL`) must never inflate these numbers.
 */
export interface MetricsCounts {
  received: number;
  verified: number;
  rejected: number;
}

export function MetricsBadges({ metrics }: { metrics: MetricsCounts }) {
  return (
    <dl className="count-list" aria-label="Record metrics">
      <div>
        <dt>Received</dt>
        <dd>{metrics.received}</dd>
      </div>
      <div>
        <dt>Verified</dt>
        <dd>{metrics.verified}</dd>
      </div>
      <div>
        <dt>Rejected</dt>
        <dd>{metrics.rejected}</dd>
      </div>
    </dl>
  );
}
