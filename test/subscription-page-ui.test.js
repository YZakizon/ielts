const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rootDir = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(rootDir, "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(rootDir, "styles.css"), "utf8");

test("subscription page renders a modern pricing catalog without account summary", () => {
  const headingRule = stylesSource.match(/\.subscription-heading h1 \{[^}]+\}/)?.[0] || "";

  assert.match(indexSource, /Choose the plan that matches your study pace\./);
  assert.match(appSource, /function planFeatureList\(plan\)/);
  assert.match(appSource, /function formatPlanLimit\(value\)/);
  assert.match(appSource, /\? "Unlimited"/);
  assert.match(appSource, /Unlimited monthly practice for intensive preparation/);
  assert.match(appSource, /AI-powered practice guidance for sharper IELTS study/);
  assert.doesNotMatch(appSource, /Usage dashboard and billing history/);
  assert.match(appSource, /class="plan-card-header"/);
  assert.match(appSource, /class="plan-quota-grid"/);
  assert.match(appSource, /class="plan-features"/);
  assert.doesNotMatch(indexSource, /id="subscriptionCurrent"/);
  assert.doesNotMatch(appSource, /current-plan-summary|usage-meter|subscriptionCurrent/);
  assert.match(stylesSource, /\.plan-card-header/);
  assert.match(stylesSource, /\.plan-features li::before/);
  assert.doesNotMatch(stylesSource, /\.subscription-current|\.current-plan-summary|\.usage-meter/);
  assert.match(stylesSource, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(headingRule, /font-size:\s*clamp\(/);
});
