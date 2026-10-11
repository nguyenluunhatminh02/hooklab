import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { SubscriberForm } from './SubscriberForm';

/**
 * Structural axe gate for SubscriberForm: accessible names on every input,
 * select and textarea, aria-invalid/aria-describedby wiring to the error
 * alerts, and the submit button's own name. jsdom has no layout engine, so
 * color contrast is out of reach here — real contrast coverage lives in
 * src/styles/tokens.a11y.spec.ts.
 */

const axeOptions = {
  rules: {
    // jsdom has no layout engine, so axe cannot compute rendered colors — real
    // contrast coverage lives in src/styles/tokens.a11y.spec.ts.
    'color-contrast': { enabled: false },
  },
};

describe('SubscriberForm accessibility', () => {
  it('has no structural axe violations on the blank create form', async () => {
    const { container } = render(
      <SubscriberForm submitLabel="Create subscriber" onSubmit={vi.fn()} />,
    );

    const results = await axe.run(container, axeOptions);

    expect(
      results.violations.map(
        (violation) =>
          `${violation.id} (${violation.nodes.length}): ${violation.nodes
            .map((node) => node.target.join(' '))
            .join('; ')}`,
      ),
    ).toEqual([]);
  }, 15000);

  it('has no structural axe violations once the required-field errors are shown', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SubscriberForm submitLabel="Create subscriber" onSubmit={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: 'Create subscriber' }));
    expect(screen.getByText('Name is required.')).toBeInTheDocument();

    const results = await axe.run(container, axeOptions);

    expect(
      results.violations.map(
        (violation) =>
          `${violation.id} (${violation.nodes.length}): ${violation.nodes
            .map((node) => node.target.join(' '))
            .join('; ')}`,
      ),
    ).toEqual([]);
  }, 15000);

  it('has no structural axe violations with the credential fields rendered', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SubscriberForm submitLabel="Create subscriber" onSubmit={vi.fn()} />,
    );

    await user.selectOptions(screen.getByLabelText('Destination authentication'), 'basic');

    const results = await axe.run(container, axeOptions);

    expect(
      results.violations.map(
        (violation) =>
          `${violation.id} (${violation.nodes.length}): ${violation.nodes
            .map((node) => node.target.join(' '))
            .join('; ')}`,
      ),
    ).toEqual([]);
  }, 15000);
});
