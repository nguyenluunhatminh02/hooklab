import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { useDocumentVisibility } from './useDocumentVisibility';

/**
 * The poll-pause contract (BUILD_PLAN §5.2): consumers read the live tab
 * visibility, so the hook must report the initial state, follow every
 * `visibilitychange` event, and drop its listener on unmount (otherwise a
 * stale listener would outlive the component).
 */

/**
 * jsdom keeps `visibilityState`/`hidden` read-only, so the test owns both
 * getters — and keeps them consistent, exactly as the platform does.
 */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => state === 'hidden',
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/**
 * The `visibilitychange` handler `addEventListener` received during render.
 * `MockInstance<typeof document.addEventListener>` keeps `mock.calls` as the
 * real overload tuple; vitest 4's generic `spyOn` signatures make
 * `ReturnType<typeof vi.spyOn>` collapse to `any`, which erases the parameter
 * types and turns the destructuring below into an implicit `any`.
 */
function registeredListener(
  addSpy: MockInstance<typeof document.addEventListener>,
): EventListener {
  const call = addSpy.mock.calls.find(([eventName]) => eventName === 'visibilitychange');
  if (!call) throw new Error('useDocumentVisibility never registered a listener');
  return call[1] as EventListener;
}

describe('useDocumentVisibility', () => {
  afterEach(() => {
    setVisibility('visible');
    vi.restoreAllMocks();
  });

  it('returns true when the document starts visible', () => {
    setVisibility('visible');

    const { result } = renderHook(() => useDocumentVisibility());

    expect(document.hidden).toBe(false);
    expect(document.visibilityState).toBe('visible');
    expect(result.current).toBe(true);
  });

  it('returns false when the document starts hidden', () => {
    setVisibility('hidden');

    const { result } = renderHook(() => useDocumentVisibility());

    expect(document.hidden).toBe(true);
    expect(result.current).toBe(false);
  });

  it('flips to false on visibilitychange with document.hidden mocked true', () => {
    setVisibility('visible');
    const { result } = renderHook(() => useDocumentVisibility());
    expect(result.current).toBe(true);

    setVisibility('hidden');
    expect(result.current).toBe(false);
  });

  it('flips back to true when the tab becomes visible again', () => {
    setVisibility('hidden');
    const { result } = renderHook(() => useDocumentVisibility());
    expect(result.current).toBe(false);

    setVisibility('visible');
    expect(result.current).toBe(true);
  });

  it('detaches its visibilitychange listener on unmount', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    const { unmount } = renderHook(() => useDocumentVisibility());
    const listener = registeredListener(addSpy);
    expect(removeSpy).not.toHaveBeenCalledWith('visibilitychange', listener);

    unmount();

    // The unmount getter is the very one the effect registered in render.
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', listener);
  });
});
