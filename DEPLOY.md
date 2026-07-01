# Deploy the Perfect Imports site → GitHub Pages (live + AI-editable)

**Goal:** live at https://perfect-imports.com, editable by Claude/Codex → `git push` → live in ~30s,
and your Google Workspace email (froy@perfect-imports.com) stays **completely untouched**.

> Hand this whole folder to Claude/Codex on your MacBook and say "run DEPLOY.md."

## Prereqs (MacBook)
- `gh auth status` shows you logged into GitHub (else run `gh auth login`)
- `git` installed

## 1. Create repo + push (run inside this folder)
```bash
git init -b main
git add -A
git commit -m "Perfect Imports website"
gh repo create perfect-imports-site --public --source=. --push
```
(Public repo so free GitHub Pages works — the site is public content anyway, no secrets.)

## 2. Enable GitHub Pages
```bash
OWNER=$(gh api user -q .login)
gh api -X POST "repos/$OWNER/perfect-imports-site/pages" \
  -f "source[branch]=main" -f "source[path]=/" \
 || echo "If this errors, enable manually: repo → Settings → Pages → Deploy from a branch → main / (root)"
echo "GitHub username: $OWNER   (you'll need it for the www CNAME below)"
```
Wait ~1–2 min → live at `https://<username>.github.io/perfect-imports-site/`. The included `CNAME`
file means it will serve at perfect-imports.com once DNS (step 3) is set.

## 3. Point perfect-imports.com at it — ⚠️ EMAIL-SAFE DNS
In your domain's DNS panel (Squarespace / Google Domains → perfect-imports.com → DNS).
**Change ONLY the web records. DO NOT touch MX, SPF, DKIM, or DMARC — those run your email.**

**REMOVE:**
- A record `@` → `198.49.23.144` (old Squarespace site)
- the `www` records pointing to Squarespace (`ext-sq.squarespace.com` / 198.185.159.x / 198.49.23.x)

**ADD:**
| Type | Host | Value |
|------|------|-------|
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| CNAME | www | `<username>.github.io` |

**KEEP EXACTLY AS-IS (these are your email — do not delete/edit):**
- MX → `aspmx.l.google.com`, `alt1.aspmx.l.google.com`, `alt2.aspmx.l.google.com`
- TXT `@` → `v=spf1 include:_spf.google.com ~all`
- TXT `google._domainkey` → `v=DKIM1; k=rsa; p=...`
- TXT `_dmarc` → `v=DMARC1; p=none; rua=mailto:froy@perfect-imports.com`

DNS propagates ~15 min–2 h; GitHub auto-issues HTTPS. Then https://perfect-imports.com is live.

## 4. Editing it forever after (what you wanted)
Tell Claude/Codex on your Mac: *"edit index.html — change the headline to X"*, then:
```bash
git add -A && git commit -m "update copy" && git push
```
Live in ~30 seconds. No Squarespace, ever.

## Before you go fully live — confirm 2 things in index.html
1. Compliance line (72°F / FDA / FSVP / alcohol-licensed / bonded) is worded as your **3PL partner's** — keep it that way unless Perfect Imports itself holds those.
2. Footer address — replace "Fort Lauderdale, FL" with a real business mailing address (not a home address).
