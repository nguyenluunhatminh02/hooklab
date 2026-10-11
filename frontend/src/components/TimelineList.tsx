import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { RecordListItem } from '../api/records';
import type { TimelineTab } from '../hooks/useTimeline';
import { EmptyState } from './EmptyState';
import { TimelineRow } from './TimelineRow';

export interface TimelineListProps {
  records: RecordListItem[];
  statusTab: TimelineTab;
  selectedRecordId: number | null;
  onSelect: (record: RecordListItem) => void;
  isPaused?: boolean;
}

/**
 * `role="listbox"` timeline with roving tabindex (04 §9): ↑/↓ move focus,
 * Enter/Space select. Only the status tab is re-applied here — the search `q`
 * is server-side only (02 §5 also matches exact x-request-id and, on the
 * workspace route, token prefix; a client eventType-only re-filter would drop
 * those hits and show a false empty state). The tab filter still guards the
 * `keepPreviousData` window when a freshly clicked tab holds the old page.
 */
export function TimelineList({
  records,
  statusTab,
  selectedRecordId,
  onSelect,
  isPaused = false,
}: TimelineListProps) {
  const visible = records.filter((record) => {
    return statusTab === 'all' || record.status === statusTab;
  });

  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    if (activeIndex !== null) rowRefs.current[activeIndex]?.focus();
  }, [activeIndex]);

  function handleKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    if (visible.length === 0) return;
    const current = activeIndex ?? 0;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(Math.min(current + 1, visible.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(Math.max(current - 1, 0));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(visible[current]);
    }
  }

  return (
    <div className="timeline">
      <div className="timeline-meta">
        <span className="muted">
          {visible.length} {visible.length === 1 ? 'record' : 'records'}
        </span>
        {isPaused ? (
          <span className="muted" data-testid="timeline-paused">
            polling paused (tab hidden)
          </span>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title="No records match"
          hint="Nothing found for this tab and search — new deliveries appear within 2 s."
        />
      ) : (
        <ul
          role="listbox"
          aria-label="Record timeline"
          className="timeline-list"
          onKeyDown={handleKeyDown}
        >
          {visible.map((record, index) => (
            <TimelineRow
              key={record.id}
              ref={(element) => {
                rowRefs.current[index] = element;
              }}
              record={record}
              isSelected={record.id === selectedRecordId}
              tabIndex={activeIndex === null ? (index === 0 ? 0 : -1) : index === activeIndex ? 0 : -1}
              onSelect={(selected) => {
                setActiveIndex(index);
                onSelect(selected);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
