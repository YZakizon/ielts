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
POSTGRES_DB=ielts
POSTGRES_USER=ielts
POSTGRES_PASSWORD=change_this_postgres_password
DATABASE_URL=postgresql://ielts:change_this_postgres_password@postgres:5432/ielts
AUTH_USERNAME=admin
AUTH_PASSWORD=change_me
SESSION_SECRET=replace_with_a_long_random_secret
LOGIN_RATE_LIMIT_WINDOW_MS=900000
LOGIN_RATE_LIMIT_MAX=5
LOGIN_RATE_LIMIT_LOCKOUT_MS=900000
```

`AUTH_USERNAME` and `AUTH_PASSWORD` seed or update the initial login user in
Postgres on startup. The app stores only a bcrypt password hash.
Failed login attempts are rate-limited by IP and username.

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

Metrics exposed:

- `ielts_ai_calls_total`
- `ielts_ai_tokens_total`
- `ielts_distinct_vocab_total`
- `ielts_vocab_per_day_total{day="YYYY-MM-DD"}`
- `ielts_sentence_translations_total`
- `ielts_sentence_translations_per_day_total{day="YYYY-MM-DD"}`
- `ielts_unique_users_per_day{day="YYYY-MM-DD"}`
