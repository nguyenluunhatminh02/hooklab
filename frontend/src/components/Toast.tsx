/**
 * Transient status message (04 §5 step 5: "record expired (7-day retention)").
 * `role="status"` announces without stealing focus; the dismiss button keeps a
 * message around until it has actually been read.
 */
export function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      <button type="button" className="btn btn-ghost" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
