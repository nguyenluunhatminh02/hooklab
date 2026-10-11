import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeadersTable } from './HeadersTable';

describe('HeadersTable', () => {
  it('shows the empty message instead of a table when nothing was captured', () => {
    render(<HeadersTable headers={{}} />);

    expect(screen.getByText('No captured headers.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders every captured header as a row of name and value', () => {
    render(
      <HeadersTable
        headers={{
          'content-type': 'application/json',
          'x-request-id': 'req_9f2',
        }}
      />,
    );

    expect(screen.getByRole('table', { name: 'Captured request headers' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'content-type' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'application/json' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'x-request-id' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'req_9f2' })).toBeInTheDocument();
  });
});
