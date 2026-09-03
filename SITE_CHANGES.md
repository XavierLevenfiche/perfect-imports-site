# Site changes 2026-08-27 — deploy from the MacBook

Two changes to `index.html`. Backup: `~/projects/archive/scratch/site-index.html.bak-20260827`.

## Why

Perfect Imports has recorded five leads ever. **Two came from this page** — matched by the
`mailto` subject line reproducing the site's own CTA text verbatim (International LOFT,
which now has a booked call, and DVL/OTIF). Both were filed as `inbound_unattributed`
because nothing tracked them.

Meanwhile ~1,030 cold emails produced zero leads, and a placement test on 2026-08-26
confirmed that cold mail from `getperfectted.com` lands in Gmail spam.

**The site is the channel that works, and it was the only one with no instrumentation.**

## 1. Cloudflare Web Analytics

Added before `</head>`. Free, cookieless, no consent banner.

**ACTION REQUIRED before this does anything:** replace `REPLACE_WITH_CF_TOKEN` with the
real token from Cloudflare dashboard → Web Analytics → `perfect-imports.com`.

Alternative with no code at all: Cloudflare can enable Web Analytics automatically for a
proxied site from the dashboard. If you use that, delete the script tag.

## 2. Contact links exempted from Cloudflare email obfuscation

Cloudflare was rewriting all five `mailto:` links into `[email protected]` and rebuilding
them in JavaScript. Any visitor whose browser blocks that script, and any crawler or link
preview, saw no working contact link.

Every contact link is now wrapped in `<!--email_off-->`, which tells Cloudflare to leave
it alone. The link text and subjects are unchanged.

**The CTA subjects were deliberately NOT touched.** They are what made attribution
possible, and changing them would break the only working measurement.

## Deploy

Per `DEPLOY.md`, from the MacBook. This repo has only a `nas-backup` remote, so the push
must come from the machine that holds the GitHub remote.

## Not done

A real form to replace `mailto:`. It would capture source automatically and remove the
JavaScript dependency entirely. Cloudflare Pages Functions can host it free. Bigger job.
