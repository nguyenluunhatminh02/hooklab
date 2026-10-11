import type { TimelineTab } from '../hooks/useTimeline';

const TABS: { value: TimelineTab; label: string }[] = [
  { value: 'all', label: 'all' },
  { value: 'verified', label: 'verified' },
  { value: 'rejected', label: 'rejected' },
];

/**
 * Status filter for the timeline. Toggle buttons with `aria-pressed` rather
 * than an ARIA tablist: the panel below is a listbox (04 §9), and a half-wired
 * tab pattern (no arrow-key roving, no tabpanel) would be worse than none.
 */
export function TimelineTabs({
  value,
  onChange,
}: {
  value: TimelineTab;
  onChange: (tab: TimelineTab) => void;
}) {
  return (
    <div className="timeline-tabs" role="group" aria-label="Filter by status">
      {TABS.map((tab) => (
        <button
          key={tab.value}
          type="button"
          className={`btn timeline-tab${value === tab.value ? ' timeline-tab-active' : ''}`}
          aria-pressed={value === tab.value}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
