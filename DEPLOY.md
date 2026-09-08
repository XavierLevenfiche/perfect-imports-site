# Deploy the Perfect Imports site

**Live at** https://perfect-imports.com (+ `www`, + `perfect-imports.pages.dev`).

**Host: Cloudflare Pages, project `perfect-imports`, direct upload.**
Cloudflare account: the one owned by froy@perfect-imports.com. (The account ID is
deliberately not written down here - this file has historically been served publicly.
Read it from the dashboard URL when you need it.)

> This document previously described GitHub Pages. That has not been the host since the
> Cloudflare migration on 2026-07-19. The stale version caused a production incident on
> 2026-09-03 — see "The trap" below. If you are reading a copy that talks about
> `185.199.108.153`, it is out of date.

---

## The trap: read this before you deploy anything

The Pages project is **direct-upload**, not git-connected. The API confirms it
(`"source": null`, and Settings → Build shows "Git repository — Connect", not a repo).

Two consequences, both of which have already bitten:

1. **`git push` deploys nothing.** The GitHub repo
   (`XavierLevenfiche/perfect-imports-site`) is a mirror for history and review only.
   Pushing to `main` does not update the live site. Deployment rows in the dashboard
   display `main` and a commit message purely because wrangler stamps local git metadata
   onto a direct upload — that is cosmetic, not causal.

2. **Uploading a zip in the Cloudflare dashboard silently breaks `/api/inquiry`.**
   The dashboard's upload path publishes *static assets only*. It does **not** compile
   Pages Functions. `functions/api/inquiry.js` disappears from the build and the endpoint
   starts returning `405` with an empty body — the form goes dead while every page still
   looks perfect. On 2026-09-03 this took lead capture offline and was only caught by
   probing the endpoint directly.

   **Only `wrangler pages deploy` compiles Functions.**

**And you MUST `cd` into the directory and deploy `.` — never pass an absolute path.**
`wrangler pages deploy /abs/path` resolves `functions/` relative to your CURRENT working
directory, not the deploy target. It finds no functions, says nothing about it, uploads
the static assets, and still prints "Deployment complete". Lead capture then returns 405.

This is the SAME 405 as the dashboard-zip trap, from a different cause, and it took lead
capture down a second time on 2026-09-04. The reliable tell is the absence of two lines:

    * Compiled Worker successfully     <- must be present
    * Uploading Functions bundle       <- must be present

If either is missing, Functions did not ship. Do not trust "Deployment complete", and do
not truncate wrangler's output when checking.

Correct. The checked wrapper runs the claim check against the staged site directory
first, then `cd`s into that same directory and deploys `.`:

    /path/to/repo/ads/deploy_site_checked.sh /path/to/staged --project-name=perfect-imports \
        --branch=main --commit-dirty=true

Also exclude `.pytest_cache/` from the staged copy - it appears if pytest has been run in
the source tree and adds noise files to the deployment.
 You will see
   `✨ Compiled Worker successfully` and `✨ Uploading Functions bundle` in its output.
   If those two lines are absent, Functions did not ship.

---

## Deploying

From the repository root, after staging `/tmp/pi-deploy`:

```bash
ads/deploy_site_checked.sh /tmp/pi-deploy \
  --project-name=perfect-imports \
  --branch=main \
  --commit-dirty=true \
  --commit-message="what changed"
```

First run needs `npx wrangler@4 login` (OAuth, browser). The consent screen is
"Wrangler wants to access your account" — 29 permissions, revocable at
My Profile → Access Management → Connected Applications.

### Exclude the test file

`functions/api/inquiry.test.mjs` sits inside `functions/`, imports `node:fs/promises`,
and is a node test runner file — not a route. Do not ship it. Stage a copy first:

```bash
rsync -a --exclude '.git' --exclude '.wrangler' --exclude '.gitignore' \
      --exclude 'functions/api/*.test.mjs' --exclude 'tests/' --exclude '.pytest_cache/' ./ /tmp/pi-deploy/
```

### Deploy to a preview branch first

Any `--branch` other than `main` produces a testable URL without touching production:

```bash
ads/deploy_site_checked.sh /tmp/pi-deploy --project-name=perfect-imports \
  --branch=preflight --commit-dirty=true
```

**Expect the happy-path POST to return `503` on a preview.** Preview has no bindings —
production holds the `INQUIRIES` KV namespace and `INQUIRY_TO`, preview holds neither.
A `503` there is correct and proves nothing is wrong. A `405` is the real failure signal.

---

## Verify after every deploy — the pages are not the test

A deploy that renders all five pages correctly can still have dead lead capture.
Always probe the endpoint:

```bash
curl -s -o /dev/stdout -w '\n%{http_code}\n' -X POST \
  https://perfect-imports.com/api/inquiry \
  -H 'content-type: application/json' -d '{}'
```

| Response | Meaning |
|---|---|
| `400 {"ok":false,"error":"a valid email address is required"}` | **Correct.** Function is live and validating. |
| `405`, empty body | **Broken.** Functions were not compiled — you deployed via the dashboard. |
| `503` | KV binding missing (normal on preview, an incident on production). |

Then the pages and the address:

```bash
for p in / /bonded-warehousing/ /thanks/ /terms/ /privacy/ /removal.html; do
  printf '%-24s %s\n' "$p" "$(curl -sL -o /dev/null -w '%{http_code}' https://perfect-imports.com$p)"
done
curl -sL https://perfect-imports.com/ | grep -o '"streetAddress"[^,]*'
```

### Rollback

Workers & Pages → `perfect-imports` → Deployments → "…" on a known-good row →
**Rollback to this deployment**. Takes effect in seconds. Previous deployments stay
addressable at `https://<hash>.perfect-imports.pages.dev`, which makes them useful as a
*control* — diff a suspect deploy against the last good one rather than guessing.

---

## How a lead actually reaches you

There is no Resend key configured, and none is needed:

```
form POST  ->  functions/api/inquiry.js  ->  KV namespace INQUIRIES  (key inq:<iso>:<rand>)
           ->  perfect-imports-inquiry-relay.timer  (minipc, every 5 min)
           ->  reconcile.gmail_send_gated  ->  froy@perfect-imports.com
           ->  KV key deleted only after a confirmed send
```

The Function returns `{"ok":true}` **only once the KV write succeeds** — the visitor is
never told "sent" for a lead that was not durably stored. Measured end to end on
2026-09-03: **3m19s** from submit to inbox.

Do not add a second notification provider to the Function. KV + the local relay is the
single email-delivery path; a second sender would notify twice after every successful
submission.

---

## DNS (Cloudflare, froy@ account) — email-safe rules

`perfect-imports.com` is on Cloudflare DNS with the Pages origin proxied (Full Strict).
Registrar is still Squarespace.

**Never touch MX, SPF, DKIM or DMARC** — they run Google Workspace mail:

- MX → `aspmx.l.google.com`, `alt1.aspmx.l.google.com`, `alt2.aspmx.l.google.com`
- TXT `@` → `v=spf1 include:_spf.google.com ~all` — **one SPF record only**; a second
  one breaks the first
- TXT `google._domainkey` → `v=DKIM1; k=rsa; p=...`
- TXT `_dmarc` → `v=DMARC1; p=none; rua=mailto:froy@perfect-imports.com`

Any future mail provider gets a **subdomain** (e.g. `send.perfect-imports.com`) so
Workspace mail is never in the blast radius.

---

## Content invariants — keep these true

1. **Partner framing on facility/licence claims.** "provide" / "operate out of a
   CBP-bonded warehouse" / "third-party alcohol-licensed handling". Do not tighten to
   first-person ownership unless Perfect Imports itself holds those credentials.
   (Reworded 2026-07-05.)

2. **Address is `3259 SW 11th Ave, Fort Lauderdale, FL 33315`.** Canonical source: the
   Articles of Organization, corroborated by the Google Ads payments profile
   ORGANIZATION ADDRESS. `3255` is the adjacent door of the same warehouse and had
   propagated into the site, QuickBooks and outreach copy. Corrected across the site
   2026-09-03, including the JSON-LD `streetAddress`.

   Historical records that quote `3255` are deliberately left alone — they are what was
   said at the time. In particular, `ops-strip/config/lead_meeting_mappings.json` holds a
   live `3255 -> 3259` correction rule whose *match pattern* must stay `3255`.

3. **`removal.html` mails froy@**, because the `removal@` alias does not exist (operator
   and API confirmed 2026-07-05). If you create the alias in Workspace Admin, flip the
   mailto back for a cleaner channel.


## Lead acceptance and shared browser contract

Before staging a release, run both behavior suites from the site source directory:

```bash
node --test functions/api/inquiry.test.mjs tests/inquiry-client.test.mjs
```

The browser suite executes the shared script referenced by each actual page, checks its
content-hashed filename, and tests receipt/error/analytics behavior. Both form pages and
/thanks/ must reference the same new asset bytes. Keep any already deployed hashed assets
available through rollout and rollback; never modify an asset without changing its hash
and all three references. Do not ship the tests/ directory as public assets.

The server emits JSON for enhanced submissions and useful HTML for native browser POSTs.
Only HTTP success with `ok:true`, `accepted:true`, `stored:true` and a valid durable ID is
confirmation. A write acknowledgement error returns `stored:null` because persistence is
unknown. Never turn that into received copy or a conversion. Page views of /thanks/ are
not conversion evidence; successful handlers emit the existing lead events once.

The bonded page retains its existing direct Ads conversion label, and both forms retain
the GA4 generate_lead event. Their conversion-action settings are unchanged; whether two
configured primary actions count the same enquiry remains a separate Ads decision.
Repeated clicks while a request is running or after confirmed acceptance are ignored.
No automatic retry occurs. After ambiguous response loss, a manual retry can create a
second ID/record; this change does not claim exactly-once submission with eventual KV.

Before publishing: independent model review, rendered UI verification, offline browser
checks for normal/honeypot/KV error, native POST with JS disabled or the asset blocked,
direct/reloaded thanks, and a verified Functions bundle remain required. Test against
mock KV first; do not submit an unapproved test lead to the live production namespace.

Before declaring rollout complete, require exact current HTML/shared-asset/Function deployment identity for all three pages. If any HTML is stale, the owner's scoped cache purge and successful reread are blocking gates. A static
asset upload alone cannot establish the backend contract; follow the Functions checks
above and a separately authorized acceptance check. This documentation is not permission
to change ad spend, ad claims, or conversion-action settings.


Blocking rollout checks for this shared asset: verify the deployed JavaScript response MIME type
and that the effective CSP allows the same-origin asset. Verify cache headers and current
HTML bytes for /, /bonded-warehousing/ and /thanks/; use the owner's scoped cache-purge
procedure if stale HTML remains. Old cached /thanks/ code can still fire its old page-load
event; do not claim conversion accuracy until current HTML is confirmed. A native browser
POST refresh can resubmit, and a very early native submission before the deferred asset
loads may omit client-side attribution. Both are existing fallback limitations.

Both forms give their existing event callbacks up to two seconds before navigating;
blocked analytics still cannot reverse confirmed receipt. Thanks without a recent receipt
uses neutral contact copy, including successful old cached form tabs that never created a
new receipt marker. Full bounded payload logging is retained only on failed storage as an
operator rescue aid; neither log retention nor operator recovery is guaranteed by this
change. Success logging contains only the durable ID. Never treat a rescue log as proof
that an ambiguous write did not commit.

Honeypot trips are durably stored under `quarantine:inq:` with `quarantined:true` and `accepted:false`; the response is HTTP 200 with a normal bounded `inq:` ID, but it is not a receipt or conversion contract. Do not broaden the relay's normal `inq:` delivery prefix or remove the quarantine guard without adding a reviewed path. Inspect the content-hashed asset cache policy; immutable caching is compatible with its filename, but do not apply it to HTML.
