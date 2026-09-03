# Deploy the Perfect Imports site

**Live at** https://perfect-imports.com (+ `www`, + `perfect-imports.pages.dev`).

**Host: Cloudflare Pages, project `perfect-imports`, direct upload.**
Account `56a658078f56eb8fa8a4fb6b40badbda` (froy@perfect-imports.com).

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

   **Only `wrangler pages deploy` compiles Functions.** You will see
   `✨ Compiled Worker successfully` and `✨ Uploading Functions bundle` in its output.
   If those two lines are absent, Functions did not ship.

---

## Deploying

From a clean copy of this directory:

```bash
npx --yes wrangler@4 pages deploy . \
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
      --exclude 'functions/api/*.test.mjs' ./ /tmp/pi-deploy/
```

### Deploy to a preview branch first

Any `--branch` other than `main` produces a testable URL without touching production:

```bash
npx --yes wrangler@4 pages deploy /tmp/pi-deploy --project-name=perfect-imports \
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

If you later add `RESEND_API_KEY` as a production secret, the Function will also fire an
immediate best-effort email; failures there are logged and never change what the visitor
sees. The relay remains the guaranteed path either way.

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
