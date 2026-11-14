import { beforeEach, describe, expect, it, vi } from 'vitest';

const trialBalance = vi.fn();
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  journalControllerTrialBalance: (...args: unknown[]) => trialBalance(...args),
}));

const { fetchTrialBalance } = await import('./AccountsPage');

describe('AccountsPage trial balance request', () => {
  beforeEach(() => trialBalance.mockReset());

  it("passes the query's signal as the request option, not as a query parameter", async () => {
    trialBalance.mockResolvedValue({ data: { rows: [] }, status: 200, headers: new Headers() });
    const controller = new AbortController();
    await expect(fetchTrialBalance(controller.signal)).resolves.toEqual({ rows: [] });
    expect(trialBalance).toHaveBeenCalledTimes(1);
    const [params, options] = trialBalance.mock.calls[0] as [Record<string, unknown>, { signal?: AbortSignal }];
    expect(params).toEqual({});
    expect(options.signal).toBe(controller.signal);
  });
});
