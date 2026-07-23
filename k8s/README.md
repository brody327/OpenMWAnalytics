# k8s — deploying the OpenMW Analytics API to k3s

These manifests deploy the API container (from GHCR) onto the single-node k3s cluster
on the EC2 box, wired to the managed RDS Postgres.

## Objects

| File | Kind | Role |
|------|------|------|
| `deployment.yaml` | Deployment | Runs 1 replica of the GHCR image, injects env, probes `/health` |
| `service.yaml` | Service (ClusterIP) | Stable in-cluster address in front of the pod; Ingress target |
| `cluster-issuer.yaml` | ClusterIssuer ×2 | Let's Encrypt (staging + prod) ACME issuers for cert-manager |
| `ingress.yaml` | Ingress | Public HTTPS route `api.omwanalytics.com` → the Service, TLS via cert-manager |
| `cronjob-friction-rollup.yaml` | CronJob | Folds newly-settled sessions into the friction rollups every 5 min (design docs `06`) |
| — | Secret | Holds `DATABASE_URL`; created imperatively, **never committed** |

## The Secret (do NOT put this in git)

The connection string contains the DB password, so it's created imperatively on the box
rather than as a checked-in YAML file. Run this on the EC2 (fill in the real password):

```bash
kubectl create secret generic omwa-api-secrets \
  --from-literal=DATABASE_URL='postgresql://omwa:<PASSWORD>@omwa-db.crs8e8i0k5q4.us-east-2.rds.amazonaws.com:5432/omwanalytics' \
  --from-literal=OMWA_INGEST_TOKEN='<TOKEN>'
```

The Deployment references both via `secretKeyRef` and sets `DATABASE_SSL=true` (RDS requires TLS).

**`OMWA_INGEST_TOKEN`** authenticates `POST /events` — the only write path. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

The same value goes to the shipper as `OMWA_INGEST_TOKEN`. ⚠️ **The API fails closed:** if the
key is absent the write path returns 503 and logs loudly, rather than silently accepting
unauthenticated writes — a missing config breaks ingestion noisily instead of removing the
control. To add the key to an existing secret:

```bash
kubectl patch secret omwa-api-secrets \
  -p "{\"stringData\":{\"OMWA_INGEST_TOKEN\":\"<TOKEN>\"}}"
kubectl rollout restart deployment/omwa-api    # pods read secrets at start
```

## Apply

From the repo `k8s/` dir on the EC2 (or `kubectl apply -f` each file):

```bash
kubectl apply -f service.yaml
kubectl apply -f deployment.yaml
kubectl rollout status deployment/omwa-api   # watch it come up + pull from GHCR
kubectl get pods -l app=omwa-api             # should be Running / READY 1/1
kubectl logs -l app=omwa-api                 # '[api] listening on ...'
```

If the pod is stuck in `ImagePullBackOff`, the GHCR package is likely still private —
make it public (GitHub → Packages → omwanalytics-api → settings → visibility), or add an
imagePullSecret.

## Public URL: cert-manager + Ingress

Install cert-manager once per cluster (CRDs + 3 pods: controller, webhook, cainjector):

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.21.0/cert-manager.yaml
kubectl -n cert-manager rollout status deploy/cert-manager-webhook   # wait: it must be Ready
```

Then apply the issuers and the route:

```bash
kubectl apply -f cluster-issuer.yaml
kubectl apply -f ingress.yaml
```

Then the rollup scheduler (it reuses the same image and the same `omwa-api-secrets`):

```bash
kubectl apply -f cronjob-friction-rollup.yaml
kubectl get cronjob omwa-friction-rollup
kubectl get jobs -l app=omwa-friction-rollup     # did it run, did it work
kubectl logs -l app=omwa-friction-rollup --tail=20
kubectl create job --from=cronjob/omwa-friction-rollup rollup-manual-1   # force a run now
```

⚠️ **Schema must land in RDS BEFORE the image that depends on it.** There is no automated
migration step yet (see design docs `09 §7`) — CI ships code, schema is applied by hand, and
nothing links the two. This has already caused a production 500.

For the rollup work specifically, RDS needs **both**:

1. the three tables — `friction_rollup`, `friction_sessions_done`, `friction_attempts_rollup`
   (incl. `install_id`);
2. the **stored generated columns on `events`** — `suspect`, `topic`, `reason`, `passed`, plus
   `events_confrontation_cols_idx` and `events_confrontation_reason_idx`, then
   `VACUUM ANALYZE events` (adding a generated column rewrites the table, leaving the visibility
   map cold, so index-only scans fall back to heap fetches until vacuumed).

Missing (2) is what broke `/stats/confrontations` — an endpoint the rollup PR never touched.
**Verify every endpoint after a deploy, not just the one you changed.** Until the first fold
completes, `/stats/friction` returns empty arrays rather than an error.

Watch the ACME flow. A `Certificate` spawns a `CertificateRequest` → `Order` → `Challenge`;
each disappears as it completes, and the `omwa-api-tls` Secret appearing means success:

```bash
kubectl get certificate,certificaterequest,order,challenge
kubectl describe certificate omwa-api-tls     # events tell you exactly where it stalled
kubectl get secret omwa-api-tls               # exists ⇒ issued
curl -v https://api.omwanalytics.com/health
```

Issuance normally takes 30–90s. If `Challenge` sits in `pending`, the cause is almost always
reachability, not k8s: check the A record resolves to the Elastic IP (`nslookup`) and that
port **80** is open to `0.0.0.0/0` in the EC2 security group — Let's Encrypt fetches the
challenge URL from the public internet, so a My-IP-only rule fails.

## Prerequisites

- CI green and the GHCR package **public** (so k3s pulls anonymously).
- The `events` table already migrated into RDS (`drizzle-kit push`).
- RDS security group allows 5432 inbound from the EC2's security group.
- EC2 security group allows **80 and 443 from `0.0.0.0/0`** (80 is required for HTTP-01).
- An **Elastic IP** associated with the instance, and an `A` record for
  `api.omwanalytics.com` pointing at it (DNS-only, not proxied).
