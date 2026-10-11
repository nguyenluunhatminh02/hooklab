import { useEffect, useState } from 'react';

/**
 * Live mirror of `document.visibilityState` — drives the 2s poll pause
 * (BUILD_PLAN §5.2: hidden tab must stop refetching).
 */
export function useDocumentVisibility(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');

  useEffect(() => {
    const handleChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', handleChange);
    return () => document.removeEventListener('visibilitychange', handleChange);
  }, []);

  return visible;
}
