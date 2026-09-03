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

function formRequest(ip = "203.0.113.10", source = "test-source") {
  const body = new URLSearchParams({
    email: "buyer@example.com",
    message: "Please contact me",
    source,
  });
  return new Request("https://example.test/api/inquiry", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "cf-connecting-ip": ip,
    },
    body,
  });
}

function inquiryPuts(kv) {
  return kv.puts.filter((item) => item.key.startsWith("inq:"));
}

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

test("the sixth attempt from one IP is rate limited and not stored", async () => {
  const kv = new MockKV();
  const originalNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await worker.onRequestPost({
        request: formRequest("203.0.113.12", "rate-test-" + attempt),
        env: { INQUIRIES: kv },
      });
      assert.equal(response.status, 200);
    }
    const blocked = await worker.onRequestPost({
      request: formRequest("203.0.113.12", "must-not-store"),
      env: { INQUIRIES: kv },
    });

    assert.equal(blocked.status, 429);
    assert.match(blocked.headers.get("retry-after"), /^\d+$/);
    assert.equal(inquiryPuts(kv).length, 5);
    assert.equal(
      inquiryPuts(kv).some((item) => JSON.parse(item.value).source === "must-not-store"),
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
      request: formRequest("203.0.113.13", "counter-fail-open"),
      env: { INQUIRIES: kv },
    });
    assert.equal(response.status, 200);
    assert.equal(inquiryPuts(kv).length, 1);
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
      source: "json-test",
    }),
  });

  const response = await worker.onRequestPost({ request, env: { INQUIRIES: kv } });

  assert.equal(response.status, 200);
  assert.equal(JSON.parse(inquiryPuts(kv)[0].value).source, "json-test");
});
