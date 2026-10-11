import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretRevealModal, type SecretRevealModalProps } from './SecretRevealModal';

const url = 'https://hooks.example.com/ingest/wh_9f2';
const token = 'tok_live_8c41c0d2';
const secret = 'shh_5b6e7d8c9a0b1c2d';

// jsdom implements no clipboard — stub writeText so CopyButton's happy path
// resolves instead of bouncing through its failed branch.
const writeText = vi.fn();

const axeOptions = {
  rules: {
    // jsdom has no layout engine, so axe cannot compute rendered colors — real
    // contrast coverage lives in src/styles/tokens.a11y.spec.ts.
    'color-contrast': { enabled: false },
  },
};

function renderModal(kind: SecretRevealModalProps['kind'] = 'created') {
  return render(
    <SecretRevealModal kind={kind} url={url} token={token} secret={secret} onClose={vi.fn()} />,
  );
}

describe('SecretRevealModal accessibility', () => {
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('has no structural axe violations in the created state', async () => {
    const { container } = renderModal('created');

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

  it('has no structural axe violations in the rotated state, with the copy status settled', async () => {
    const user = userEvent.setup();
    // userEvent.setup() swaps navigator.clipboard for its own jsdom stub,
    // shadowing the spy from beforeEach — put ours back so the copy resolves
    // to 'Copied' and the status live region carries text before axe runs.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { container } = renderModal('rotated');

    await user.click(screen.getByRole('button', { name: 'Copy URL' }));
    await screen.findByText('Copied');

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
