import { RETENTION_DAYS_FALLBACK } from '../config';

export interface RetentionNoticeProps {
  /** `stats.retention.days` when the stats call answered; the constant covers a missing stats call. */
  days?: number;
  /** `stats.retention.notice` verbatim when the server sends it (02 §8). */
  notice?: string;
}

/**
 * Retention banner. The server's `stats.retention.notice` renders verbatim
 * when it exists; otherwise the same lowercase phrasing is composed from days
 * (fallback constant 7 covers a stats call that has not answered yet). Both
 * paths keep the contract string "records auto-delete after N days".
 */
export function RetentionNotice({ days = RETENTION_DAYS_FALLBACK, notice }: RetentionNoticeProps) {
  const text =
    notice !== undefined && notice.trim() !== '' ? notice.trim() : `records auto-delete after ${days} days`;
  return <p className="retention-notice">{text}</p>;
}
