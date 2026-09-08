import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerSource = await readFile(new URL("./inquiry.js", import.meta.url), "utf8");
const worker = await import(
  "data:text/javascript;base64," + Buffer.from(workerSource).toString("base64")
);

class MockKV {
  constructor() {
    this.values = new Map();
    this.puts = [];
    this.gets = [];
  }

  async get(key) {
    this.gets.push(key);
    return this.values.get(key) ?? null;
  }

  async put(key, value, options) {
    this.puts.push({ key, value, options });
    this.values.set(key, value);
  }
}

function formRequest(
  ip = "203.0.113.10",
  source = "contact-section",
  fields = {},
  headers = {},
) {
  const values = {
    email: "buyer@example.com",
    message: "Please contact me",
    source,
    ...fields,
  };
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) body.set(key, value);
  }
  return new Request("https://example.test/api/inquiry", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "cf-connecting-ip": ip,
      ...headers,
    },
    body,
  });
}

function inquiryPuts(kv) {
  return kv.puts.filter((item) => item.key.startsWith("inq:"));
}

function quarantinePuts(kv) {
  return kv.puts.filter((item) => item.key.startsWith("quarantine:inq:"));
}

function storedRecord(kv, index = 0) {
  return JSON.parse(inquiryPuts(kv)[index].value);
}

test("honeypot is durably quarantined but never accepted as a lead", async () => {
  // This used to assert 200/ok:true with no ID and no storage. That pinned the bug:
  // human clients could treat a discarded autofill trip as a received enquiry. The
  // replacement contract preserves bot ambiguity with a 200 response and an opaque ID,
  // but the explicit non-acceptance bit prevents thanks-page receipts and conversions.
  const kv = new MockKV();

  const response = await worker.onRequestPost({
    request: formRequest("203.0.113.9", "bonded-warehousing", { pi_inquiry_extra: "https://bot.test" }),
    env: { INQUIRIES: kv },
  });
  const body = await response.json();
  const puts = quarantinePuts(kv);

  assert.equal(response.status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.accepted, false);
  assert.equal(body.stored, true);
  assert.match(body.inquiry_id, /^inq:/);
  assert.ok(body.inquiry_id.length <= 64);
  assert.equal(inquiryPuts(kv).length, 0);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, "quarantine:" + body.inquiry_id);
  const record = JSON.parse(puts[0].value);
  assert.equal(record.inquiry_id, body.inquiry_id);
  assert.equal(record.email, "buyer@example.com");
  assert.equal(record.message, "Please contact me");
  assert.equal(record.quarantined, true);
  assert.equal(record.accepted, false);
  assert.deepEqual(record.quarantine, {
    reason: "honeypot_filled",
    field: "pi_inquiry_extra",
    value_length: "https://bot.test".length,
    review_required: true,
    normal_relay: false,
  });
  assert.equal(kv.puts.some((item) => item.key.startsWith("rate:inquiry:")), false);
  assert.equal(kv.puts.filter((item) => item.key.startsWith("rate:inquiry-honeypot:")).length, 1);
});

test("legacy website honeypot remains active during cached HTML rollout", async () => {
  const kv = new MockKV();

  const response = await worker.onRequestPost({
    request: formRequest("203.0.113.91", "contact-section", { website: "cached-autofill.example" }),
    env: { INQUIRIES: kv },
  });
  const body = await response.json();
  const record = JSON.parse(quarantinePuts(kv)[0].value);

  assert.equal(response.status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.accepted, false);
  assert.equal(body.stored, true);
  assert.match(body.inquiry_id, /^inq:/);
  assert.equal(inquiryPuts(kv).length, 0);
  assert.equal(record.quarantine.field, "website");
});

test("successful submissions return the durable inquiry id that was written", async () => {
  const kv = new MockKV();

  const response = await worker.onRequestPost({
    request: formRequest("203.0.113.10", "3pl-warehousing"),
    env: { INQUIRIES: kv },
  });
  const body = await response.json();
  const puts = inquiryPuts(kv);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.accepted, true);
  assert.equal(body.stored, true);
  assert.ok(body.inquiry_id.length <= 64);
  assert.equal(puts.length, 1);
  assert.equal(body.inquiry_id, puts[0].key);
  assert.equal(storedRecord(kv).inquiry_id, puts[0].key);
  assert.equal(storedRecord(kv).source, "3pl-warehousing");
});

test("attribution and qualification fields round-trip into storage with caps", async () => {
  const kv = new MockKV();
  const fields = {
    gclid: "g".repeat(600),
    gbraid: "b".repeat(600),
    wbraid: "w".repeat(600),
    utm_source: "s".repeat(140),
    utm_medium: "m".repeat(140),
    utm_campaign: "c".repeat(240),
    utm_term: "t".repeat(240),
    utm_content: "n".repeat(240),
    channel: "paid-search",
    landing_path: "https://perfect-imports.com/" + "p".repeat(600),
    landing_referrer: "https://google.com/" + "r".repeat(600),
    commodity: "green coffee ".repeat(20),
    approx_volume: "20 pallets, 1 container/month ".repeat(8),
  };

  const response = await worker.onRequestPost({
    request: formRequest(
      "203.0.113.15",
      "bonded-warehousing",
      fields,
      { referer: "https://server-ref.example/path?query=1" },
    ),
    env: { INQUIRIES: kv },
  });
  const record = storedRecord(kv);

  assert.equal(response.status, 200);
  assert.equal(record.referrer, "https://server-ref.example/path?query=1");
  assert.equal(record.channel, "paid-search");
  assert.equal(record.gclid.length, 512);
  assert.equal(record.gbraid.length, 512);
  assert.equal(record.wbraid.length, 512);
  assert.equal(record.utm_source.length, 100);
  assert.equal(record.utm_medium.length, 100);
  assert.equal(record.utm_campaign.length, 200);
  assert.equal(record.utm_term.length, 200);
  assert.equal(record.utm_content.length, 200);
  assert.equal(record.landing_path.length, 512);
  assert.equal(record.landing_referrer.length, 512);
  assert.equal(record.commodity.length, 160);
  assert.equal(record.approx_volume.length, 120);
});

test("a forged channel field is ignored and channel is derived from evidence", async () => {
  const kv = new MockKV();

  const response = await worker.onRequestPost({
    request: formRequest("203.0.113.16", "contact-section", { channel: "paid-social" }),
    env: { INQUIRIES: kv },
  });

  assert.equal(response.status, 200);
  assert.equal(storedRecord(kv).channel, "direct");
});

test("google cpc UTMs are paid search even without a click id", async () => {
  const kv = new MockKV();

  const response = await worker.onRequestPost({
    request: formRequest("203.0.113.21", "bonded-warehousing", {
      utm_source: "google",
      utm_medium: "cpc",
    }),
    env: { INQUIRIES: kv },
  });

  assert.equal(response.status, 200);
  assert.equal(storedRecord(kv).channel, "paid-search");
});

test("lookalike search domains are referral rather than organic", async () => {
  const kv = new MockKV();

  const response = await worker.onRequestPost({
    request: formRequest("203.0.113.22", "contact-section", {
      landing_referrer: "https://fake-google.example/landing",
    }),
    env: { INQUIRIES: kv },
  });

  assert.equal(response.status, 200);
  assert.equal(storedRecord(kv).channel, "referral");
});

test("inquiry ids use collision-resistant UUIDs", async () => {
  const kv = new MockKV();
  const first = await worker.onRequestPost({
    request: formRequest("203.0.113.23"),
    env: { INQUIRIES: kv },
  });
  const second = await worker.onRequestPost({
    request: formRequest("203.0.113.24"),
    env: { INQUIRIES: kv },
  });
  const firstBody = await first.json();
  const secondBody = await second.json();

  assert.notEqual(firstBody.inquiry_id, secondBody.inquiry_id);
  assert.match(firstBody.inquiry_id, /:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("successful storage does not invoke a second notification provider", async () => {
  const kv = new MockKV();
  const oldFetch = globalThis.fetch;
  let notificationCalls = 0;
  globalThis.fetch = async () => {
    notificationCalls += 1;
    throw new Error("must not send directly");
  };
  try {
    const response = await worker.onRequestPost({
      request: formRequest("203.0.113.25"),
      env: {
        INQUIRIES: kv,
        RESEND_API_KEY: "must-be-ignored",
        INQUIRY_TO: "owner@example.com",
      },
    });

    assert.equal(response.status, 200);
    assert.equal(notificationCalls, 0);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("sources outside the allowlist are stored as unknown", async () => {
  const kv = new MockKV();

  const response = await worker.onRequestPost({
    request: formRequest("203.0.113.17", "ads-bonded-warehousing"),
    env: { INQUIRIES: kv },
  });

  assert.equal(response.status, 200);
  assert.equal(storedRecord(kv).source, "unknown");
});

test("declared oversized bodies are rejected before reading or touching KV", async () => {
  // NOTE: do not assert on a `pull` flag. ReadableStream calls pull() eagerly on
  // construction to fill its queue, so the flag is already true before the handler runs
  // and the assertion fails against correct code. Verified on node v24.
  // getReader() is the honest signal: it is called only when we actually read the body.
  let readerTaken = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array([123, 125]));
      controller.close();
    },
  });
  const request = {
    headers: new Headers({
      "content-length": "16385",
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10",
    }),
    get body() {
      return {
        getReader() {
          readerTaken = true;
          return stream.getReader();
        },
      };
    },
  };
  const kv = new MockKV();

  const response = await worker.onRequestPost({ request, env: { INQUIRIES: kv } });

  assert.equal(response.status, 413);
  assert.equal(readerTaken, false);
  assert.equal(kv.gets.length, 0);
  assert.equal(kv.puts.length, 0);
});

test("chunked oversized bodies are stopped at the byte cap before parsing", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(16385));
      controller.close();
    },
  });
  const request = new Request("https://example.test/api/inquiry", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": "203.0.113.11",
    },
    body: stream,
    duplex: "half",
  });
  const kv = new MockKV();

  const response = await worker.onRequestPost({ request, env: { INQUIRIES: kv } });

  assert.equal(response.status, 413);
  assert.equal(inquiryPuts(kv).length, 0);
});

test("invalid email addresses are rejected and not stored", async () => {
  const kv = new MockKV();

  const response = await worker.onRequestPost({
    request: formRequest("203.0.113.18", "contact-section", { email: "buyer@example.com,victim@example.com" }),
    env: { INQUIRIES: kv },
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.accepted, false);
  assert.equal(body.stored, false);
  assert.equal(body.error, "a valid email address is required");
  assert.equal(inquiryPuts(kv).length, 0);
});

test("missing messages are rejected and not stored", async () => {
  const kv = new MockKV();

  const response = await worker.onRequestPost({
    request: formRequest("203.0.113.19", "contact-section", { message: undefined }),
    env: { INQUIRIES: kv },
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.accepted, false);
  assert.equal(body.stored, false);
  assert.equal(body.error, "please tell us what you need");
  assert.equal(inquiryPuts(kv).length, 0);
});

test("the sixth attempt from one IP is rate limited and not stored", async () => {
  const kv = new MockKV();
  const originalNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await worker.onRequestPost({
        request: formRequest("203.0.113.12", "contact-section", {
          message: "Rate test " + attempt,
        }),
        env: { INQUIRIES: kv },
      });
      assert.equal(response.status, 200);
    }
    const blocked = await worker.onRequestPost({
      request: formRequest("203.0.113.12", "contact-section", {
        message: "Must not store",
      }),
      env: { INQUIRIES: kv },
    });

    assert.equal(blocked.status, 429);
    assert.match(blocked.headers.get("retry-after"), /^\d+$/);
    assert.equal(inquiryPuts(kv).length, 5);
    assert.equal(
      inquiryPuts(kv).some((item) => JSON.parse(item.value).message === "Must not store"),
      false,
    );
  } finally {
    Date.now = originalNow;
  }
});

test("rate counters are per IP, expiring, and do not retain the raw address", async () => {
  const kv = new MockKV();
  const originalNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await worker.onRequestPost({
        request: formRequest("198.51.100.21"),
        env: { INQUIRIES: kv },
      });
    }
    const otherIp = await worker.onRequestPost({
      request: formRequest("198.51.100.22", "other-ip"),
      env: { INQUIRIES: kv },
    });

    assert.equal(otherIp.status, 200);
    const counters = kv.puts.filter((item) => item.key.startsWith("rate:inquiry:"));
    assert.ok(counters.length >= 6);
    assert.ok(counters.every((item) => item.options.expirationTtl === 660));
    assert.ok(counters.every((item) => !item.key.includes("198.51.100")));
    assert.equal(new Set(counters.map((item) => item.key)).size, 2);
  } finally {
    Date.now = originalNow;
  }
});

test("a transient rate-counter failure does not discard a valid enquiry", async () => {
  const kv = new MockKV();
  kv.get = async () => {
    throw new Error("counter unavailable");
  };
  const oldError = console.error;
  const oldLog = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    const response = await worker.onRequestPost({
      request: formRequest("203.0.113.13", "contact-section"),
      env: { INQUIRIES: kv },
    });
    assert.equal(response.status, 200);
    assert.equal(inquiryPuts(kv).length, 1);
  } finally {
    console.error = oldError;
    console.log = oldLog;
  }
});

test("durable KV write failures return 503 and no success inquiry id", async () => {
  const kv = new MockKV();
  kv.put = async function (key, value, options) {
    if (key.startsWith("inq:")) throw new Error("KV unavailable");
    return MockKV.prototype.put.call(this, key, value, options);
  };
  const oldError = console.error;
  const oldLog = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    const response = await worker.onRequestPost({
      request: formRequest("203.0.113.20", "bonded-warehousing"),
      env: { INQUIRIES: kv },
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
  assert.equal(body.accepted, false);
  assert.equal(body.stored, null);
    assert.equal(Object.hasOwn(body, "inquiry_id"), false);
    assert.equal(inquiryPuts(kv).length, 0);
  } finally {
    console.error = oldError;
    console.log = oldLog;
  }
});

test("small JSON submissions are still accepted after bounded parsing", async () => {
  const kv = new MockKV();
  const request = new Request("https://example.test/api/inquiry", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.14",
    },
    body: JSON.stringify({
      email: "json@example.com",
      message: "JSON path",
      source: "free-sample",
    }),
  });

  const response = await worker.onRequestPost({ request, env: { INQUIRIES: kv } });

  assert.equal(response.status, 200);
  assert.equal(storedRecord(kv).source, "free-sample");
});


test("missing KV cannot report acceptance", async () => {
  const response = await worker.onRequestPost({ request: formRequest(), env: {} });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.accepted, false);
  assert.equal(body.stored, false);
  assert.equal(Object.hasOwn(body, "inquiry_id"), false);
});

test("a failed write followed by a manual retry accepts exactly one durable record", async () => {
  const kv = new MockKV();
  let fail = true;
  kv.put = async function (key, value, options) {
    if (key.startsWith("inq:") && fail) { fail = false; throw new Error("synthetic write failure"); }
    return MockKV.prototype.put.call(this, key, value, options);
  };
  const first = await worker.onRequestPost({ request: formRequest(), env: { INQUIRIES: kv } });
  assert.equal(first.status, 503);
  assert.equal(inquiryPuts(kv).length, 0);
  const retry = await worker.onRequestPost({ request: formRequest(), env: { INQUIRIES: kv } });
  assert.equal(retry.status, 200);
  assert.equal(inquiryPuts(kv).length, 1);
  assert.equal((await retry.json()).inquiry_id.length, 61);
});

test("ambiguous commit-then-error never reports confirmed acceptance", async () => {
  const kv = new MockKV();
  kv.put = async function (key, value, options) {
    await MockKV.prototype.put.call(this, key, value, options);
    if (key.startsWith("inq:")) throw new Error("synthetic acknowledgement lost after commit");
  };
  const response = await worker.onRequestPost({ request: formRequest(), env: { INQUIRIES: kv } });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.accepted, false);
  assert.equal(body.stored, null);
  assert.equal(Object.hasOwn(body, "inquiry_id"), false);
  assert.equal(inquiryPuts(kv).length, 1); // Ambiguous state remains explicit, never invented success.
});

test("simultaneous valid enquiries have separate bounded IDs, preserving relay identity", async () => {
  const kv = new MockKV();
  const replies = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    worker.onRequestPost({ request: formRequest("203.0.113." + (50 + index)), env: { INQUIRIES: kv } })
  ));
  const bodies = await Promise.all(replies.map(response => response.json()));
  assert.equal(new Set(bodies.map(body => body.inquiry_id)).size, 20);
  for (const body of bodies) {
    assert.equal(body.inquiry_id.length, 61);
    assert.equal(body.stored, true);
    assert.equal(JSON.parse(kv.values.get(body.inquiry_id)).inquiry_id, body.inquiry_id);
  }
});

test("invalid JSON and empty message never return accepted or stored", async () => {
  for (const request of [
    new Request("https://example.test/api/inquiry", { method: "POST", headers: {"content-type":"application/json"}, body: "{" }),
    formRequest("203.0.113.10", "contact-section", { message: "" }),
  ]) {
    const kv = new MockKV();
    const response = await worker.onRequestPost({ request, env: { INQUIRIES: kv } });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.accepted, false);
    assert.equal(body.stored, false);
    assert.equal(inquiryPuts(kv).length, 0);
  }
});

test("native HTML confirmation is returned only after confirmed storage", async () => {
  const kv = new MockKV();
  const response = await worker.onRequestPost({ request: formRequest("203.0.113.40", "contact-section", {}, {accept:"text/html"}), env:{INQUIRIES:kv} });
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/text\/html/);
  const html=await response.text();
  assert.match(html,/<h1>Enquiry received<\/h1>/);
  assert.equal(inquiryPuts(kv).length,1);
  assert.equal(html.includes('buyer@example.com'),false);
  assert.equal(html.includes('<script'),false);
});

test("native honeypot and storage errors cannot render a received heading", async () => {
  for(const mode of ['honeypot','no-binding']) {
    const kv=new MockKV();
    const response=await worker.onRequestPost({request:formRequest('203.0.113.41','contact-section',mode==='honeypot'?{pi_inquiry_extra:'autofill.example'}:{},{accept:'text/html'}),env:mode==='no-binding'?{}:{INQUIRIES:kv}});
    assert.equal(response.status,mode==='honeypot'?200:503);
    const html=await response.text();assert.match(html,/<h1>Enquiry not confirmed<\/h1>/);assert.equal(inquiryPuts(kv).length,0);
    assert.equal(quarantinePuts(kv).length,mode==='honeypot'?1:0);
  }
});

test("the enhanced client can explicitly negotiate JSON and no-store responses",async()=>{
  const response=await worker.onRequestPost({request:formRequest('203.0.113.42','contact-section',{}, {accept:'application/json'}),env:{INQUIRIES:new MockKV()}});
  assert.match(response.headers.get('content-type'),/application\/json/);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('vary'),'Accept');
  assert.equal((await response.json()).stored,true);
});


test("failure-only rescue log preserves bounded buyer details without claiming acceptance", async () => {
  const errors = [], logs = [];
  const originalError = console.error, originalLog = console.log;
  console.error = (...args) => errors.push(args);
  console.log = (...args) => logs.push(args);
  try {
    const failed = new MockKV();
    failed.put = async (key, value) => { if (key.startsWith("inq:")) throw new Error("synthetic failure"); };
    const response = await worker.onRequestPost({request: formRequest(), env: {INQUIRIES: failed}});
    assert.equal(response.status, 503);
    const failure = await response.json();
    assert.equal(failure.accepted, false);
    assert.equal(Object.hasOwn(failure, "inquiry_id"), false);
    assert.match(errors.find(row => row[0] === "inquiry: KV write failed")[1], /^inq:/);
    const rescued = errors.filter(row => row[0] === "INQUIRY_UNSAVED");
    assert.equal(rescued.length, 1);
    assert.equal(rescued[0][2], errors.find(row => row[0] === "inquiry: KV write failed")[1]);
    const payload = JSON.parse(rescued[0][1]);
    assert.equal(payload.email, "buyer@example.com");
    assert.equal(payload.message, "Please contact me");
    assert.ok(payload.received_utc);
    assert.equal(logs.length, 0);
    errors.length = 0;
    const success = await worker.onRequestPost({request: formRequest(), env: {INQUIRIES: new MockKV()}});
    assert.equal(success.status, 200);
    assert.equal(errors.filter(row => row[0] === "INQUIRY_UNSAVED").length, 0);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], "INQUIRY_STORED");
    assert.equal(logs[0].length, 2);
    assert.match(logs[0][1], /^inq:/);
  } finally { console.error = originalError; console.log = originalLog; }
});


test("explicit JSON takes precedence in mixed Accept headers",async()=>{
  const response=await worker.onRequestPost({request:formRequest('203.0.113.43','contact-section',{}, {accept:'text/html, application/json, */*'}),env:{INQUIRIES:new MockKV()}});
  assert.match(response.headers.get('content-type'),/application\/json/);
  assert.equal((await response.json()).stored,true);
});
