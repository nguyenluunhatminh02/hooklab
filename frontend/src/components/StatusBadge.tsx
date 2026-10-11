import type { RecordStatus } from '../api/records';

/** Record status chip — verified/rejected are a different job than brand hues. */
export function StatusBadge({ status }: { status: RecordStatus }) {
  return <span className={`chip chip-${status}`}>{status}</span>;
}
