import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RecordListItem } from '../api/records';
import { TimelineList } from './TimelineList';
import { TimelineRow } from './TimelineRow';

/**
 * Row contract (04 §9): one listbox option carrying time, status chip, event
 * type, method, byte count, and the optional replay markers. The selected
 * affordance is `aria-selected` + the `timeline-row-selected` class; keyboard
 * selection itself lives on the parent listbox (TimelineList), so it is probed
 * through that wrapper here rather than re-implemented.
 */

const baseRecord: RecordListItem = {
  id: 11,
  subscriberId: 7,
  workspaceId: 1,
  subscriberName: 'acme',
  status: 'verified',
  reason: null,
  eventType: 'shipment.created',
  method: 'POST',
  bodyBytes: 128,
  isReplay: false,
  replayOfId: null,
  replayResponseStatus: null,
  receivedAt: '2026-10-08T12:00:00.000Z',
};

/** Same formatting the component uses — locale-proof pin of the contract. */
function expectedTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

function renderRow(overrides: Partial<RecordListItem> = {}, isSelected = false, onSelect = vi.fn()) {
  const record: RecordListItem = { ...baseRecord, ...overrides };
  render(
    <ul>
      <TimelineRow record={record} isSelected={isSelected} onSelect={onSelect} tabIndex={0} />
    </ul>,
  );
  return { record, onSelect };
}

describe('TimelineRow', () => {
  it('renders the event type, status badge, formatted time, method and byte count', () => {
    renderRow();

    const row = screen.getByRole('option');
    expect(row).toHaveTextContent('shipment.created');
    expect(row).toHaveTextContent('verified');
    expect(row).toHaveTextContent(expectedTime(baseRecord.receivedAt));
    expect(row).toHaveTextContent('POST');
    expect(row).toHaveTextContent('128 B');
    expect(row).toHaveAttribute('data-status', 'verified');
  });

  it('renders the placeholder when the record has no event type', () => {
    renderRow({ eventType: null });

    expect(screen.getByRole('option')).toHaveTextContent('(no event type)');
  });

  it('falls back to the raw receivedAt string when the timestamp does not parse', () => {
    renderRow({ receivedAt: 'not-a-timestamp' });

    expect(screen.getByRole('option')).toHaveTextContent('not-a-timestamp');
  });

  it('marks the selected row with aria-selected and the selection class', () => {
    renderRow({}, true);

    const row = screen.getByRole('option');
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(row).toHaveClass('timeline-row-selected');
  });

  it('leaves the unselected row off the selection affordance but keeps it tabbable', () => {
    renderRow({}, false);

    const row = screen.getByRole('option');
    expect(row).toHaveAttribute('aria-selected', 'false');
    expect(row).not.toHaveClass('timeline-row-selected');
    expect(row).toHaveAttribute('tabindex', '0');
  });

  it('fires onSelect with the full record (including its id) on click', () => {
    const { record, onSelect } = renderRow();

    fireEvent.click(screen.getByRole('option'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(record);
    expect(onSelect.mock.calls[0][0].id).toBe(11);
  });

  it('renders the replay chip and outbound status only on replay rows', () => {
    renderRow();
    expect(screen.getByRole('option')).not.toHaveTextContent('replay');
    expect(screen.getByRole('option')).not.toHaveTextContent('→ 200');
    cleanup();

    renderRow({ isReplay: true, replayOfId: 11, replayResponseStatus: 200 });

    const row = screen.getByRole('option');
    expect(row).toHaveTextContent('replay');
    expect(row).toHaveTextContent('→ 200');
  });

  it('omits the outbound status marker when replayResponseStatus is null', () => {
    renderRow({ isReplay: true, replayOfId: 11, replayResponseStatus: null });

    const row = screen.getByRole('option');
    expect(row).toHaveTextContent('replay');
    expect(row).not.toHaveTextContent('→');
  });

  it('sends Enter on the focused row to onSelect through the parent listbox', async () => {
    // Keyboard selection is the listbox's job (TimelineList wires ArrowUp/
    // ArrowDown/Enter onto the ul); this probes that path end-to-end so the
    // row's id lands in the callback, not just its index.
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const second: RecordListItem = {
      ...baseRecord,
      id: 12,
      eventType: 'payment.failed',
      status: 'rejected',
    };

    render(
      <TimelineList
        records={[baseRecord, second]}
        statusTab="all"
        selectedRecordId={null}
        onSelect={onSelect}
      />,
    );

    const rows = screen.getAllByRole('option');
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe(12);
  });
});
