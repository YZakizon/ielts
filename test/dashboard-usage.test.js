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
