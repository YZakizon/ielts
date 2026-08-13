const assert = require("node:assert/strict");
const test = require("node:test");

const { ttsLockKeys, withTtsGenerationGate } = require("../server");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("anonymous TTS generation gates different guests sharing one subject hash", async () => {
  const firstDone = deferred();
  const events = [];
  const sharedSubjectHash = "same-ip-quota-key";

  const first = withTtsGenerationGate(
    { userId: null, guestId: "11111111-1111-4111-8111-111111111111", subjectHash: sharedSubjectHash },
    async () => {
      events.push("first-start");
      await firstDone.promise;
      events.push("first-end");
    },
  );

  const second = withTtsGenerationGate(
    { userId: null, guestId: "22222222-2222-4222-8222-222222222222", subjectHash: sharedSubjectHash },
    async () => {
      events.push("second-start");
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first-start"]);

  firstDone.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
});

test("TTS anonymous lock keys include shared subject hash independently", () => {
  assert.deepEqual(
    ttsLockKeys({ userId: null, guestId: "guest-id", subjectHash: "shared-ip" }),
    ["guest:guest-id", "ip:shared-ip"],
  );
});
