import { forwardRef } from 'react';
import type { RecordListItem } from '../api/records';
import { StatusBadge } from './StatusBadge';

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}

export interface TimelineRowProps {
  record: RecordListItem;
  isSelected: boolean;
  onSelect: (record: RecordListItem) => void;
  /** Roving tabindex: exactly one row in the list is tabbable. */
  tabIndex: number;
}

export const TimelineRow = forwardRef<HTMLLIElement, TimelineRowProps>(function TimelineRow(
  { record, isSelected, onSelect, tabIndex },
  ref,
) {
  return (
    <li
      ref={ref}
      role="option"
      aria-selected={isSelected}
      tabIndex={tabIndex}
      className={`timeline-row${isSelected ? ' timeline-row-selected' : ''}`}
      data-status={record.status}
      onClick={() => onSelect(record)}
    >
      <span className="timeline-time">{formatTime(record.receivedAt)}</span>
      <StatusBadge status={record.status} />
      <span className="timeline-event">{record.eventType ?? '(no event type)'}</span>
      <span className="muted timeline-method">{record.method}</span>
      {record.isReplay ? <span className="chip">replay</span> : null}
      {record.replayResponseStatus !== null ? (
        <span className="muted">→ {record.replayResponseStatus}</span>
      ) : null}
      <span className="muted timeline-bytes">{record.bodyBytes} B</span>
    </li>
  );
});
