import type { RecordStatus, RejectReason, ReplayChild } from '../api/records';
import { JsonView } from './JsonView';
import { StatusBadge } from './StatusBadge';
import '../styles/replay.css';

export interface ReplayComparisonOriginal {
  method: string;
  url: string;
  rawBody: string;
  status: RecordStatus;
  reason: RejectReason | null;
}

export interface ReplayComparisonProps {
  /** The record that was replayed — left column (04 §6 success row). */
  original: ReplayComparisonOriginal;
  /** The stored replay attempt — right column, round-trip evidence. */
  replay: ReplayChild;
}

/**
 * Original request vs replayed round trip, side by side: what went out at
 * capture time on the left, what the destination answered on the right.
 */
export function ReplayComparison({ original, replay }: ReplayComparisonProps) {
  return (
    <section className="replay-comparison" aria-label="Original request versus replay">
      <div className="replay-col">
        <h3>Original request</h3>
        <p className="endpoint-row">
          <code className="subscriber-url">
            {original.method} {original.url}
          </code>
        </p>
        <p>
          <StatusBadge status={original.status} />
          {original.reason ? <span className="chip chip-rejected"> {original.reason}</span> : null}
        </p>
        <JsonView raw={original.rawBody} />
      </div>

      <div className="replay-col">
        <h3>Replay response</h3>
        <p className="endpoint-row">
          <code className="subscriber-url">
            {replay.request.method} {replay.request.url}
          </code>
        </p>
        <p>
          <span className="chip" data-testid="replay-outcome">
            {replay.response.outcome}
          </span>
          {replay.response.status !== null ? (
            <span className="chip" data-testid="replay-status">
              {' '}
              HTTP {replay.response.status}
            </span>
          ) : null}
          <span className="muted"> {replay.response.durationMs} ms</span>
        </p>
        {replay.response.body !== null ? (
          <JsonView raw={replay.response.body} />
        ) : (
          <p className="muted">No response body.</p>
        )}
      </div>
    </section>
  );
}
