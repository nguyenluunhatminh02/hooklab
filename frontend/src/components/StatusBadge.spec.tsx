import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RecordStatus } from '../api/records';
import { StatusBadge } from './StatusBadge';

const ALL_STATUSES: RecordStatus[] = ['verified', 'rejected'];

describe('StatusBadge', () => {
  it.each(ALL_STATUSES)(
    'renders the %s status as its label with the matching chip class',
    (status) => {
      render(<StatusBadge status={status} />);

      const badge = screen.getByText(status);
      expect(badge).toHaveClass('chip');
      expect(badge).toHaveClass(`chip-${status}`);
    },
  );
});
