import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders just the title when no hint is given', () => {
    const { container } = render(<EmptyState title="No records yet." />);

    expect(screen.getByText('No records yet.')).toBeInTheDocument();
    expect(container.textContent).toBe('No records yet.');
  });

  it('renders the hint as a second paragraph with the hint class', () => {
    render(<EmptyState title="No records yet." hint="Create a subscriber to begin." />);

    expect(screen.getByText('No records yet.')).toBeInTheDocument();
    expect(screen.getByText('Create a subscriber to begin.')).toHaveClass('hint');
  });
});
