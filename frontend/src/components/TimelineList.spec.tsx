import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_DEBOUNCE_MS } from '../config';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import type { RecordListItem } from '../api/records';
import type { TimelineTab } from '../hooks/useTimeline';
import { SearchInput } from './SearchInput';
import { TimelineList } from './TimelineList';
import { TimelineTabs } from './TimelineTabs';

/**
 * Listbox contract + filters (BUILD_PLAN §8.3): ArrowUp/ArrowDown roving
 * focus, Enter selects; clicking a status tab renders only that status's rows;
 * `q` is applied server-side only (02 §5 — event-type substring, exact
 * x-request-id, and on the workspace route a token prefix). The harness below
 * stands in for the server: it narrows the row array per (tab, debounced q)
 * and hands the already-filtered rows to the list, the way the page does.
 */

const baseRecord = {
  subscriberId: 7,
  workspaceId: 1,
  subscriberName: 'acme',
  method: 'POST',
  bodyBytes: 128,
  isReplay: false,
  replayOfId: null,
  replayResponseStatus: null,
};

const records: RecordListItem[] = [
  {
    id: 101,
    ...baseRecord,
    status: 'verified',
    reason: null,
    eventType: 'shipment.created',
    receivedAt: '2026-10-08T12:00:00.000Z',
  },
  {
    id: 102,
    ...baseRecord,
    status: 'rejected',
    reason: 'invalid_signature',
    eventType: 'payment.failed',
    receivedAt: '2026-10-08T12:01:00.000Z',
  },
  {
    id: 103,
    ...baseRecord,
    status: 'verified',
    reason: null,
    eventType: 'payment.refund',
    receivedAt: '2026-10-08T12:02:00.000Z',
  },
];

/** Server stand-in: eventType substring plus the exact x-request-id mode the
 *  row payload cannot express (rows carry no headers — see api/records.ts). */
function serverFilter(rows: RecordListItem[], q: string): RecordListItem[] {
  if (q === '') return rows;
  return rows.filter(
    (row) =>
      (row.eventType ?? '').toLowerCase().includes(q.toLowerCase()) ||
      String(row.id) === q || // exact x-request-id stand-in for the spec
      (row as RecordListItem & { requestId?: string }).requestId === q,
  );
}

/** The page wiring: tab state, raw input debounced, server-filtered rows. */
function TimelineHarness({ onSelect }: { onSelect: (record: RecordListItem) => void }) {
  const [tab, setTab] = useState<TimelineTab>('all');
  const [input, setInput] = useState('');
  const debouncedSearch = useDebouncedValue(input, SEARCH_DEBOUNCE_MS);
  return (
    <>
      <TimelineTabs value={tab} onChange={setTab} />
      <SearchInput value={input} onChange={setInput} />
      <TimelineList
        records={serverFilter(records, debouncedSearch)}
        statusTab={tab}
        selectedRecordId={null}
        onSelect={onSelect}
      />
    </>
  );
}

function optionTexts(): string[] {
  return screen.getAllByRole('option').map((row) => row.textContent ?? '');
}

describe('TimelineList', () => {
  const onSelect = vi.fn();

  beforeEach(() => {
    onSelect.mockReset();
  });

  it('moves focus with ArrowDown/ArrowUp (roving tabindex) and Enter selects the focused row', () => {
    render(<TimelineHarness onSelect={onSelect} />);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute('tabindex', '0');
    expect(options[1]).toHaveAttribute('tabindex', '-1');

    options[0].focus();
    fireEvent.keyDown(options[0], { key: 'ArrowDown' });
    expect(options[1]).toHaveFocus();

    fireEvent.keyDown(options[1], { key: 'ArrowDown' });
    expect(options[2]).toHaveFocus();

    // Clamped at the last row — no wrap-around, no index overflow.
    fireEvent.keyDown(options[2], { key: 'ArrowDown' });
    expect(options[2]).toHaveFocus();

    fireEvent.keyDown(options[2], { key: 'ArrowUp' });
    expect(options[1]).toHaveFocus();

    fireEvent.keyDown(options[1], { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(records[1]);

    // Roving tabindex follows the active row.
    expect(options[1]).toHaveAttribute('tabindex', '0');
    expect(options[0]).toHaveAttribute('tabindex', '-1');
  });

  it('renders only verified rows after the verified tab is clicked', async () => {
    const user = userEvent.setup();
    render(<TimelineHarness onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'verified' }));

    const texts = optionTexts();
    expect(texts).toHaveLength(2);
    expect(texts.join(' ')).toContain('shipment.created');
    expect(texts.join(' ')).toContain('payment.refund');
    expect(texts.join(' ')).not.toContain('payment.failed');
    expect(screen.getByRole('button', { name: 'verified' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('renders only rejected rows after the rejected tab is clicked', async () => {
    const user = userEvent.setup();
    render(<TimelineHarness onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'rejected' }));

    const texts = optionTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('payment.failed');
  });

  it('returns to every row on the all tab', async () => {
    const user = userEvent.setup();
    render(<TimelineHarness onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'rejected' }));
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'all' }));
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('renders the debounced search result rows (server-filtered)', async () => {
    const user = userEvent.setup();
    render(<TimelineHarness onSelect={onSelect} />);

    await user.type(screen.getByRole('searchbox'), 'payment');

    // Debounced through useDebouncedValue — the server query lands after the window.
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2), {
      timeout: 2000,
    });
    const texts = optionTexts();
    expect(texts.join(' ')).toContain('payment.failed');
    expect(texts.join(' ')).toContain('payment.refund');
    expect(texts.join(' ')).not.toContain('shipment.created');
  });

  it('shows the empty state when the server returns no rows for this tab + search', async () => {
    const user = userEvent.setup();
    render(<TimelineHarness onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'rejected' }));
    await user.type(screen.getByRole('searchbox'), 'shipment');

    await waitFor(() => expect(screen.getByText('No records match')).toBeInTheDocument(), {
      timeout: 2000,
    });
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(
      screen.getByText('Nothing found for this tab and search — new deliveries appear within 2 s.'),
    ).toBeInTheDocument();
  });

  it('keeps a server-side request-id hit visible even when its eventType lacks the needle', async () => {
    // The server matched this row by exact x-request-id for q='req_7f3a'; the
    // row payload carries no request-id/headers field (api/records.ts), so a
    // client re-filter on eventType would wrongly drop it and flash the empty
    // state. The list must render exactly what the server returned.
    const serverHit = { ...records[1] } as RecordListItem & { requestId: string };
    serverHit.requestId = 'req_7f3a';
    function RegressionHarness() {
      const [input, setInput] = useState('');
      const debouncedSearch = useDebouncedValue(input, SEARCH_DEBOUNCE_MS);
      return (
        <>
          <SearchInput value={input} onChange={setInput} />
          <TimelineList
            records={serverFilter([serverHit], debouncedSearch)}
            statusTab="all"
            selectedRecordId={null}
            onSelect={onSelect}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<RegressionHarness />);

    await user.type(screen.getByRole('searchbox'), 'req_7f3a');

    await waitFor(() => expect(screen.getByText('payment.failed')).toBeInTheDocument(), {
      timeout: 2000,
    });
    expect(screen.queryByText('No records match')).not.toBeInTheDocument();
  });

  it('marks the selected row and surfaces the polling-paused badge', () => {
    function SelectedProbe() {
      return (
        <TimelineList
          records={[...records]}
          statusTab="all"
          selectedRecordId={103}
          onSelect={onSelect}
          isPaused
        />
      );
    }
    render(<SelectedProbe />);

    const selected = screen.getAllByRole('option').find((row) => row.getAttribute('aria-selected') === 'true');
    expect(selected).toBeDefined();
    expect(selected).toHaveTextContent('payment.refund');
    expect(screen.getByTestId('timeline-paused')).toHaveTextContent('polling paused (tab hidden)');
  });

  it('shows the replay chip and outbound status only on replay rows (02 §5)', () => {
    const replayRow: RecordListItem = {
      ...records[0],
      id: 201,
      isReplay: true,
      replayOfId: 101,
      replayResponseStatus: 200,
    };
    render(
      <TimelineList
        records={[records[0], replayRow]}
        statusTab="all"
        selectedRecordId={null}
        onSelect={onSelect}
      />,
    );

    const [original, replay] = screen.getAllByRole('option');
    expect(original).not.toHaveTextContent('replay');
    expect(original).not.toHaveTextContent('→ 200');
    expect(replay).toHaveTextContent('replay');
    expect(replay).toHaveTextContent('→ 200');
  });
});
