const freeAccountLimitPerDay = Number(process.env.FREE_ACCOUNT_LIMIT_PER_DAY || 50);

const accountPlans = {
  free: {
    label: "Free",
    vocabDailyLimit: Number(process.env.FREE_ACCOUNT_VOCAB_DAILY_LIMIT || freeAccountLimitPerDay),
    translationDailyLimit: Number(process.env.FREE_ACCOUNT_TRANSLATION_DAILY_LIMIT || freeAccountLimitPerDay),
  },
  premium: {
    label: "Premium",
    vocabDailyLimit: Number(process.env.PREMIUM_VOCAB_DAILY_LIMIT || 100),
    translationDailyLimit: Number(process.env.PREMIUM_TRANSLATION_DAILY_LIMIT || 500),
  },
  ultimate: {
    label: "Ultimate",
    vocabDailyLimit: Number(process.env.ULTIMATE_VOCAB_DAILY_LIMIT || 500),
    translationDailyLimit: Number(process.env.ULTIMATE_TRANSLATION_DAILY_LIMIT || 1000),
  },
  admin: {
    label: "Admin",
    vocabDailyLimit: null,
    translationDailyLimit: null,
  },
};

const validAccountPlans = new Set(Object.keys(accountPlans));

function normalizeAccountPlan(plan) {
  const normalized = String(plan || "").trim().toLowerCase();
  return validAccountPlans.has(normalized) ? normalized : "free";
}

function accountPlanLabel(plan) {
  return accountPlans[normalizeAccountPlan(plan)].label;
}

function effectiveAccountPlan(user, isConfiguredAdminEmail = false) {
  return user?.email_verified_at && isConfiguredAdminEmail ? "admin" : normalizeAccountPlan(user?.plan);
}

function dailyLimitForPlan(plan, quotaType) {
  const definition = accountPlans[normalizeAccountPlan(plan)];
  return quotaType === "vocab" ? definition.vocabDailyLimit : definition.translationDailyLimit;
}

function planUsagePayload(plan, usage = {}) {
  const planKey = normalizeAccountPlan(plan);
  const vocabUsed = Number(usage.vocab_used || 0);
  const translationUsed = Number(usage.translation_used || 0);
  const vocabDailyLimit = dailyLimitForPlan(planKey, "vocab");
  const translationDailyLimit = dailyLimitForPlan(planKey, "translation");

  return {
    plan: planKey,
    planLabel: accountPlanLabel(planKey),
    vocabDailyLimit,
    vocabUsedToday: vocabUsed,
    vocabRemainingToday: vocabDailyLimit === null ? null : Math.max(vocabDailyLimit - vocabUsed, 0),
    translationDailyLimit,
    translationUsedToday: translationUsed,
    translationRemainingToday:
      translationDailyLimit === null ? null : Math.max(translationDailyLimit - translationUsed, 0),
  };
}

module.exports = {
  accountPlans,
  accountPlanLabel,
  dailyLimitForPlan,
  effectiveAccountPlan,
  normalizeAccountPlan,
  planUsagePayload,
  validAccountPlans,
};
