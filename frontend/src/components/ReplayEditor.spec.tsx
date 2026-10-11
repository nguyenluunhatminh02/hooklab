import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReplayEditor } from './ReplayEditor';

const VALID_PRESET = '{"event":"shipment.created","id":"shp_42"}';
const PRETTY_PRESET = `{
  "event": "shipment.created",
  "id": "shp_42"
}`;

/** Braces/brackets are key descriptors in userEvent.type — set JSON via change. */
function setBody(text: string): HTMLTextAreaElement {
  const textarea = screen.getByLabelText('Replay body') as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: text } });
  return textarea;
}

describe('ReplayEditor', () => {
  it('presets the textarea with the pretty-printed original body', () => {
    render(<ReplayEditor defaultBody={VALID_PRESET} onSubmit={vi.fn()} />);

    expect(screen.getByLabelText('Replay body')).toHaveValue(PRETTY_PRESET);
  });

  it('never submits invalid JSON and marks the textarea aria-invalid', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<ReplayEditor defaultBody={VALID_PRESET} onSubmit={onSubmit} />);
    const textarea = setBody('{ "event": ');
    const submit = screen.getByRole('button', { name: 'Replay request' });

    await user.click(submit);

    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    const errorId = textarea.getAttribute('aria-describedby');
    expect(errorId).toBeTruthy();
    expect(document.getElementById(errorId ?? '')).toHaveTextContent(/JSON|position|token/i);
    expect(onSubmit).not.toHaveBeenCalled();
    // The failure shows inline — the button stays live, no silent disable.
    expect(submit).toBeEnabled();
  });

  it('rejects a top-level array because ReplayDto only accepts objects', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<ReplayEditor defaultBody={VALID_PRESET} onSubmit={onSubmit} />);
    setBody('[1, 2, 3]');
    await user.click(screen.getByRole('button', { name: 'Replay request' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Replay body must be a JSON object.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the parsed object when the JSON is valid', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<ReplayEditor defaultBody={VALID_PRESET} onSubmit={onSubmit} />);
    const textarea = setBody('{"event":"shipment.updated"}');

    await user.click(screen.getByRole('button', { name: 'Replay request' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ event: 'shipment.updated' });
    expect(textarea).not.toHaveAttribute('aria-invalid');
  });

  it('clears the inline error once the body becomes valid again', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<ReplayEditor defaultBody={VALID_PRESET} onSubmit={onSubmit} />);
    const textarea = setBody('nope');
    await user.click(screen.getByRole('button', { name: 'Replay request' }));
    expect(textarea).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(textarea, { target: { value: '{"ok":true}' } });

    expect(textarea).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('re-presents the new preset when the parent swaps defaultBody', () => {
    const { rerender } = render(<ReplayEditor defaultBody={VALID_PRESET} onSubmit={vi.fn()} />);
    const textarea = screen.getByLabelText('Replay body');
    expect(textarea).toHaveValue(PRETTY_PRESET);

    rerender(<ReplayEditor defaultBody={'{"event":"shipment.purged"}'} onSubmit={vi.fn()} />);

    expect(textarea).toHaveValue(`{
  "event": "shipment.purged"
}`);
  });

  it('drops a stale validation error when defaultBody changes record', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ReplayEditor defaultBody={VALID_PRESET} onSubmit={vi.fn()} />);
    setBody('{ "event": ');
    await user.click(screen.getByRole('button', { name: 'Replay request' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(<ReplayEditor defaultBody={'{"event":"shipment.purged"}'} onSubmit={vi.fn()} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Replay body')).not.toHaveAttribute('aria-invalid');
  });

  it('renders the disabled editor with its reason banner', () => {
    render(
      <ReplayEditor
        defaultBody={VALID_PRESET}
        disabled
        reason="Subscriber revoked — replay has no live destination."
        onSubmit={vi.fn()}
      />,
    );

    const textarea = screen.getByLabelText('Replay body');
    expect(textarea).toBeDisabled();
    expect(
      screen.getByText('Subscriber revoked — replay has no live destination.'),
    ).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: 'Replay request' });
    expect(submit).toBeDisabled();
    // The reason is reachable from the control itself, not only visually.
    const describedBy = textarea.getAttribute('aria-describedby') ?? '';
    const reasonId = describedBy.split(' ').pop() ?? '';
    expect(document.getElementById(reasonId)).toHaveTextContent('Subscriber revoked');
  });
});
