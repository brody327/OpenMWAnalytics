# 09 — Deployment & Hosting

**Status:** 🟡 in progress (2026-07-19). Cloud VM + Kubernetes + managed DB + CI are
stood up; RDS networking, k8s manifests, and the public URL are the remaining work.
Live step-by-step state and the exact resume point are tracked in agent memory
(`project-deployment-plan`); this doc records the *design*.

Also a deliberate learning target: the job baseline's "What Sets You Apart" line —
**"cloud infrastructure, Docker/Kubernetes, and CI/CD."** Dosed to *demonstrate*, not
to become an infra specialist (one node, not a fleet).

---

## 1. The deploy boundary — what can and cannot be hosted

The pull architecture (`01`) draws the deployment line for us:

```
┌─ LOCAL (each player's PC) ──────────────┐        ┌─ CLOUD ────────────────────────────┐
│  OpenMW mod → openmw.log → shipper       │──POST──▶│  API → Postgres → (dashboard)      │
└──────────────────────────────────────────┘   ▲    └─────────────────────────────────────┘
                                                └── the shipper→API HTTP seam = the deploy line
```

The **mod and shipper can never be cloud-hosted** — they run where the game runs. Only
the **API, database, and dashboard** are hostable. Deployment is therefore just
*repointing config*: the shipper's `OMWA_API` and the dashboard's `OMWA_API_BASE` move
from `localhost` to a public URL. Both were env-externalized from the start, so the app
was already deploy-shaped — the egress design paid off here.

---

## 2. Target topology

| Component | Host | Why |
| --- | --- | --- |
| **API** (Express, Dockerized) | **k3s** on one **AWS EC2** VM (Linux) | exercises cloud + Docker + Kubernetes + Linux admin on one cheap/free box |
| **Postgres** | **AWS RDS** (managed) | see §3 — capacity forced it, and it's the managed-stateful lesson |
| **Image registry** | **GHCR** (ghcr.io) | free; GitHub Actions pushes here; k3s pulls |
| **CI/CD** | **GitHub Actions** | build+push image on git push (deploy step to follow) |
| **Dashboard** (Next.js) | **Vercel** | idiomatic Next host; pure consumer of the public API |
| **Shipper** | stays LOCAL | can't be hosted; repoints at the public API |

**Why k3s on one VM (not managed EKS, not Docker-Compose):** k3s is a single-binary,
full-API Kubernetes. On one VM it gives *real* manifests / `kubectl` / orchestration
concepts (the JD names Kubernetes) **and** real Linux admin (SSH, systemd, firewall) —
maximum skill coverage, minimum sprawl. Managed EKS costs money and hides the Linux;
Compose would skip Kubernetes entirely.

---

## 3. The managed-stateful boundary (why Postgres is on RDS, not in the cluster)

The original plan self-hosted Postgres in k3s (StatefulSet + PersistentVolume) to learn
the stateful path. Reality intervened: the free-tier `t3.micro` has **1 GB RAM**, k3s's
control plane alone consumes ~750 MB, and a Postgres pod on top pushed the node into
swap-thrash (observed live as kine "Slow SQL" + API-server TLS timeouts). That capacity
limit was the **authentic forcing function** for the managed boundary:

> **Stateless = cattle** (API pod: if it dies, k8s starts another; nothing lost).
> **Stateful = pet** (the DB holds the only copy — it needs a durable disk, backups,
> careful upgrades). Handing the pet to **RDS** means AWS runs the process, disk,
> backups, patching, and failover; the app just gets a **connection string**.

Net: the box runs only k3s + the stateless API; RDS owns the data. We still *document*
the self-hosted StatefulSet+PVC manifests as "the other path," without running them.
Trade-off recorded: self-hosting on k8s would have needed a `t3.small` (2 GB, ~$15/mo) —
rejected to stay on the free tier.

---

## 4. Notable decisions & gotchas (design-relevant)

- **Networking by identity, not IP:** the RDS firewall (security group) allows Postgres
  (5432) *from the EC2's security group*, not from an IP range — access granted by
  group membership, survives IP changes, and never exposes the DB to the internet
  (public access off).
- **RDS requires TLS:** the pg client must connect with SSL to RDS (URL `sslmode` or a
  `ssl` option) — a runtime config change from the local no-SSL Postgres.
- **Secrets stay out of git:** `DATABASE_URL` (with the RDS password) lives in a
  Kubernetes **Secret** on the cluster / a CI secret — never committed. `.env`,
  `aws.txt`, and the SSH `.pem` are git-ignored.
- **Image is config-free:** the Docker image carries only code; `PORT` and
  `DATABASE_URL` are injected at runtime by k8s — one image runs in any environment.
- **Capacity is a first-class constraint:** a starved node presents as "slow datastore +
  handler timeouts," fixed with swap/right-sizing — not a k8s reinstall.

---

## 5. Remaining work

RDS security-group rule → k8s manifests (Deployment/Service/Secret, `/health` probes) +
schema migration to RDS → Traefik ingress + TLS + a public URL → point dashboard
(Vercel) and shipper at it → (optional) automate deploy in CI. Step-level detail lives
in the `project-deployment-plan` memory.
