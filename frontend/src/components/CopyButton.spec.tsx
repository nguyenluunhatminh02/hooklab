import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyButton } from './CopyButton';

type WriteText = (text: string) => Promise<void>;

/**
 * jsdom implements no Clipboard API, so the property is replaced outright
 * (it is configurable) and the component's own navigator.clipboard call runs
 * against it. Must happen after userEvent.setup(), which installs its stub.
 */
function stubClipboard(writeText: WriteText): void {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

describe('CopyButton', () => {
  it('labels the button and opens with an empty polite live region', () => {
    render(<CopyButton value="https://hooks.example.com/in" label="Copy URL" />);

    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeInTheDocument();

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toBeEmptyDOMElement();
  });

  it('writes the value to the clipboard and announces Copied', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn<WriteText>().mockResolvedValue(undefined);
    stubClipboard(writeText);

    render(<CopyButton value="https://hooks.example.com/in" label="Copy URL" />);
    await user.click(screen.getByRole('button', { name: 'Copy URL' }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('https://hooks.example.com/in');

    const status = await screen.findByText('Copied');
    expect(status).toHaveAttribute('role', 'status');
  });

  it('announces Copy failed when writeText rejects', async () => {
    const user = userEvent.setup();
    stubClipboard(vi.fn<WriteText>().mockRejectedValue(new Error('permission denied')));

    render(<CopyButton value="whsec_do_not_leak" label="Copy token" />);
    await user.click(screen.getByRole('button', { name: 'Copy token' }));

    const status = await screen.findByText('Copy failed');
    expect(status).toHaveAttribute('role', 'status');
    // The rejected promise is swallowed into the failed branch, never copied.
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });
});
