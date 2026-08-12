const assert = require("node:assert/strict");
const test = require("node:test");

const {
  accountPlanLabel,
  dailyLimitForPlan,
  effectiveAccountPlan,
  normalizeAccountPlan,
  planUsagePayload,
} = require("../account-plans");

test("normalizes known account plans and falls back to free", () => {
  assert.equal(normalizeAccountPlan("premium"), "premium");
  assert.equal(normalizeAccountPlan("Ultimate"), "ultimate");
  assert.equal(normalizeAccountPlan("unknown"), "free");
});

test("uses configured Premium and Ultimate daily limits", () => {
  assert.equal(dailyLimitForPlan("premium", "vocab"), 100);
  assert.equal(dailyLimitForPlan("premium", "translation"), 500);
  assert.equal(dailyLimitForPlan("ultimate", "vocab"), 500);
  assert.equal(dailyLimitForPlan("ultimate", "translation"), 1000);
});

test("reports remaining plan usage for vocab items and translations", () => {
  assert.deepEqual(planUsagePayload("premium", { vocab_used: 40, translation_used: 125 }), {
    plan: "premium",
    planLabel: "Premium",
    vocabDailyLimit: 100,
    vocabUsedToday: 40,
    vocabRemainingToday: 60,
    translationDailyLimit: 500,
    translationUsedToday: 125,
    translationRemainingToday: 375,
  });
});

test("treats admin plans as unlimited", () => {
  assert.equal(accountPlanLabel("admin"), "Admin");
  assert.deepEqual(planUsagePayload("admin", { vocab_used: 600, translation_used: 1200 }), {
    plan: "admin",
    planLabel: "Admin",
    vocabDailyLimit: null,
    vocabUsedToday: 600,
    vocabRemainingToday: null,
    translationDailyLimit: null,
    translationUsedToday: 1200,
    translationRemainingToday: null,
  });
});

test("configured admin email has effective admin plan after verification", () => {
  assert.equal(
    effectiveAccountPlan(
      {
        email: "owner@example.com",
        email_verified_at: new Date().toISOString(),
        plan: "free",
      },
      true,
    ),
    "admin",
  );
});
