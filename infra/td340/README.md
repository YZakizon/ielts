# td340 Deployment

Production on `td340` deploys to `/home/yeffry/ielts`. The app container binds
only to `127.0.0.1:8091`, and host-managed Nginx proxies `ielts.appliva.io`
to that loopback port over HTTP. Run certbot separately when DNS is ready.

1. Create `/home/yeffry/ielts/.env` on `td340`:

```bash
AI_API_KEY=your_key_here
AI_MODEL=
IELTS_HOST_PORT=8091
METRICS_FILE=/data/metrics.json
```

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
curl -I http://ielts.appliva.io
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
- `ielts_unique_users_per_day{day="YYYY-MM-DD"}`
