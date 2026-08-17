# td340 Deployment

Production on `td340` deploys to `/home/yeffry/ielts`. The app container binds
only to `127.0.0.1:8091`, and host-managed Nginx proxies `ielts.appliva.io`
to that loopback port over HTTPS. Run certbot separately before installing the
HTTPS vhost if certificates are not already present.

The repository uses one `docker-compose.yml` with profiles: `dev` is for local
Traefik, and `td340` is for production Nginx.

1. Create `/home/yeffry/ielts/.env` on `td340`:

```bash
AI_API_KEY=your_key_here
AI_MODEL=
TTS_MODEL=gemini-2.5-flash-preview-tts
TTS_VOICE=Achernar
TTS_REQUEST_TIMEOUT_MS=30000
IELTS_HOST_PORT=8091
METRICS_FILE=/data/metrics.json
METRICS_TOKEN=replace_with_a_long_random_metrics_token
POSTGRES_DB=ielts
POSTGRES_USER=ielts
POSTGRES_PASSWORD=change_this_postgres_password
DATABASE_URL=postgresql://ielts:change_this_postgres_password@postgres:5432/ielts
ADMIN_EMAILS=capis2256@gmail.com,yeffry@appliva.io
SESSION_SECRET=replace_with_a_long_random_secret
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_PREMIUM_MONTHLY=
STRIPE_PRICE_PRO_MONTHLY=
STRIPE_PAST_DUE_GRACE_DAYS=0
ADMIN_USER_LIMIT=100
SMTP_TIMEOUT_MS=5000
LOGIN_RATE_LIMIT_WINDOW_MS=900000
LOGIN_RATE_LIMIT_MAX=5
LOGIN_RATE_LIMIT_LOCKOUT_MS=900000
GUEST_VOCABULARY_LIMIT=2
GUEST_SENTENCE_TRANSLATION_LIMIT=2
NO_PLAN_REQUEST_LIMIT_PER_DAY=10
NO_PLAN_VOCAB_DAILY_LIMIT=10
NO_PLAN_SENTENCE_DAILY_LIMIT=10
GUEST_TTS_HOURLY_LIMIT_MINUTES=10
NO_PLAN_TTS_HOURLY_LIMIT_MINUTES=15
PREMIUM_TTS_DAILY_LIMIT_MINUTES=50
ULTIMATE_TTS_DAILY_LIMIT_MINUTES=90
```

The `td340` Compose profile requires this `.env` and passes it into the app
container; do not duplicate these app settings in `environment:` unless Compose
must set a container-only constant.

`ADMIN_EMAILS` is a comma-separated list. Any signed-up user whose email is in
that list is treated as an admin.
Admins can open `/admin` to grant permanent or expiring Premium and Pro access.
Stripe customers are linked by their stored customer ID, never by email lookup.
Create monthly Stripe Prices for Premium and Pro, place their IDs in the matching
environment variables, enable the Stripe Customer Portal, and register
`https://ielts.appliva.io/api/webhooks/stripe` for Checkout Session, customer
subscription, invoice paid, and invoice payment failed events. Use the endpoint's
signing secret as `STRIPE_WEBHOOK_SECRET`.
Failed login attempts are rate-limited by IP and email. Signup sends the email
verification link through the configured SMTP server. Without SMTP, the app logs
the verification link server-side for local development only.
Translation endpoints require a verified login and either an active Stripe-paid
subscription or an active administrator grant. There is no free plan or trial.
Text-to-speech uses Gemini 2.5 Flash Preview TTS with the Achernar voice by
default. Anonymous visitors and Free accounts receive 10 generated audio
minutes per rolling hour, Premium receives 50 minutes per UTC day, Ultimate
receives 90 minutes per UTC day, and Admin is unlimited. Quotas count generated
audio duration rather than playback time.

2. Deploy the app:

```bash
make deploy-td340
```

3. Install or refresh the Nginx vhost:

```bash
make nginx-install-td340
```

4. Verify:

```bash
ssh td340 'cd /home/yeffry/ielts && COMPOSE_PROFILES=td340 docker compose ps'
curl -I https://ielts.appliva.io
```

Prometheus/Grafana can scrape:

```text
http://127.0.0.1:8091/metrics
```

`/metrics` requires a token. Send either:

```text
Authorization: Bearer $METRICS_TOKEN
X-Metrics-Token: $METRICS_TOKEN
```

Metrics exposed:

- `ielts_ai_calls_total`
- `ielts_ai_tokens_total`
- `ielts_distinct_vocab_total`
- `ielts_vocab_per_day_total{day="YYYY-MM-DD"}`
- `ielts_sentence_translations_total`
- `ielts_sentence_translations_per_day_total{day="YYYY-MM-DD"}`
- `ielts_unique_users_per_day{day="YYYY-MM-DD"}`
- `ielts_tts_generated_seconds_total{plan,key_type,voice,model}`
- `ielts_tts_tokens_total{token_type,plan,key_type,voice,model}`
- `ielts_tts_generations_total{outcome,plan,key_type,voice,model}`

The standalone Grafana dashboard is stored at
`infra/gw1/grafana/ielts-tts.json`. Import or provision it in the existing
Grafana instance without replacing its other dashboards or provisioning.
