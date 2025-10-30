import { describe, expect, it } from 'vitest';
import { getNextOrder, sortByOrder } from '../../src/lib/array/order.js';

describe('array/order helpers', () => {
  it('computes next order accounting for max', () => {
    const items = [{ order: 2 }, { order: 5 }, { order: 3 }];
    expect(getNextOrder(items, (item) => item.order)).toBe(6);
  });

  it('returns 1 when items are empty', () => {
    expect(getNextOrder([], () => 0)).toBe(1);
    expect(getNextOrder(null, () => 0)).toBe(1);
  });

  it('sorts by order and original index for ties', () => {
    const result = sortByOrder([
      { order: 3, name: 'c' },
      { order: 1, name: 'a' },
      { name: 'b' }
    ]);
    expect(result.map((item) => item.name)).toEqual(['a', 'c', 'b']);
  });
});
