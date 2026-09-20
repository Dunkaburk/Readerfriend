/** Probe 4: does vi.waitFor hang in this environment? */
import { describe, expect, it, vi } from 'vitest';

describe('probe4', () => {
  it('waitFor resolves', async () => {
    let n = 0;
    await vi.waitFor(() => {
      n += 1;
      expect(n).toBeGreaterThan(2);
    });
    expect(n).toBeGreaterThanOrEqual(3);
  });
});
