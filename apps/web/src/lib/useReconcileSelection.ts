import { useEffect } from 'react';
import { useSelection } from './stores';

/** Only reconcile authoritative loaded pages, never an optimistic hide or an incomplete fetch. */
export function useReconcileSelection(scope: string, available: readonly string[], ready: boolean) {
  const selected = useSelection(s => s.ids);
  useEffect(() => {
    if (ready) useSelection.getState().retain(scope, available);
  }, [scope, available, ready, selected]);
}
