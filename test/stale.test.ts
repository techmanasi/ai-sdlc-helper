import { describe, expect, test } from 'vitest';
import { staleLabel } from '../web/ui/src/stale.js';

describe('staleLabel', () => {
  test('fresh facts have no mark; old ones say how old', () => {
    expect(staleLabel(null)).toBe('');
    expect(staleLabel(undefined)).toBe('');
    expect(staleLabel(9_999)).toBe('');
    expect(staleLabel(42_000)).toBe('as of 42 s ago');
    expect(staleLabel(180_000)).toBe('as of 3 min ago');
    expect(staleLabel(7_200_000)).toBe('as of 2 h ago');
  });
});
