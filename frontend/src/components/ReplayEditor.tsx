import { useEffect, useId, useState, type FormEvent } from 'react';
import '../styles/replay.css';

export interface ReplayEditorProps {
  /** Pretty-printed original body — the preset the user edits (04 §6). */
  defaultBody: string;
  /** 410 revoked: the editor stays visible with a banner stating why it is off. */
  disabled?: boolean;
  /** Visible reason next to a disabled editor — controls are never silently greyed out. */
  reason?: string;
  submitting?: boolean;
  /** Fires only with a parsed JSON object; arrays and broken JSON never reach it. */
  onSubmit: (body: Record<string, unknown>) => void;
}

type ParseResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string };

function parseReplayBody(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : 'Invalid JSON.' };
  }
  // ReplayDto is @IsObject — a top-level array or null would be a guaranteed 400 (02 §14).
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'Replay body must be a JSON object.' };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

function prettyPrint(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // Non-JSON originals (rare, but rawBody is a Text column) still have to be editable.
    return raw;
  }
}

export function ReplayEditor({
  defaultBody,
  disabled = false,
  reason,
  submitting = false,
  onSubmit,
}: ReplayEditorProps) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const reasonId = `${inputId}-reason`;
  const [value, setValue] = useState(() => prettyPrint(defaultBody));
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  // The parent can swap records without remounting (no key guaranteed), so a
  // new preset must replace the old payload — and its stale validation error.
  useEffect(() => {
    setValue(prettyPrint(defaultBody));
    setError(null);
    setAttempted(false);
  }, [defaultBody]);

  function handleChange(next: string): void {
    setValue(next);
    if (!attempted) return;
    const result = parseReplayBody(next);
    setError(result.ok ? null : result.message);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAttempted(true);
    const result = parseReplayBody(value);
    setError(result.ok ? null : result.message);
    // Invalid input never submits — the inline error is the feedback, not a dead button.
    if (!result.ok) return;
    onSubmit(result.body);
  }

  const describedBy = [error !== null ? errorId : null, disabled ? reasonId : null]
    .filter((id): id is string => id !== null)
    .join(' ');

  return (
    <form className="replay-editor" onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label htmlFor={inputId}>Replay body</label>
        <textarea
          id={inputId}
          className="mono"
          rows={10}
          spellCheck={false}
          value={value}
          disabled={disabled || submitting}
          aria-invalid={error !== null ? true : undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          onChange={(event) => handleChange(event.target.value)}
        />
        {error !== null ? (
          <p id={errorId} className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {disabled ? (
        <p id={reasonId} className="replay-reason" role="status">
          {reason ?? 'Replay is disabled for this subscriber.'}
        </p>
      ) : null}

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={disabled || submitting}>
          {submitting ? 'Replaying…' : 'Replay request'}
        </button>
      </div>
    </form>
  );
}
