import { useEffect, useState } from 'react';

/**
 * Collapses rapid input into one value `delayMs` after the last change.
 * Timeline search is debounced at 300 ms (`SEARCH_DEBOUNCE_MS`) so every
 * keystroke does not become a request (04 §5 step 4).
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
