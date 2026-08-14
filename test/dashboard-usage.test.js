const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dashboardHtml = fs.readFileSync(path.join(__dirname, "..", "dashboard.html"), "utf8");
const dashboardSource = fs.readFileSync(path.join(__dirname, "..", "dashboard.js"), "utf8");

test("dashboard reports inactive subscriptions clearly and includes TTS usage", () => {
  assert.match(dashboardSource, /No active subscription/);
  assert.match(dashboardSource, /session\.ttsUsage/);
  assert.match(dashboardHtml, /id="dashboardTts"/);
});

test("dashboard formats unlimited subscription usage without converting null to zero", () => {
  const functionSource = dashboardSource.match(/function usedLimit\(usage\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource, "usedLimit should exist");
  const usedLimit = Function(`${functionSource}; return usedLimit;`)();

  assert.equal(usedLimit({ used: 5000, limit: null }), "5,000 / Unlimited");
  assert.equal(usedLimit({ used: 5, limit: 0 }), "5 / 0");
  assert.equal(usedLimit(null), "No active subscription");
});
