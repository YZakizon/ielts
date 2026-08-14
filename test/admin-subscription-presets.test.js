const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rootDir = path.join(__dirname, "..");
const adminHtml = fs.readFileSync(path.join(rootDir, "admin.html"), "utf8");
const adminSource = fs.readFileSync(path.join(rootDir, "admin.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(rootDir, "styles.css"), "utf8");

test("admin subscription grants offer expiration presets", () => {
  assert.match(adminHtml, /id="adminSubscriptionDialog"/);
  assert.match(adminHtml, /<option value="unlimited">Unlimited<\/option>/);
  assert.match(adminHtml, /<option value="1-month">1 month<\/option>/);
  assert.match(adminHtml, /<option value="3-months">3 months<\/option>/);
  assert.match(adminHtml, /<option value="6-months">6 months<\/option>/);
  assert.match(adminHtml, /<option value="1-year">1 year<\/option>/);
  assert.match(adminHtml, /<option value="custom">Custom date<\/option>/);
  assert.match(adminHtml, /type="button" data-admin-subscription-cancel aria-label="Close"/);
  assert.match(adminHtml, /type="button" data-admin-subscription-cancel>Cancel<\/button>/);
  assert.match(adminSource, /function requestSubscriptionGrant\(plan\)/);
  assert.match(adminSource, /function expiresAtForSubscriptionChoice\(preset, customDate\)/);
  assert.match(adminSource, /if \(preset === "unlimited"\) return null/);
  assert.match(adminSource, /adminSubscriptionExpiryPreset\.addEventListener\("change"/);
  assert.match(adminSource, /button\.addEventListener\("click", \(\) => adminSubscriptionDialog\.close\("cancel"\)\)/);
  assert.match(stylesSource, /\.admin-subscription-dialog form/);
});
