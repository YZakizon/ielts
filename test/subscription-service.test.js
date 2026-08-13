const assert = require("node:assert/strict");
const test = require("node:test");
const { PLAN_DEFINITIONS, addMonth, addMonthsAnchored, stripeStatus } = require("../subscription-service");

test("subscription catalog exposes exactly Premium and Pro with independent limits", () => {
  assert.deepEqual(Object.keys(PLAN_DEFINITIONS), ["premium", "pro"]);
  assert.deepEqual(PLAN_DEFINITIONS.premium, { name: "Premium", vocabularyLimit: 500, sentenceLimit: 500 });
  assert.deepEqual(PLAN_DEFINITIONS.pro, { name: "Pro", vocabularyLimit: 1000, sentenceLimit: 1000 });
});

test("admin monthly periods retain their anchor at month boundaries", () => {
  assert.equal(addMonth(new Date("2026-01-31T10:00:00Z")).toISOString(), "2026-02-28T10:00:00.000Z");
  assert.equal(addMonth(new Date("2026-08-12T10:00:00Z")).toISOString(), "2026-09-12T10:00:00.000Z");
  assert.equal(addMonthsAnchored(new Date("2026-01-31T10:00:00Z"), 2).toISOString(), "2026-03-31T10:00:00.000Z");
});

test("scheduled cancellation remains active through the paid period", () => {
  const now = new Date("2026-08-20T00:00:00Z");
  assert.equal(stripeStatus("active", "2026-09-12T00:00:00Z", true, now), "active");
  assert.equal(stripeStatus("canceled", "2026-08-19T00:00:00Z", false, now), "cancelled");
  assert.equal(stripeStatus("past_due", "2026-09-12T00:00:00Z", false, now), "past_due");
});
