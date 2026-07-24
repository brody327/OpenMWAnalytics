# 09 — Deployment & Hosting

**Status:** 🟢 **the API is publicly live at `https://api.omwanalytics.com`** (2026-07-20).
CI/CD (Actions→GHCR), the k3s Deployment/Service, RDS networking + TLS, the schema
migration, and the public Ingress with an auto-renewing Let's Encrypt certificate are all
done and verified from the open internet. Wiring the dashboard/shipper to the public URL
(and populating real data) is the remaining work.
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

## 4. The public entry point — DNS, Ingress, TLS

Getting from "a pod that works" to "a URL someone can use" is four independent layers, and
naming them separately is most of the clarity:

| Layer | Choice | Why |
| --- | --- | --- |
| **Stable address** | **Elastic IP** `16.58.59.201` | EC2's default public IP is a lease from a shared pool, reclaimed on every stop. An EIP is allocated to the account and remapped at will, so a DNS record survives stop/start. |
| **Name** | **`omwanalytics.com`** (Cloudflare Registrar), `A api → EIP`, **DNS-only** | A real domain over `sslip.io`: certs are issued to *names*, the URL outlives the IP, and it reads as a product rather than a demo. |
| **Routing** | **Traefik Ingress** (built into k3s) | An Ingress is a routing *rule*; the controller reconfigures itself to match. One node + one IP serves many services, dispatching by Host header. |
| **Certificate** | **cert-manager v1.21 + Let's Encrypt** (HTTP-01) | Real trusted cert, auto-renewed. |

**Why Ingress and not the simpler exposures:** `NodePort` yields a random high port and no
TLS; `LoadBalancer` on k3s (Klipper) binds the host port, so *one* Service would own :443.
Ingress shares :80/:443 across every service and centralizes TLS — adding the dashboard
later is one more `rules:` entry, not new infrastructure.

**How HTTP-01 proves domain control.** cert-manager requests a cert; Let's Encrypt returns a
token and expects it served at `http://<host>/.well-known/acme-challenge/<token>`;
cert-manager spins up a temporary solver Pod/Service/Ingress for exactly that path; **LE
fetches that URL from the public internet.** Serving it proves control of both the DNS name
and the machine it resolves to. The solver is torn down and the signed cert lands in the
Secret named by the Ingress's `tls.secretName`. Certs last 90 days by design — short
lifetimes cap the damage of a leaked key and force the automation.

Traffic path, with the two independent TLS segments:

```
client ──TLS(LE cert)──▶ Elastic IP :443 ──▶ Traefik  [TLS terminates here]
                                              │ plaintext, in-cluster
                                              ▼
                                    Service omwa-api:80 ──▶ Pod :4000
                                              │ ──TLS(RDS)──▶ RDS (private VPC)
```

---

## 5. Notable decisions & gotchas (design-relevant)

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
- **`port-forward` validated a path production doesn't use.** The pod was verified last
  session with `kubectl port-forward deploy/omwa-api`, which connects *straight to the pod* —
  so the fact that the `Service` had never actually been created went unnoticed until the
  Ingress needed it. **Lesson (a rhyme with the shipper's "I saw the log line"): test through
  the layer production uses, or you prove a different system than the one you ship.**
- **A valid cert plus a 404 localizes the fault precisely.** Traefik selects the certificate
  by SNI from the Ingress's `tls:` block, then *separately* resolves the rule's backend.
  Getting a chain-verified LE cert while receiving Traefik's `404 page not found` proved the
  Ingress was loaded and the backend was not — two independent facts from one request.
  (Express's 404 reads `Cannot GET /path`; distinguishing *whose* 404 you got is the tell.)
- **HTTP-01 needs :80 open to `0.0.0.0/0`, not to My-IP.** Validation is an *inbound* fetch
  by Let's Encrypt's servers, so an IP-scoped rule looks fine from your laptop and fails the
  challenge. DNS-01 is the alternative when :80 can't be opened (or for wildcards).
- **Cloudflare's orange-cloud proxy must stay OFF** (grey cloud / "DNS only"): proxying
  answers DNS with Cloudflare's anycast IPs and terminates TLS itself, which hides the origin
  and breaks HTTP-01. **Verify DNS by resolving the name, not by reading the dashboard** — if
  the answer is your own IP, it isn't proxied.
- **ACME contact email in a public repo:** the ClusterIssuers use a GitHub `noreply` address
  rather than a personal one — LE only sends expiry notices, and committed email is harvested.
- **Public IPv4 now bills.** An *unattached* Elastic IP has always cost ~$0.005/hr; since
  Feb 2024 AWS charges that for *all* public IPv4 including in-use (~$3.60/mo), with a
  free-tier allowance for the first 12 months. Don't release the EIP when stopping the
  instance — releasing it breaks the DNS binding for a few cents.

---

## 6. Progress & remaining work

**Done + verified (2026-07-19):** RDS security-group rule (5432 from the EC2 SG) →
`api/Dockerfile` + Actions build/push to GHCR (dropped the retired `type=gha` build cache)
→ k8s `Deployment`/`Service` (`k8s/`) with `DATABASE_URL` in a Secret and `/health`
liveness+readiness probes → schema migrated to RDS → pod **1/1 Running**, a DB-backed query
served from the pod through the private VPC path with TLS.

**Done + verified (2026-07-20) — the cloud half is complete:** Elastic IP allocated and
associated → `omwanalytics.com` registered (Cloudflare Registrar) with `A api → EIP`,
DNS-only → cert-manager v1.21.0 installed → `ClusterIssuer` ×2 (LE staging + prod) →
`Ingress` for `api.omwanalytics.com` → certificate **issued on the first attempt**
(`Certificate → CertificateRequest → Order → Challenge`, solver torn down, `omwa-api-tls`
Secret populated). Verified from the public internet with full chain verification:
`https://api.omwanalytics.com/health` → `{"ok":true}` and
`/stats/confrontations` → `{"byTopic":[],"byReason":[]}` (empty only because RDS holds no
events yet). Cert `CN=api.omwanalytics.com`, issuer Let's Encrypt, TLSv1.3, expires
2026-10-18, auto-renewing ~30 days prior.

**Done + verified (2026-07-20) — the dashboard is live too:**
**`https://open-mw-analytics-dashboard.vercel.app`**, deployed from the `dashboard/`
workspace via Vercel's Git integration (Root Directory `dashboard`; `OMWA_API_BASE` set on
Production + Preview only, so local dev keeps its `localhost:4000` fallback). Push to `main`
now auto-deploys the dashboard, while the same push builds and publishes the API image —
one trigger, two independent delivery paths. Verified: HTTP 200, stat tiles rendered, no
error banner ⇒ the full chain `browser → Vercel SSR → api.omwanalytics.com → pod → RDS` works.

**The public URL is `https://omwanalytics.com`** — the apex serves the dashboard (Vercel-issued
certificate), `www` redirects, and `api.` continues to point at the Elastic IP. Wiring it kept
**Cloudflare authoritative** and added two CNAMEs (`@` and `www` → a Vercel-unique
`*.vercel-dns-017.com` host, DNS-only). Vercel's *default* suggestion — delegating nameservers to
`ns1/ns2.vercel-dns.com` — was **declined on purpose**: it would strip Cloudflare's authority and
take the `api` A record with it, breaking the API and its HTTP-01 renewal, all to host one record.
Note the apex CNAME is illegal DNS (the apex must hold SOA/NS, which a CNAME cannot coexist with);
it works only because Cloudflare **flattens** it and answers with A records.

**Degrading gracefully when the API is down.** The API lives on one EC2 box that gets stopped
between sessions, so "upstream unreachable" is a *normal* state, and an error page is a poor
answer for a URL on a résumé. The dashboard now falls back to a committed last-known-good
snapshot with a plainly-worded notice and the capture date. Two details carry the design:

- **The fetch is bounded** (`AbortSignal.timeout`). A *stopped* box drops packets rather than
  refusing them, so an unbounded fetch **hangs** instead of failing — the timeout is what turns
  an indefinite wait into a handleable error. Verified against an unroutable address: HTTP 200
  in 4.08s with the fallback rendered.
- **The snapshot is captured from the live API** (`npm run snapshot`), never hand-written, and
  the script **refuses to overwrite a good snapshot with an empty response** — an API that is up
  but empty would otherwise silently erase the fallback precisely when it is needed later.

Rejected here: Next's `use cache` / ISR stale-while-revalidate. It reads like the right tool, but
a **cold cache after a deploy** has nothing stale to serve, and the default cache is in-memory on
serverless — implicit machinery whose failure mode is "sometimes works." An explicit committed
snapshot always works, including on the first request after a deploy.

Two things that fell out of the Vercel build, both worth keeping:

- **`next dev` doesn't gate on type errors; `next build` does.** The first Vercel build failed
  on a Recharts `LabelList` formatter typed to accept `RenderableText`
  (`string | number | null | undefined`) where ours took `number`. The fix is to *narrow*, and
  to leave the parameter **un-annotated** so contextual typing supplies the exact union —
  hand-restating a library's union is how you get it wrong. Run the production build locally
  before pushing.
- **The route summary is the proof of rendering mode.** `ƒ /` (dynamic) rather than `○`
  (static) is what confirms `cache: 'no-store'` is keeping the dashboard live rather than
  serving a snapshot baked at build time.

**Remaining:** repoint the local shipper (`OMWA_API=https://api.omwanalytics.com/events` — note
this var carries the *path*, unlike `OMWA_API_BASE`) and play to populate real data; the local
API on `:4000` is no longer part of the loop. Then: **authentication on `POST /events`**, which
became a genuine gap the moment ingestion went public (anyone can inject fabricated telemetry —
candidates are a shared ingest key or per-install tokens); a decision on **uptime policy**, since
the dashboard is only as up as the EC2 box we stop between sessions; and optionally automating
`kubectl apply` in CI to close the CD loop, an HTTP→HTTPS redirect middleware, and pinning the
RDS CA bundle instead of `rejectUnauthorized:false`.
Step-level detail lives in the `project-deployment-plan` memory.

---

## 7. Schema migration is the missing link in CI/CD (learned the hard way, 2026-07-22)

**What happened.** The friction-rollup PR merged, CI built the image, the Deployment rolled out —
and `/stats/confrontations` immediately started returning **500 in production**. The new image
queries `events.suspect / topic / reason / passed`, the **stored generated columns** added during
performance tuning. Those columns existed in local Docker Postgres and had never been applied to
RDS. `/stats/friction` failed differently and more quietly: it returned `200` with empty arrays,
because its tables existed but the fold job crashed on the same missing columns.

**Root cause is a process gap, not a typo.** `api/package.json` wires up `db:generate` and
`db:migrate`, but **no `drizzle/` migrations directory has ever been generated**. Schema changes
are applied ad hoc — `drizzle-kit push` against local Docker, hand-written DDL against RDS. So
*nothing connects "this commit merged" to "this schema is applied"*, and the pipeline will deploy
code whose schema prerequisites do not exist. CI/CD is only half built: it ships **code**
automatically and **schema** by memory.

**Why it was not caught earlier.** Every previous deploy happened to be schema-compatible. The
rollup work was the first change to add columns the read path *depends on*, so it was the first
time the gap could bite.

**The general rule:** in a deploy that ships code and schema separately, **schema must land first
and be backward-compatible** — old code must tolerate the new schema, because during a rollout
both versions run at once (two pods were briefly Running here). "Expand, then contract": add
columns, deploy code that uses them, remove the old path later — never in one step.

### Deploy checklist (until migrations are automated)

Before merging anything that touches `api/src/db/schema.ts`:

1. Diff the local schema against RDS — **tables AND columns AND indexes**, not just tables.
2. Apply the DDL to RDS **first**, and `VACUUM ANALYZE` any table that got a generated column
   (adding one rewrites the table, leaving the visibility map cold — see `06`, round 2).
3. Then merge, let CI build, and roll out.
4. Verify **every** endpoint, not the one you changed. The 500 here was on
   `/stats/confrontations`, which this session never edited.

### Remaining work (now the top deploy priority)

Generate a real migration baseline (`npm run db:generate`), commit it, and run
`drizzle-kit migrate` as a **k8s Job or an init container** before the Deployment rolls. That
turns the checklist above into something the pipeline enforces instead of something a human
remembers. Until then, treat every `schema.ts` change as a manual RDS change too.

### ⚠️ Known gap: the CronJob can outrun the migration

The initContainer guarantees ordering **for the API pod only**. `cronjob-friction-rollup.yaml`
pulls the same `:latest` tag independently, so after a push the fold job can start on the new
image *before* the Deployment has rolled and applied migrations. If a fold ever needs a table
the migration has not created yet, that tick fails.

It **self-heals** — the next tick runs after the rollout — and `backoffLimit: 2` plus visible Job
failures mean it is loud rather than silent. Observed as a latent risk on 2026-07-22, not as an
incident.

Proper fixes, in ascending order of effort: pin both manifests to an immutable `:<sha>` tag and
roll them together (also fixes the traceability caveat already noted on the Deployment); or run
migrations as a pre-deploy Job that both workloads wait on; or have the fold no-op cleanly when
its schema is not yet present. Not urgent while the fold is the only scheduled workload.
