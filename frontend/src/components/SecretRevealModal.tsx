import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { CopyButton } from './CopyButton';

export interface SecretRevealModalProps {
  kind: 'created' | 'rotated';
  /** Endpoint URL + ingest token come from the create response / cached subscriber. */
  url: string;
  token: string;
  /** Full HMAC secret — present only in the create/rotate response, never refetched. */
  secret: string;
  onClose: () => void;
}

/**
 * One-time secret reveal (04 §4). The secret exists only in this props object:
 * closing the dialog is the last chance to copy it, by design (02 §4).
 */
export function SecretRevealModal({ kind, url, token, secret, onClose }: SecretRevealModalProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Remember what opened the dialog so focus can go back there on close —
    // otherwise Tab lands on <body> and keyboard users lose their place.
    triggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const trigger = triggerRef.current;
    return () => {
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    // Trap: cycle Tab/Shift+Tab across the dialog's focusable nodes so focus
    // never escapes to the page behind (copy buttons + close are all tabbable).
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute('disabled'));
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const outside = active === null || !dialog.contains(active);
    if (event.shiftKey && (outside || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (outside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="dialog"
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId} className="dialog-title">
          {kind === 'created' ? 'Subscriber created' : 'Secret rotated'}
        </h2>
        <p className="dialog-body">
          The secret is shown once. Copy it into your webhook sender now — it cannot be
          displayed again (only the last 4 characters are kept on file).
        </p>

        <dl className="reveal-list">
          <dt>Endpoint URL</dt>
          <dd>
            <code className="reveal-value">{url}</code>
            <CopyButton value={url} label="Copy URL" />
          </dd>
          <dt>Ingest token</dt>
          <dd>
            <code className="reveal-value">{token}</code>
            <CopyButton value={token} label="Copy token" />
          </dd>
          <dt>Secret</dt>
          <dd>
            <code className="reveal-value">{secret}</code>
            <CopyButton value={secret} label="Copy secret" />
          </dd>
        </dl>

        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" ref={closeRef} onClick={onClose}>
            I saved it — close
          </button>
        </div>
      </div>
    </div>
  );
}
