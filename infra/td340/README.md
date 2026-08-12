# td340 Deployment

Production on `td340` deploys to `/home/yeffry/ielts`. The app container binds
only to `127.0.0.1:8091`, and host-managed Nginx proxies `ielts.appliva.io`
to that loopback port over HTTPS. Run certbot separately before installing the
HTTPS vhost if certificates are not already present.

1. Create `/home/yeffry/ielts/.env` on `td340`:

```bash
AI_API_KEY=your_key_here
AI_MODEL=
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
LOGIN_RATE_LIMIT_WINDOW_MS=900000
LOGIN_RATE_LIMIT_MAX=5
LOGIN_RATE_LIMIT_LOCKOUT_MS=900000
FREE_SESSION_LIMIT=5
FREE_VOCAB_GENERATION_LIMIT=2
FREE_ACCOUNT_LIMIT_PER_MINUTE=2
FREE_ACCOUNT_LIMIT_PER_HOUR=20
FREE_ACCOUNT_LIMIT_PER_DAY=50
```

`ADMIN_EMAILS` is a comma-separated list. Any signed-up user whose email is in
that list is treated as an admin.
Failed login attempts are rate-limited by IP and email. Signup sends the email
verification link through the configured SMTP server. Without SMTP, the app logs
the verification link server-side for local development only.
Anonymous visitors can use up to `FREE_SESSION_LIMIT` sentence translations and
`FREE_VOCAB_GENERATION_LIMIT` AI vocabulary generations before creating an
account or logging in. The anonymous trial is enforced by both the guest cookie
and a server-side hashed requester-IP quota, so clearing cookies does not reset
AI access.
Logged-in free accounts can make up to `FREE_ACCOUNT_LIMIT_PER_MINUTE` combined
AI requests per minute, `FREE_ACCOUNT_LIMIT_PER_HOUR` per hour, and
`FREE_ACCOUNT_LIMIT_PER_DAY` per day across vocabulary generation, vocabulary
search, and sentence translation.

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
ssh td340 'docker compose -f /home/yeffry/ielts/docker-compose.td340.yml ps'
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
