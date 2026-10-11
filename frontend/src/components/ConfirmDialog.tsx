import { useEffect, useId, useRef, type KeyboardEvent } from 'react';

export interface ConfirmDialogProps {
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive dialogs open with focus on Cancel — the easy way out wins. */
  danger?: boolean;
  /** While the confirm action is in flight both buttons disable — no double submit. */
  submitting?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  submitting = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (danger) {
      cancelRef.current?.focus();
    } else {
      confirmRef.current?.focus();
    }
  }, [danger]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      if (submitting) return;
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;

    // Two-button trap: Tab cycles Cancel ↔ Confirm while the dialog is open.
    const cancel = cancelRef.current;
    const confirm = confirmRef.current;
    if (!cancel || !confirm) return;
    if (!event.shiftKey && document.activeElement === confirm) {
      event.preventDefault();
      cancel.focus();
    } else if (event.shiftKey && document.activeElement === cancel) {
      event.preventDefault();
      confirm.focus();
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="dialog"
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        {body ? <p className="dialog-body">{body}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel} disabled={submitting}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            ref={confirmRef}
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
