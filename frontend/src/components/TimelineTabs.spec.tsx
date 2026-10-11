import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom';
import { TimelineTabs } from './TimelineTabs';
import type { TimelineTab } from '../hooks/useTimeline';

/**
 * Filter-toggle contract (04 §9): three `aria-pressed` buttons, not a tablist —
 * the panel below is a listbox, so a half-wired tab pattern would be worse
 * than none. `value`/`onChange` are controlled; the URL wiring (status in the
 * search param so a refresh keeps the filter) lives in the consumer, probed
 * here through a MemoryRouter harness mirroring that wiring.
 */

/** Location probe: renders the exact query string so assertions see navigation. */
function LocationProbe() {
  const [searchParams] = useSearchParams();
  return <div data-testid="location">{searchParams.toString()}</div>;
}

/** Consumer-style harness: tab value derives from ?status=, clicks update it. */
function UrlWiredTabs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('status');
  const value: TimelineTab = raw === 'verified' || raw === 'rejected' ? raw : 'all';
  function handleChange(tab: TimelineTab): void {
    setSearchParams(tab === 'all' ? {} : { status: tab });
  }
  return (
    <>
      <TimelineTabs value={value} onChange={handleChange} />
      <LocationProbe />
    </>
  );
}

function renderUrlWiredAt(query: string) {
  return render(
    <MemoryRouter initialEntries={[`/?${query}`]}>
      <Routes>
        <Route path="/" element={<UrlWiredTabs />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TimelineTabs', () => {
  it('renders the three status filter buttons inside a labelled group, with no counts', () => {
    render(<TimelineTabs value="all" onChange={vi.fn()} />);

    const group = screen.getByRole('group', { name: 'Filter by status' });
    expect(group).toBeInTheDocument();
    // Labels carry no counts — the source renders a plain filter, not counters.
    expect(screen.getByRole('button', { name: 'all' })).toHaveTextContent(/^all$/);
    expect(screen.getByRole('button', { name: 'verified' })).toHaveTextContent(/^verified$/);
    expect(screen.getByRole('button', { name: 'rejected' })).toHaveTextContent(/^rejected$/);
    expect(group.querySelectorAll('button')).toHaveLength(3);
  });

  it('presses only the tab matching the controlled value and moves with rerender', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TimelineTabs value="all" onChange={onChange} />);

    expect(screen.getByRole('button', { name: 'all' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'verified' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'rejected' })).toHaveAttribute('aria-pressed', 'false');

    rerender(<TimelineTabs value="rejected" onChange={onChange} />);

    expect(screen.getByRole('button', { name: 'all' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'rejected' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'rejected' })).toHaveClass('timeline-tab-active');
  });

  it('calls onChange with the clicked tab value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<TimelineTabs value="all" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'verified' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('verified');
  });

  it('starts on the all tab when the URL has no status param', () => {
    renderUrlWiredAt('');

    expect(screen.getByRole('button', { name: 'all' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('location').textContent).toBe('');
  });

  it('reads the active tab from an existing status param on mount', () => {
    renderUrlWiredAt('status=verified');

    expect(screen.getByRole('button', { name: 'verified' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'all' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('updates the status param when a tab is clicked and drops it when returning to all', async () => {
    const user = userEvent.setup();
    renderUrlWiredAt('');

    await user.click(screen.getByRole('button', { name: 'rejected' }));

    expect(screen.getByTestId('location').textContent).toBe('status=rejected');
    expect(screen.getByRole('button', { name: 'rejected' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'all' }));

    expect(screen.getByTestId('location').textContent).toBe('');
    expect(screen.getByRole('button', { name: 'all' })).toHaveAttribute('aria-pressed', 'true');
  });
});
