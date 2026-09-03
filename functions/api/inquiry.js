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
 * This captures the enquiry server-side with its source, then emails it on. No mailto,
 * no JavaScript dependency for the address, and attribution is recorded rather than
 * inferred months later.
 *
 * SETUP (Cloudflare Pages -> Settings -> Environment variables):
 *   INQUIRY_TO      destination, e.g. froy@perfect-imports.com
 *   RESEND_API_KEY  or equivalent provider key
 * Notification config is best-effort. The INQUIRIES KV binding is the durable acceptance
 * path, and a missing or failed KV write returns a retryable error to the visitor.
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

const CHANNEL_ALLOWLIST = [
  "paid-search",
  "organic",
  "referral",
  "direct",
  "unknown",
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

function addBodyLine(lines, label, value) {
  if (value) lines.push(label + ": " + value);
}

function buildEmailBody(payload) {
  var lines = [];
  addBodyLine(lines, "Inquiry ID", payload.inquiry_id);
  addBodyLine(lines, "Source", payload.source);
  addBodyLine(lines, "Channel", payload.channel);
  addBodyLine(lines, "Name", payload.name);
  addBodyLine(lines, "Email", payload.email);
  addBodyLine(lines, "Company", payload.company);
  addBodyLine(lines, "Country", payload.country);
  addBodyLine(lines, "Referrer", payload.referrer);
  addBodyLine(lines, "Landing path", payload.landing_path);
  addBodyLine(lines, "Landing referrer", payload.landing_referrer);
  addBodyLine(lines, "gclid", payload.gclid);
  addBodyLine(lines, "gbraid", payload.gbraid);
  addBodyLine(lines, "wbraid", payload.wbraid);
  addBodyLine(lines, "utm_source", payload.utm_source);
  addBodyLine(lines, "utm_medium", payload.utm_medium);
  addBodyLine(lines, "utm_campaign", payload.utm_campaign);
  addBodyLine(lines, "utm_term", payload.utm_term);
  addBodyLine(lines, "utm_content", payload.utm_content);
  addBodyLine(lines, "Commodity", payload.commodity);
  addBodyLine(lines, "Approx volume", payload.approx_volume);
  addBodyLine(lines, "Received", payload.received_utc);
  return lines.join("\n") + "\n\n" + payload.message + "\n";
}

function json(obj, status, extraHeaders) {
  var headers = { "content-type": "application/json" };
  Object.keys(extraHeaders || {}).forEach(function (key) {
    headers[key] = extraHeaders[key];
  });
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: headers,
  });
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

  var declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared.trim()) && Number(declared) > MAX_BODY_BYTES) {
    return json({ ok: false, error: "request body is too large" }, 413);
  }

  try {
    var admission = await rateLimit(request, env);
    if (!admission.allowed) {
      return json(
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

  let form;
  try {
    var bodyBytes = await readBodyLimited(request);
    form = await parseBody(request, bodyBytes);
  } catch (e) {
    if (e && e.tooLarge) {
      return json({ ok: false, error: "request body is too large" }, 413);
    }
    return json({ ok: false, error: "could not read the form" }, 400);
  }
  if (!form || typeof form !== "object" || Array.isArray(form)) {
    return json({ ok: false, error: "could not read the form" }, 400);
  }

  // Honeypot. Real users never fill a hidden field; naive bots fill everything.
  // Answer 200 so a bot cannot tell it was rejected.
  // `ok` alone is deliberately not proof of storage; `inquiry_id` is the durable-write
  // signal the conversion pixel keys on.
  if (clean(form.website, 200)) return json({ ok: true });

  var source = allowlisted(clean(form.source, MAX.source), SOURCE_ALLOWLIST);
  var channel = allowlisted(clean(form.channel, MAX.channel), CHANNEL_ALLOWLIST);

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
    channel: channel,
    landing_path: clean(form.landing_path, MAX.landing_path),
    landing_referrer: clean(form.landing_referrer, MAX.landing_referrer),
    commodity: clean(form.commodity, MAX.commodity),
    approx_volume: clean(form.approx_volume, MAX.approx_volume),
    received_utc: new Date().toISOString(),
  };

  if (!payload.email || !looksLikeEmail(payload.email)) {
    return json({ ok: false, error: "a valid email address is required" }, 400);
  }
  if (!payload.message) {
    return json({ ok: false, error: "please tell us what you need" }, 400);
  }

  const subject =
    "Website enquiry [" + payload.source + "] - " +
    (payload.company || payload.name || payload.email);

  // DURABLE FIRST. The visitor is told "sent" only when a durable record exists.
  // Previously Resend ran first and both failures were swallowed behind {ok:true}, so a
  // provider outage or a missing binding silently lost the lead while the form reset and
  // said thank you. Logging is not acceptance.
  var stored = false;
  var key = "";
  try {
    if (env.INQUIRIES) {
      key = "inq:" + payload.received_utc + ":" + Math.random().toString(36).slice(2, 8);
      payload.inquiry_id = key;
      await env.INQUIRIES.put(key, JSON.stringify(payload));
      stored = true;
    } else {
      console.error("inquiry: KV binding INQUIRIES missing");
    }
  } catch (err) {
    delete payload.inquiry_id;
    key = "";
    console.error("inquiry: KV write failed", err);
  }

  console.log("INQUIRY", JSON.stringify(payload));

  if (!stored) {
    // Retryable. The browser keeps the form populated so nothing the visitor typed is lost.
    return json({ ok: false, error: "could not save your enquiry - please email froy@perfect-imports.com" }, 503);
  }

  // Best-effort immediate notification. The KV relay is the guaranteed path, so a failure
  // here is logged and never affects what the visitor sees.
  try {
    if (env.RESEND_API_KEY && env.INQUIRY_TO) {
      var body = buildEmailBody(payload);
      var r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + env.RESEND_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Website <website@perfect-imports.com>",
          to: [env.INQUIRY_TO],
          reply_to: payload.email,
          subject: subject,
          text: body,
        }),
      });
      if (!r.ok) console.error("inquiry: resend failed", r.status);
    }
  } catch (err) {
    console.error("inquiry: resend threw", err);
  }

  return json({ ok: true, inquiry_id: key });
}
