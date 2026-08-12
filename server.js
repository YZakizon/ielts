const express = require("express");
const { createHmac, randomBytes, randomUUID, timingSafeEqual } = require("crypto");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const nodemailer = require("nodemailer");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 8080;
const metricsFile = process.env.METRICS_FILE || "/data/metrics.json";
const metricsToken = process.env.METRICS_TOKEN || process.env.METRICS_API_KEY || "";
const aiRequestTimeoutMs = Number(process.env.AI_REQUEST_TIMEOUT_MS || 15000);
const freeAccountLimitPerMinute = Number(process.env.FREE_ACCOUNT_LIMIT_PER_MINUTE || 2);
const freeAccountLimitPerHour = Number(process.env.FREE_ACCOUNT_LIMIT_PER_HOUR || 20);
const freeAccountLimitPerDay = Number(process.env.FREE_ACCOUNT_LIMIT_PER_DAY || 50);
const loginRateLimitWindowMs = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const loginRateLimitMax = Number(process.env.LOGIN_RATE_LIMIT_MAX || 5);
const loginRateLimitLockoutMs = Number(process.env.LOGIN_RATE_LIMIT_LOCKOUT_MS || 15 * 60 * 1000);
const signupRateLimitWindowMs = Number(process.env.SIGNUP_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const signupRateLimitIpMax = Number(process.env.SIGNUP_RATE_LIMIT_IP_MAX || 10);
const signupRateLimitEmailMax = Number(process.env.SIGNUP_RATE_LIMIT_EMAIL_MAX || 3);
const signupRateLimitLockoutMs = Number(process.env.SIGNUP_RATE_LIMIT_LOCKOUT_MS || 15 * 60 * 1000);
const freeSessionLimit = Number(process.env.FREE_SESSION_LIMIT || 5);
const freeVocabGenerationLimit = Number(process.env.FREE_VOCAB_GENERATION_LIMIT || 2);
const maxDailyUniqueUsers = Number(process.env.MAX_DAILY_UNIQUE_USERS || 50000);
const maxDistinctVocab = Number(process.env.MAX_DISTINCT_VOCAB || 50000);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const loginRateLimitBuckets = new Map();
const signupRateLimitBuckets = new Map();
const adminEmails = new Set(
  String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => normalizeEmail(email))
    .filter(Boolean),
);
const databaseUrl = process.env.DATABASE_URL || "";
const sessionSecret = process.env.SESSION_SECRET || "";
const sessionCookieName = "ielts_session";
const guestCookieName = "ielts_guest_id";
const sessionDurationMs = Number(process.env.SESSION_DURATION_MS || 12 * 60 * 60 * 1000);
const smtpHost = process.env.SMTP_HOST || "";
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpUser = process.env.SMTP_USER || "";
const smtpPassword = process.env.SMTP_PASSWORD || "";
const smtpFrom = process.env.SMTP_FROM || smtpUser;
const dbPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

app.set("trust proxy", "loopback");

const labels = {
  beginner: "Beginner",
  medium: "Medium",
  advance: "Advance",
  "more-advance": "More Advance",
};

const englishVariantLabels = {
  us: "US English",
  british: "British English",
};

const translationLanguageLabels = {
  auto: "the detected source language",
  english: "English (US)",
  "english-uk": "English (UK)",
  "english-au": "English (AU)",
  "english-australia": "Australian English",
  indonesian: "Bahasa Indonesia",
  spanish: "Spanish",
  french: "French",
  german: "German",
  arabic: "Arabic",
  "chinese-simplified": "Chinese Simplified",
  japanese: "Japanese",
  korean: "Korean",
};

function isEnglishLanguage(language) {
  return ["english", "english-uk", "english-au", "english-australia"].includes(language);
}

const metrics = loadMetrics();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadMetrics() {
  try {
    const saved = JSON.parse(fs.readFileSync(metricsFile, "utf8"));
    return {
      aiCallsTotal: Number(saved.aiCallsTotal || 0),
      aiTokensTotal: Number(saved.aiTokensTotal || 0),
      distinctVocab: Array.isArray(saved.distinctVocab) ? saved.distinctVocab.slice(0, maxDistinctVocab) : [],
      sentenceTranslationsByDay: saved.sentenceTranslationsByDay || {},
      sentenceTranslationsTotal: Number(saved.sentenceTranslationsTotal || 0),
      uniqueUsersByDay: sanitizeUniqueUsersByDay(saved.uniqueUsersByDay),
      vocabByDay: saved.vocabByDay || {},
    };
  } catch {
    return {
      aiCallsTotal: 0,
      aiTokensTotal: 0,
      distinctVocab: [],
      sentenceTranslationsByDay: {},
      sentenceTranslationsTotal: 0,
      uniqueUsersByDay: {},
      vocabByDay: {},
    };
  }
}

function sanitizeUniqueUsersByDay(value = {}) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([_day, users]) => Array.isArray(users))
      .map(([day, users]) => [
        day,
        users
          .filter((userId) => uuidPattern.test(String(userId)))
          .slice(0, maxDailyUniqueUsers),
      ]),
  );
}

function saveMetrics() {
  try {
    fs.mkdirSync(path.dirname(metricsFile), { recursive: true });
    fs.writeFileSync(metricsFile, JSON.stringify(metrics, null, 2));
  } catch (error) {
    console.error(`Unable to save metrics: ${error.message}`);
  }
}

function parseCookies(cookieHeader = "") {
  const cookies = {};
  cookieHeader
    .split(";")
    .map((cookie) => cookie.trim().split("="))
    .filter(([key, value]) => key && value)
    .forEach(([key, value]) => {
      try {
        cookies[key] = decodeURIComponent(value).slice(0, 2048);
      } catch {
        cookies[key] = "";
      }
    });
  return cookies;
}

function authConfigured() {
  return Boolean(dbPool && sessionSecret);
}

function signSession(value) {
  return createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function hashToken(token) {
  return createHmac("sha256", sessionSecret).update(token).digest("hex");
}

function publicBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || (isSecureRequest(req) ? "https" : "http");
  return `${proto}://${req.headers.host}`;
}

function smtpConfigured() {
  return Boolean(smtpHost && smtpFrom);
}

async function sendVerificationEmail(email, verificationUrl) {
  if (!smtpConfigured()) {
    console.warn(`SMTP is not configured. Email verification link for ${email}: ${verificationUrl}`);
    return false;
  }

  const transporter = nodemailer.createTransport({
    auth: smtpUser || smtpPassword ? { user: smtpUser, pass: smtpPassword } : undefined,
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
  });

  await transporter.sendMail({
    from: smtpFrom,
    to: email,
    subject: "Verify your IELTS Study Hub email",
    text: `Verify your email address by opening this link:\n\n${verificationUrl}\n\nThis link expires in 24 hours.`,
    html: `
      <p>Verify your email address by opening this link:</p>
      <p><a href="${verificationUrl}">Verify email</a></p>
      <p>This link expires in 24 hours.</p>
    `,
  });
  return true;
}

function createSessionToken(email) {
  const expiresAt = Date.now() + sessionDurationMs;
  const nonce = randomBytes(16).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ email, expiresAt, nonce })).toString("base64url");
  return `${payload}.${signSession(payload)}`;
}

function sameValue(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function readBearerToken(req) {
  const authorization = String(req.headers.authorization || "");
  const [scheme, token] = authorization.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" ? token || "" : "";
}

function requireMetricsToken(req, res, next) {
  if (!metricsToken) {
    return res.status(503).json({ error: "Metrics access is not configured. Set METRICS_TOKEN." });
  }

  const providedToken = String(req.headers["x-metrics-token"] || req.headers["x-api-key"] || readBearerToken(req));
  if (!sameValue(providedToken, metricsToken)) {
    res.set("WWW-Authenticate", 'Bearer realm="metrics"');
    return res.status(401).json({ error: "Metrics token required." });
  }

  next();
}

function readSession(req) {
  if (!authConfigured()) {
    return null;
  }

  const token = parseCookies(req.headers.cookie)[sessionCookieName];
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature || !sameValue(signature, signSession(payload))) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.email || Number(session.expiresAt) < Date.now()) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function setSessionCookie(req, res, email) {
  res.cookie(sessionCookieName, createSessionToken(email), {
    httpOnly: true,
    maxAge: sessionDurationMs,
    sameSite: "lax",
    secure: isSecureRequest(req),
  });
}

function clearSessionCookie(res) {
  res.clearCookie(sessionCookieName, { sameSite: "lax" });
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isAdminEmail(email) {
  return adminEmails.has(normalizeEmail(email));
}

function isAdminUser(user) {
  return Boolean(user?.email_verified_at && isAdminEmail(user.email));
}

function validateAccountInput(email, password) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return "Enter a valid email address.";
  }
  if (String(password || "").length < 8) {
    return "Password must be at least 8 characters.";
  }
  return "";
}

function ensureGuestId(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const guestId = uuidPattern.test(cookies[guestCookieName] || "")
    ? cookies[guestCookieName]
    : randomUUID();

  if (cookies[guestCookieName] !== guestId) {
    res.cookie(guestCookieName, guestId, {
      httpOnly: true,
      maxAge: 365 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
      secure: isSecureRequest(req),
    });
  }

  return guestId;
}

function anonymousQuotaKey(req) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  return createHmac("sha256", sessionSecret).update(`anonymous:${ip}`).digest("hex");
}

async function findActiveUser(email) {
  if (!dbPool) {
    return null;
  }

  const result = await dbPool.query(
    "SELECT id, email, password_hash, email_verified_at FROM app_users WHERE email = $1 AND is_active = true LIMIT 1",
    [normalizeEmail(email)],
  );
  return result.rows[0] || null;
}

async function readUserFromSession(req) {
  const session = readSession(req);
  return session ? findActiveUser(session.email) : null;
}

async function requireAuth(req, res, next) {
  if (!authConfigured()) {
    return res.status(503).json({ error: "Login is not configured. Set DATABASE_URL and SESSION_SECRET." });
  }

  const session = readSession(req);
  if (!session) {
    return res.status(401).json({ error: "Login required." });
  }

  try {
    const user = await findActiveUser(session.email);
    if (!user) {
      return res.status(401).json({ error: "Login required." });
    }

    req.session = session;
    req.user = { email: user.email, id: user.id };
    next();
  } catch (error) {
    next(error);
  }
}

function recordUniqueUser(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const userId =
    uuidPattern.test(cookies.ielts_user_id || "")
      ? cookies.ielts_user_id
      : randomUUID();

  if (cookies.ielts_user_id !== userId) {
    res.cookie("ielts_user_id", userId, {
      httpOnly: true,
      maxAge: 365 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
      secure: isSecureRequest(req),
    });
  }

  const day = todayKey();
  metrics.uniqueUsersByDay[day] = metrics.uniqueUsersByDay[day] || [];
  if (
    metrics.uniqueUsersByDay[day].length < maxDailyUniqueUsers &&
    !metrics.uniqueUsersByDay[day].includes(userId)
  ) {
    metrics.uniqueUsersByDay[day].push(userId);
    saveMetrics();
  }
}

function isSecureRequest(req) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

function recordGeneratedWords(words) {
  const day = todayKey();
  metrics.vocabByDay[day] = (metrics.vocabByDay[day] || 0) + words.length;

  const distinct = new Set(metrics.distinctVocab);
  words.forEach((item) => {
    if (item?.word) {
      distinct.add(String(item.word).trim().toLowerCase());
    }
  });
  metrics.distinctVocab = [...distinct].sort().slice(0, maxDistinctVocab);
  saveMetrics();
}

function recordAiUsage(data) {
  metrics.aiCallsTotal += 1;
  metrics.aiTokensTotal += Number(data.usageMetadata?.totalTokenCount || 0);
  saveMetrics();
}

function recordSentenceTranslation() {
  const day = todayKey();
  metrics.sentenceTranslationsTotal += 1;
  metrics.sentenceTranslationsByDay[day] = (metrics.sentenceTranslationsByDay[day] || 0) + 1;
  saveMetrics();
}

async function initializeDatabase() {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required for login.");
  }

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id bigserial PRIMARY KEY,
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      email_verified_at timestamptz,
      email_verification_token_hash text,
      email_verification_expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await dbPool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'app_users' AND column_name = 'username'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'app_users' AND column_name = 'email'
      ) THEN
        ALTER TABLE app_users RENAME COLUMN username TO email;
      END IF;
    END $$;
  `);

  await dbPool.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz");
  await dbPool.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email_verification_token_hash text");
  await dbPool.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email_verification_expires_at timestamptz");

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS guest_usage (
      guest_id uuid PRIMARY KEY,
      translation_sessions integer NOT NULL DEFAULT 0,
      vocab_generations integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS anonymous_usage (
      subject_hash text PRIMARY KEY,
      translation_sessions integer NOT NULL DEFAULT 0,
      vocab_generations integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS free_account_usage_events (
      id bigserial PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      endpoint text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS free_account_usage_events_user_created_idx
    ON free_account_usage_events (user_id, created_at DESC)
  `);

  console.log("Login database initialized.");
}

async function getGuestUsage(guestId) {
  const result = await dbPool.query(
    `
      INSERT INTO guest_usage (guest_id)
      VALUES ($1)
      ON CONFLICT (guest_id) DO UPDATE SET updated_at = guest_usage.updated_at
      RETURNING translation_sessions, vocab_generations
    `,
    [guestId],
  );
  return result.rows[0];
}

async function getAnonymousUsage(subjectHash) {
  const result = await dbPool.query(
    `
      INSERT INTO anonymous_usage (subject_hash)
      VALUES ($1)
      ON CONFLICT (subject_hash) DO UPDATE SET updated_at = anonymous_usage.updated_at
      RETURNING translation_sessions, vocab_generations
    `,
    [subjectHash],
  );
  return result.rows[0];
}

function maxQuotaUsage(...usages) {
  return usages.reduce(
    (maxUsage, usage = {}) => ({
      translation_sessions: Math.max(
        Number(maxUsage.translation_sessions || 0),
        Number(usage.translation_sessions || 0),
      ),
      vocab_generations: Math.max(
        Number(maxUsage.vocab_generations || 0),
        Number(usage.vocab_generations || 0),
      ),
    }),
    { translation_sessions: 0, vocab_generations: 0 },
  );
}

function quotaPayload(usage = {}) {
  const translationSessions = Number(usage.translation_sessions || 0);
  const vocabGenerations = Number(usage.vocab_generations || 0);
  return {
    freeSessionLimit,
    freeSessionsRemaining: Math.max(freeSessionLimit - translationSessions, 0),
    freeVocabGenerationLimit,
    freeVocabGenerationsRemaining: Math.max(freeVocabGenerationLimit - vocabGenerations, 0),
  };
}

async function consumeGuestQuota(req, res, quotaType) {
  const guestId = ensureGuestId(req, res);
  const column = quotaType === "vocab" ? "vocab_generations" : "translation_sessions";
  const limit = quotaType === "vocab" ? freeVocabGenerationLimit : freeSessionLimit;
  const result = await dbPool.query(
    `
      INSERT INTO guest_usage (guest_id, ${column})
      VALUES ($1, 1)
      ON CONFLICT (guest_id) DO UPDATE SET
        ${column} = guest_usage.${column} + 1,
        updated_at = now()
      WHERE guest_usage.${column} < $2
      RETURNING translation_sessions, vocab_generations
    `,
    [guestId, limit],
  );

  return {
    allowed: Boolean(result.rows[0]),
    usage: result.rows[0] || (await getGuestUsage(guestId)),
  };
}

async function consumeAnonymousQuota(req, quotaType) {
  const subjectHash = anonymousQuotaKey(req);
  const column = quotaType === "vocab" ? "vocab_generations" : "translation_sessions";
  const limit = quotaType === "vocab" ? freeVocabGenerationLimit : freeSessionLimit;
  const result = await dbPool.query(
    `
      INSERT INTO anonymous_usage (subject_hash, ${column})
      VALUES ($1, 1)
      ON CONFLICT (subject_hash) DO UPDATE SET
        ${column} = anonymous_usage.${column} + 1,
        updated_at = now()
      WHERE anonymous_usage.${column} < $2
      RETURNING translation_sessions, vocab_generations
    `,
    [subjectHash, limit],
  );

  return {
    allowed: Boolean(result.rows[0]),
    usage: result.rows[0] || (await getAnonymousUsage(subjectHash)),
  };
}

function sendQuotaExceeded(res, usage) {
  return res.status(402).json({
    error: "Free limit reached. Create an account or login to continue.",
    code: "free_limit_reached",
    ...quotaPayload(usage),
  });
}

function allowAuthenticatedOrGuestQuota(quotaType) {
  return async (req, res, next) => {
    if (!authConfigured()) {
      return res.status(503).json({ error: "Login is not configured. Set DATABASE_URL and SESSION_SECRET." });
    }

    try {
      const user = await readUserFromSession(req);
      if (user) {
        req.user = { email: user.email, id: user.id };
        return next();
      }

      const guestId = ensureGuestId(req, res);
      const guestUsage = await getGuestUsage(guestId);
      const anonymousUsage = await getAnonymousUsage(anonymousQuotaKey(req));
      const effectiveUsage = maxQuotaUsage(guestUsage, anonymousUsage);
      const payload = quotaPayload(effectiveUsage);
      const remaining =
        quotaType === "vocab"
          ? payload.freeVocabGenerationsRemaining
          : payload.freeSessionsRemaining;
      if (remaining <= 0) {
        return sendQuotaExceeded(res, effectiveUsage);
      }

      const anonymousQuota = await consumeAnonymousQuota(req, quotaType);
      if (!anonymousQuota.allowed) {
        return sendQuotaExceeded(res, maxQuotaUsage(guestUsage, anonymousQuota.usage));
      }

      const guestQuota = await consumeGuestQuota(req, res, quotaType);
      if (!guestQuota.allowed) {
        return sendQuotaExceeded(res, maxQuotaUsage(guestQuota.usage, anonymousQuota.usage));
      }

      const reservedPayload = quotaPayload(maxQuotaUsage(guestQuota.usage, anonymousQuota.usage));
      res.set("X-Free-Sessions-Remaining", String(reservedPayload.freeSessionsRemaining));
      res.set("X-Free-Vocab-Generations-Remaining", String(reservedPayload.freeVocabGenerationsRemaining));
      req.guestQuotaReserved = true;
      next();
    } catch (error) {
      next(error);
    }
  };
}

async function recordGuestQuota(req, res) {
  return Boolean(req.guestQuotaReserved && !req.user && res);
}

function metricLine(name, value, labels = {}) {
  const labelEntries = Object.entries(labels);
  const renderedLabels = labelEntries.length
    ? `{${labelEntries.map(([key, val]) => `${key}="${String(val).replaceAll('"', '\\"')}"`).join(",")}}`
    : "";
  return `${name}${renderedLabels} ${value}`;
}

function renderMetrics() {
  const lines = [
    "# HELP ielts_ai_calls_total Total successful AI generation calls.",
    "# TYPE ielts_ai_calls_total counter",
    metricLine("ielts_ai_calls_total", metrics.aiCallsTotal),
    "# HELP ielts_ai_tokens_total Total AI tokens reported by the provider.",
    "# TYPE ielts_ai_tokens_total counter",
    metricLine("ielts_ai_tokens_total", metrics.aiTokensTotal),
    "# HELP ielts_distinct_vocab_total Number of distinct vocabulary words generated or searched.",
    "# TYPE ielts_distinct_vocab_total gauge",
    metricLine("ielts_distinct_vocab_total", metrics.distinctVocab.length),
    "# HELP ielts_vocab_per_day_total Number of vocabulary entries generated per day.",
    "# TYPE ielts_vocab_per_day_total counter",
    ...Object.entries(metrics.vocabByDay).map(([day, count]) =>
      metricLine("ielts_vocab_per_day_total", count, { day }),
    ),
    "# HELP ielts_sentence_translations_total Total successful sentence translations.",
    "# TYPE ielts_sentence_translations_total counter",
    metricLine("ielts_sentence_translations_total", metrics.sentenceTranslationsTotal),
    "# HELP ielts_sentence_translations_per_day_total Number of successful sentence translations per day.",
    "# TYPE ielts_sentence_translations_per_day_total counter",
    ...Object.entries(metrics.sentenceTranslationsByDay).map(([day, count]) =>
      metricLine("ielts_sentence_translations_per_day_total", count, { day }),
    ),
    "# HELP ielts_unique_users_per_day Unique browser users per day.",
    "# TYPE ielts_unique_users_per_day gauge",
    ...Object.entries(metrics.uniqueUsersByDay).map(([day, users]) =>
      metricLine("ielts_unique_users_per_day", users.length, { day }),
    ),
  ];

  return `${lines.join("\n")}\n`;
}

function generationRequest(prompt) {
  const modelFamily = ["ge", "mini"].join("");
  const defaultModel = `${modelFamily}-3.5-flash-lite`;
  const requestedModel = process.env.AI_MODEL || defaultModel;
  const host = ["generative", "language.googleapis.com"].join("");
  const payload = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.AI_API_KEY,
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
      },
    }),
  };

  return { defaultModel, host, payload, requestedModel };
}

async function fetchGeneratedJson(prompt) {
  const { defaultModel, host, payload, requestedModel } = generationRequest(prompt);
  let response = await fetchWithTimeout(`https://${host}/v1beta/models/${requestedModel}:generateContent`, payload);

  if (response.status === 404 && requestedModel !== defaultModel) {
    response = await fetchWithTimeout(`https://${host}/v1beta/models/${defaultModel}:generateContent`, payload);
  }

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = await response.json();
  recordAiUsage(data);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Generation service returned an empty response.");
  }

  return JSON.parse(text);
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), aiRequestTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function freeAccountLimitPayload(counts = {}) {
  const minuteUsed = Number(counts.minute_count || 0);
  const hourUsed = Number(counts.hour_count || 0);
  const dayUsed = Number(counts.day_count || 0);
  return {
    freeAccountLimitPerMinute,
    freeAccountLimitPerHour,
    freeAccountLimitPerDay,
    freeAccountMinuteRemaining: Math.max(freeAccountLimitPerMinute - minuteUsed, 0),
    freeAccountHourRemaining: Math.max(freeAccountLimitPerHour - hourUsed, 0),
    freeAccountDayRemaining: Math.max(freeAccountLimitPerDay - dayUsed, 0),
  };
}

function sendFreeAccountLimitExceeded(res, counts) {
  const payload = freeAccountLimitPayload(counts);
  const retryAfter =
    payload.freeAccountMinuteRemaining <= 0
      ? 60
      : payload.freeAccountHourRemaining <= 0
        ? 60 * 60
        : 24 * 60 * 60;
  res.set("Retry-After", String(retryAfter));
  return res.status(429).json({
    error: "Free account limit reached. Please try again later.",
    code: "free_account_limit_reached",
    ...payload,
  });
}

async function consumeFreeAccountLimit(userId, endpoint) {
  await dbPool.query("DELETE FROM free_account_usage_events WHERE created_at < now() - interval '2 days'");
  const result = await dbPool.query(
    `
      WITH locked AS (
        SELECT pg_advisory_xact_lock($1::bigint)
      ),
      usage AS (
        SELECT
          COUNT(*) FILTER (WHERE created_at >= now() - interval '1 minute') AS minute_count,
          COUNT(*) FILTER (WHERE created_at >= now() - interval '1 hour') AS hour_count,
          COUNT(*) FILTER (WHERE created_at >= now() - interval '1 day') AS day_count
        FROM free_account_usage_events, locked
        WHERE user_id = $1
          AND created_at >= now() - interval '1 day'
      ),
      inserted AS (
        INSERT INTO free_account_usage_events (user_id, endpoint)
        SELECT $1, $5
        WHERE (SELECT minute_count FROM usage) < $2
          AND (SELECT hour_count FROM usage) < $3
          AND (SELECT day_count FROM usage) < $4
        RETURNING 1
      )
      SELECT
        usage.minute_count,
        usage.hour_count,
        usage.day_count,
        EXISTS(SELECT 1 FROM inserted) AS allowed
      FROM usage
    `,
    [userId, freeAccountLimitPerMinute, freeAccountLimitPerHour, freeAccountLimitPerDay, endpoint],
  );
  return result.rows[0] || { allowed: false, minute_count: 0, hour_count: 0, day_count: 0 };
}

async function enforceFreeAccountRateLimit(req, res) {
  if (!req.user) {
    return true;
  }

  const usage = await consumeFreeAccountLimit(req.user.id, req.originalUrl.split("?")[0]);
  if (!usage.allowed) {
    sendFreeAccountLimitExceeded(res, usage);
    return false;
  }

  const payload = freeAccountLimitPayload({
    minute_count: Number(usage.minute_count || 0) + 1,
    hour_count: Number(usage.hour_count || 0) + 1,
    day_count: Number(usage.day_count || 0) + 1,
  });
  res.set("X-Free-Account-Minute-Remaining", String(payload.freeAccountMinuteRemaining));
  res.set("X-Free-Account-Hour-Remaining", String(payload.freeAccountHourRemaining));
  res.set("X-Free-Account-Day-Remaining", String(payload.freeAccountDayRemaining));
  return true;
}

function loginRateLimitKey(req, email) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const normalizedEmail = String(email || "").trim().toLowerCase().slice(0, 254) || "empty";
  return `${ip}:${normalizedEmail}`;
}

function signupRateLimitKeys(req, email) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const normalizedEmail = String(email || "").trim().toLowerCase().slice(0, 254) || "empty";
  return [
    { key: `ip:${ip}`, max: signupRateLimitIpMax },
    { key: `email:${ip}:${normalizedEmail}`, max: signupRateLimitEmailMax },
  ];
}

function pruneLoginRateLimitBuckets(now) {
  if (loginRateLimitBuckets.size <= 10000) {
    return;
  }

  for (const [key, bucket] of loginRateLimitBuckets.entries()) {
    const windowExpired = now - bucket.firstFailureAt >= loginRateLimitWindowMs;
    const lockoutExpired = !bucket.lockedUntil || now >= bucket.lockedUntil;
    if (windowExpired && lockoutExpired) {
      loginRateLimitBuckets.delete(key);
    }
  }
}

function getActiveLoginLockout(key) {
  const now = Date.now();
  pruneLoginRateLimitBuckets(now);

  const bucket = loginRateLimitBuckets.get(key);
  if (!bucket) {
    return null;
  }

  if (bucket.lockedUntil && now < bucket.lockedUntil) {
    return bucket;
  }

  if (now - bucket.firstFailureAt >= loginRateLimitWindowMs) {
    loginRateLimitBuckets.delete(key);
  }

  return null;
}

function recordFailedLogin(key) {
  const now = Date.now();
  const bucket = loginRateLimitBuckets.get(key);
  const nextBucket =
    bucket && now - bucket.firstFailureAt < loginRateLimitWindowMs
      ? { ...bucket, failures: bucket.failures + 1 }
      : { failures: 1, firstFailureAt: now, lockedUntil: 0 };

  if (nextBucket.failures >= loginRateLimitMax) {
    nextBucket.lockedUntil = now + loginRateLimitLockoutMs;
  }

  loginRateLimitBuckets.set(key, nextBucket);
  return nextBucket;
}

function clearLoginRateLimit(key) {
  loginRateLimitBuckets.delete(key);
}

function sendLoginLockout(res, bucket) {
  res.set("Retry-After", String(Math.ceil((bucket.lockedUntil - Date.now()) / 1000)));
  return res.status(429).json({ error: "Too many login attempts. Please try again later." });
}

function pruneSignupRateLimitBuckets(now) {
  if (signupRateLimitBuckets.size <= 10000) {
    return;
  }

  for (const [key, bucket] of signupRateLimitBuckets.entries()) {
    const windowExpired = now - bucket.firstAttemptAt >= signupRateLimitWindowMs;
    const lockoutExpired = !bucket.lockedUntil || now >= bucket.lockedUntil;
    if (windowExpired && lockoutExpired) {
      signupRateLimitBuckets.delete(key);
    }
  }
}

function getActiveSignupLockout(keys) {
  const now = Date.now();
  pruneSignupRateLimitBuckets(now);

  for (const { key } of keys) {
    const bucket = signupRateLimitBuckets.get(key);
    if (!bucket) {
      continue;
    }

    if (bucket.lockedUntil && now < bucket.lockedUntil) {
      return bucket;
    }

    if (now - bucket.firstAttemptAt >= signupRateLimitWindowMs) {
      signupRateLimitBuckets.delete(key);
    }
  }

  return null;
}

function recordSignupAttempt(keys) {
  const now = Date.now();
  let lockedBucket = null;

  for (const { key, max } of keys) {
    const bucket = signupRateLimitBuckets.get(key);
    const nextBucket =
      bucket && now - bucket.firstAttemptAt < signupRateLimitWindowMs
        ? { ...bucket, attempts: bucket.attempts + 1 }
        : { attempts: 1, firstAttemptAt: now, lockedUntil: 0 };

    if (nextBucket.attempts >= max) {
      nextBucket.lockedUntil = now + signupRateLimitLockoutMs;
      lockedBucket = lockedBucket || nextBucket;
    }

    signupRateLimitBuckets.set(key, nextBucket);
  }

  return lockedBucket;
}

function sendSignupLockout(res, bucket) {
  res.set("Retry-After", String(Math.ceil((bucket.lockedUntil - Date.now()) / 1000)));
  return res.status(429).json({ error: "Too many signup attempts. Please try again later." });
}

app.use(express.json({ limit: "32kb" }));
app.get("/api/session", async (req, res, next) => {
  try {
    const user = await readUserFromSession(req);
    const guestId = ensureGuestId(req, res);
    const usage = dbPool
      ? maxQuotaUsage(await getGuestUsage(guestId), await getAnonymousUsage(anonymousQuotaKey(req)))
      : {};
    res.json({
      authenticated: Boolean(user),
      configured: authConfigured(),
      email: user?.email || null,
      isAdmin: isAdminUser(user),
      quota: quotaPayload(usage),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/signup", async (req, res, next) => {
  if (!authConfigured()) {
    return res.status(503).json({ error: "Login is not configured. Set DATABASE_URL and SESSION_SECRET." });
  }

  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  const validationError = validateAccountInput(email, password);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const signupKeys = signupRateLimitKeys(req, email);
  const activeLockout = getActiveSignupLockout(signupKeys);
  if (activeLockout) {
    return sendSignupLockout(res, activeLockout);
  }

  const signupBucket = recordSignupAttempt(signupKeys);
  if (signupBucket) {
    return sendSignupLockout(res, signupBucket);
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const verificationToken = randomBytes(32).toString("base64url");
    const verificationTokenHash = hashToken(verificationToken);
    const result = await dbPool.query(
      `
        INSERT INTO app_users (
          email,
          password_hash,
          email_verification_token_hash,
          email_verification_expires_at
        )
        VALUES ($1, $2, $3, now() + interval '24 hours')
        ON CONFLICT (email) DO NOTHING
        RETURNING email
      `,
      [email, passwordHash, verificationTokenHash],
    );

    if (!result.rows[0]) {
      return res.status(409).json({ error: "Email is already registered." });
    }

    const verificationUrl = `${publicBaseUrl(req)}/api/verify-email?token=${encodeURIComponent(verificationToken)}`;
    const emailSent = await sendVerificationEmail(email, verificationUrl);

    setSessionCookie(req, res, email);
    res.status(201).json({
      authenticated: true,
      email,
      isAdmin: false,
      verificationEmailSent: emailSent,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/verify-email", async (req, res, next) => {
  if (!authConfigured()) {
    return res.status(503).send("Login is not configured.");
  }

  const token = String(req.query.token || "");
  if (!token) {
    return res.status(400).send("Verification token is required.");
  }

  try {
    const result = await dbPool.query(
      `
        UPDATE app_users
        SET
          email_verified_at = now(),
          email_verification_token_hash = null,
          email_verification_expires_at = null,
          updated_at = now()
        WHERE
          email_verification_token_hash = $1
          AND email_verification_expires_at > now()
        RETURNING email
      `,
      [hashToken(token)],
    );

    if (!result.rows[0]) {
      return res.status(400).send("Verification link is invalid or expired.");
    }

    res.type("html").send(`
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Email verified</title>
        </head>
        <body>
          <main style="font-family: system-ui, sans-serif; max-width: 520px; margin: 80px auto; line-height: 1.5;">
            <h1>Email verified</h1>
            <p>Your email has been verified. You can return to IELTS Study Hub.</p>
            <p><a href="/">Open IELTS Study Hub</a></p>
          </main>
        </body>
      </html>
    `);
  } catch (error) {
    next(error);
  }
});

app.post("/api/login", async (req, res, next) => {
  if (!authConfigured()) {
    return res.status(503).json({ error: "Login is not configured. Set DATABASE_URL and SESSION_SECRET." });
  }

  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  const loginKey = loginRateLimitKey(req, email);
  const activeLockout = getActiveLoginLockout(loginKey);
  if (activeLockout) {
    return sendLoginLockout(res, activeLockout);
  }

  try {
    const user = await findActiveUser(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      const failedBucket = recordFailedLogin(loginKey);
      if (failedBucket.lockedUntil && Date.now() < failedBucket.lockedUntil) {
        return sendLoginLockout(res, failedBucket);
      }
      return res.status(401).json({ error: "Invalid email or password." });
    }

    clearLoginRateLimit(loginKey);
    setSessionCookie(req, res, user.email);
    res.json({ authenticated: true, email: user.email, isAdmin: isAdminUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ authenticated: false });
});

app.use("/api/vocab", allowAuthenticatedOrGuestQuota("vocab"));
app.use("/api/search-vocab", allowAuthenticatedOrGuestQuota("vocab"));
app.use("/api/translate-sentence", allowAuthenticatedOrGuestQuota("session"));
app.use((req, res, next) => {
  if (req.path !== "/metrics") {
    recordUniqueUser(req, res);
  }
  next();
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get(["/app.js", "/styles.css"], (req, res) => {
  res.sendFile(path.join(__dirname, req.path));
});

app.get("/metrics", requireMetricsToken, (_req, res) => {
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderMetrics());
});

app.post("/api/vocab", async (req, res) => {
  const { level, targetLanguage = "indonesian", variant } = req.body || {};

  if (
    !labels[level] ||
    !englishVariantLabels[variant] ||
    !translationLanguageLabels[targetLanguage] ||
    targetLanguage === "auto"
  ) {
    return res.status(400).json({ error: "Invalid level, English variant, or target language." });
  }

  if (!process.env.AI_API_KEY) {
    return res.status(503).json({ error: "AI_API_KEY is not configured." });
  }

  const targetLabel = translationLanguageLabels[targetLanguage];
  const prompt = `
Generate exactly 20 random IELTS vocabulary items for the "${labels[level]}" level.
Use ${englishVariantLabels[variant]} spelling and ${englishVariantLabels[variant]} IPA phonetic symbols.
Return only valid JSON with this shape:
{
  "words": [
    {
      "word": "English word",
      "phonetic": "/IPA symbols/",
      "translation": "${targetLabel} translation",
      "synonyms": ["synonym 1", "synonym 2", "synonym 3"],
      "usage": "Clear explanation in English about how to use the word.",
      "usageTranslation": "${targetLabel} translation of the usage explanation.",
      "example": "IELTS-style example sentence in English.",
      "exampleTranslation": "${targetLabel} translation of the example sentence."
    }
  ]
}
Use academic IELTS vocabulary, natural ${targetLabel} translations, and no markdown.
`;

  try {
    if (!(await enforceFreeAccountRateLimit(req, res))) {
      return;
    }

    const generated = await fetchGeneratedJson(prompt);

    if (!Array.isArray(generated.words)) {
      return res.status(502).json({ error: "AI service returned invalid data." });
    }

    const words = generated.words.slice(0, 20);
    await recordGuestQuota(req, res);
    recordGeneratedWords(words);
    res.json({ words });
  } catch (error) {
    res.status(502).json({ error: error.message || "AI generation failed." });
  }
});

app.post("/api/search-vocab", async (req, res) => {
  const { query, targetLanguage = "indonesian", variant } = req.body || {};
  const word = String(query || "").trim();

  if (!word) {
    return res.status(400).json({ error: "Search word is required." });
  }

  if (!englishVariantLabels[variant] || !translationLanguageLabels[targetLanguage] || targetLanguage === "auto") {
    return res.status(400).json({ error: "Invalid English variant or target language." });
  }

  if (!process.env.AI_API_KEY) {
    return res.status(503).json({ error: "AI_API_KEY is not configured." });
  }

  const targetLabel = translationLanguageLabels[targetLanguage];
  const prompt = `
Create one IELTS vocabulary entry for "${word}".
Use ${englishVariantLabels[variant]} spelling and ${englishVariantLabels[variant]} IPA phonetic symbols.
If "${word}" is not a useful English IELTS vocabulary word, choose the closest useful IELTS vocabulary word.
Return only valid JSON with this shape:
{
  "word": "English word",
  "phonetic": "/IPA symbols/",
  "translation": "${targetLabel} translation",
  "synonyms": ["synonym 1", "synonym 2", "synonym 3"],
  "usage": "Clear explanation in English about how to use the word.",
  "usageTranslation": "${targetLabel} translation of the usage explanation.",
  "example": "IELTS-style example sentence in English.",
  "exampleTranslation": "${targetLabel} translation of the example sentence."
}
Use natural ${targetLabel} translations and no markdown.
`;

  try {
    if (!(await enforceFreeAccountRateLimit(req, res))) {
      return;
    }

    const generated = await fetchGeneratedJson(prompt);
    if (!generated.word) {
      return res.status(502).json({ error: "Generation service returned invalid data." });
    }
    await recordGuestQuota(req, res);
    recordGeneratedWords([generated]);
    res.json({ word: generated });
  } catch (error) {
    res.status(502).json({ error: error.message || "Search generation failed." });
  }
});

app.post("/api/translate-sentence", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const sourceLanguage = String(req.body?.sourceLanguage || "auto");
  const targetLanguage = String(req.body?.targetLanguage || "english");

  if (!text) {
    return res.status(400).json({ error: "Sentence text is required." });
  }

  if (text.length > 800) {
    return res.status(400).json({ error: "Sentence text must be 800 characters or fewer." });
  }

  if (!translationLanguageLabels[sourceLanguage] || !translationLanguageLabels[targetLanguage]) {
    return res.status(400).json({ error: "Invalid source or target language." });
  }

  if (targetLanguage === "auto") {
    return res.status(400).json({ error: "Target language must be selected." });
  }

  if (!isEnglishLanguage(targetLanguage)) {
    return res.status(400).json({ error: "Target language must be English." });
  }

  if (!process.env.AI_API_KEY) {
    return res.status(503).json({ error: "AI_API_KEY is not configured." });
  }

  const sourceLabel = translationLanguageLabels[sourceLanguage];
  const targetLabel = translationLanguageLabels[targetLanguage];
  const needsIeltsFeedback = isEnglishLanguage(sourceLanguage);
  const sourceLanguageForPrompt =
    sourceLanguage === "auto" ? "the following text" : `the following ${sourceLabel} text`;
  const englishTargetRequirements = `
For the "translation" field, translate ${sourceLanguageForPrompt} into natural, polished IELTS Band 8-9 ${targetLabel}.
Requirements for the "translation" field:
- Preserve the original meaning accurately.
- Use sophisticated but natural vocabulary.
- Prefer precise, elegant, formal phrasing over casual or conversational wording.
- Use advanced collocations where appropriate.
- Prefer expressions such as "throughout the entire journey" over casual alternatives such as "all along the way" when the meaning supports it.
- Avoid overly poetic, literary, or dramatic language.
- Avoid unnatural thesaurus-style vocabulary.
- Do not simplify the meaning.
- Keep the translation concise, fluent, and grammatically polished.
- Make it sound like educated, natural English rather than a literal translation.
- Return only the translated English text inside the "translation" field.
`;
  const translationDescription = `Natural, polished IELTS Band 8-9 ${targetLabel} translation`;
  const prompt = `
Translate this text from ${sourceLabel} into natural, polished IELTS Band 8-9 ${targetLabel}:
"${text.replaceAll('"', '\\"')}"
${englishTargetRequirements}

Return only valid JSON with this shape:
{
  "translation": "${translationDescription}",
  "keyPhrases": [
    { "source": "important source phrase", "target": "meaning in ${targetLabel}" }
  ],
  "notes": [
    "Short grammar or word-choice note for IELTS learners"
  ],
  "ieltsFeedback": {
    "correctedSentence": "${needsIeltsFeedback ? "Corrected English sentence, or the original if already correct" : ""}",
    "corrections": ${needsIeltsFeedback ? '["Specific grammar, spelling, or word-choice correction"]' : "[]"},
    "suggestions": ${needsIeltsFeedback ? '["IELTS-focused suggestion to make the sentence more academic, accurate, or natural"]' : "[]"}
  }
}
${needsIeltsFeedback ? "Because the source language is English, provide concise correction and IELTS learner suggestions." : "Because the source language is not English, leave ieltsFeedback fields empty."}
Use the Band 8-9 requirements for the ${targetLabel} translation while preserving the source meaning exactly. Use no markdown and no extra keys.
`;

  try {
    if (!(await enforceFreeAccountRateLimit(req, res))) {
      return;
    }

    const generated = await fetchGeneratedJson(prompt);
    if (!generated.translation) {
      return res.status(502).json({ error: "AI service returned invalid translation data." });
    }
    await recordGuestQuota(req, res);
    recordSentenceTranslation();
    res.json(generated);
  } catch (error) {
    res.status(502).json({ error: error.message || "Sentence translation failed." });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Internal server error." });
});

initializeDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`IELTS app listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error(`Unable to initialize Postgres login: ${error.message}`);
    process.exit(1);
  });
