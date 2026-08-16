const express = require("express");
require("dotenv").config();
const { createHmac, randomBytes, randomUUID, timingSafeEqual } = require("crypto");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const nodemailer = require("nodemailer");
const path = require("path");
const { Pool } = require("pg");
const Stripe = require("stripe");
const { SubscriptionService } = require("./subscription-service");
const { UsageError, UsageService } = require("./usage-service");
const {
  accountPlans,
  accountPlanLabel,
  dailyLimitForPlan,
  effectiveAccountPlan: configuredEffectiveAccountPlan,
  normalizeAccountPlan,
  planUsagePayload,
  ttsLimitForPlan,
  validAccountPlans,
} = require("./account-plans");
const { extractTtsAudio, ttsRequest } = require("./tts");

const app = express();
const port = process.env.PORT || 8080;
const policyVersion = "2026-08-13";
const legalContactEmail = "info@appliva.io";
const metricsFile = process.env.METRICS_FILE || "/data/metrics.json";
const metricsToken = process.env.METRICS_TOKEN || process.env.METRICS_API_KEY || "";
const aiRequestTimeoutMs = Number(process.env.AI_REQUEST_TIMEOUT_MS || 15000);
const ttsRequestTimeoutMs = Number(process.env.TTS_REQUEST_TIMEOUT_MS || 30000);
const freeAccountLimitPerMinute = Number(process.env.FREE_ACCOUNT_LIMIT_PER_MINUTE || 2);
const freeAccountLimitPerHour = Number(process.env.FREE_ACCOUNT_LIMIT_PER_HOUR || 20);
const freeAccountLimitPerDay = Number(process.env.NO_PLAN_REQUEST_LIMIT_PER_DAY || 10);
const loginRateLimitWindowMs = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const loginRateLimitMax = Number(process.env.LOGIN_RATE_LIMIT_MAX || 5);
const loginRateLimitLockoutMs = Number(process.env.LOGIN_RATE_LIMIT_LOCKOUT_MS || 15 * 60 * 1000);
const signupRateLimitWindowMs = Number(process.env.SIGNUP_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
const signupRateLimitIpMax = Number(process.env.SIGNUP_RATE_LIMIT_IP_MAX || 10);
const signupRateLimitEmailMax = Number(process.env.SIGNUP_RATE_LIMIT_EMAIL_MAX || 3);
const signupRateLimitLockoutMs = Number(process.env.SIGNUP_RATE_LIMIT_LOCKOUT_MS || 5 * 60 * 1000);
const passwordResetRateLimitWindowMs = Number(process.env.PASSWORD_RESET_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const passwordResetRateLimitIpMax = Number(process.env.PASSWORD_RESET_RATE_LIMIT_IP_MAX || 5);
const passwordResetRateLimitEmailMax = Number(process.env.PASSWORD_RESET_RATE_LIMIT_EMAIL_MAX || 3);
const passwordResetRateLimitLockoutMs = Number(process.env.PASSWORD_RESET_RATE_LIMIT_LOCKOUT_MS || 15 * 60 * 1000);
const unverifiedAccountCleanupIntervalMs = 60 * 60 * 1000;
const freeSessionLimit = Number(process.env.GUEST_SENTENCE_TRANSLATION_LIMIT || 2);
const freeVocabGenerationLimit = Number(process.env.GUEST_VOCABULARY_LIMIT || 2);
const adminUserLimit = Math.max(1, Math.min(Number(process.env.ADMIN_USER_LIMIT || 100) || 100, 500));
const maxDailyUniqueUsers = Number(process.env.MAX_DAILY_UNIQUE_USERS || 50000);
const maxDistinctVocab = Number(process.env.MAX_DISTINCT_VOCAB || 50000);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const loginRateLimitBuckets = new Map();
const signupRateLimitBuckets = new Map();
const passwordResetRateLimitBuckets = new Map();
const adminEmails = new Set(
  String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => normalizeEmail(email))
    .filter(Boolean),
);
const databaseUrl = process.env.DATABASE_URL || "";
const databaseHost = process.env.DATABASE_HOST || "";
const sessionSecret = process.env.SESSION_SECRET || "";
const sessionCookieName = "ielts_session";
const guestCookieName = "ielts_guest_id";
const sessionDurationMs = Number(process.env.SESSION_DURATION_MS || 12 * 60 * 60 * 1000);
const smtpHost = process.env.SMTP_HOST || "";
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpUser = process.env.SMTP_USER || "";
const smtpPassword = process.env.SMTP_PASSWORD || "";
const smtpFrom = process.env.SMTP_FROM || smtpUser;
const smtpTimeoutMs = Number(process.env.SMTP_TIMEOUT_MS || 5000);
const dbPool = databaseHost
  ? new Pool({
      host: databaseHost,
      port: Number(process.env.DATABASE_PORT || 5432),
      database: process.env.DATABASE_NAME || process.env.POSTGRES_DB || "ielts",
      user: process.env.DATABASE_USER || process.env.POSTGRES_USER || "ielts",
      password: process.env.DATABASE_PASSWORD || process.env.POSTGRES_PASSWORD || "",
    })
  : databaseUrl
    ? new Pool({ connectionString: databaseUrl })
    : null;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const stripeWebhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "");
const stripePrices = {
  premium: String(process.env.STRIPE_PRICE_PREMIUM_MONTHLY || ""),
  pro: String(process.env.STRIPE_PRICE_PRO_MONTHLY || ""),
};
const subscriptionService = dbPool ? new SubscriptionService(dbPool, { pastDueGraceDays: process.env.STRIPE_PAST_DUE_GRACE_DAYS }) : null;
const usageService = dbPool ? new UsageService(dbPool, subscriptionService) : null;

app.set("trust proxy", "loopback");

const labels = {
  beginner: "Beginner",
  medium: "Medium",
  advance: "Advance",
  "more-advance": "More Advance",
};

const englishVariantLabels = {
  us: "English (US)",
  british: "English (UK)",
  australian: "English (AU)",
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
  portuguese: "Portuguese",
  italian: "Italian",
  hindi: "Hindi",
  urdu: "Urdu",
  thai: "Thai",
  vietnamese: "Vietnamese",
  turkish: "Turkish",
  russian: "Russian",
  polish: "Polish",
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
      aiCallsByKeyType: sanitizeMetricCounts(saved.aiCallsByKeyType, ["primary", "paid"]),
      aiTokensByKeyType: sanitizeMetricCounts(saved.aiTokensByKeyType, ["primary", "paid"]),
      aiTokensTotal: Number(saved.aiTokensTotal || 0),
      distinctVocab: Array.isArray(saved.distinctVocab) ? saved.distinctVocab.slice(0, maxDistinctVocab) : [],
      sentenceTranslationsByDay: saved.sentenceTranslationsByDay || {},
      sentenceTranslationsTotal: Number(saved.sentenceTranslationsTotal || 0),
      ttsMetricSeries: saved.ttsMetricSeries || {},
      uniqueUsersByDay: sanitizeUniqueUsersByDay(saved.uniqueUsersByDay),
      vocabByDay: saved.vocabByDay || {},
    };
  } catch {
    return {
      aiCallsTotal: 0,
      aiCallsByKeyType: { primary: 0, paid: 0 },
      aiTokensByKeyType: { primary: 0, paid: 0 },
      aiTokensTotal: 0,
      distinctVocab: [],
      sentenceTranslationsByDay: {},
      sentenceTranslationsTotal: 0,
      ttsMetricSeries: {},
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

function sanitizeMetricCounts(value = {}, keys = []) {
  return Object.fromEntries(keys.map((key) => [key, Number(value?.[key] || 0)]));
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
    connectionTimeout: smtpTimeoutMs,
    greetingTimeout: smtpTimeoutMs,
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    socketTimeout: smtpTimeoutMs,
  });

  try {
    await transporter.sendMail({
      from: smtpFrom,
      to: email,
      subject: "Verify your IELTS Study Hub email",
      text: `Thank you for signing up to our IELTS Website.\n\nVerify your email address by opening this link:\n\n${verificationUrl}\n\nThis link expires in 24 hours.`,
      html: `
        <p>Thank you for signing up to our IELTS Website.</p>
        <p>Verify your email address by opening this link:</p>
        <p><a href="${verificationUrl}">Verify email</a></p>
        <p>This link expires in 24 hours.</p>
      `,
    });
    return true;
  } catch (error) {
    console.warn(`Unable to send verification email to ${email}: ${error.message}`);
    return false;
  }
}

async function sendPasswordResetEmail(email, resetUrl) {
  if (!smtpConfigured()) {
    console.warn(`SMTP is not configured. Password reset link for ${email}: ${resetUrl}`);
    return false;
  }

  const transporter = nodemailer.createTransport({
    auth: smtpUser || smtpPassword ? { user: smtpUser, pass: smtpPassword } : undefined,
    connectionTimeout: smtpTimeoutMs,
    greetingTimeout: smtpTimeoutMs,
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    socketTimeout: smtpTimeoutMs,
  });

  try {
    await transporter.sendMail({
      from: smtpFrom,
      to: email,
      subject: "Reset your IELTS Study Hub password",
      text: `Reset your password by opening this link:\n\n${resetUrl}\n\nThis link expires in 1 hour. If you did not request it, ignore this email.`,
      html: `
        <p>Reset your password by opening this link:</p>
        <p><a href="${resetUrl}">Reset password</a></p>
        <p>This link expires in 1 hour. If you did not request it, ignore this email.</p>
      `,
    });
    return true;
  } catch (error) {
    console.warn(`Unable to send password reset email to ${email}: ${error.message}`);
    return false;
  }
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

function effectiveAccountPlan(user) {
  return configuredEffectiveAccountPlan(user, user?.email_verified_at && isAdminEmail(user.email));
}

function isAdminUser(user) {
  return Boolean(user?.email_verified_at && effectiveAccountPlan(user) === "admin");
}

function translationRequestId(req) {
  return String(req.headers["idempotency-key"] || req.headers["x-translation-request-id"] || req.body?.requestId || "");
}

function sendUsageError(res, error) {
  return res.status(error.statusCode || 429).json({
    error: error.code,
    message: error.message,
    ...error.details,
  });
}

async function reserveTranslationUsage(req, res, type) {
  if (!req.user) return { guestReservation: true };

  try {
    return await usageService.reserve(req.user.id, type, translationRequestId(req));
  } catch (error) {
    if (error instanceof UsageError && error.code === "SUBSCRIPTION_REQUIRED" && req.user) {
      const freeReservation = await reserveAuthenticatedUsage(
        req,
        res,
        type === "vocabulary" ? "vocab" : "translation",
        1,
      );
      return freeReservation.allowed ? { freeReservation } : null;
    }
    if (error instanceof UsageError) {
      sendUsageError(res, error);
      return null;
    }
    throw error;
  }
}

async function refundTranslationUsage(reservation) {
  if (!reservation || reservation.freeReservation || reservation.guestReservation) return;
  try {
    await usageService.refund(reservation);
  } catch (error) {
    console.error(JSON.stringify({ event: "usage.refund_failed", user_id: reservation.userId, translation_request_id: reservation.requestId, error: error.message }));
  }
}

async function finalizeTranslationUsage(reservation) {
  if (!reservation?.freeReservation) return true;
  return reservation.freeReservation.recordSuccess(1);
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

function validatePassword(password) {
  if (String(password || "").length < 8) {
    return "Password must be at least 8 characters.";
  }
  return "";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function privacyContactText() {
  return legalContactEmail;
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
    "SELECT id, email, password_hash, plan, email_verified_at FROM app_users WHERE email = $1 AND is_active = true LIMIT 1",
    [normalizeEmail(email)],
  );
  return result.rows[0] || null;
}

async function findActiveUserByResetToken(token) {
  if (!dbPool) {
    return null;
  }

  const result = await dbPool.query(
    `
      SELECT id, email, plan, email_verified_at
      FROM app_users
      WHERE
        password_reset_token_hash = $1
        AND password_reset_expires_at > now()
        AND is_active = true
      LIMIT 1
    `,
    [hashToken(token)],
  );
  return result.rows[0] || null;
}

async function readUserFromSession(req) {
  const session = readSession(req);
  const user = session ? await findActiveUser(session.email) : null;
  return user?.email_verified_at ? user : null;
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
    if (!user || !user.email_verified_at) {
      if (user && !user.email_verified_at) {
        clearSessionCookie(res);
      }
      return res.status(401).json({ error: "Login required." });
    }

    req.session = session;
    req.user = { email: user.email, id: user.id, plan: effectiveAccountPlan(user) };
    next();
  } catch (error) {
    next(error);
  }
}

async function requireAdmin(req, res, next) {
  if (!authConfigured()) {
    return res.status(503).json({ error: "Login is not configured. Set DATABASE_URL and SESSION_SECRET." });
  }

  try {
    const user = await readUserFromSession(req);
    if (!user) {
      return res.status(401).json({ error: "Login required." });
    }
    if (!isAdminUser(user)) {
      return res.status(403).json({ error: "Admin access required." });
    }

    req.user = { email: user.email, id: user.id, plan: effectiveAccountPlan(user) };
    next();
  } catch (error) {
    next(error);
  }
}

async function requireAdminPage(req, res, next) {
  if (!authConfigured()) {
    return res.redirect("/?loginRequired=not_configured");
  }

  try {
    const user = await readUserFromSession(req);
    if (!user) {
      return res.redirect("/?loginRequired=1");
    }
    if (!isAdminUser(user)) {
      return res.redirect("/?adminRequired=1");
    }

    req.user = { email: user.email, id: user.id, plan: effectiveAccountPlan(user) };
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

function recordAiUsage(data, keyType = "primary") {
  const normalizedKeyType = keyType === "paid" ? "paid" : "primary";
  const tokens = Number(data.usageMetadata?.totalTokenCount || 0);
  metrics.aiCallsTotal += 1;
  metrics.aiCallsByKeyType[normalizedKeyType] = Number(metrics.aiCallsByKeyType[normalizedKeyType] || 0) + 1;
  metrics.aiTokensTotal += tokens;
  metrics.aiTokensByKeyType[normalizedKeyType] = Number(metrics.aiTokensByKeyType[normalizedKeyType] || 0) + tokens;
  saveMetrics();
}

function recordSentenceTranslation() {
  const day = todayKey();
  metrics.sentenceTranslationsTotal += 1;
  metrics.sentenceTranslationsByDay[day] = (metrics.sentenceTranslationsByDay[day] || 0) + 1;
  saveMetrics();
}

function ttsMetricKey(labels) {
  return [labels.plan, labels.keyType, labels.voice, labels.model].join("|");
}

function recordTtsMetrics(result, labels, outcome) {
  const key = ttsMetricKey(labels);
  const series = metrics.ttsMetricSeries[key] || {
    generatedSeconds: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    outcomes: {},
  };
  series.generatedSeconds += result.durationMs / 1000;
  series.inputTokens += result.inputTokens;
  series.outputTokens += result.outputTokens;
  series.totalTokens += result.totalTokens;
  series.outcomes[outcome] = Number(series.outcomes[outcome] || 0) + 1;
  metrics.ttsMetricSeries[key] = series;
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
      password_reset_token_hash text,
      password_reset_expires_at timestamptz,
      terms_accepted_at timestamptz,
      terms_version text,
      privacy_version text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await subscriptionService.initializeSchema();
  await subscriptionService.configureStripePrices(stripePrices);

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS tts_usage_events (
      id bigserial PRIMARY KEY,
      user_id bigint REFERENCES app_users(id) ON DELETE CASCADE,
      guest_id uuid,
      subject_hash text,
      plan text NOT NULL,
      generated_duration_ms integer NOT NULL,
      charged_duration_ms integer NOT NULL,
      input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0,
      total_tokens integer NOT NULL DEFAULT 0,
      delivery_status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS tts_usage_events_identity_created_idx
    ON tts_usage_events (user_id, guest_id, subject_hash, created_at DESC)
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
  await dbPool.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_reset_token_hash text");
  await dbPool.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_reset_expires_at timestamptz");
  await dbPool.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz");
  await dbPool.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS terms_version text");
  await dbPool.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS privacy_version text");
  await dbPool.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free'");
  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS app_users_unverified_created_idx
    ON app_users (created_at)
    WHERE email_verified_at IS NULL
  `);
  await dbPool.query(`
    UPDATE app_users
    SET plan = 'free'
    WHERE plan IS NULL OR plan NOT IN ('free', 'premium', 'ultimate', 'admin')
  `);
  await dbPool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'app_users_plan_check'
          AND conrelid = 'app_users'::regclass
      ) THEN
        ALTER TABLE app_users
        ADD CONSTRAINT app_users_plan_check
        CHECK (plan IN ('free', 'premium', 'ultimate', 'admin'));
      END IF;
    END $$;
  `);

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
  await dbPool.query("ALTER TABLE free_account_usage_events ADD COLUMN IF NOT EXISTS usage_type text NOT NULL DEFAULT 'request'");
  await dbPool.query("ALTER TABLE free_account_usage_events ADD COLUMN IF NOT EXISTS units integer NOT NULL DEFAULT 1");
  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS free_account_usage_events_user_type_created_idx
    ON free_account_usage_events (user_id, usage_type, created_at DESC)
  `);

  console.log("Login database initialized.");
}

async function deleteExpiredUnverifiedAccounts(email = null) {
  if (!dbPool) return 0;

  const result = email
    ? await dbPool.query(
        `
          DELETE FROM app_users
          WHERE email = $1
            AND email_verified_at IS NULL
            AND created_at < now() - interval '7 days'
        `,
        [normalizeEmail(email)],
      )
    : await dbPool.query(`
        DELETE FROM app_users
        WHERE email_verified_at IS NULL
          AND created_at < now() - interval '7 days'
      `);
  return result.rowCount;
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
        req.user = { email: user.email, id: user.id, plan: effectiveAccountPlan(user) };
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

async function attachOptionalUser(req, res, next) {
  if (!authConfigured()) {
    return res.status(503).json({ error: "Login is not configured. Set DATABASE_URL and SESSION_SECRET." });
  }
  try {
    const user = await readUserFromSession(req);
    if (user) req.user = { email: user.email, id: user.id, plan: effectiveAccountPlan(user) };
    next();
  } catch (error) {
    next(error);
  }
}

function ttsIdentity(req, res) {
  if (req.user) {
    return { userId: Number(req.user.id), guestId: null, subjectHash: null, plan: normalizeAccountPlan(req.user.plan) };
  }
  return {
    userId: null,
    guestId: ensureGuestId(req, res),
    subjectHash: anonymousQuotaKey(req),
    plan: "guest",
  };
}

function ttsWindowSql(window) {
  return window === "hour"
    ? "now() - interval '1 hour'"
    : "date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
}

function ttsLockKeys(identity) {
  return identity.userId
    ? [`user:${identity.userId}`]
    : [`guest:${identity.guestId}`, `ip:${identity.subjectHash}`].sort();
}

const ttsGenerationGates = new Map();

async function withTtsGenerationGate(identity, task) {
  const gateKeys = ttsLockKeys(identity);
  const previous = Promise.all(gateKeys.map((gateKey) => (ttsGenerationGates.get(gateKey) || Promise.resolve()).catch(() => {})));
  const run = previous.then(task);
  const blocker = run.catch(() => {});
  for (const gateKey of gateKeys) {
    ttsGenerationGates.set(gateKey, blocker);
  }

  try {
    return await run;
  } finally {
    for (const gateKey of gateKeys) {
      if (ttsGenerationGates.get(gateKey) === blocker) {
        ttsGenerationGates.delete(gateKey);
      }
    }
  }
}

async function getTtsUsage(identity, queryable = dbPool) {
  const { limitMs, window } = ttsLimitForPlan(identity.plan);
  const result = await queryable.query(
    `
      SELECT COALESCE(SUM(charged_duration_ms), 0)::bigint AS used_ms
      FROM tts_usage_events
      WHERE created_at >= ${ttsWindowSql(window)}
        AND (
          ($1::bigint IS NOT NULL AND user_id = $1::bigint)
          OR ($1::bigint IS NULL AND (guest_id = $2::uuid OR subject_hash = $3::text))
        )
    `,
    [identity.userId, identity.guestId, identity.subjectHash],
  );
  const usedMs = Number(result.rows[0]?.used_ms || 0);
  return { limitMs, remainingMs: limitMs === null ? null : Math.max(limitMs - usedMs, 0), usedMs, window };
}

function setTtsUsageHeaders(res, usage, durationMs = null) {
  res.set("X-TTS-Window", usage.window);
  res.set("X-TTS-Used-Seconds", String(Math.ceil(usage.usedMs / 1000)));
  if (usage.limitMs !== null) {
    res.set("X-TTS-Limit-Seconds", String(Math.floor(usage.limitMs / 1000)));
    res.set("X-TTS-Remaining-Seconds", String(Math.floor(usage.remainingMs / 1000)));
  }
  if (durationMs !== null) res.set("X-TTS-Duration-Seconds", String(Math.ceil(durationMs / 1000)));
}

function ttsUsagePayload(usage) {
  return {
    limitSeconds: usage.limitMs === null ? null : Math.floor(usage.limitMs / 1000),
    usedSeconds: Math.ceil(usage.usedMs / 1000),
    remainingSeconds: usage.remainingMs === null ? null : Math.floor(usage.remainingMs / 1000),
    window: usage.window,
  };
}

function sendTtsLimitExceeded(res, usage) {
  setTtsUsageHeaders(res, usage);
  res.set("Retry-After", String(usage.window === "hour" ? 3600 : 86400));
  return res.status(429).json({
    error: "Text-to-speech time limit reached for your plan.",
    code: "tts_limit_reached",
    ttsUsage: ttsUsagePayload(usage),
  });
}

async function recordTtsUsage(identity, result) {
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    for (const lockKey of ttsLockKeys(identity)) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [lockKey]);
    }
    const usage = await getTtsUsage(identity, client);
    const chargedMs = usage.limitMs === null ? result.durationMs : Math.min(result.durationMs, usage.remainingMs);
    const delivered = usage.limitMs === null || result.durationMs <= usage.remainingMs;
    await client.query(
      `
        INSERT INTO tts_usage_events (
          user_id, guest_id, subject_hash, plan, generated_duration_ms, charged_duration_ms,
          input_tokens, output_tokens, total_tokens, delivery_status
        ) VALUES ($1::bigint, $2::uuid, $3::text, $4::text, $5::integer, $6::integer,
          $7::integer, $8::integer, $9::integer, $10::text)
      `,
      [
        identity.userId,
        identity.guestId,
        identity.subjectHash,
        identity.plan,
        result.durationMs,
        chargedMs,
        result.inputTokens,
        result.outputTokens,
        result.totalTokens,
        delivered ? "delivered" : "quota_rejected",
      ],
    );
    await client.query("DELETE FROM tts_usage_events WHERE created_at < now() - interval '2 days'");
    await client.query("COMMIT");
    return { delivered, usage: await getTtsUsage(identity) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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
  const ttsSeries = Object.entries(metrics.ttsMetricSeries).flatMap(([key, series]) => {
    const [plan, keyType, voice, model] = key.split("|");
    const labels = { plan, key_type: keyType, voice, model };
    return { labels, series };
  });
  const lines = [
    "# HELP ielts_ai_calls_total Total successful AI generation calls.",
    "# TYPE ielts_ai_calls_total counter",
    metricLine("ielts_ai_calls_total", metrics.aiCallsTotal),
    "# HELP ielts_ai_api_key_calls_total Total successful AI generation calls by configured key type.",
    "# TYPE ielts_ai_api_key_calls_total counter",
    ...Object.entries(metrics.aiCallsByKeyType).map(([keyType, count]) =>
      metricLine("ielts_ai_api_key_calls_total", count, { key_type: keyType }),
    ),
    "# HELP ielts_ai_tokens_total Total AI tokens reported by the provider.",
    "# TYPE ielts_ai_tokens_total counter",
    metricLine("ielts_ai_tokens_total", metrics.aiTokensTotal),
    "# HELP ielts_ai_api_key_tokens_total Total AI tokens reported by the provider by configured key type.",
    "# TYPE ielts_ai_api_key_tokens_total counter",
    ...Object.entries(metrics.aiTokensByKeyType).map(([keyType, count]) =>
      metricLine("ielts_ai_api_key_tokens_total", count, { key_type: keyType }),
    ),
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
    "# HELP ielts_tts_generated_seconds_total Total generated TTS audio duration in seconds.",
    "# TYPE ielts_tts_generated_seconds_total counter",
    ...ttsSeries.map(({ labels, series }) => metricLine("ielts_tts_generated_seconds_total", series.generatedSeconds, labels)),
    "# HELP ielts_tts_tokens_total Gemini TTS tokens by token type.",
    "# TYPE ielts_tts_tokens_total counter",
    ...ttsSeries.flatMap(({ labels, series }) => [
      metricLine("ielts_tts_tokens_total", series.inputTokens, { ...labels, token_type: "input" }),
      metricLine("ielts_tts_tokens_total", series.outputTokens, { ...labels, token_type: "output" }),
      metricLine("ielts_tts_tokens_total", series.totalTokens, { ...labels, token_type: "total" }),
    ]),
    "# HELP ielts_tts_generations_total TTS generations by delivery outcome.",
    "# TYPE ielts_tts_generations_total counter",
    ...ttsSeries.flatMap(({ labels, series }) =>
      Object.entries(series.outcomes).map(([outcome, count]) =>
        metricLine("ielts_tts_generations_total", count, { ...labels, outcome }),
      ),
    ),
  ];

  return `${lines.join("\n")}\n`;
}

function configuredAiApiKeys(env = process.env) {
  return [...new Set([env.AI_API_KEY, env.GEMINI_API_KEY_PAID].map((key) => String(key || "").trim()).filter(Boolean))];
}

function configuredAiApiKeyEntries(env = process.env) {
  const entries = [
    { key: String(env.AI_API_KEY || "").trim(), keyType: "primary" },
    { key: String(env.GEMINI_API_KEY_PAID || "").trim(), keyType: "paid" },
  ].filter((entry) => entry.key);
  const seenKeys = new Set();
  return entries.filter((entry) => {
    if (seenKeys.has(entry.key)) {
      return false;
    }
    seenKeys.add(entry.key);
    return true;
  });
}

function generationRequest(prompt, apiKey) {
  const modelFamily = ["ge", "mini"].join("");
  const defaultModel = `${modelFamily}-3.5-flash-lite`;
  const requestedModel = process.env.AI_MODEL || defaultModel;
  const host = ["generative", "language.googleapis.com"].join("");
  const payload = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
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
  const apiKeys = configuredAiApiKeyEntries();
  let lastError;

  for (const { key, keyType } of apiKeys) {
    try {
      return await fetchGeneratedJsonWithKey(prompt, key, keyType);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("AI_API_KEY or GEMINI_API_KEY_PAID is not configured.");
}

async function fetchGeneratedJsonWithKey(prompt, apiKey, keyType = "primary") {
  const { defaultModel, host, payload, requestedModel } = generationRequest(prompt, apiKey);
  let response = await fetchWithTimeout(`https://${host}/v1beta/models/${requestedModel}:generateContent`, payload);

  if (response.status === 404 && requestedModel !== defaultModel) {
    response = await fetchWithTimeout(`https://${host}/v1beta/models/${defaultModel}:generateContent`, payload);
  }

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = await response.json();
  recordAiUsage(data, keyType);
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

async function fetchTtsAudio(text) {
  let lastError;
  for (const { key, keyType } of configuredAiApiKeyEntries()) {
    const request = ttsRequest(text, key);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ttsRequestTimeoutMs);
      let response;
      try {
        response = await fetch(`https://${request.host}/v1beta/models/${request.model}:generateContent`, {
          ...request.payload,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(await response.text());
      return { ...extractTtsAudio(await response.json()), keyType, model: request.model, voice: request.voice };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("AI_API_KEY or GEMINI_API_KEY_PAID is not configured.");
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

function usageTypeFromQuotaType(quotaType) {
  return quotaType === "vocab" ? "vocab" : "translation";
}

async function getPlanUsageToday(userId) {
  const result = await dbPool.query(
    `
      SELECT
        COALESCE(SUM(units) FILTER (WHERE usage_type = 'vocab'), 0) AS vocab_used,
        COALESCE(SUM(units) FILTER (WHERE usage_type = 'translation'), 0) AS translation_used
      FROM free_account_usage_events
      WHERE user_id = $1
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    `,
    [userId],
  );
  return result.rows[0] || { vocab_used: 0, translation_used: 0 };
}

function setPlanUsageHeaders(res, payload) {
  res.set("X-Account-Plan", payload.plan);
  if (payload.vocabRemainingToday !== null) {
    res.set("X-Plan-Vocab-Remaining", String(payload.vocabRemainingToday));
  }
  if (payload.translationRemainingToday !== null) {
    res.set("X-Plan-Translation-Remaining", String(payload.translationRemainingToday));
  }
}

function sendPlanLimitExceeded(res, plan, quotaType, usage) {
  const payload = planUsagePayload(plan, usage);
  const limit = dailyLimitForPlan(plan, quotaType);
  const used = quotaType === "vocab" ? payload.vocabUsedToday : payload.translationUsedToday;
  const remaining = quotaType === "vocab" ? payload.vocabRemainingToday : payload.translationRemainingToday;

  res.set("Retry-After", String(24 * 60 * 60));
  return res.status(429).json({
    error:
      quotaType === "vocab"
        ? "Daily vocabulary limit reached for your plan."
        : "Daily translation limit reached for your plan.",
    code: "plan_limit_reached",
    quotaType,
    limit,
    used,
    remaining,
    ...payload,
  });
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
          COUNT(*) FILTER (WHERE created_at >= now() - interval '1 minute')::integer AS minute_count,
          COUNT(*) FILTER (WHERE created_at >= now() - interval '1 hour')::integer AS hour_count,
          COUNT(*) FILTER (WHERE created_at >= now() - interval '1 day')::integer AS day_count
        FROM free_account_usage_events, locked
        WHERE user_id = $1::bigint
          AND usage_type = 'request'
          AND created_at >= now() - interval '1 day'
      ),
      inserted AS (
        INSERT INTO free_account_usage_events (user_id, endpoint, usage_type, units)
        SELECT $1::bigint, $5::text, 'request', 1
        WHERE (SELECT minute_count FROM usage) < $2::integer
          AND (SELECT hour_count FROM usage) < $3::integer
          AND (SELECT day_count FROM usage) < $4::integer
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

async function consumePaidPlanUsage(userId, plan, quotaType, units) {
  const limit = dailyLimitForPlan(plan, quotaType);
  if (limit === null) {
    return { allowed: true, usage: await getPlanUsageToday(userId) };
  }

  const usageType = usageTypeFromQuotaType(quotaType);
  await dbPool.query("DELETE FROM free_account_usage_events WHERE created_at < now() - interval '2 days'");
  const result = await dbPool.query(
    `
      WITH locked AS (
        SELECT pg_advisory_xact_lock($1::bigint)
      ),
      usage AS (
        SELECT
          COALESCE(SUM(units), 0)::integer AS used
        FROM free_account_usage_events, locked
        WHERE user_id = $1::bigint
          AND usage_type = $2::text
          AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      ),
      inserted AS (
        INSERT INTO free_account_usage_events (user_id, endpoint, usage_type, units)
        SELECT $1::bigint, $3::text, $2::text, $4::integer
        WHERE (SELECT used FROM usage) + $4::integer <= $5::integer
        RETURNING 1
      )
      SELECT
        usage.used,
        EXISTS(SELECT 1 FROM inserted) AS allowed
      FROM usage
    `,
    [userId, usageType, quotaType, units, limit],
  );
  const row = result.rows[0] || { allowed: false, used: 0 };
  const usage = await getPlanUsageToday(userId);
  return { allowed: Boolean(row.allowed), usage };
}

async function reserveAuthenticatedUsage(req, res, quotaType, units) {
  if (!req.user) {
    return { allowed: true, recordSuccess: async () => true };
  }

  const plan = normalizeAccountPlan(req.user.plan);
  if (plan === "admin") {
    const payload = planUsagePayload(plan, await getPlanUsageToday(req.user.id));
    setPlanUsageHeaders(res, payload);
    return { allowed: true, recordSuccess: async () => true };
  }

  const usage = await getPlanUsageToday(req.user.id);
  const payload = planUsagePayload(plan, usage);
  const remaining = quotaType === "vocab" ? payload.vocabRemainingToday : payload.translationRemainingToday;
  if (remaining !== null && remaining < units) {
    sendPlanLimitExceeded(res, plan, quotaType, usage);
    return { allowed: false, recordSuccess: async () => false };
  }

  setPlanUsageHeaders(res, payload);
  if (plan === "free") {
    const freeUsage = await consumeFreeAccountLimit(req.user.id, req.originalUrl.split("?")[0]);
    if (!freeUsage.allowed) {
      sendFreeAccountLimitExceeded(res, freeUsage);
      return { allowed: false, recordSuccess: async () => false };
    }

    const freePayload = freeAccountLimitPayload({
      minute_count: Number(freeUsage.minute_count || 0) + 1,
      hour_count: Number(freeUsage.hour_count || 0) + 1,
      day_count: Number(freeUsage.day_count || 0) + 1,
    });
    res.set("X-Free-Account-Minute-Remaining", String(freePayload.freeAccountMinuteRemaining));
    res.set("X-Free-Account-Hour-Remaining", String(freePayload.freeAccountHourRemaining));
    res.set("X-Free-Account-Day-Remaining", String(freePayload.freeAccountDayRemaining));
  }

  return {
    allowed: true,
    recordSuccess: async (actualUnits = units) => {
      const result = await consumePaidPlanUsage(req.user.id, plan, quotaType, actualUnits);
      if (!result.allowed) {
        sendPlanLimitExceeded(res, plan, quotaType, result.usage);
        return false;
      }
      setPlanUsageHeaders(res, planUsagePayload(plan, result.usage));
      return true;
    },
  };
}

function planFromSubscription(subscription) {
  const price = subscription?.items?.data?.[0]?.price;
  const product = price?.product;
  const productName = typeof product === "object" ? product.name : "";
  return productName || price?.nickname || price?.lookup_key || price?.id || "Paid";
}

async function lookupStripeBilling(email) {
  if (!stripe) {
    return {
      plan: "Free",
      billingStatus: "stripe_not_configured",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
  }

  const customers = await stripe.customers.list({ email, limit: 10 });
  for (const customer of customers.data) {
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      expand: ["data.items.data.price.product"],
      limit: 10,
      status: "all",
    });
    const subscription =
      subscriptions.data.find((item) => ["active", "trialing"].includes(item.status)) ||
      subscriptions.data.find((item) => ["past_due", "unpaid"].includes(item.status)) ||
      subscriptions.data[0];

    if (subscription) {
      return {
        plan: ["active", "trialing"].includes(subscription.status)
          ? planFromSubscription(subscription)
          : "Free",
        billingStatus: subscription.status,
        stripeCustomerId: customer.id,
        stripeSubscriptionId: subscription.id,
      };
    }
  }

  return {
    plan: "Free",
    billingStatus: "none",
    stripeCustomerId: customers.data[0]?.id || null,
    stripeSubscriptionId: null,
  };
}

async function getAdminUserUsage(userIds) {
  if (!userIds.length) return new Map();

  const result = await dbPool.query(
    `
      SELECT
        user_id,
        COUNT(*) FILTER (
          WHERE usage_type = 'request' AND created_at >= now() - interval '1 minute'
        )::integer AS minute_count,
        COUNT(*) FILTER (
          WHERE usage_type = 'request' AND created_at >= now() - interval '1 hour'
        )::integer AS hour_count,
        COUNT(*) FILTER (
          WHERE usage_type = 'request' AND created_at >= now() - interval '1 day'
        )::integer AS day_count,
        COALESCE(SUM(units) FILTER (
          WHERE usage_type = 'vocab'
            AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        ), 0)::integer AS vocab_used,
        COALESCE(SUM(units) FILTER (
          WHERE usage_type = 'translation'
            AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        ), 0)::integer AS translation_used
      FROM free_account_usage_events
      WHERE user_id = ANY($1::bigint[])
        AND created_at >= now() - interval '1 day'
      GROUP BY user_id
    `,
    [userIds],
  );

  return new Map(result.rows.map((row) => [Number(row.user_id), row]));
}

function adminUsagePayload(subscription, usage = {}) {
  const subscriptionUsage = subscription?.usage;
  return {
    vocabUsedToday: Number(subscriptionUsage?.vocabulary?.used || 0),
    vocabDailyLimit: subscriptionUsage?.vocabulary?.limit ?? 0,
    translationUsedToday: Number(subscriptionUsage?.sentence?.used || 0),
    translationDailyLimit: subscriptionUsage?.sentence?.limit ?? 0,
    requestLimits:
      !subscription?.plan
        ? {
            minute: { used: Number(usage.minute_count || 0), limit: freeAccountLimitPerMinute },
            hour: { used: Number(usage.hour_count || 0), limit: freeAccountLimitPerHour },
            day: { used: Number(usage.day_count || 0), limit: freeAccountLimitPerDay },
          }
        : null,
  };
}

async function adminUserPayload(row, usage = {}) {
  const isAdmin = isAdminUser(row);
  try {
    const subscription = await subscriptionService.getSubscriptionSummary(row.id);
    return {
      id: Number(row.id),
      email: row.email,
      isActive: row.is_active,
      isAdmin,
      emailVerified: Boolean(row.email_verified_at),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      localPlan: normalizeAccountPlan(row.plan),
      plan: subscription.plan,
      planLabel: subscription.planName || "No subscription",
      billingPlan: subscription.planName || "None",
      billingStatus: subscription.status,
      subscription,
      usage: adminUsagePayload(subscription, usage),
    };
  } catch (error) {
    return {
      id: Number(row.id),
      email: row.email,
      isActive: row.is_active,
      isAdmin,
      emailVerified: Boolean(row.email_verified_at),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      localPlan: normalizeAccountPlan(row.plan),
      plan: null,
      planLabel: "No subscription",
      billingPlan: "Unknown",
      billingStatus: "lookup_error",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      billingError: error.message,
      usage: adminUsagePayload(null, usage),
    };
  }
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

function passwordResetRateLimitKeys(req, email) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const normalizedEmail = String(email || "").trim().toLowerCase().slice(0, 254) || "empty";
  return [
    { key: `ip:${ip}`, max: passwordResetRateLimitIpMax },
    { key: `email:${ip}:${normalizedEmail}`, max: passwordResetRateLimitEmailMax },
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

function prunePasswordResetRateLimitBuckets(now) {
  if (passwordResetRateLimitBuckets.size <= 10000) {
    return;
  }

  for (const [key, bucket] of passwordResetRateLimitBuckets.entries()) {
    const windowExpired = now - bucket.firstAttemptAt >= passwordResetRateLimitWindowMs;
    const lockoutExpired = !bucket.lockedUntil || now >= bucket.lockedUntil;
    if (windowExpired && lockoutExpired) {
      passwordResetRateLimitBuckets.delete(key);
    }
  }
}

function getActivePasswordResetLockout(keys) {
  const now = Date.now();
  prunePasswordResetRateLimitBuckets(now);

  for (const { key } of keys) {
    const bucket = passwordResetRateLimitBuckets.get(key);
    if (!bucket) {
      continue;
    }

    if (bucket.lockedUntil && now < bucket.lockedUntil) {
      return bucket;
    }

    if (now - bucket.firstAttemptAt >= passwordResetRateLimitWindowMs) {
      passwordResetRateLimitBuckets.delete(key);
    }
  }

  return null;
}

function recordPasswordResetAttempt(keys) {
  const now = Date.now();
  let lockedBucket = null;

  for (const { key, max } of keys) {
    const bucket = passwordResetRateLimitBuckets.get(key);
    const nextBucket =
      bucket && now - bucket.firstAttemptAt < passwordResetRateLimitWindowMs
        ? { ...bucket, attempts: bucket.attempts + 1 }
        : { attempts: 1, firstAttemptAt: now, lockedUntil: 0 };

    if (nextBucket.attempts >= max) {
      nextBucket.lockedUntil = now + passwordResetRateLimitLockoutMs;
      lockedBucket = lockedBucket || nextBucket;
    }

    passwordResetRateLimitBuckets.set(key, nextBucket);
  }

  return lockedBucket;
}

function sendPasswordResetLockout(res, bucket) {
  res.set("Retry-After", String(Math.ceil((bucket.lockedUntil - Date.now()) / 1000)));
  return res.status(429).json({ error: "Too many password reset attempts. Please try again later." });
}

function passwordResetRequestedPayload() {
  return {
    message: "If an account exists for that email, a password reset link has been sent.",
  };
}

function renderLegalPage(title, description, bodyHtml) {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(title)} | IELTS Study Hub</title>
        <meta name="description" content="${escapeHtml(description)}" />
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body class="legal-page">
        <header class="site-header legal-header">
          <a class="brand" href="/" aria-label="IELTS Study Hub home">
            <span class="brand-mark">I</span>
            <span>IELTS Study Hub</span>
          </a>
          <nav class="legal-page-nav" aria-label="Legal navigation">
            <a class="nav-link" href="/">Home</a>
            <a class="nav-link" href="/terms">Terms</a>
            <a class="nav-link" href="/privacy">Privacy</a>
          </nav>
        </header>
        <main class="legal-shell">
          <article class="legal-document">
            <div class="legal-title">
              <p class="eyebrow">IELTS Study Hub</p>
              <h1>${escapeHtml(title)}</h1>
              <p>Effective ${escapeHtml(policyVersion)}. This page is a practical notice, not legal advice.</p>
            </div>
            ${bodyHtml}
          </article>
        </main>
        <footer class="legal-copyright">Copyright 2026 Appliva LLC</footer>
      </body>
    </html>
  `;
}

function renderTermsPage() {
  return renderLegalPage(
    "Terms of Service",
    "Terms for using IELTS Study Hub.",
    `
      <h2>Using the service</h2>
      <p>IELTS Study Hub provides vocabulary practice, sentence translation, text-to-speech, and related study tools. You are responsible for how you use study content and for keeping your account credentials secure.</p>
      <h2>Educational content</h2>
      <p>AI-generated examples, translations, and feedback are for study support only. They may be incomplete or incorrect, and IELTS Study Hub does not guarantee any exam score, admission result, or official IELTS outcome.</p>
      <h2>Use of AI</h2>
      <p>IELTS Study Hub uses artificial intelligence services to generate vocabulary examples, translations, writing feedback, and speech audio. Review AI output before relying on it, especially for exam preparation, academic work, or important decisions.</p>
      <h2>Accounts and acceptable use</h2>
      <ul>
        <li>Provide accurate account information and verify your email address when required.</li>
        <li>Do not abuse quotas, attempt to bypass access controls, scrape the service, or interfere with other users.</li>
        <li>Do not submit content that is unlawful, harmful, or violates another person's rights.</li>
      </ul>
      <h2>Fair use</h2>
      <p>Use IELTS Study Hub in a reasonable way for personal study and learning. We may apply rate limits, quotas, temporary restrictions, or account review when usage is excessive, automated, abusive, harmful to service reliability, or outside the intended educational purpose.</p>
      <h2>Billing</h2>
      <p>Paid plans, when offered, are processed by Stripe. Billing terms shown at checkout apply to the purchase. Deleting a local app account does not automatically cancel a Stripe subscription unless the checkout or account process says otherwise.</p>
      <h2>Availability and changes</h2>
      <p>The service may change, be limited, or be unavailable at times. We may update these terms when the service changes. Material changes should be presented clearly rather than applied secretly.</p>
      <h2>Contact</h2>
      <p>Questions about these terms can be sent to ${escapeHtml(privacyContactText())}.</p>
    `,
  );
}

function renderPrivacyPage() {
  return renderLegalPage(
    "Privacy Policy",
    "Privacy notice for IELTS Study Hub.",
    `
      <h2>Information we collect</h2>
      <p>We collect account information such as email address, password hash, email verification status, plan, signup consent records, session cookies, guest identifiers, usage and quota records, and content you submit for vocabulary, translation, or text-to-speech features.</p>
      <h2>How we use information</h2>
      <ul>
        <li>To create accounts, verify email addresses, authenticate sessions, and prevent abuse.</li>
        <li>To provide study features, enforce free or paid plan limits, troubleshoot errors, and measure service health.</li>
        <li>To monitor fair use, detect abuse, protect service reliability, and apply quotas or rate limits.</li>
        <li>To send verification and password reset emails.</li>
      </ul>
      <h2>Third-party processors</h2>
      <p>Submitted study content may be sent to AI providers to generate translations, vocabulary, feedback, or audio. Billing information may be processed by Stripe. Email delivery may use the configured SMTP provider. These providers process information to support the requested service.</p>
      <h2>AI processing</h2>
      <p>When you use AI-powered features, the text you submit and related request details may be processed by AI providers to return the requested study output. Do not submit sensitive personal information that is not needed for your study request.</p>
      <h2>Cookies and retention</h2>
      <p>We use essential cookies or identifiers for login sessions, guest quota tracking, and security. We retain account, usage, and operational records for as long as needed to provide the service, enforce limits, resolve disputes, and meet legal or security needs.</p>
      <h2>Your choices and rights</h2>
      <p>You may request access, correction, deletion, or export of your account information, and you may object to or restrict certain processing where applicable law provides those rights. We do not claim to sell personal information.</p>
      <h2>Security and children</h2>
      <p>We use reasonable technical safeguards such as password hashing, session cookies, and server-side access controls. IELTS Study Hub is intended for learners old enough to manage an online study account and is not directed to young children.</p>
      <h2>Contact</h2>
      <p>Privacy requests can be sent to ${escapeHtml(privacyContactText())}. We may need to verify your identity before acting on account requests.</p>
    `,
  );
}

function renderPasswordResetPage(token) {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Reset password</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <main class="reset-page">
          <form id="resetPasswordForm" class="login-panel">
            <div>
              <p class="eyebrow">Account recovery</p>
              <h1>Reset password</h1>
              <p class="auth-copy">Choose a new password for your IELTS Study Hub account.</p>
            </div>
            <label for="newPassword">
              <span>New password</span>
              <span class="password-field">
                <input id="newPassword" name="password" type="password" autocomplete="new-password" minlength="8" required />
                <button class="password-toggle" type="button" data-password-toggle="newPassword" aria-label="Show new password">
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
              </span>
            </label>
            <label for="confirmPassword">
              <span>Confirm password</span>
              <span class="password-field">
                <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required />
                <button class="password-toggle" type="button" data-password-toggle="confirmPassword" aria-label="Show confirm password">
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
              </span>
            </label>
            <div class="auth-actions">
              <button id="resetPasswordBtn" type="submit">Reset password</button>
            </div>
            <p id="resetPasswordStatus" class="status-text" role="status"></p>
          </form>
        </main>
        <script>
          const resetToken = ${JSON.stringify(token)};
          const form = document.querySelector("#resetPasswordForm");
          const password = document.querySelector("#newPassword");
          const confirmPassword = document.querySelector("#confirmPassword");
          const statusText = document.querySelector("#resetPasswordStatus");
          const button = document.querySelector("#resetPasswordBtn");

          function setStatus(message, isError = false) {
            statusText.textContent = message;
            statusText.classList.toggle("error", isError);
          }

          document.querySelectorAll("[data-password-toggle]").forEach((toggle) => {
            toggle.addEventListener("click", () => {
              const input = document.querySelector("#" + toggle.dataset.passwordToggle);
              const shouldShow = input.type === "password";
              input.type = shouldShow ? "text" : "password";
              const fieldName = input === confirmPassword ? "confirm password" : "new password";
              toggle.setAttribute("aria-label", (shouldShow ? "Hide " : "Show ") + fieldName);
            });
          });

          form.addEventListener("submit", async (event) => {
            event.preventDefault();
            setStatus("");

            if (password.value !== confirmPassword.value) {
              setStatus("Passwords do not match.", true);
              return;
            }

            button.disabled = true;
            try {
              const response = await fetch("/api/reset-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: resetToken, password: password.value }),
              });
              const data = await response.json().catch(() => ({}));
              if (!response.ok) {
                throw new Error(data.error || "Password reset failed.");
              }
              setStatus("Password updated. Opening IELTS Study Hub...");
              window.setTimeout(() => {
                window.location.href = "/";
              }, 900);
            } catch (error) {
              setStatus(error.message, true);
            } finally {
              button.disabled = false;
            }
          });
        </script>
      </body>
    </html>
  `;
}

async function processStripeEvent(event) {
  const object = event.data.object;
  if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    await subscriptionService.syncStripeSubscription(object, event.created);
    return;
  }
  if (event.type === "checkout.session.completed" && object.subscription) {
    const subscription = await stripe.subscriptions.retrieve(object.subscription, { expand: ["items.data.price"] });
    await subscriptionService.syncStripeSubscription(subscription, event.created);
    return;
  }
  if (["invoice.paid", "invoice.payment_failed"].includes(event.type)) {
    const subscriptionId = typeof object.subscription === "string" ? object.subscription : object.parent?.subscription_details?.subscription;
    if (subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
      await subscriptionService.syncStripeSubscription(subscription, event.created);
    }
  }
}

app.post("/api/webhooks/stripe", express.raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
  if (!stripe || !stripeWebhookSecret) return res.status(503).json({ error: "Stripe webhooks are not configured." });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], stripeWebhookSecret);
  } catch {
    return res.status(400).json({ error: "Invalid Stripe webhook signature." });
  }
  try {
    const claimed = await dbPool.query(
      `INSERT INTO stripe_webhook_events (id,stripe_event_id,event_type,payload,processing_started_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (stripe_event_id) DO UPDATE SET processing_error=NULL,processing_started_at=now()
       WHERE stripe_webhook_events.processed_at IS NULL
         AND (stripe_webhook_events.processing_started_at IS NULL OR stripe_webhook_events.processing_started_at < now() - interval '5 minutes')
       RETURNING processed_at`,
      [randomUUID(), event.id, event.type, event],
    );
    if (!claimed.rowCount || claimed.rows[0].processed_at) return res.json({ received: true, duplicate: true });
    await processStripeEvent(event);
    await dbPool.query("UPDATE stripe_webhook_events SET processed_at=now(),processing_error=NULL,processing_started_at=NULL WHERE stripe_event_id=$1", [event.id]);
    res.json({ received: true });
  } catch (error) {
    await dbPool.query("UPDATE stripe_webhook_events SET processing_error=$1,processing_started_at=NULL WHERE stripe_event_id=$2", [String(error.message).slice(0, 2000), event.id]).catch(() => {});
    console.error(JSON.stringify({ event: "stripe.webhook_failed", stripe_event_id: event.id, stripe_event_type: event.type, error: error.message }));
    res.status(500).json({ error: "Stripe webhook processing failed." });
  }
});

app.use(express.json({ limit: "32kb" }));
app.get("/api/session", async (req, res, next) => {
  try {
    const user = await readUserFromSession(req);
    const subscription = user && subscriptionService ? await subscriptionService.getSubscriptionSummary(user.id) : null;
    const plan = subscription?.plan || null;
    const noPlanUsage = user && !subscription
      ? planUsagePayload("free", await getPlanUsageToday(user.id))
      : null;
    const guestId = ensureGuestId(req, res);
    const ttsUsage = dbPool
      ? await getTtsUsage(
          user
            ? { userId: Number(user.id), guestId: null, subjectHash: null, plan }
            : { userId: null, guestId, subjectHash: anonymousQuotaKey(req), plan: "guest" },
        )
      : { limitMs: 10 * 60 * 1000, remainingMs: 10 * 60 * 1000, usedMs: 0, window: "hour" };
    res.json({
      authenticated: Boolean(user),
      configured: authConfigured(),
      email: user?.email || null,
      isAdmin: isAdminUser(user),
      quota: user
        ? noPlanUsage
        : quotaPayload(maxQuotaUsage(
            await getGuestUsage(guestId),
            await getAnonymousUsage(anonymousQuotaKey(req)),
          )),
      plan,
      planLabel: subscription?.planName || null,
      planUsage: subscription?.usage || noPlanUsage,
      subscription,
      ttsUsage: ttsUsagePayload(ttsUsage),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/billing/plans", async (_req, res, next) => {
  try {
    const plans = await subscriptionService.listPlans();
    res.json({ plans: plans.map((plan) => ({
      key: plan.key, name: plan.name, description: plan.description,
      vocabularyLimit: plan.vocabulary_translation_limit,
      sentenceLimit: plan.sentence_translation_limit,
      monthlyAvailable: Boolean(plan.stripe_monthly_price_id),
    })) });
  } catch (error) { next(error); }
});

app.get("/api/billing/subscription", requireAuth, async (req, res, next) => {
  try { res.json({ subscription: await subscriptionService.getSubscriptionSummary(req.user.id) }); }
  catch (error) { next(error); }
});

app.get("/api/billing/usage", requireAuth, async (req, res, next) => {
  try { res.json({ current: (await subscriptionService.getSubscriptionSummary(req.user.id)).usage, periods: await usageService.history(req.user.id) }); }
  catch (error) { next(error); }
});

app.get("/dashboard", async (req, res, next) => {
  try {
    const user = await readUserFromSession(req);
    if (!user) return res.redirect("/?loginRequired=1");
    res.sendFile(path.join(__dirname, "dashboard.html"));
  } catch (error) { next(error); }
});

async function ensureStripeCustomer(req) {
  const existing = await dbPool.query("SELECT stripe_customer_id,email FROM app_users WHERE id=$1", [req.user.id]);
  if (existing.rows[0]?.stripe_customer_id) return existing.rows[0].stripe_customer_id;
  const customer = await stripe.customers.create({ email: existing.rows[0].email, metadata: { user_id: String(req.user.id) } });
  await dbPool.query("UPDATE app_users SET stripe_customer_id=$1,updated_at=now() WHERE id=$2 AND stripe_customer_id IS NULL", [customer.id, req.user.id]);
  const saved = await dbPool.query("SELECT stripe_customer_id FROM app_users WHERE id=$1", [req.user.id]);
  return saved.rows[0].stripe_customer_id;
}

function requireStripeBilling(res) {
  if (!stripe) { res.status(503).json({ error: "Stripe billing is not configured." }); return false; }
  return true;
}

app.post("/api/billing/checkout", requireAuth, async (req, res, next) => {
  if (!requireStripeBilling(res)) return;
  const planKey = String(req.body?.plan || "").toLowerCase();
  const interval = String(req.body?.interval || "monthly");
  if (!stripePrices[planKey] || interval !== "monthly") return res.status(400).json({ error: "Invalid or unavailable billing plan." });
  try {
    const existing = await subscriptionService.getEffectiveSubscription(req.user.id);
    if (existing?.source === "stripe") return res.status(409).json({ error: "Manage or change your existing Stripe subscription." });
    const customer = await ensureStripeCustomer(req);
    const session = await stripe.checkout.sessions.create({
      customer, mode: "subscription", line_items: [{ price: stripePrices[planKey], quantity: 1 }],
      success_url: `${publicBaseUrl(req)}/?checkout=success#subscription`,
      cancel_url: `${publicBaseUrl(req)}/?checkout=cancelled#subscription`,
      subscription_data: { metadata: { user_id: String(req.user.id), plan: planKey } },
      metadata: { user_id: String(req.user.id), plan: planKey },
    });
    res.json({ url: session.url });
  } catch (error) { next(error); }
});

app.post("/api/billing/portal", requireAuth, async (req, res, next) => {
  if (!requireStripeBilling(res)) return;
  try {
    const customer = await ensureStripeCustomer(req);
    const session = await stripe.billingPortal.sessions.create({ customer, return_url: `${publicBaseUrl(req)}/#subscription` });
    res.json({ url: session.url });
  } catch (error) { next(error); }
});

async function activeStripeSubscription(userId) {
  const result = await dbPool.query("SELECT * FROM subscriptions WHERE user_id=$1 AND source='stripe' AND status IN ('active','past_due') ORDER BY updated_at DESC LIMIT 1", [userId]);
  if (!result.rows[0]) throw Object.assign(new Error("Active Stripe subscription not found."), { statusCode: 404 });
  return result.rows[0];
}

app.post("/api/billing/upgrade", requireAuth, async (req, res, next) => {
  if (!requireStripeBilling(res)) return;
  try {
    const local = await activeStripeSubscription(req.user.id);
    const remote = await stripe.subscriptions.retrieve(local.stripe_subscription_id);
    if (String(req.body?.plan) !== "pro") return res.status(400).json({ error: "Only upgrading to Pro is supported." });
    await stripe.subscriptions.update(remote.id, { items: [{ id: remote.items.data[0].id, price: stripePrices.pro }], proration_behavior: "always_invoice" });
    res.status(202).json({ message: "Upgrade submitted. Access updates after Stripe confirmation." });
  } catch (error) { next(error); }
});

app.post("/api/billing/downgrade", requireAuth, async (req, res, next) => {
  if (!requireStripeBilling(res)) return;
  try {
    const local = await activeStripeSubscription(req.user.id);
    const remote = await stripe.subscriptions.retrieve(local.stripe_subscription_id);
    const remoteItem = remote.items.data[0];
    const periodStart = remoteItem.current_period_start || remote.current_period_start;
    const periodEnd = remoteItem.current_period_end || remote.current_period_end;
    if (String(req.body?.plan) !== "premium") return res.status(400).json({ error: "Only downgrading to Premium is supported." });
    const schedule = remote.schedule || (await stripe.subscriptionSchedules.create({ from_subscription: remote.id })).id;
    await stripe.subscriptionSchedules.update(typeof schedule === "string" ? schedule : schedule.id, {
      end_behavior: "release",
      phases: [
        { items: [{ price: remoteItem.price.id, quantity: 1 }], start_date: periodStart, end_date: periodEnd },
        { items: [{ price: stripePrices.premium, quantity: 1 }], start_date: periodEnd },
      ],
    });
    res.status(202).json({ message: "Downgrade scheduled for the next billing period." });
  } catch (error) { next(error); }
});

app.post("/api/billing/cancel", requireAuth, async (req, res, next) => {
  if (!requireStripeBilling(res)) return;
  try { const local = await activeStripeSubscription(req.user.id); await stripe.subscriptions.update(local.stripe_subscription_id, { cancel_at_period_end: true }); res.status(202).json({ message: "Cancellation scheduled." }); }
  catch (error) { next(error); }
});

app.post("/api/billing/reactivate", requireAuth, async (req, res, next) => {
  if (!requireStripeBilling(res)) return;
  try { const local = await activeStripeSubscription(req.user.id); await stripe.subscriptions.update(local.stripe_subscription_id, { cancel_at_period_end: false }); res.status(202).json({ message: "Reactivation submitted." }); }
  catch (error) { next(error); }
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
  if (req.body?.acceptedTerms !== true) {
    return res.status(400).json({ error: "Agree to the Terms and Privacy Policy to create an account." });
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

  const client = await dbPool.connect();
  try {
    await deleteExpiredUnverifiedAccounts(email);
    const passwordHash = await bcrypt.hash(password, 12);
    const verificationToken = randomBytes(32).toString("base64url");
    const verificationTokenHash = hashToken(verificationToken);
    await client.query("BEGIN");
    const result = await client.query(
      `
        INSERT INTO app_users (
          email,
          password_hash,
          email_verification_token_hash,
          email_verification_expires_at,
          terms_accepted_at,
          terms_version,
          privacy_version
        )
        VALUES ($1, $2, $3, now() + interval '24 hours', now(), $4, $5)
        ON CONFLICT (email) DO NOTHING
        RETURNING email
      `,
      [email, passwordHash, verificationTokenHash, policyVersion, policyVersion],
    );

    if (!result.rows[0]) {
      const existing = await client.query(
        "SELECT email_verified_at FROM app_users WHERE email = $1 LIMIT 1",
        [email],
      );
      await client.query("ROLLBACK");
      const canResendVerification = Boolean(existing.rows[0] && !existing.rows[0].email_verified_at);
      return res.status(409).json({
        error: canResendVerification
          ? "Email is already registered but has not been verified."
          : "Email is already registered.",
        canResendVerification,
      });
    }

    const verificationUrl = `${publicBaseUrl(req)}/api/verify-email?token=${encodeURIComponent(verificationToken)}`;
    const emailSent = await sendVerificationEmail(email, verificationUrl);
    if (!emailSent) {
      const error = new Error("Verification email is not configured.");
      error.code = "EMAIL_DELIVERY_FAILED";
      throw error;
    }
    await client.query("COMMIT");

    res.status(201).json({
      authenticated: false,
      email,
      isAdmin: false,
      verificationEmailSent: true,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "EMAIL_DELIVERY_FAILED" || error.code === "EENVELOPE" || error.command || error.responseCode) {
      return res.status(502).json({
        error: "Account was not created because the verification email could not be sent.",
      });
    }
    next(error);
  } finally {
    client.release();
  }
});

app.post("/api/resend-verification", async (req, res, next) => {
  if (!authConfigured()) {
    return res.status(503).json({ error: "Login is not configured. Set DATABASE_URL and SESSION_SECRET." });
  }

  const email = normalizeEmail(req.body?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Enter a valid email address." });
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

  const client = await dbPool.connect();
  try {
    await deleteExpiredUnverifiedAccounts(email);
    const verificationToken = randomBytes(32).toString("base64url");
    const verificationTokenHash = hashToken(verificationToken);

    await client.query("BEGIN");
    const result = await client.query(
      `
        UPDATE app_users
        SET
          email_verification_token_hash = $1,
          email_verification_expires_at = now() + interval '24 hours',
          updated_at = now()
        WHERE email = $2
          AND email_verified_at IS NULL
          AND created_at >= now() - interval '7 days'
        RETURNING email
      `,
      [verificationTokenHash, email],
    );

    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      return res.json({ message: "If an unverified account exists, a new verification link has been sent." });
    }

    const verificationUrl = `${publicBaseUrl(req)}/api/verify-email?token=${encodeURIComponent(verificationToken)}`;
    const emailSent = await sendVerificationEmail(email, verificationUrl);
    if (!emailSent) {
      await client.query("ROLLBACK");
      return res.status(502).json({ error: "Verification email could not be sent." });
    }

    await client.query("COMMIT");
    res.json({ message: "A new verification link has been sent." });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
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

app.post("/api/forgot-password", async (req, res, next) => {
  if (!authConfigured()) {
    return res.status(503).json({ error: "Login is not configured. Set DATABASE_URL and SESSION_SECRET." });
  }

  const email = normalizeEmail(req.body?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  const resetKeys = passwordResetRateLimitKeys(req, email);
  const activeLockout = getActivePasswordResetLockout(resetKeys);
  if (activeLockout) {
    return sendPasswordResetLockout(res, activeLockout);
  }

  const resetBucket = recordPasswordResetAttempt(resetKeys);
  if (resetBucket) {
    return sendPasswordResetLockout(res, resetBucket);
  }

  try {
    const user = await findActiveUser(email);
    if (user) {
      const resetToken = randomBytes(32).toString("base64url");
      await dbPool.query(
        `
          UPDATE app_users
          SET
            password_reset_token_hash = $1,
            password_reset_expires_at = now() + interval '1 hour',
            updated_at = now()
          WHERE id = $2
        `,
        [hashToken(resetToken), user.id],
      );

      const resetUrl = `${publicBaseUrl(req)}/reset-password?token=${encodeURIComponent(resetToken)}`;
      await sendPasswordResetEmail(user.email, resetUrl);
    }

    res.json(passwordResetRequestedPayload());
  } catch (error) {
    next(error);
  }
});

app.get("/reset-password", async (req, res, next) => {
  if (!authConfigured()) {
    return res.status(503).send("Login is not configured.");
  }

  const token = String(req.query.token || "");
  if (!token) {
    return res.status(400).send("Password reset token is required.");
  }

  try {
    const user = await findActiveUserByResetToken(token);
    if (!user) {
      return res.status(400).send("Password reset link is invalid or expired.");
    }

    res.type("html").send(renderPasswordResetPage(token));
  } catch (error) {
    next(error);
  }
});

app.post("/api/reset-password", async (req, res, next) => {
  if (!authConfigured()) {
    return res.status(503).json({ error: "Login is not configured. Set DATABASE_URL and SESSION_SECRET." });
  }

  const token = String(req.body?.token || "");
  const password = String(req.body?.password || "");
  const validationError = validatePassword(password);
  if (!token) {
    return res.status(400).json({ error: "Password reset token is required." });
  }
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const user = await findActiveUserByResetToken(token);
    if (!user) {
      return res.status(400).json({ error: "Password reset link is invalid or expired." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await dbPool.query(
      `
        UPDATE app_users
        SET
          password_hash = $1,
          password_reset_token_hash = null,
          password_reset_expires_at = null,
          updated_at = now()
        WHERE id = $2
      `,
      [passwordHash, user.id],
    );

    if (user.email_verified_at) {
      setSessionCookie(req, res, user.email);
    }
    res.json({ authenticated: Boolean(user.email_verified_at), email: user.email, isAdmin: isAdminUser(user) });
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

    if (!user.email_verified_at) {
      clearLoginRateLimit(loginKey);
      clearSessionCookie(res);
      return res.status(403).json({
        error: "Verify your email address before logging in.",
        canResendVerification: true,
      });
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

app.get("/api/admin/users", requireAdmin, async (_req, res, next) => {
  try {
    const result = await dbPool.query(
      `
        SELECT id, email, plan, is_active, email_verified_at, created_at, updated_at
        FROM app_users
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [adminUserLimit],
    );
    const usageByUserId = await getAdminUserUsage(result.rows.map((row) => Number(row.id)));
    const users = [];
    for (const row of result.rows) {
      users.push(await adminUserPayload(row, usageByUserId.get(Number(row.id))));
    }
    res.json({
      users,
      stripeConfigured: Boolean(stripe),
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/admin/users/:id/plan", requireAdmin, async (req, res, next) => {
  const userId = Number(req.params.id);
  const plan = normalizeAccountPlan(req.body?.plan);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "Invalid user id." });
  }
  if (!validAccountPlans.has(String(req.body?.plan || "").trim().toLowerCase())) {
    return res.status(400).json({ error: "Invalid plan." });
  }
  if (userId === Number(req.user.id) && !isAdminEmail(req.user.email) && plan !== "admin") {
    return res.status(400).json({ error: "You cannot remove your own admin plan." });
  }

  try {
    const result = await dbPool.query(
      `
        UPDATE app_users
        SET plan = $1, updated_at = now()
        WHERE id = $2
        RETURNING id, email, plan, is_active, email_verified_at, created_at, updated_at
      `,
      [plan, userId],
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json({ user: await adminUserPayload(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/users/:id/subscription", requireAdmin, async (req, res, next) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: "Invalid user id." });
  const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) return res.status(400).json({ error: "Expiration must be in the future." });
  try {
    const subscription = await subscriptionService.grantAdminSubscription({ userId, planKey: String(req.body?.plan || ""), actorUserId: req.user.id, expiresAt, reason: String(req.body?.reason || "") });
    res.status(201).json({ subscription });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ error: error.message }); next(error); }
});

app.patch("/api/admin/users/:id/subscription", requireAdmin, async (req, res, next) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: "Invalid user id." });
  const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
  try {
    const subscription = await subscriptionService.grantAdminSubscription({ userId, planKey: String(req.body?.plan || ""), actorUserId: req.user.id, expiresAt, reason: String(req.body?.reason || "Plan changed by administrator") });
    res.json({ subscription });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ error: error.message }); next(error); }
});

app.delete("/api/admin/users/:id/subscription", requireAdmin, async (req, res, next) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: "Invalid user id." });
  try { await subscriptionService.removeAdminSubscription({ userId, actorUserId: req.user.id, reason: String(req.body?.reason || "Removed by administrator") }); res.json({ removed: true }); }
  catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ error: error.message }); next(error); }
});

app.get("/api/admin/users/:id/usage", requireAdmin, async (req, res, next) => {
  const userId = Number(req.params.id);
  try { res.json({ subscription: await subscriptionService.getSubscriptionSummary(userId), periods: await usageService.history(userId) }); }
  catch (error) { next(error); }
});

app.post("/api/admin/users/:id/usage-adjustment", requireAdmin, async (req, res, next) => {
  const userId = Number(req.params.id);
  const type = String(req.body?.type || "");
  const amount = Number(req.body?.amount);
  const reason = String(req.body?.reason || "").trim();
  const columns = type === "vocabulary_translation" ? { used: "vocabulary_used", limit: "vocabulary_limit" } : type === "sentence_translation" ? { used: "sentence_used", limit: "sentence_limit" } : null;
  if (!Number.isSafeInteger(userId) || !columns || !Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 1000 || !reason) return res.status(400).json({ error: "Valid type, non-zero amount, and reason are required." });
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const effective = await subscriptionService.getEffectiveSubscription(userId, client);
    if (!effective) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Active subscription not found." }); }
    const period = await subscriptionService.ensureUsagePeriod(effective, client);
    const updated = await client.query(`UPDATE usage_periods SET ${columns.used}=LEAST(${columns.limit},GREATEST(0,${columns.used}+$1)),updated_at=now() WHERE id=$2 RETURNING ${columns.used} AS used,${columns.limit} AS limit`, [amount, period.id]);
    await client.query("INSERT INTO billing_audit_events (id,event_type,actor_user_id,target_user_id,old_value,new_value,reason) VALUES ($1,'usage.admin_adjusted',$2,$3,$4,$5,$6)", [randomUUID(), req.user.id, userId, { type }, { type, amount, ...updated.rows[0] }, reason]);
    await client.query("COMMIT");
    res.json({ usage: updated.rows[0] });
  } catch (error) { await client.query("ROLLBACK"); next(error); } finally { client.release(); }
});

app.delete("/api/admin/users/:id", requireAdmin, async (req, res, next) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "Invalid user id." });
  }
  if (userId === req.user.id) {
    return res.status(400).json({ error: "You cannot delete your own admin account." });
  }

  try {
    const result = await dbPool.query("DELETE FROM app_users WHERE id = $1 RETURNING id, email", [userId]);
    if (!result.rows[0]) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json({ deleted: true, user: { id: Number(result.rows[0].id), email: result.rows[0].email } });
  } catch (error) {
    next(error);
  }
});

app.use("/api/vocab", allowAuthenticatedOrGuestQuota("vocab"));
app.use("/api/search-vocab", allowAuthenticatedOrGuestQuota("vocab"));
app.use("/api/translate-sentence", allowAuthenticatedOrGuestQuota("translation"));
app.use("/api/tts", attachOptionalUser);
app.use((req, res, next) => {
  if (req.path !== "/metrics") {
    recordUniqueUser(req, res);
  }
  next();
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/admin", requireAdminPage, (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/terms", (_req, res) => {
  res.type("html").send(renderTermsPage());
});

app.get("/privacy", (_req, res) => {
  res.type("html").send(renderPrivacyPage());
});

app.get(["/app.js", "/admin.js", "/dashboard.js", "/styles.css"], (req, res) => {
  res.sendFile(path.join(__dirname, req.path));
});

app.get("/metrics", requireMetricsToken, (_req, res) => {
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderMetrics());
});

app.post("/api/tts", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Text-to-speech text is required." });
  if (text.length > 1000) return res.status(400).json({ error: "Text-to-speech text must be 1,000 characters or fewer." });
  if (configuredAiApiKeys().length === 0) {
    return res.status(503).json({ error: "AI_API_KEY or GEMINI_API_KEY_PAID is not configured." });
  }

  const identity = ttsIdentity(req, res);
  try {
    const ttsResult = await withTtsGenerationGate(identity, async () => {
      const before = await getTtsUsage(identity);
      if (before.limitMs !== null && before.remainingMs <= 0) return { limited: true, usage: before };

      const generated = await fetchTtsAudio(text);
      const recorded = await recordTtsUsage(identity, generated);
      return { generated, recorded };
    });
    if (ttsResult.limited) return sendTtsLimitExceeded(res, ttsResult.usage);

    const { generated, recorded } = ttsResult;
    const outcome = recorded.delivered ? "delivered" : "quota_rejected";
    recordTtsMetrics(generated, {
      plan: identity.plan,
      keyType: generated.keyType,
      voice: generated.voice,
      model: generated.model,
    }, outcome);
    if (!recorded.delivered) return sendTtsLimitExceeded(res, recorded.usage);

    setTtsUsageHeaders(res, recorded.usage, generated.durationMs);
    res.type("audio/wav").send(generated.wav);
  } catch (error) {
    res.status(502).json({ error: error.name === "AbortError" ? "Text-to-speech generation timed out." : error.message || "Text-to-speech generation failed." });
  }
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

  if (configuredAiApiKeys().length === 0) {
    return res.status(503).json({ error: "AI_API_KEY or GEMINI_API_KEY_PAID is not configured." });
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

  let usageReservation;
  try {
    usageReservation = await reserveTranslationUsage(req, res, "vocabulary");
    if (!usageReservation) return;

    const generated = await fetchGeneratedJson(prompt);

    if (!Array.isArray(generated.words)) {
      throw new Error("AI service returned invalid data.");
    }

    const words = generated.words.slice(0, 20);
    if (!(await finalizeTranslationUsage(usageReservation))) return;
    recordGeneratedWords(words);
    res.json({ words });
  } catch (error) {
    await refundTranslationUsage(usageReservation);
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

  if (configuredAiApiKeys().length === 0) {
    return res.status(503).json({ error: "AI_API_KEY or GEMINI_API_KEY_PAID is not configured." });
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

  let usageReservation;
  try {
    usageReservation = await reserveTranslationUsage(req, res, "vocabulary");
    if (!usageReservation) return;

    const generated = await fetchGeneratedJson(prompt);
    if (!generated.word) {
      throw new Error("Generation service returned invalid data.");
    }
    if (!(await finalizeTranslationUsage(usageReservation))) return;
    recordGeneratedWords([generated]);
    res.json({ word: generated });
  } catch (error) {
    await refundTranslationUsage(usageReservation);
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

  if (text.length > 200) {
    return res.status(400).json({ error: "Sentence text must be 200 characters or fewer." });
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

  if (configuredAiApiKeys().length === 0) {
    return res.status(503).json({ error: "AI_API_KEY or GEMINI_API_KEY_PAID is not configured." });
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

  let usageReservation;
  try {
    usageReservation = await reserveTranslationUsage(req, res, "sentence");
    if (!usageReservation) return;

    const generated = await fetchGeneratedJson(prompt);
    if (!generated.translation) {
      throw new Error("AI service returned invalid translation data.");
    }
    if (!(await finalizeTranslationUsage(usageReservation))) return;
    recordSentenceTranslation();
    res.json(generated);
  } catch (error) {
    await refundTranslationUsage(usageReservation);
    res.status(502).json({ error: error.message || "Sentence translation failed." });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error." });
});

if (require.main === module) {
  initializeDatabase()
    .then(async () => {
      const deletedAccounts = await deleteExpiredUnverifiedAccounts();
      if (deletedAccounts) {
        console.log(`Deleted ${deletedAccounts} expired unverified account(s).`);
      }
      const cleanupTimer = setInterval(() => {
        deleteExpiredUnverifiedAccounts()
          .then((deleted) => {
            if (deleted) console.log(`Deleted ${deleted} expired unverified account(s).`);
          })
          .catch((error) => console.error(`Unable to clean up unverified accounts: ${error.message}`));
      }, unverifiedAccountCleanupIntervalMs);
      cleanupTimer.unref();

      app.listen(port, () => {
        console.log(`IELTS app listening on port ${port}`);
      });
    })
    .catch((error) => {
      console.error(`Unable to initialize Postgres login: ${error.message}`);
      process.exit(1);
    });
}

module.exports = {
  accountPlans,
  accountPlanLabel,
  configuredAiApiKeys,
  dailyLimitForPlan,
  effectiveAccountPlan,
  fetchGeneratedJson,
  normalizeAccountPlan,
  planUsagePayload,
  renderMetrics,
  fetchTtsAudio,
  getTtsUsage,
  recordTtsUsage,
  ttsLockKeys,
  ttsUsagePayload,
  withTtsGenerationGate,
};
