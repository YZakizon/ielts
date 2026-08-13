const assert = require("node:assert/strict");
const test = require("node:test");
const { UsageError, UsageService } = require("../usage-service");

function fakePool({ used = 499, limit = 500, duplicate = false } = {}) {
  const state = { used, transactions: new Set(duplicate ? ["vocabulary_translation:req-12345"] : []) };
  const client = {
    async query(sql, values = []) {
      if (/SELECT amount FROM usage_transactions/.test(sql)) return { rowCount: state.transactions.has(values[0]) ? 1 : 0, rows: state.transactions.has(values[0]) ? [{ amount: 1 }] : [] };
      if (/SELECT vocabulary_used AS used/.test(sql)) return { rows: [{ used: state.used, limit }] };
      if (/UPDATE usage_periods SET vocabulary_used=vocabulary_used\+1/.test(sql)) { state.used += 1; return { rowCount: 1, rows: [] }; }
      if (/INSERT INTO usage_transactions/.test(sql)) { state.transactions.add(values[5]); return { rowCount: 1, rows: [{ id: values[0] }] }; }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  return { state, connect: async () => client };
}

function subscriptionService() {
  return {
    async getEffectiveSubscription() { return { id: "subscription", user_id: 7 }; },
    async ensureUsagePeriod() { return { id: "period" }; },
  };
}

test("atomic reservation allows the final vocabulary request", async () => {
  const pool = fakePool();
  const usage = new UsageService(pool, subscriptionService());
  await usage.reserve(7, "vocabulary", "req-12345");
  assert.equal(pool.state.used, 500);
});

test("reservation blocks at the independent limit", async () => {
  const usage = new UsageService(fakePool({ used: 500 }), subscriptionService());
  await assert.rejects(() => usage.reserve(7, "vocabulary", "req-12345"), (error) => {
    assert.ok(error instanceof UsageError);
    assert.equal(error.code, "VOCABULARY_LIMIT_REACHED");
    return true;
  });
});

test("duplicate translation request is not charged again", async () => {
  const pool = fakePool({ duplicate: true });
  const usage = new UsageService(pool, subscriptionService());
  await assert.rejects(() => usage.reserve(7, "vocabulary", "req-12345"), (error) => error.code === "DUPLICATE_TRANSLATION_REQUEST");
  assert.equal(pool.state.used, 499);
});
