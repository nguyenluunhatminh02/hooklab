import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretRevealModal, type SecretRevealModalProps } from './SecretRevealModal';

const url = 'https://hooks.example.com/ingest/wh_9f2';
const token = 'tok_live_8c41c0d2';
const secret = 'shh_5b6e7d8c9a0b1c2d';

// jsdom implements no clipboard — stub writeText so CopyButton's happy path
// resolves instead of failing every interaction that reaches a copy button.
const writeText = vi.fn();

function renderModal(onClose: () => void, kind: SecretRevealModalProps['kind'] = 'created') {
  return render(
    <SecretRevealModal kind={kind} url={url} token={token} secret={secret} onClose={onClose} />,
  );
}

describe('SecretRevealModal', () => {
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

  it("renders the 'Subscriber created' title when kind is created", () => {
    renderModal(vi.fn(), 'created');

    expect(screen.getByRole('heading', { name: 'Subscriber created' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Secret rotated' })).not.toBeInTheDocument();
  });

  it("renders the 'Secret rotated' title when kind is rotated", () => {
    renderModal(vi.fn(), 'rotated');

    expect(screen.getByRole('heading', { name: 'Secret rotated' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Subscriber created' })).not.toBeInTheDocument();
  });

  it('renders the url, token and secret each inside a code element', () => {
    const { container } = renderModal(vi.fn());

    const codeValues = Array.from(container.querySelectorAll('code')).map(
      (element) => element.textContent,
    );

    expect(codeValues).toEqual([url, token, secret]);
  });

  it('focuses the close button when the dialog opens', () => {
    renderModal(vi.fn());

    expect(screen.getByRole('button', { name: /I saved it/ })).toHaveFocus();
  });

  it('calls onClose when Escape is pressed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    renderModal(onClose);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on mousedown on the backdrop but not on mousedown inside the dialog', () => {
    const onClose = vi.fn();
    renderModal(onClose);
    const dialog = screen.getByRole('dialog', { name: 'Subscriber created' });

    // Clicking within the dialog content must not count as a backdrop click.
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = dialog.parentElement;
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wraps Tab from the last focusable element back to the first', async () => {
    const user = userEvent.setup();
    renderModal(vi.fn());

    // Mount places focus on the close button, which sits last in tab order.
    expect(screen.getByRole('button', { name: /I saved it/ })).toHaveFocus();

    await user.tab();

    expect(screen.getByRole('button', { name: 'Copy URL' })).toHaveFocus();
  });

  it('wraps Shift+Tab from the first focusable element back to the last', async () => {
    const user = userEvent.setup();
    renderModal(vi.fn());

    screen.getByRole('button', { name: 'Copy URL' }).focus();

    await user.tab({ shift: true });

    expect(screen.getByRole('button', { name: /I saved it/ })).toHaveFocus();
  });

  it('returns focus to the previously focused element when unmounted', () => {
    render(<button type="button">Reveal secret</button>);
    const trigger = screen.getByRole('button', { name: 'Reveal secret' });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = renderModal(vi.fn());
    expect(screen.getByRole('button', { name: /I saved it/ })).toHaveFocus();

    unmount();

    expect(document.activeElement).toBe(trigger);
  });

  it('copies the endpoint URL to the clipboard from the copy button', async () => {
    const user = userEvent.setup();
    // userEvent.setup() swaps navigator.clipboard for its own jsdom stub,
    // shadowing the spy from beforeEach — put ours back on top so the copy
    // can be asserted against writeText.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderModal(vi.fn());

    await user.click(screen.getByRole('button', { name: 'Copy URL' }));

    expect(writeText).toHaveBeenCalledWith(url);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });
});
