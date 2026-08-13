const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const adminSource = fs.readFileSync(path.join(__dirname, "..", "admin.js"), "utf8");
const dashboardSource = fs.readFileSync(path.join(__dirname, "..", "dashboard.js"), "utf8");

test("admin users API aggregates current usage for all listed users", () => {
  assert.match(serverSource, /user_id = ANY\(\$1::bigint\[\]\)/);
  assert.match(serverSource, /usageByUserId\.get\(Number\(row\.id\)\)/);
  assert.match(serverSource, /usage: adminUsagePayload\(subscription, usage\)/);
});

test("dashboard uses subscription summary period fields", () => {
  assert.match(dashboardSource, /subscription\.periodEnd/);
  assert.doesNotMatch(dashboardSource, /subscription\.currentPeriodEnd/);
});

test("admin usage reports rolling free request limits and daily plan limits", () => {
  assert.match(serverSource, /created_at >= now\(\) - interval '1 minute'/);
  assert.match(serverSource, /created_at >= now\(\) - interval '1 hour'/);
  assert.match(serverSource, /created_at >= now\(\) - interval '1 day'/);
  assert.match(serverSource, /const subscriptionUsage = subscription\?\.usage/);
  assert.match(serverSource, /requestLimits:/);
});

test("admin UI renders requests, vocabulary, and translation usage", () => {
  assert.match(adminSource, /<b>Requests<\/b>/);
  assert.match(adminSource, /<b>Vocabulary<\/b>/);
  assert.match(adminSource, /<b>Translations<\/b>/);
  assert.match(adminSource, /No rate limit/);
});
