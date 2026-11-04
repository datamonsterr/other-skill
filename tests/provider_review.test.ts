import { describe, it, expect, mock } from "bun:test";
import { DecisionProvider, isFreeModel } from "../lib/provider";
describe("reviewed free provider", () => {
  it("rejects deceptive suffixes including direct requests without HTTP", async () => {
    const fetchFn = mock(async () => new Response("{}"));
    expect(isFreeModel("paid/model:free-but-paid")).toBe(false);
    const provider = new DecisionProvider({ apiKey: "test", fetchFn });
    await expect(
      provider.sendDecisionRequest({
        model: "paid/model:free-but-paid",
        state: {},
        questions: {},
      }),
    ).rejects.toThrow(/Invalid decision model id/);
    expect(fetchFn).toHaveBeenCalledTimes(0);
  });
  it("bounds stalled response JSON and retries", async () => {
    const fetchFn = mock(
      async () => ({ ok: true, text: () => new Promise(() => {}) }) as Response,
    );
    const provider = new DecisionProvider({
      apiKey: "test",
      fetchFn,
      timeoutMs: 15,
      retries: 2,
      retryDelayMs: 1,
    });
    const start = Date.now();
    await expect(
      provider.sendDecisionRequest({
        model: "inception/mercury-decide:free",
        state: {},
        questions: {},
      }),
    ).rejects.toThrow(/timed out|abort/i);
    expect(Date.now() - start).toBeLessThan(500);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  }, 1000);
});
