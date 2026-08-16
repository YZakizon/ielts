const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("guest translation routes enforce separate two-request limits", () => {
  assert.match(serverSource, /GUEST_SENTENCE_TRANSLATION_LIMIT \|\| 2/);
  assert.match(serverSource, /GUEST_VOCABULARY_LIMIT \|\| 2/);
  assert.match(serverSource, /app\.use\("\/api\/vocab", allowAuthenticatedOrGuestQuota\("vocab"\)\)/);
  assert.match(serverSource, /app\.use\("\/api\/translate-sentence", allowAuthenticatedOrGuestQuota\("translation"\)\)/);
});

test("signed users without subscriptions use the free-account allowance", () => {
  assert.match(serverSource, /error\.code === "SUBSCRIPTION_REQUIRED" && req\.user/);
  assert.match(serverSource, /NO_PLAN_REQUEST_LIMIT_PER_DAY \|\| 10/);
  assert.doesNotMatch(appSource, /authenticated && !hasSubscription/);
});
