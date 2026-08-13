const { randomUUID } = require("crypto");

const PLAN_DEFINITIONS = Object.freeze({
  premium: { name: "Premium", vocabularyLimit: 500, sentenceLimit: 500 },
  pro: { name: "Pro", vocabularyLimit: 1000, sentenceLimit: 1000 },
});

function addMonth(date) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function addMonthsAnchored(date, months) {
  const source = new Date(date);
  const result = new Date(source);
  const day = source.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function stripeStatus(status, periodEnd, cancelAtPeriodEnd, now = new Date()) {
  if (cancelAtPeriodEnd && periodEnd && new Date(periodEnd) > now) return "active";
  if (["active"].includes(status)) return "active";
  if (["past_due", "unpaid"].includes(status)) return "past_due";
  if (["canceled", "cancelled"].includes(status)) return "cancelled";
  return "expired";
}

class SubscriptionService {
  constructor(pool, { pastDueGraceDays = 0 } = {}) {
    this.pool = pool;
    this.pastDueGraceDays = Math.max(0, Number(pastDueGraceDays) || 0);
  }

  async initializeSchema() {
    await this.pool.query(`
      ALTER TABLE app_users ADD COLUMN IF NOT EXISTS stripe_customer_id text;
      CREATE UNIQUE INDEX IF NOT EXISTS app_users_stripe_customer_id_uidx
        ON app_users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS plans (
        id uuid PRIMARY KEY,
        key text NOT NULL UNIQUE,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        stripe_product_id text,
        stripe_monthly_price_id text,
        stripe_yearly_price_id text,
        vocabulary_translation_limit integer NOT NULL CHECK (vocabulary_translation_limit > 0),
        sentence_translation_limit integer NOT NULL CHECK (sentence_translation_limit > 0),
        is_active boolean NOT NULL DEFAULT true,
        is_public boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id uuid PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        plan_id uuid NOT NULL REFERENCES plans(id),
        source text NOT NULL CHECK (source IN ('stripe', 'admin')),
        status text NOT NULL CHECK (status IN ('active', 'past_due', 'cancelled', 'expired')),
        stripe_customer_id text,
        stripe_subscription_id text,
        stripe_price_id text,
        billing_interval text CHECK (billing_interval IN ('monthly', 'yearly')),
        current_period_start timestamptz,
        current_period_end timestamptz,
        cancel_at_period_end boolean NOT NULL DEFAULT false,
        cancelled_at timestamptz,
        starts_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz,
        pending_plan_id uuid REFERENCES plans(id),
        stripe_state_updated_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((source = 'admin' AND stripe_subscription_id IS NULL) OR source = 'stripe')
      );
      CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_stripe_subscription_uidx
        ON subscriptions (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS subscriptions_user_status_idx ON subscriptions (user_id, status, source);
      CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_active_admin_user_uidx
        ON subscriptions (user_id) WHERE source = 'admin' AND status = 'active';

      CREATE TABLE IF NOT EXISTS subscription_admin_grants (
        id uuid PRIMARY KEY,
        subscription_id uuid NOT NULL REFERENCES subscriptions(id),
        granted_by_user_id bigint NOT NULL REFERENCES app_users(id),
        reason text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS usage_periods (
        id uuid PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        subscription_id uuid NOT NULL REFERENCES subscriptions(id),
        plan_id uuid NOT NULL REFERENCES plans(id),
        period_start timestamptz NOT NULL,
        period_end timestamptz NOT NULL,
        vocabulary_limit integer NOT NULL,
        sentence_limit integer NOT NULL,
        vocabulary_used integer NOT NULL DEFAULT 0 CHECK (vocabulary_used >= 0),
        sentence_used integer NOT NULL DEFAULT 0 CHECK (sentence_used >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (subscription_id, period_start, period_end)
      );
      CREATE INDEX IF NOT EXISTS usage_periods_user_period_idx ON usage_periods (user_id, period_start DESC);

      CREATE TABLE IF NOT EXISTS usage_transactions (
        id uuid PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        usage_period_id uuid NOT NULL REFERENCES usage_periods(id),
        usage_type text NOT NULL CHECK (usage_type IN ('vocabulary_translation', 'sentence_translation')),
        amount integer NOT NULL CHECK (amount IN (-1, 1)),
        reference_type text NOT NULL DEFAULT 'translation_request',
        reference_id text NOT NULL,
        idempotency_key text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS stripe_webhook_events (
        id uuid PRIMARY KEY,
        stripe_event_id text NOT NULL UNIQUE,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        processed_at timestamptz,
        processing_error text,
        processing_started_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_state_updated_at timestamptz;
      ALTER TABLE stripe_webhook_events ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

      CREATE TABLE IF NOT EXISTS billing_audit_events (
        id uuid PRIMARY KEY,
        event_type text NOT NULL,
        actor_user_id bigint REFERENCES app_users(id),
        target_user_id bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        old_value jsonb,
        new_value jsonb,
        reason text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const ids = {
      premium: "11111111-1111-4111-8111-111111111111",
      pro: "22222222-2222-4222-8222-222222222222",
    };
    for (const [key, definition] of Object.entries(PLAN_DEFINITIONS)) {
      await this.pool.query(
        `INSERT INTO plans (id, key, name, description, vocabulary_translation_limit, sentence_translation_limit)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
           vocabulary_translation_limit = EXCLUDED.vocabulary_translation_limit,
           sentence_translation_limit = EXCLUDED.sentence_translation_limit, updated_at = now()`,
        [ids[key], key, definition.name, `${definition.name} IELTS translation subscription`, definition.vocabularyLimit, definition.sentenceLimit],
      );
    }
  }

  async configureStripePrices(prices) {
    for (const key of Object.keys(PLAN_DEFINITIONS)) {
      if (prices[key]) {
        await this.pool.query("UPDATE plans SET stripe_monthly_price_id = $1, updated_at = now() WHERE key = $2", [prices[key], key]);
      }
    }
  }

  async listPlans(publicOnly = true) {
    const result = await this.pool.query(
      `SELECT id, key, name, description, stripe_product_id, stripe_monthly_price_id,
              vocabulary_translation_limit, sentence_translation_limit, is_active, is_public
       FROM plans WHERE is_active = true ${publicOnly ? "AND is_public = true" : ""} ORDER BY vocabulary_translation_limit`,
    );
    return result.rows;
  }

  async getPlan(key) {
    const result = await this.pool.query("SELECT * FROM plans WHERE key = $1 AND is_active = true LIMIT 1", [key]);
    return result.rows[0] || null;
  }

  async getEffectiveSubscription(userId, client = this.pool) {
    await client.query(`UPDATE subscriptions SET status = 'expired', updated_at = now()
      WHERE user_id = $1 AND source = 'admin' AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= now()`, [userId]);
    const result = await client.query(
      `SELECT s.*, p.key AS plan_key, p.name AS plan_name,
              p.vocabulary_translation_limit, p.sentence_translation_limit
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = $1 AND (s.status = 'active' OR (s.status = 'past_due' AND s.updated_at + make_interval(days => $2) > now())) AND s.starts_at <= now()
         AND (s.expires_at IS NULL OR s.expires_at > now())
         AND (s.source = 'admin' OR s.current_period_end > now())
       ORDER BY CASE s.source WHEN 'admin' THEN 0 ELSE 1 END, s.updated_at DESC LIMIT 1`,
      [userId, this.pastDueGraceDays],
    );
    return result.rows[0] || null;
  }

  async ensureUsagePeriod(subscription, client = this.pool) {
    let start = subscription.current_period_start || subscription.starts_at;
    let end = subscription.current_period_end;
    if (subscription.source === "admin") {
      const anchor = new Date(start);
      start = anchor;
      end = end ? new Date(end) : addMonthsAnchored(anchor, 1);
      const now = new Date();
      let periodNumber = 1;
      while (end <= now) {
        start = end;
        periodNumber += 1;
        end = addMonthsAnchored(anchor, periodNumber);
      }
      if (subscription.expires_at && end > new Date(subscription.expires_at)) end = new Date(subscription.expires_at);
      if (end <= now) return null;
      if (subscription.pending_plan_id) {
        const existing = await client.query("SELECT id FROM usage_periods WHERE subscription_id=$1 AND period_start=$2 AND period_end=$3", [subscription.id, start, end]);
        if (!existing.rowCount) {
          const pending = await client.query("SELECT * FROM plans WHERE id=$1", [subscription.pending_plan_id]);
          if (pending.rows[0]) {
            await client.query("UPDATE subscriptions SET plan_id=$1,pending_plan_id=NULL,updated_at=now() WHERE id=$2", [subscription.pending_plan_id, subscription.id]);
            subscription.plan_id = pending.rows[0].id;
            subscription.vocabulary_translation_limit = pending.rows[0].vocabulary_translation_limit;
            subscription.sentence_translation_limit = pending.rows[0].sentence_translation_limit;
          }
        }
      }
    }
    if (!start || !end) return null;
    const id = randomUUID();
    const result = await client.query(
      `INSERT INTO usage_periods (id, user_id, subscription_id, plan_id, period_start, period_end,
          vocabulary_limit, sentence_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (subscription_id, period_start, period_end) DO UPDATE SET updated_at = usage_periods.updated_at
       RETURNING *`,
      [id, subscription.user_id, subscription.id, subscription.plan_id, start, end,
        subscription.vocabulary_translation_limit, subscription.sentence_translation_limit],
    );
    return result.rows[0];
  }

  async getSubscriptionSummary(userId) {
    const subscription = await this.getEffectiveSubscription(userId);
    if (!subscription) return { plan: null, source: null, status: "none", usage: null };
    const usage = await this.ensureUsagePeriod(subscription);
    return {
      id: subscription.id, plan: subscription.plan_key, planName: subscription.plan_name,
      source: subscription.source, status: subscription.status,
      periodStart: usage?.period_start || subscription.current_period_start,
      periodEnd: usage?.period_end || subscription.current_period_end,
      expiresAt: subscription.expires_at, cancelAtPeriodEnd: subscription.cancel_at_period_end,
      usage: usage && {
        vocabulary: { used: usage.vocabulary_used, limit: usage.vocabulary_limit, remaining: Math.max(usage.vocabulary_limit - usage.vocabulary_used, 0) },
        sentence: { used: usage.sentence_used, limit: usage.sentence_limit, remaining: Math.max(usage.sentence_limit - usage.sentence_used, 0) },
      },
    };
  }

  async grantAdminSubscription({ userId, planKey, actorUserId, startsAt = new Date(), expiresAt = null, reason }) {
    const plan = await this.getPlan(planKey);
    if (!plan) throw Object.assign(new Error("Invalid plan."), { statusCode: 400 });
    if (!reason?.trim()) throw Object.assign(new Error("A reason is required."), { statusCode: 400 });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const old = await this.getEffectiveSubscription(userId, client);
      if (old?.source === "admin") {
        const isUpgrade = Number(plan.vocabulary_translation_limit) >= Number(old.vocabulary_translation_limit)
          && Number(plan.sentence_translation_limit) >= Number(old.sentence_translation_limit);
        if (isUpgrade) {
          await client.query("UPDATE subscriptions SET plan_id=$1,pending_plan_id=NULL,expires_at=$2,updated_at=now() WHERE id=$3", [plan.id, expiresAt, old.id]);
          await client.query("UPDATE usage_periods SET plan_id=$1,vocabulary_limit=GREATEST(vocabulary_limit,$2),sentence_limit=GREATEST(sentence_limit,$3),updated_at=now() WHERE subscription_id=$4 AND period_start<=now() AND period_end>now()", [plan.id, plan.vocabulary_translation_limit, plan.sentence_translation_limit, old.id]);
        } else {
          await client.query("UPDATE subscriptions SET pending_plan_id=$1,expires_at=$2,updated_at=now() WHERE id=$3", [plan.id, expiresAt, old.id]);
        }
        await client.query("INSERT INTO subscription_admin_grants (id,subscription_id,granted_by_user_id,reason) VALUES ($1,$2,$3,$4)", [randomUUID(), old.id, actorUserId, reason.trim()]);
        await client.query("INSERT INTO billing_audit_events (id,event_type,actor_user_id,target_user_id,old_value,new_value,reason) VALUES ($1,'subscription.admin_changed',$2,$3,$4,$5,$6)", [randomUUID(), actorUserId, userId, old, { plan: planKey, expiresAt, applies: isUpgrade ? "immediately" : "next_period" }, reason.trim()]);
        await client.query("COMMIT");
        return this.getSubscriptionSummary(userId);
      }
      await client.query("UPDATE subscriptions SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE user_id = $1 AND source = 'admin' AND status = 'active'", [userId]);
      const id = randomUUID();
      await client.query(
        `INSERT INTO subscriptions (id,user_id,plan_id,source,status,starts_at,expires_at,billing_interval)
         VALUES ($1,$2,$3,'admin','active',$4,$5,'monthly')`,
        [id, userId, plan.id, startsAt, expiresAt],
      );
      await client.query("INSERT INTO subscription_admin_grants (id,subscription_id,granted_by_user_id,reason) VALUES ($1,$2,$3,$4)", [randomUUID(), id, actorUserId, reason.trim()]);
      await client.query("INSERT INTO billing_audit_events (id,event_type,actor_user_id,target_user_id,old_value,new_value,reason) VALUES ($1,'subscription.admin_granted',$2,$3,$4,$5,$6)", [randomUUID(), actorUserId, userId, old, { plan: planKey, expiresAt }, reason.trim()]);
      await client.query("COMMIT");
      return this.getSubscriptionSummary(userId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async removeAdminSubscription({ userId, actorUserId, reason }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const old = await this.getEffectiveSubscription(userId, client);
      const result = await client.query("UPDATE subscriptions SET status='cancelled',cancelled_at=now(),updated_at=now() WHERE user_id=$1 AND source='admin' AND status='active' RETURNING id", [userId]);
      if (!result.rowCount) throw Object.assign(new Error("Active admin subscription not found."), { statusCode: 404 });
      await client.query("INSERT INTO billing_audit_events (id,event_type,actor_user_id,target_user_id,old_value,new_value,reason) VALUES ($1,'subscription.admin_removed',$2,$3,$4,$5,$6)", [randomUUID(), actorUserId, userId, old, { status: "cancelled" }, reason || null]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async syncStripeSubscription(subscription, eventCreated = null) {
    const price = subscription.items?.data?.[0]?.price;
    const priceId = price?.id;
    const planResult = await this.pool.query("SELECT * FROM plans WHERE stripe_monthly_price_id=$1 OR stripe_yearly_price_id=$1 LIMIT 1", [priceId]);
    const plan = planResult.rows[0];
    if (!plan) throw new Error(`No application plan maps Stripe Price ${priceId}.`);
    const userResult = await this.pool.query("SELECT id FROM app_users WHERE stripe_customer_id=$1 LIMIT 1", [subscription.customer]);
    const user = userResult.rows[0];
    if (!user) throw new Error(`No application user maps Stripe Customer ${subscription.customer}.`);
    const item = subscription.items?.data?.[0];
    const periodStart = new Date(Number(item?.current_period_start || subscription.current_period_start) * 1000);
    const periodEnd = new Date(Number(item?.current_period_end || subscription.current_period_end) * 1000);
    const status = stripeStatus(subscription.status, periodEnd, subscription.cancel_at_period_end);
    const result = await this.pool.query(
      `INSERT INTO subscriptions (id,user_id,plan_id,source,status,stripe_customer_id,stripe_subscription_id,stripe_price_id,billing_interval,current_period_start,current_period_end,cancel_at_period_end,cancelled_at,starts_at,stripe_state_updated_at)
       VALUES ($1,$2,$3,'stripe',$4,$5,$6,$7,$8,$9,$10,$11,$12,$9,$13)
       ON CONFLICT (stripe_subscription_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,status=EXCLUDED.status,stripe_price_id=EXCLUDED.stripe_price_id,billing_interval=EXCLUDED.billing_interval,current_period_start=EXCLUDED.current_period_start,current_period_end=EXCLUDED.current_period_end,cancel_at_period_end=EXCLUDED.cancel_at_period_end,cancelled_at=EXCLUDED.cancelled_at,stripe_state_updated_at=EXCLUDED.stripe_state_updated_at,updated_at=now()
       WHERE subscriptions.stripe_state_updated_at IS NULL OR EXCLUDED.stripe_state_updated_at IS NULL OR subscriptions.stripe_state_updated_at <= EXCLUDED.stripe_state_updated_at
       RETURNING *`,
      [randomUUID(), user.id, plan.id, status, subscription.customer, subscription.id, priceId, price?.recurring?.interval === "year" ? "yearly" : "monthly", periodStart, periodEnd, Boolean(subscription.cancel_at_period_end), subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null, eventCreated ? new Date(eventCreated * 1000) : new Date()],
    );
    if (!result.rows[0]) return null;
    const synced = { ...result.rows[0], ...plan, id: result.rows[0].id, plan_id: plan.id, user_id: user.id };
    const usage = await this.ensureUsagePeriod(synced);
    if (usage && Number(usage.vocabulary_limit) < Number(plan.vocabulary_translation_limit)) {
      await this.pool.query("UPDATE usage_periods SET plan_id=$1,vocabulary_limit=$2,sentence_limit=$3,updated_at=now() WHERE id=$4", [plan.id, plan.vocabulary_translation_limit, plan.sentence_translation_limit, usage.id]);
    }
    return result.rows[0];
  }
}

module.exports = { PLAN_DEFINITIONS, SubscriptionService, addMonth, addMonthsAnchored, stripeStatus };
