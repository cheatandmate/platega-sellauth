import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import worker, { generateMac, verifyCallback } from "../src/index.js";

const env = { PAYCEK_API_KEY: "key123", PAYCEK_API_SECRET: "sec456", PAYCEK_PROFILE_CODE: "prof",
  SELLAUTH_API_KEY: "sa", SELLAUTH_SHOP_ID: "42", SELLAUTH_SHOP_URL: "https://shop.mysellauth.com/" };

// Reference: line-for-line port of #generateMacHash in the official paycek npm package
function ref(nonce, endpoint, bodyBytes, method = "POST", ct = "application/json") {
  const h = createHash("sha3-512");
  for (const p of [env.PAYCEK_API_KEY, env.PAYCEK_API_SECRET, nonce, method, endpoint, ct]) { h.update("\0"); h.update(Buffer.from(p)); }
  h.update("\0"); h.update(bodyBytes); h.update("\0");
  return h.digest("hex");
}

// 1. MAC parity (POST with body, GET empty)
const body = new TextEncoder().encode(JSON.stringify({ a: 1, b: "é€" }));
assert.equal(generateMac(env, "1700000000000", "/processing/api/payment/open", body),
             ref("1700000000000", "/processing/api/payment/open", Buffer.from(body)));
assert.equal(generateMac(env, "9", "/paycek/status/7", new Uint8Array(0), "GET", ""),
             ref("9", "/paycek/status/7", Buffer.alloc(0), "GET", ""));
console.log("ok  MAC matches reference");

// 2. callback verification (path form and path+query form), bad/missing -> false
const mk = (url, mac, nonce = "55") => new Request(url, { headers: mac ? { "ApiKeyAuth-Nonce": nonce, "ApiKeyAuth-MAC": mac } : {} });
const u = "https://w.example/paycek/status/7?status=successful";
assert.equal(verifyCallback(env, mk(u, ref("55", "/paycek/status/7", Buffer.alloc(0), "GET", ""))), true);
assert.equal(verifyCallback(env, mk(u, ref("55", "/paycek/status/7?status=successful", Buffer.alloc(0), "GET", ""))), true);
assert.equal(verifyCallback(env, mk(u, "deadbeef")), false);
assert.equal(verifyCallback(env, mk(u, null)), false);
console.log("ok  callback verification");

// 3. End-to-end with mocked KV + fetch
const kv = new Map();
env.STATE = { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
  put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k),
  list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) };
const calls = []; let payStatus = "waiting_confirmations";
globalThis.fetch = async (url, opt = {}) => {
  calls.push([opt.method || "GET", url]);
  const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (url.includes("sellauth.com") && url.endsWith("/invoices/8")) return j({ data: { id: 8, price: 5, currency: "USD" } });
  if (url.includes("sellauth.com") && url.endsWith("/invoices/7")) return j({ data: { id: 7, price: 12.5, email: "b@x.io", status: "pending" } });
  if (url.endsWith("/invoices/7/process?mark_as_paid=true")) return j({ ok: true });
  if (url.endsWith("payment/open")) {
    const b = JSON.parse(opt.body);
    assert.equal(b.dst_amount, "12.50"); assert.equal(b.payment_id, "7");
    assert.equal(b.status_url_callback, "https://w.example/paycek/status/7");
    assert.equal(b.success_url, "https://shop.mysellauth.com/checkout/abc123");
    assert.equal(opt.headers["ApiKeyAuth-MAC"], ref(opt.headers["ApiKeyAuth-Nonce"], "/processing/api/payment/open", Buffer.from(opt.body)));
    return j({ status: "ok", data: { payment_code: "PC", payment_url: "https://paycek.io/p/PC", payment_status: "created" } });
  }
  if (url.endsWith("payment/get")) return j({ status: "ok", data: { payment_status: payStatus, payment_id: "7", dst_amount: "12.50" } });
  throw new Error("unexpected " + url);
};
const run = (u, mac) => worker.fetch(mk(u, mac), env);

// URL says amount=0.01 (tampered); the invoice is 12.50 -> PayCek must be opened for 12.50
let r = await run("https://w.example/start?invoice=7&ref=abc123&amount=0.01&currency=EUR&email=x@y.z");
assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "https://paycek.io/p/PC");
r = await run("https://w.example/paycek/status/7?status=successful", null);  // invalid -> 401, nothing processed
assert.equal(r.status, 401); assert.ok(!calls.some((c) => c[1].includes("/invoices/7/process")));
r = await run("https://w.example/paycek/status/7?status=waiting_confirmations", ref("1", "/paycek/status/7", Buffer.alloc(0), "GET", "")); // wrong nonce -> 401
assert.equal(r.status, 401);
const good = (st) => ["https://w.example/paycek/status/7?status=" + st, ref("55", "/paycek/status/7", Buffer.alloc(0), "GET", "")];
r = await run(...good("waiting_confirmations")); assert.equal(r.status, 200);
assert.ok(!calls.some((c) => c[1].includes("/invoices/7/process")), "must not deliver before success");
payStatus = "successful";
r = await run(...good("successful")); assert.equal(r.status, 200);
r = await run(...good("successful")); assert.equal(r.status, 200);   // replay
assert.equal(calls.filter((c) => c[1].includes("/invoices/7/process")).length, 1, "delivered exactly once");
r = await run("https://w.example/start?invoice=7&ref=abc123&amount=0.01&currency=EUR"); assert.equal(r.status, 302);
assert.equal(r.headers.get("location"), "https://shop.mysellauth.com/checkout/abc123");   // paid -> back to SellAuth checkout
r = await run("https://w.example/start?invoice=8&ref=z&currency=USD"); assert.equal(r.status, 400); // currency guard
console.log("ok  end-to-end (open -> 401s -> pending -> success -> delivered once -> replay safe)");
