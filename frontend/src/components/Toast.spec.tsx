import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toast } from './Toast';

describe('Toast', () => {
  it('announces the message through a status live region', () => {
    render(<Toast message="record expired (7-day retention)" onDismiss={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('record expired (7-day retention)');
  });

  it('runs onDismiss when Dismiss is activated', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();

    render(<Toast message="record expired (7-day retention)" onDismiss={onDismiss} />);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
