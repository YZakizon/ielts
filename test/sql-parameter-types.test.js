const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("casts quota query parameters to stable PostgreSQL types", () => {
  assert.match(serverSource, /\$1::bigint/);
  assert.match(serverSource, /\$2::integer/);
  assert.match(serverSource, /\$3::integer/);
  assert.match(serverSource, /\$4::integer/);
  assert.match(serverSource, /\$5::integer/);
  assert.match(serverSource, /\$5::text/);
});

test("casts SUM and COUNT quota aggregates before parameter comparisons", () => {
  assert.match(serverSource, /COUNT\(\*\) FILTER \(WHERE created_at >= now\(\) - interval '1 minute'\)::integer AS minute_count/);
  assert.match(serverSource, /COUNT\(\*\) FILTER \(WHERE created_at >= now\(\) - interval '1 hour'\)::integer AS hour_count/);
  assert.match(serverSource, /COUNT\(\*\) FILTER \(WHERE created_at >= now\(\) - interval '1 day'\)::integer AS day_count/);
  assert.match(serverSource, /COALESCE\(SUM\(units\), 0\)::integer AS used/);
});

test("preserves the effective account plan before reserving authenticated quota", () => {
  assert.match(
    serverSource,
    /req\.user = \{ email: user\.email, id: user\.id, plan: effectiveAccountPlan\(user\) \};\n\s+return next\(\);/,
  );
});
