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

function storedRecord(kv, index = 0) {
  return JSON.parse(inquiryPuts(kv)[index].value);
}

test("honeypot returns ok without an inquiry id and stores no inquiry record", async () => {
  const kv = new MockKV();

  const response = await worker.onRequestPost({
    request: formRequest("203.0.113.9", "bonded-warehousing", { website: "https://bot.test" }),
    env: { INQUIRIES: kv },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(Object.hasOwn(body, "inquiry_id"), false);
  assert.equal(inquiryPuts(kv).length, 0);
});

test("successful submissions return the durable inquiry id that was written", async () => {
  const kv = new MockKV();

  const response = await worker.onRequestPost({
    request: formRequest("203.0.113.10", "bonded-warehousing"),
    env: { INQUIRIES: kv },
  });
  const body = await response.json();
  const puts = inquiryPuts(kv);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(puts.length, 1);
  assert.equal(body.inquiry_id, puts[0].key);
  assert.equal(storedRecord(kv).inquiry_id, puts[0].key);
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

test("channels outside the allowlist are stored as unknown", async () => {
  const kv = new MockKV();

  const response = await worker.onRequestPost({
    request: formRequest("203.0.113.16", "contact-section", { channel: "paid-social" }),
    env: { INQUIRIES: kv },
  });

  assert.equal(response.status, 200);
  assert.equal(storedRecord(kv).channel, "unknown");
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
