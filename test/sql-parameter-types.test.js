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

test("serializes TTS quota charging and stores millisecond duration", () => {
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS tts_usage_events/);
  assert.match(serverSource, /generated_duration_ms integer NOT NULL/);
  assert.match(serverSource, /charged_duration_ms integer NOT NULL/);
  assert.match(serverSource, /const ttsGenerationGates = new Map\(\)/);
  assert.match(serverSource, /async function withTtsGenerationGate\(identity, task\)/);
  assert.match(serverSource, /Promise\.all\(gateKeys\.map/);
  assert.match(serverSource, /for \(const gateKey of gateKeys\)/);
  assert.match(serverSource, /ttsGenerationGates\.set\(gateKey, blocker\)/);
  assert.match(serverSource, /pg_advisory_xact_lock\(hashtextextended\(\$1::text, 0\)\)/);
  assert.match(serverSource, /Math\.min\(result\.durationMs, usage\.remainingMs\)/);
});

test("gates TTS quota check and provider call before recording usage", () => {
  const routeStart = serverSource.indexOf('app.post("/api/tts"');
  const gateIndex = serverSource.indexOf("withTtsGenerationGate(identity", routeStart);
  const usageIndex = serverSource.indexOf("const before = await getTtsUsage(identity)", gateIndex);
  const providerIndex = serverSource.indexOf("const generated = await fetchTtsAudio(text)", gateIndex);
  const recordIndex = serverSource.indexOf("const recorded = await recordTtsUsage(identity, generated)", gateIndex);

  assert.ok(routeStart > -1);
  assert.ok(gateIndex > routeStart);
  assert.ok(usageIndex > gateIndex);
  assert.ok(providerIndex > usageIndex);
  assert.ok(recordIndex > providerIndex);
});
