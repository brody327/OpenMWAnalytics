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

---

## 8. Deploying the corpus (2026-07-26) — the first thing CI cannot do

Phase 4b (`11`) shipped a second corpus, and getting it into production exposed a boundary the
rest of the platform does not have.

### The schema half went through the existing path, unchanged

`kubectl rollout restart deployment/omwa-api` → `imagePullPolicy: Always` pulls the CI-built
`latest` → the **initContainer** (`§7`) runs `dist/jobs/migrate.js` → migration `0005` applies.
Verified after the fact rather than trusted: `pg_extension` gained `vector 0.8.2`, three tables
appeared, `drizzle.__drizzle_migrations` went 5 → 6, and both the API and dashboard stayed 200.

⚠️ **The migrate log said `schema up to date in 163 ms` — after applying a migration.** It does not
distinguish "applied one" from "nothing to do", which is a small observability gap worth closing:
a silent success and a silent no-op read identically.

### The data half cannot go through CI at all

**Ingest must run locally** (the `.esm` files cannot leave the machine, `01`) and **RDS is not
publicly reachable** (its endpoint resolves to a private VPC address, by design — `§3`). So the
corpus reaches production through an **SSH tunnel via the EC2 box**:

```bash
ssh -i omwa-key.pem -N -L 15432:omwa-db.<id>.us-east-2.rds.amazonaws.com:5432 ubuntu@<eip>

DATABASE_SSL=true \
DATABASE_URL=postgresql://omwa:<pw>@localhost:15432/omwanalytics \
  npm run ingest-corpus -- <dump> Morrowind.esm
```

171 s end to end — only ~19 s slower than the same run against local Postgres. TLS still
terminates at RDS (the tunnel is plain TCP forwarding), and the client's `rejectUnauthorized:
false` is what lets the hostname mismatch through.

> **This is a manual, human-run deployment step with no automation and no schedule.** It is the
> only part of the platform in that category, and it follows from a constraint (`01`), not an
> omission.

### ⚠️ Bulk-load ordering — a window that has now closed

The HNSW index was **dropped before the load and rebuilt after**. That was free *only* because the
table was empty and nothing queried it; inserting 36,567 vectors into a live index pays graph
maintenance per row. Standard load-then-index, and it produced a measurement:

```
NOTICE:  hnsw graph no longer fits into maintenance_work_mem after 28368 tuples
DETAIL:  Building will take significantly more time.
```

78% of the graph fit in the instance's 64 MB, and the whole build still took **19.5 s**. So the
"slow path" this document worried about is nineteen seconds, once — which retroactively justifies
having refused to raise `maintenance_work_mem` (autovacuum inherits a parameter-group value;
3 workers × 256 MB would OOM a 1 GB box, and an OOM on RDS restarts Postgres).

**Any future corpus refresh no longer has this window** — the tables are populated and `/search`
queries them, so a reindex is now a deliberate operation with a visible impact.

### ⚠️ Outstanding: `OPENAI_API_KEY` is not in the cluster

`GET /search` embeds the query at request time. Production has no key, so it currently reports
`"mode": "lexical"` — degraded, not broken (`05`). Adding it means extending the existing k8s
Secret; it is the first **runtime** external credential the API has needed, as distinct from the
ingest token it merely verifies.

---

## ✅ Search in prod — broken on 2026-07-27, fixed the same day

`GET /search` merged to `main` on 2026-07-26 and the corpus was populated in prod RDS, but the
endpoint was **not reachable** on `api.omwanalytics.com` — a live request returned
`Cannot GET /search`. Two independent causes, both worth recording because neither is a code bug:

| # | cause | fix |
| --- | --- | --- |
| 1 | **The pod still runs the pre-search image.** CI (`build-api.yml`) builds and pushes `ghcr.io/…/omwanalytics-api:latest` on every push to `main` touching `api/**`, but nothing triggers a rollout, and a `:latest` tag does not make a running pod re-pull. | `kubectl rollout restart deployment/omwa-api` (same manual step used on 2026-07-26) |
| 2 | **`OPENAI_API_KEY` is absent from `k8s/deployment.yaml`.** The API boots fine without it by design (`search.ts` `getProvider()` warns and disables the semantic half), so even after a rollout, prod search would serve `mode: 'lexical'` — half the feature, no error. | add to the `omwa-api-secrets` secret + an `env:` entry |

⭐ **This is the day's own theme in infrastructure form.** Both failures are *silent and plausible*:
cause 1 gives a 404 on one route while every other endpoint and the health check stay green; cause
2 gives a search box that returns real, relevant, useful results — just lexical ones. Neither trips
an alarm. The dashboard surfaces both (an error banner and a "word-match only" badge respectively),
which is the mitigation, but the underlying lesson is the same as the corpus bugs: **a deploy that
looks healthy and a deploy that is correct are indistinguishable without an independent check of
the specific thing you changed.**

⚠️ **Note the asymmetry in how the two halves of the platform deploy.** The dashboard auto-deploys
from `main` via Vercel's Git integration; the API does **not** auto-rollout. So a push that changes
both ships the frontend immediately and the backend never — which is precisely the ordering that
produces a live page calling an endpoint that does not exist yet.

### Timeline that proves cause 1 (not inferred — measured)

| when | what |
| --- | --- |
| 2026-07-26 **19:38** CDT | pod `omwa-api-75445fc564-p2t4q` starts (the 07-26 corpus rollout) |
| 2026-07-26 **20:23** CDT | `GET /search` merges to `main` (`df5014f`) — **45 minutes later** |

The pod was 18 h old and predated the code by three quarters of an hour. Nothing was wrong; the
running image simply had never contained the route.

### The fix, as applied 2026-07-27

```bash
# kubectl on the node needs sudo — k3s.yaml is root-only (0600).
ssh -i omwa-key.pem ubuntu@<eip>

# 1. add the key to the existing secret WITHOUT rewriting the other two entries.
#    (piped via stdin + --patch-file so the value never lands in argv or shell history)
sudo kubectl patch secret omwa-api-secrets --patch-file /tmp/p.yaml && shred -u /tmp/p.yaml

# 2. apply the manifest — the changed pod template triggers the rollout by itself, and
#    imagePullPolicy: Always pulls the current :latest built by CI from the search commits.
sudo kubectl apply -f deployment.yaml
sudo kubectl rollout status deployment/omwa-api
```

**Verified after rollout:** `/health` → 200, and
`/search?q=guards demanding bribes` → `mode: "hybrid"`, 2,647 ms cold — with `Company Guard`
and `Thief` returning at `lexical_rank: null, vector_rank: 1/2`. Semantic-only hits are the
proof that matters: they cannot be produced by the lexical half, so their presence rules out the
silent `mode:'lexical'` degradation of cause 2. **Checking `/health` would have proved nothing** —
it was green throughout both failures.

`OPENAI_API_KEY` is wired with `optional: true` **deliberately**: the search path fails *open*
(lexical-only) by design, so a hard `secretKeyRef` would put the pod in
`CreateContainerConfigError` and take the entire API down for a feature built to degrade. Contrast
`OMWA_INGEST_TOKEN`, which fails *closed* — the write path returns 503 without it.

▶ ~~**Still open:** nothing triggers a rollout on a new image.~~ **CLOSED 2026-08-09 — see §10.**

---

## 10. Closing the rollout gap (2026-08-09) — and the check that made it verifiable

The gap above bit **twice**, both times with `/health` green: the search pod predated its own code
by 45 minutes, and `/stats/sufficiency` returned 404 in production while `/stats/ranking` returned
200. Both were merged, both were built, both were pushed, neither was *running*.

### Why a new image did nothing

CI pushed a new image to the mutable tag `:latest`; the Deployment was pinned to `:latest`.

**Nothing in Kubernetes watches a registry.** The control loop reconciles the cluster against the
*pod template stored in the Deployment* — and repointing a tag does not change one byte of that
template. No diff, no reconciliation, no rollout. `imagePullPolicy: Always` does not help either:
it governs what happens **when a pod starts**, and no pod was starting. The system was working
exactly as designed; the design was pointed at the wrong thing.

### The fix — pin an immutable tag from CI

CI now tags every build `:sha-<short>` alongside `:latest`, and the deploy job runs
`kubectl set image` for **both** the app container and the `migrate` initContainer:

```
sudo kubectl set image deployment/omwa-api api=<img>:sha-abc1234 migrate=<img>:sha-abc1234
sudo kubectl rollout status deployment/omwa-api --timeout=180s
```

`set image` mutates the pod template, so the spec genuinely changes and k8s rolls out on its own.
Both containers move together on purpose: the initContainer applies the schema the app container
depends on, and letting them differ recreates the 2026-07-22 production 500 from the other side.

⚠️ **`k8s/deployment.yaml` is now intentionally behind the cluster.** It still reads `:latest` as a
bootstrap value; the live Deployment runs a sha. A bare `kubectl apply -f` will silently roll the
image *back*. Check `kubectl get deploy omwa-api -o jsonpath='{..image}'` first.

### ⭐ `GET /version` — the check a stale pod cannot pass

Repointing the image is only half of it. The reason both incidents ran for so long is that **every
check available was one a broken deploy would also pass**: `/health` emits `res.json({ ok: true })`
for any build whatsoever, and `rollout status` only proves pods reached Ready — which is decided by
`/health`.

So the deploy now ends in an observation the failure is *structurally incapable* of producing. The
commit sha is baked into the image at build time (`api/Dockerfile`, `ARG GIT_SHA` → `ENV`), and
`GET /version` reports it. CI polls the endpoint **through the public ingress** — DNS, Traefik,
Service, pod, the same path a user takes — and fails the job unless it equals the commit that just
built. A pod running last week's image cannot return this week's sha.

The `ARG` is deliberately **not** an env var injected by the manifest: anything supplied at runtime
describes the cluster's *intent*, so a manifest could confidently stamp a fresh sha on a stale
image — the exact failure being detected. Baked into the layer, the value cannot lie.

`/version` is deliberately **not** wired to any probe. An unrecognised sha is a failed deploy, not
an unhealthy process, and restarting the pod would not fix it.

### The other half: CI never ran the tests

Worth recording, because automating the rollout *removed a safety gate nobody had designed*. The
only thing between a broken commit and production was that a human had to SSH in and restart the
deployment by hand — and would presumably not do that with a red suite. Deleting the human step
without adding a test step would have made the pipeline strictly more dangerous than the footgun it
replaced. The workflow now runs `tsc` + all 77 tests (with a `pgvector` service container, since
`corpus/ingest.test.ts` needs a real database) **before** the image is built.

### ⚠️ Accepted risk, recorded not hidden

`DEPLOY_SSH_KEY` is an **unrestricted** key for `ubuntu@<eip>`, so anyone who can push to `main`
has a shell on the production host. Accepted for a single-maintainer repo (Actions secrets are not
exposed to fork PRs). The hardened form was offered and declined for setup cost: a dedicated
keypair with a forced command in `authorized_keys`
(`command="/usr/local/bin/omwa-deploy",no-pty,no-port-forwarding`), which reduces a leaked secret
from *root on the host* to *can deploy an image*. Host-key verification is TOFU per run
(`ssh-keyscan`); pinning it in a `DEPLOY_KNOWN_HOSTS` secret is the stronger form.

⚠️ **Pushing to `main` is now a production deploy.** That was previously a separate, manual, human
decision.

### Required secrets (add via the GitHub web UI)

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_KEY` | the full contents of the EC2 private key, `-----BEGIN` line through `-----END` line |
| `DEPLOY_HOST` | the elastic IP of the k3s node |

### ⚠️ The first CI run failed: a Windows-only lockfile met a Linux runner

Worth recording because it will recur with the next native dependency, and because it is a
different failure class from anything else in this doc.

`tsc` died on the runner with `Unable to resolve @typescript/typescript-linux-x64`. **TypeScript 7
is the Go port**, so `tsc` is a native binary shipped as one `optionalDependency` per platform
(`@typescript/typescript-{linux-x64,win32-x64,darwin-arm64,…}`). npm writes a lockfile entry only
for the platform variant it **actually installed** — and this lockfile has only ever been generated
on Windows. The entry for linux-x64 did not exist, so the runner installed a `typescript` package
with no executable inside it.

⭐ **Why this had never happened before:** the Dockerfile copies **only `api/package.json`**, never
the lockfile, so the image build resolves fresh and gets the correct linux binary. The bug needed a
job that checks out the whole repo *and* installs from the root lockfile — which is exactly what the
new `test` job is. **The very first run of CI found it, which is the job working.**

**Fixed** by adding the missing linux-x64 entries to the committed lockfile, in the same minimal
shape npm writes for the win32 siblings (`version`/`os`/`cpu`/`optional`, no `resolved`/`integrity`
— npm fetches these by version).

⚠️ **`tsc` was not the only one.** Auditing every platform-gated optional package in the lockfile
found **`@esbuild/win32-x64` at three different versions with no linux sibling** — and `tsx`, which
`npm test` runs on, is built on esbuild. The test job would have failed the same way immediately
after the build started passing. Both were fixed together.

**Verified in both directions**, in a `node:22` container against a `git archive` of the tree:
with the original lockfile, the *exact* CI error reproduces; with the patched one, `npm install`
resolves `typescript-linux-x64` + `esbuild/linux-x64` (×2), `tsc` exits 0, and `tsx` executes
TypeScript. Windows entries are untouched and the local suite still passes 97/97.

▶ **When adding a dependency with native binaries**, audit the lockfile for platform-gated optional
packages that lack a linux entry:

```js
// node -e '…' from the repo root
const lock = require('./package-lock.json');
for (const [k, v] of Object.entries(lock.packages))
  if (v?.optional && v.os && !v.os.includes('linux')) console.log(k, v.os);
```

▶ **Open, and the deeper version of this:** the image is built from an *unlocked* `npm install`
(`api/Dockerfile`), so CI's locked tree and production's resolved tree are not guaranteed to be the
same dependency set. Patching the lockfile makes CI pass; it does not make the two agree. The real
fix is to build the image from the repo root against the workspace lockfile — deliberately not done
here, because it is a bigger change than unblocking a deploy warranted.
