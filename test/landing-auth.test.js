const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("landing page remains visible when login is not configured", () => {
  assert.doesNotMatch(
    appSource,
    /if \(!session\.configured\) \{\s+showAuthPrompt\("Account login is not configured on the server\."\);\s+setLoginStatus\("Login is not configured on the server\.", true\);\s+return;\s+\}/,
  );
  assert.match(
    appSource,
    /if \(!session\.configured\) \{\s+showApp\(\);\s+startApp\(\);\s+return;\s+\}/,
  );
  assert.match(appSource, /if \(loginRequired === "not_configured"\) \{\s+return "";\s+\}/);
  assert.match(appSource, /accountBtn\.classList\.toggle\("hidden", authenticated\);/);
  assert.match(appSource, /if \(currentSession\?\.configured === false\) \{\s+billingStatus\.textContent = "Account login is not configured on this server\.";\s+return;\s+\}/);
});
