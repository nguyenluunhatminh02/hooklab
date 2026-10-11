import { useState } from 'react';

interface CopyButtonProps {
  value: string;
  label: string;
}

/** Clipboard copy with a polite live region so screen readers hear the result. */
export function CopyButton({ value, label }: CopyButtonProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  }

  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={copy}>
        {label}
      </button>
      <span role="status" aria-live="polite" className="copy-status">
        {status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : ''}
      </span>
    </>
  );
}
