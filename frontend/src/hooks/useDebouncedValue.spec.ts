import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_DEBOUNCE_MS } from '../config';
import { useDebouncedValue } from './useDebouncedValue';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses rapid changes to the last value after 300 ms', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, SEARCH_DEBOUNCE_MS), {
      initialProps: { value: 's' },
    });
    expect(SEARCH_DEBOUNCE_MS).toBe(300);

    rerender({ value: 'sh' });
    rerender({ value: 'shi' });
    rerender({ value: 'ship' });
    // Nothing propagates until the window closes — one value, not four.
    expect(result.current).toBe('s');

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe('s');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('ship');
  });

  it('restarts the window on every change (last keystroke wins)', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, SEARCH_DEBOUNCE_MS), {
      initialProps: { value: 'a' },
    });

    rerender({ value: 'ab' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ value: 'abc' });

    // The first keystroke's window is abandoned — still the original value.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe('a');

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe('abc');
  });
});
