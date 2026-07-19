# k8s — deploying the OpenMW Analytics API to k3s

These manifests deploy the API container (from GHCR) onto the single-node k3s cluster
on the EC2 box, wired to the managed RDS Postgres.

## Objects

| File | Kind | Role |
|------|------|------|
| `deployment.yaml` | Deployment | Runs 1 replica of the GHCR image, injects env, probes `/health` |
| `service.yaml` | Service (ClusterIP) | Stable in-cluster address in front of the pod; Ingress target |
| — | Secret | Holds `DATABASE_URL`; created imperatively, **never committed** |

## The Secret (do NOT put this in git)

The connection string contains the DB password, so it's created imperatively on the box
rather than as a checked-in YAML file. Run this on the EC2 (fill in the real password):

```bash
kubectl create secret generic omwa-api-secrets \
  --from-literal=DATABASE_URL='postgresql://omwa:<PASSWORD>@omwa-db.crs8e8i0k5q4.us-east-2.rds.amazonaws.com:5432/omwanalytics'
```

The Deployment references it via `secretKeyRef` and sets `DATABASE_SSL=true` (RDS requires TLS).

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

## Prerequisites

- CI green and the GHCR package **public** (so k3s pulls anonymously).
- The `events` table already migrated into RDS (`drizzle-kit push`).
- RDS security group allows 5432 inbound from the EC2's security group.
