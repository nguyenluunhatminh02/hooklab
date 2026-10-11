import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReplayChild } from '../api/records';
import { ReplayComparison, type ReplayComparisonOriginal } from './ReplayComparison';

const original: ReplayComparisonOriginal = {
  method: 'POST',
  url: 'https://sender.example/hooks/inbound',
  rawBody: '{"event":"shipment.created","id":"shp_42"}',
  status: 'verified',
  reason: null,
};

const replay: ReplayChild = {
  id: 902,
  receivedAt: '2026-10-08T21:00:00.000Z',
  request: {
    method: 'POST',
    url: 'https://hooks.example/shipments',
    headers: { 'content-type': 'application/json' },
    rawBody: '{"event":"shipment.created","id":"shp_42","replayed":true}',
  },
  response: {
    outcome: 'ok',
    status: 200,
    body: '{"accepted":true,"id":"shp_42"}',
    durationMs: 143,
  },
};

describe('ReplayComparison', () => {
  it('shows the original and replayed payload side by side (round trip visible)', () => {
    const { container } = render(<ReplayComparison original={original} replay={replay} />);

    // Left: what was captured.
    expect(screen.getByRole('heading', { name: 'Original request' })).toBeInTheDocument();
    expect(screen.getByText(/shipment\.created/)).toBeInTheDocument();

    // Right: what the destination answered for the replayed body.
    expect(screen.getByRole('heading', { name: 'Replay response' })).toBeInTheDocument();
    expect(screen.getByTestId('replay-outcome')).toHaveTextContent('ok');
    expect(screen.getByTestId('replay-status')).toHaveTextContent('HTTP 200');
    expect(screen.getByText(/143 ms/)).toBeInTheDocument();
    expect(screen.getByText(/"accepted": true/)).toBeInTheDocument();

    const columns = container.querySelectorAll('.replay-col');
    expect(columns).toHaveLength(2);
  });

  it('renders a timeout attempt without inventing a status chip', () => {
    render(
      <ReplayComparison
        original={original}
        replay={{
          ...replay,
          response: { outcome: 'timeout', status: null, body: null, durationMs: 10_000 },
        }}
      />,
    );

    expect(screen.getByTestId('replay-outcome')).toHaveTextContent('timeout');
    expect(screen.queryByTestId('replay-status')).not.toBeInTheDocument();
    expect(screen.getByText('No response body.')).toBeInTheDocument();
  });

  it('surfaces the ingest rejection reason next to the original payload', () => {
    render(
      <ReplayComparison
        original={{ ...original, status: 'rejected', reason: 'invalid_signature' }}
        replay={replay}
      />,
    );

    expect(screen.getByText('invalid_signature')).toBeInTheDocument();
  });
});
