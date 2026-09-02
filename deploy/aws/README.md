# Countersign on AWS

One EC2 instance, one Docker Compose stack: the app, its Postgres, and Caddy
terminating TLS on a public hostname. No RDS, no load balancer, no VPC
connectors — this is one deployable and one worker against one database
(docs/LIMITATIONS.md §13 says what a second box would need), and the free
tier covers it.

The public hostname is `<ip-with-dashes>.sslip.io`, which resolves to the
instance's Elastic IP without owning a domain; Caddy gets a Let's Encrypt
certificate for it. Point a real domain at the IP later and change one line.

## Pieces

| File | Role |
|---|---|
| `../../Dockerfile` | The app image: `pnpm build`, production deps, `dist/`, `migrations/`, `assets/` |
| `compose.yml` | app + postgres (locale C, like dev) + caddy; secrets from `/opt/countersign/` |
| `Caddyfile` | `{$PUBLIC_HOST}` → `app:3000`, automatic HTTPS |
| `bootstrap-instance.sh` | EC2 user-data: Docker, the compose plugin, swap, `/opt/countersign` |
| `deploy.sh` | build here → `docker save` over ssh → `docker compose up -d` there |

## Procedure

1. **Keys for this deployment**, never the laptop's:
   ```bash
   pnpm exec tsx scripts/gen-keys.ts --trust .countersign/aws/trust.aws.json \
     --audience https://<public-host> > .countersign/aws/keys.env
   ```
   `trust.aws.json` is what a third party verifies this deployment's exports
   with. `.countersign/` is gitignored.
2. **`app.env`** (also under `.countersign/aws/`): `NODE_ENV=production`,
   `COUNTERSIGN_BASE_URL=https://<public-host>`,
   `DATABASE_URL=postgres://countersign:<password>@postgres:5432/countersign`,
   the three `*_JWK` lines from step 1, `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`
   (test mode), `RAZORPAY_WEBHOOK_SECRET` (choose it; paste the same into the
   Razorpay dashboard), `RAZORPAY_MODE=live` (live means the real test-mode API rather than the in-memory fake; keys stay `rzp_test_`, boot refuses `rzp_live_`), `WEBHOOK_MAX_AGE_SECONDS=93600`.
   The Postgres password goes in its own file for compose's secret.
3. **Instance**: security group with 80/443 open and 22 from your IP, a key
   pair, an Elastic IP, Amazon Linux 2023 with `bootstrap-instance.sh` as
   user-data. `t3.micro` is enough.
4. **Deploy**:
   ```bash
   deploy/aws/deploy.sh ec2-user@<ip> <ip-with-dashes>.sslip.io \
     .countersign/aws/app.env .countersign/aws/postgres_password
   ```
   Migrations run at boot. `https://<public-host>/healthz` answers `{"ok":true}`.
5. **Webhook**: Razorpay dashboard (test mode) → Webhooks → URL
   `https://<public-host>/webhooks/razorpay`, the secret from step 2, events
   `payment.authorized`, `payment.captured`, `payment.failed`,
   `refund.created`, `refund.processed`.
6. **Prove it**: a purchase against the public URL with this deployment's
   keys, then pay it, then export and verify with `trust.aws.json`:
   ```bash
   set -a; source .countersign/aws/keys.env; set +a
   COUNTERSIGN_BASE_URL=https://<public-host> make buy
   ```

Redeploy is step 4 again. The database lives in the `pgdata` volume on the
instance; the audit log is only as durable as that disk, which is exactly the
kind of thing LIMITATIONS.md exists to say.
