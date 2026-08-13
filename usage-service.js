const { randomUUID } = require("crypto");

const TYPES = {
  vocabulary: { key: "vocabulary_translation", used: "vocabulary_used", limit: "vocabulary_limit" },
  sentence: { key: "sentence_translation", used: "sentence_used", limit: "sentence_limit" },
};

class UsageError extends Error {
  constructor(code, details = {}, statusCode = 429) {
    super(code === "SUBSCRIPTION_REQUIRED" ? "An active Premium or Pro subscription is required." : "Translation limit reached for this billing period.");
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
  }
}

class UsageService {
  constructor(pool, subscriptionService) { this.pool = pool; this.subscriptions = subscriptionService; }

  async reserve(userId, type, requestId) {
    const definition = TYPES[type];
    if (!definition) throw new Error("Invalid usage type.");
    if (!/^[A-Za-z0-9:_-]{8,200}$/.test(String(requestId || ""))) throw new UsageError("INVALID_REQUEST_ID", {}, 400);
    const key = `${definition.key}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const subscription = await this.subscriptions.getEffectiveSubscription(userId, client);
      if (!subscription) throw new UsageError("SUBSCRIPTION_REQUIRED", {}, 402);
      const period = await this.subscriptions.ensureUsagePeriod(subscription, client);
      if (!period) throw new UsageError("SUBSCRIPTION_REQUIRED", {}, 402);
      const duplicate = await client.query("SELECT amount FROM usage_transactions WHERE idempotency_key=$1", [key]);
      if (duplicate.rowCount) throw new UsageError("DUPLICATE_TRANSLATION_REQUEST", {}, 409);
      const locked = await client.query(`SELECT ${definition.used} AS used, ${definition.limit} AS limit FROM usage_periods WHERE id=$1 FOR UPDATE`, [period.id]);
      const used = Number(locked.rows[0].used);
      const limit = Number(locked.rows[0].limit);
      if (used >= limit) {
        const code = type === "vocabulary" ? "VOCABULARY_LIMIT_REACHED" : "SENTENCE_LIMIT_REACHED";
        throw new UsageError(code, { limit, used, remaining: 0 });
      }
      await client.query(`UPDATE usage_periods SET ${definition.used}=${definition.used}+1,updated_at=now() WHERE id=$1`, [period.id]);
      await client.query("INSERT INTO usage_transactions (id,user_id,usage_period_id,usage_type,amount,reference_id,idempotency_key) VALUES ($1,$2,$3,$4,1,$5,$6)", [randomUUID(), userId, period.id, definition.key, requestId, key]);
      await client.query("COMMIT");
      return { userId, periodId: period.id, type, requestId, key };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async refund(reservation) {
    const definition = TYPES[reservation.type];
    const refundKey = `${reservation.key}:refund`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query("INSERT INTO usage_transactions (id,user_id,usage_period_id,usage_type,amount,reference_type,reference_id,idempotency_key) VALUES ($1,$2,$3,$4,-1,'translation_refund',$5,$6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id", [randomUUID(), reservation.userId, reservation.periodId, definition.key, reservation.requestId, refundKey]);
      if (inserted.rowCount) await client.query(`UPDATE usage_periods SET ${definition.used}=GREATEST(${definition.used}-1,0),updated_at=now() WHERE id=$1`, [reservation.periodId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async history(userId) {
    const result = await this.pool.query(`SELECT up.*, p.key AS plan FROM usage_periods up JOIN plans p ON p.id=up.plan_id WHERE up.user_id=$1 ORDER BY up.period_start DESC LIMIT 24`, [userId]);
    return result.rows;
  }
}

module.exports = { TYPES, UsageError, UsageService };
