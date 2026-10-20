import { beforeEach, describe, expect, it } from 'vitest';
import { useSelection } from './stores';
beforeEach(() => { useSelection.getState().setScope('unrecognized'); useSelection.getState().clear(); });
describe('authoritative selection reconciliation', () => {
  it('drops processed images and anchor while retaining remaining selections', () => {
    const store = useSelection.getState(); store.setMany(['a', 'b', 'c']); store.toggle('d');
    store.retain('unrecognized', ['b', 'c', 'new']);
    expect([...useSelection.getState().ids]).toEqual(['b', 'c']); expect(useSelection.getState().anchor).toBeNull();
    store.retain('unrecognized', ['new']); expect(useSelection.getState().ids.size).toBe(0);
  });
  it('does not affect a different page or rebuild unchanged selections after pagination', () => {
    const store = useSelection.getState(); store.setMany(['a', 'b']); const ids = useSelection.getState().ids;
    store.retain('gallery', []); expect(useSelection.getState().ids).toBe(ids);
    store.retain('unrecognized', ['a', 'b', 'c', 'd']); expect(useSelection.getState().ids).toBe(ids);
  });
});
