import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RETENTION_DAYS_FALLBACK } from '../config';
import { RetentionNotice } from './RetentionNotice';

describe('RetentionNotice', () => {
  it('renders the exact contract copy when notice is provided verbatim (from stats.retention.notice)', () => {
    render(
      <RetentionNotice
        days={30}
        notice="records auto-delete after 30 days"
      />,
    );
    expect(screen.getByText('records auto-delete after 30 days')).toBeInTheDocument();
    expect(RETENTION_DAYS_FALLBACK).toBe(7);
  });

  it('falls back to the lowercase copy with the days number (7 days by default)', () => {
    render(<RetentionNotice />);
    expect(screen.getByText('records auto-delete after 7 days')).toBeInTheDocument();
  });

  it('uses provided days in the fallback copy', () => {
    render(<RetentionNotice days={14} />);
    expect(screen.getByText('records auto-delete after 14 days')).toBeInTheDocument();
  });
});
