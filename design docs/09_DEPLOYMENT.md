# 09 — Deployment & Hosting

**Status:** 🟡 in progress (2026-07-19). **API is live on the cluster and talking to RDS.**
CI/CD (Actions→GHCR), the k3s Deployment/Service, RDS networking + TLS, and the schema
migration are all done and verified end-to-end (a DB-backed query served from the pod).
The **public URL (Ingress + TLS)** and wiring the dashboard/shipper are the remaining work.
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

**Postscript (2026-07-19): the 1 GB box couldn't even hold k3s + the *stateless* API.**
Moving Postgres to RDS was necessary but not sufficient — with just k3s's control plane
and one 128 Mi API pod, the `t3.micro` still ran out of RAM and its full 2 GB swap,
thrashing until the API server timed out (`kubectl` "hung"). Fixes, in order: (1) added a
second swapfile (→ 4 GB swap) + restarted k3s to reclaim memory — enough to schedule the
pod but permanently sluggish; (2) **right-sized to `t3.small`** (2 GB) via an in-place
instance-type change (stop → change type → start; EBS, swap, and k3s all persist on the
disk). Result: ~780 MB free, 0 swap in use, responsive cluster. **Lesson: k3s has a hard
RAM floor (~600–750 MB idle); 1 GB is below the practical minimum for k3s + any workload.**
`t3.small` is *not* free 24/7 (~$0.02/hr) — cost is controlled by **stopping the instance
between sessions**. We did **not** use the cheaper free-tier `t4g.small` (2 GB): it's
**arm64**, and our image is built amd64 by the Actions runner — arm would force multi-arch
CI and a from-scratch box (container images are architecture-specific).

---

## 4. Notable decisions & gotchas (design-relevant)

- **Networking by identity, not IP:** the RDS firewall (security group) allows Postgres
  (5432) *from the EC2's security group*, not from an IP range — access granted by
  group membership, survives IP changes, and never exposes the DB to the internet
  (public access off).
- **RDS requires TLS:** the pg client must connect with SSL to RDS. Implemented in
  `api/src/db/client.ts` as `ssl: { rejectUnauthorized: false }`, gated on a
  `DATABASE_SSL=true` env var so **local dev (no-TLS Docker Postgres) is untouched** and
  only the cloud pod enables it. `rejectUnauthorized:false` = *encrypted but the RDS cert
  chain is not verified* — safe vs. eavesdropping inside the private VPC; the strict
  upgrade pins Amazon's RDS CA bundle (documented follow-up).
- **GHCR package visibility is separate from repo visibility:** making the *repo* public
  did **not** make the *container package* public. k3s pulls anonymously, so a private
  package returns `401 Unauthorized` on the token request → `ImagePullBackOff`. Fix: set
  the package itself to Public (or add an `imagePullSecret` for a private one).
- **Schema migration to a private DB:** RDS 5432 is VPC-private, so `drizzle-kit push`
  from the laptop needed a *temporary* path in — RDS `Public access = Yes` + a laptop-IP
  security-group rule (`?sslmode=no-verify` on the URL for RDS TLS) — then **reverted**
  both. Alternatives considered: run from the EC2 (keeps DB private) or an in-cluster
  migration Job (most production-correct). One table → the reversible temp path won.
- **Secrets stay out of git:** `DATABASE_URL` (with the RDS password) lives in a
  Kubernetes **Secret** on the cluster / a CI secret — never committed. `.env`,
  `aws.txt`, and the SSH `.pem` are git-ignored.
- **Image is config-free:** the Docker image carries only code; `PORT` and
  `DATABASE_URL` are injected at runtime by k8s — one image runs in any environment.
- **Capacity is a first-class constraint:** a starved node presents as "slow datastore +
  handler timeouts," fixed with swap/right-sizing — not a k8s reinstall.

---

## 5. Progress & remaining work

**Done + verified (2026-07-19):** RDS security-group rule (5432 from the EC2 SG) →
`api/Dockerfile` + Actions build/push to GHCR (dropped the retired `type=gha` build cache)
→ k8s `Deployment`/`Service` (`k8s/`) with `DATABASE_URL` in a Secret and `/health`
liveness+readiness probes → schema migrated to RDS → pod **1/1 Running**, a DB-backed query
served from the pod through the private VPC path with TLS.

**Remaining:** Traefik Ingress + TLS + a stable public URL (needs an **Elastic IP** since the
public IP changes on stop/start) → repoint the dashboard (Vercel `OMWA_API_BASE`) and the
local shipper (`OMWA_API`) at it → seed/play to populate data → (optional) automate the
`kubectl apply` in CI to close the CD loop. Step-level detail lives in the
`project-deployment-plan` memory.
