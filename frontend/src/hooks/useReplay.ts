import { useMutation, useQueryClient } from '@tanstack/react-query';
import { replayRecord } from '../api/records';

/**
 * Replay mutation (04 §5 step 6): a successful replay adds a child row and
 * updates the record detail, so both are invalidated — while metrics are
 * deliberately left alone because badges come from the canonical count and
 * replay rows must never bump them.
 */
export function useReplay(recordId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => replayRecord(recordId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['records'] });
      void queryClient.invalidateQueries({ queryKey: ['record', recordId] });
    },
  });
}
