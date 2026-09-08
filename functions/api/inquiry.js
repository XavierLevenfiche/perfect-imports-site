/**
 * Contact form handler - Cloudflare Pages Function.
 *
 * WHY THIS EXISTS. Every contact link on this site was a `mailto:`. That produced two of
 * the five leads Perfect Imports has ever recorded, but both arrived as
 * `inbound_unattributed` - the only reason we later identified them was that the sender
 * happened to leave the CTA subject line intact. Cloudflare also rewrites every mailto
 * into "[email protected]" and rebuilds it in JavaScript, so a visitor with that script
 * blocked sees no contact link at all.
 *
 * This captures the enquiry server-side with its source. The local KV relay owns email
 * delivery; keeping one sender prevents a successful request from notifying twice.
 *
 * SETUP (Cloudflare Pages -> Settings -> Environment variables):
 * The INQUIRIES KV binding is the durable acceptance path, and a missing or failed KV
 * write returns a retryable error to the visitor.
 */

const MAX = {
  name: 120,
  email: 254,
  company: 160,
  message: 4000,
  source: 60,
  gclid: 512,
  gbraid: 512,
  wbraid: 512,
  utm_source: 100,
  utm_medium: 100,
  utm_campaign: 200,
  utm_term: 200,
  utm_content: 200,
  channel: 80,
  landing_path: 512,
  landing_referrer: 512,
  commodity: 160,
  approx_volume: 120,
};

const SOURCE_ALLOWLIST = [
  "bonded-warehousing",
  "verified-buyer-list-79",
  "market-opportunity-brief-99",
  "free-sample",
  "contact-section",
];

// Admission control. The endpoint is public and unauthenticated, so without these a
// single script can fill KV, burn Gmail quota and bury a real lead under noise.
// No CAPTCHA and no paid service - this uses only the KV binding that already exists.
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT = { attempts: 5, windowSeconds: 10 * 60 };

function clean(v, cap) {
  // Strip C0 controls, DEL, C1 controls, and the Unicode line separators U+0085,
  // U+2028 and U+2029. Python's EmailMessage treats those last three as line breaks and
  // raises when they appear in a header, which poisoned the relay permanently until a
  // human intervened. Filtering below charCode 32 alone was not enough.
  return String(v == null ? "" : v)
    .split("")
    .filter(function (ch) {
      var c = ch.charCodeAt(0);
      if (c < 32 || c === 127) return false;
      if (c >= 128 && c <= 159) return false;
      if (c === 0x85 || c === 0x2028 || c === 0x2029) return false;
      return true;
    })
    .join("")
    .trim()
    .slice(0, cap);
}

function looksLikeEmail(v) {
  // ONE mailbox. Commas, semicolons and colons are rejected: "a@b.com,victim" passed the
  // old test and produced a two-address Reply-To, so a human reply could go somewhere the
  // send gate never sees.
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(v) && v.length <= 254;
}

function allowlisted(v, allowed) {
  return allowed.indexOf(v) !== -1 ? v : "unknown";
}

function simpleHost(value) {
  var host = String(value || "").toLowerCase().replace(/^www\./, "");
  try {
    host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch (e) {
    // UTM sources such as "google" are deliberately accepted as bare identifiers.
  }
  return host;
}

function looksLikeSearchEngine(value) {
  var host = simpleHost(value);
  if (["google", "bing", "yahoo", "duckduckgo", "ddg", "ecosia", "yandex",
       "baidu", "ask", "aol", "brave", "qwant", "startpage"].indexOf(host) !== -1) {
    return true;
  }
  return /(^|\.)(google\.[a-z]{2,}(\.[a-z]{2})?|bing\.com|search\.yahoo\.com|duckduckgo\.com|ecosia\.org|yandex\.[a-z.]+|baidu\.com|ask\.com|aol\.com|search\.brave\.com|qwant\.com|startpage\.com)$/.test(host);
}

function classifyChannel(payload) {
  if (payload.gclid || payload.gbraid || payload.wbraid) return "paid-search";
  var sourceIsSearch = looksLikeSearchEngine(payload.utm_source);
  var medium = String(payload.utm_medium || "").toLowerCase().replace(/[\s_]+/g, "-");
  var paidMedium = ["cpc", "ppc", "paid", "paid-search", "sem"].indexOf(medium) !== -1;
  var organicMedium = !medium || ["organic", "seo"].indexOf(medium) !== -1;
  if (sourceIsSearch && paidMedium) return "paid-search";
  if (sourceIsSearch && organicMedium) return "organic";
  if (payload.utm_source && !paidMedium) return "referral";
  if (payload.utm_source) return "unknown";
  var referrerHost = simpleHost(payload.landing_referrer);
  if (looksLikeSearchEngine(referrerHost)) return "organic";
  if (referrerHost && referrerHost !== "perfect-imports.com") return "referral";
  return "direct";
}

function json(obj, status, extraHeaders, request) {
  var headers = { "content-type": "application/json", "cache-control": "no-store", "vary": "Accept" };
  Object.keys(extraHeaders || {}).forEach(function (key) {
    headers[key] = extraHeaders[key];
  });
  var outcome = { accepted: false, stored: false, ...obj };
  var accept = request ? (request.headers.get("accept") || "").toLowerCase() : "";
  if (!accept.includes("application/json") && accept.includes("text/html")) {
    var accepted = outcome.ok === true && outcome.accepted === true && outcome.stored === true;
    var title = accepted ? "Enquiry received" : "Enquiry not confirmed";
    var message = accepted ? "Thanks — your enquiry has been received. I usually reply the same day." :
      (outcome.error || "We could not confirm your enquiry was received.");
    var escape = value => String(value).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    headers["content-type"] = "text/html; charset=utf-8";
    headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
    return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + title + ' — Perfect Imports</title><style>body{font:18px/1.6 system-ui;background:#f5f1e8;color:#142c3e;max-width:42rem;margin:10vh auto;padding:2rem}a{color:inherit}</style>' +
      '<main><p>Perfect Imports</p><h1>' + title + '</h1><p>' + escape(message) + '</p>' +
      (accepted ? '' : '<p>Use your browser’s Back button to return to your details, or email us directly.</p>') +
      '<p><a href="mailto:froy@perfect-imports.com">froy@perfect-imports.com</a></p><p><a href="/">Return to Perfect Imports</a></p></main></html>',
      { status: status || 200, headers: headers });
  }
  return new Response(JSON.stringify(outcome), { status: status || 200, headers: headers });
}

async function readBodyLimited(request) {
  var declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared.trim()) && Number(declared) > MAX_BODY_BYTES) {
    var declaredError = new Error("request body is too large");
    declaredError.tooLarge = true;
    throw declaredError;
  }

  if (!request.body) return new Uint8Array(0);

  // Do not call request.json(), request.formData(), text(), or arrayBuffer() until the
  // size is known: each of those can buffer an unbounded chunked body. Read at most one
  // byte beyond the cap, then cancel the stream.
  var reader = request.body.getReader();
  var chunks = [];
  var total = 0;
  while (true) {
    var part = await reader.read();
    if (part.done) break;
    var chunk = part.value instanceof Uint8Array
      ? part.value
      : new Uint8Array(part.value);
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) {
      try { await reader.cancel("request body is too large"); } catch (e) { /* no-op */ }
      var streamedError = new Error("request body is too large");
      streamedError.tooLarge = true;
      throw streamedError;
    }
    chunks.push(chunk);
  }

  var body = new Uint8Array(total);
  var offset = 0;
  chunks.forEach(function (chunk) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return body;
}

async function parseBody(request, body) {
  var ct = request.headers.get("content-type") || "";
  if (ct.toLowerCase().indexOf("application/json") !== -1) {
    return JSON.parse(new TextDecoder().decode(body));
  }
  var parsed = await new Response(body, { headers: { "content-type": ct } }).formData();
  return Object.fromEntries(parsed);
}

async function rateLimit(request, env) {
  // Cloudflare supplies CF-Connecting-IP at the edge. Hash it before using it in a KV
  // key so raw visitor addresses are not retained. KV counters are deliberately scoped
  // away from the `inq:` delivery prefix and expire shortly after their fixed window.
  if (!env.INQUIRIES) return { allowed: true };
  var ip = request.headers.get("cf-connecting-ip") || "unknown";
  var digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  var hash = Array.from(new Uint8Array(digest).slice(0, 16))
    .map(function (b) { return b.toString(16).padStart(2, "0"); })
    .join("");
  var nowSeconds = Math.floor(Date.now() / 1000);
  var window = Math.floor(nowSeconds / RATE_LIMIT.windowSeconds);
  var key = "rate:inquiry:" + window + ":" + hash;
  var count = Number(await env.INQUIRIES.get(key)) || 0;
  var retryAfter = RATE_LIMIT.windowSeconds - (nowSeconds % RATE_LIMIT.windowSeconds);
  if (count >= RATE_LIMIT.attempts) {
    return { allowed: false, retryAfter: retryAfter };
  }
  await env.INQUIRIES.put(key, String(count + 1), {
    expirationTtl: RATE_LIMIT.windowSeconds + 60,
  });
  return { allowed: true };
}

export async function onRequestPost(context) {
  const request = context.request;
  const env = context.env;
  const respond = (obj, status, headers) => json(obj, status, headers, request);

  var declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared.trim()) && Number(declared) > MAX_BODY_BYTES) {
    return respond({ ok: false, error: "request body is too large" }, 413);
  }

  let form;
  try {
    var bodyBytes = await readBodyLimited(request);
    form = await parseBody(request, bodyBytes);
  } catch (e) {
    if (e && e.tooLarge) {
      return respond({ ok: false, error: "request body is too large" }, 413);
    }
    return respond({ ok: false, error: "could not read the form" }, 400);
  }
  if (!form || typeof form !== "object" || Array.isArray(form)) {
    return respond({ ok: false, error: "could not read the form" }, 400);
  }

  // A discarded submission is never accepted or stored, even if autofill hit the
  // hidden field. Keep the buyer's form intact and offer a real contact fallback.
  if (clean(form.website, 200)) {
    return respond({ ok: false, error: "We could not accept this enquiry. Please email froy@perfect-imports.com." }, 422);
  }

  // Honeypot traffic must not consume the shared-IP allowance before it is rejected.
  // Otherwise five naive bots behind an office NAT can block a real buyer for 10 minutes.
  try {
    var admission = await rateLimit(request, env);
    if (!admission.allowed) {
      return respond(
        { ok: false, error: "too many enquiries - please try again shortly" },
        429,
        { "retry-after": String(admission.retryAfter) }
      );
    }
  } catch (err) {
    // The durable write below remains authoritative. A transient counter failure must
    // not discard a legitimate lead, but it is visible in Worker logs.
    console.error("inquiry: rate limit check failed", err);
  }

  var source = allowlisted(clean(form.source, MAX.source), SOURCE_ALLOWLIST);
  const payload = {
    name: clean(form.name, MAX.name),
    email: clean(form.email, MAX.email),
    company: clean(form.company, MAX.company),
    message: clean(form.message, MAX.message),
    // The whole point: which CTA produced this enquiry, recorded not guessed.
    source: source,
    referrer: clean(request.headers.get("referer"), 300),
    country: request.headers.get("cf-ipcountry") || "",
    gclid: clean(form.gclid, MAX.gclid),
    gbraid: clean(form.gbraid, MAX.gbraid),
    wbraid: clean(form.wbraid, MAX.wbraid),
    utm_source: clean(form.utm_source, MAX.utm_source),
    utm_medium: clean(form.utm_medium, MAX.utm_medium),
    utm_campaign: clean(form.utm_campaign, MAX.utm_campaign),
    utm_term: clean(form.utm_term, MAX.utm_term),
    utm_content: clean(form.utm_content, MAX.utm_content),
    landing_path: clean(form.landing_path, MAX.landing_path),
    landing_referrer: clean(form.landing_referrer, MAX.landing_referrer),
    commodity: clean(form.commodity, MAX.commodity),
    approx_volume: clean(form.approx_volume, MAX.approx_volume),
    received_utc: new Date().toISOString(),
  };
  // Never trust a hidden `channel` field. Derive it from the captured identifiers,
  // UTMs and landing referrer so `channel=paid-search` alone cannot poison reporting.
  payload.channel = classifyChannel(payload);

  if (!payload.email || !looksLikeEmail(payload.email)) {
    return respond({ ok: false, error: "a valid email address is required" }, 400);
  }
  if (!payload.message) {
    return respond({ ok: false, error: "please tell us what you need" }, 400);
  }

  // DURABLE FIRST. The visitor is told "sent" only when a durable record exists.
  // Previously Resend ran first and both failures were swallowed behind {ok:true}, so a
  // provider outage or a missing binding silently lost the lead while the form reset and
  // said thank you. Logging is not acceptance.
  var stored = false;
  var storageUnknown = false;
  var key = "";
  try {
    if (env.INQUIRIES) {
      // Seconds + UUID keeps the durable key at 61 characters (Ads maximum 64).
      // received_utc retains its original full precision in the record.
      key = "inq:" + payload.received_utc.replace(/\.\d{3}Z$/, "Z") + ":" + crypto.randomUUID();
      payload.inquiry_id = key;
      await env.INQUIRIES.put(key, JSON.stringify(payload));
      stored = true;
    } else {
      console.error("inquiry: KV binding INQUIRIES missing");
    }
  } catch (err) {
    // A failed acknowledgement does not prove the write never committed.
    storageUnknown = true;
    console.error("inquiry: KV write failed", key, err);
    delete payload.inquiry_id;
  }

  if (!stored) {
    // Preserve the existing operator rescue path only on failure. All fields were
    // bounded above; a log is not durable acceptance or proof of non-commitment.
    console.error("INQUIRY_UNSAVED", JSON.stringify(payload), key || null);
    // Retryable. The browser keeps the form populated so nothing the visitor typed is lost.
    return respond({ ok: false, stored: storageUnknown ? null : false, error: "We could not confirm your enquiry was received. Please retry or email froy@perfect-imports.com." }, 503);
  }

  console.log("INQUIRY_STORED", key);
  return respond({ ok: true, accepted: true, stored: true, inquiry_id: key });
}
