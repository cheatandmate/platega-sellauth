import assert from "node:assert/strict";
import worker from "../src/index.js";

const env = { PLATEGA_MERCHANT_ID: "11111111-1111-1111-1111-111111111111", PLATEGA_SECRET: "sek",
  SELLAUTH_API_KEY: "sa", SELLAUTH_SHOP_ID: "42", SELLAUTH_SHOP_URL: "https://shop.mysellauth.com/",
  PLATEGA_PAYMENT_METHOD: "2" };
const kv = new Map();
env.STATE = { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
  put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k),
  list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) };

let cbrDown = false;
const calls = []; let txStatus = "PENDING"; let txAmount = 500; let txCurrency = "RUB";
const TX = "3fa85f64-5717-4562-b3fc-2c463f66afa6";
globalThis.fetch = async (url, opt = {}) => {
  calls.push([opt.method || "GET", url]);
  const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (url.includes("api.sellauth.com") && url.endsWith("/invoices/7")) return j({ data: { id: 7, price: 500, currency: "RUB", email: "b@x.io", status: "pending" } });
  if (url.includes("api.sellauth.com") && url.endsWith("/invoices/9")) return j({ data: { id: 9, price: 5 } }); // no currency
  if (url.includes("api.sellauth.com") && url.endsWith("/invoices/11")) return j({ data: { id: 11, price: 9.99, currency: "USD", email: "b@x.io", status: "pending" } });
  if (url.includes("api.sellauth.com") && url.endsWith("/invoices/12")) return j({ data: { id: 12, price: 10, currency: "JPY", status: "pending" } });
  if (url === "https://www.cbr-xml-daily.ru/daily_json.js") { if (cbrDown) throw new Error("down"); return j({ Valute: { USD: { Nominal: 1, Value: 90.5 } } }); }
  if (url.endsWith("/invoices/7/process?mark_as_paid=true")) { assert.equal(opt.headers.Authorization, "Bearer sa"); return j({ ok: true }); }
  if (url === "https://app.platega.io/transaction/process") {
    assert.equal(opt.method, "POST");
    assert.equal(opt.headers["X-MerchantId"], env.PLATEGA_MERCHANT_ID); assert.equal(opt.headers["X-Secret"], "sek");
    const b = JSON.parse(opt.body);
    assert.equal(b.id, undefined, "must not send id");
    if (b.payload === "11") { assert.deepEqual(b.paymentDetails, { amount: env.PLATEGA_MARKUP_PCT === "2" ? 922.18 : 904.1, currency: "RUB" }); return j({ transactionId: "tx-usd-11", redirect: "https://pay.platega.io/?usd", status: "PENDING" }); }
    assert.equal(b.paymentMethod, 2); assert.deepEqual(b.paymentDetails, { amount: 500, currency: "RUB" }); // URL said 0.01
    assert.equal(b.return, "https://shop.mysellauth.com/checkout/abc123");
    return j({ transactionId: TX, redirect: "https://pay.platega.io/?x", status: "PENDING", paymentMethod: "SBPQR" });
  }
  if (url === `https://app.platega.io/transaction/${TX}`) return j({ id: TX, status: txStatus, paymentDetails: { amount: txAmount, currency: txCurrency } });
  throw new Error("unexpected " + url);
};
const delivered = () => calls.filter((c) => c[1].includes("/invoices/7/process")).length;
const start = (qs) => worker.fetch(new Request("https://w.example/start?" + qs), env);
const cb = (headers, body) => worker.fetch(new Request("https://w.example/platega/callback", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env);
const good = { "X-MerchantId": env.PLATEGA_MERCHANT_ID, "X-Secret": "sek" };

// 1. start: tampered URL amount ignored, redirected to Platega, state stored
let r = await start("invoice=7&ref=abc123&amount=0.01&currency=USD&email=x@y.z");
assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "https://pay.platega.io/?x");
assert.equal(await env.STATE.get(`tx:${TX}`), "7");
// repeat while pending -> reuses same payment, no second create
const creates = () => calls.filter((c) => c[1].endsWith("/transaction/process")).length;
r = await start("invoice=7&ref=abc123"); assert.equal(r.status, 302); assert.equal(creates(), 1);
console.log("ok  start (invoice amount used, URL tampering ignored, no duplicate payment)");

// 2. start refuses unreadable currency / bad id
r = await start("invoice=9&ref=z"); assert.equal(r.status, 502);
r = await start("invoice=../x"); assert.equal(r.status, 400);
console.log("ok  start fails closed");

// 3. callback auth
const body = (status) => ({ id: TX, amount: 500, currency: "RUB", status, paymentMethod: 2 });
for (const h of [{}, { "X-MerchantId": env.PLATEGA_MERCHANT_ID }, { ...good, "X-Secret": "nope" }, { ...good, "X-MerchantId": "other" }]) {
  r = await cb(h, body("CONFIRMED")); assert.equal(r.status, 401);
}
assert.equal(delivered(), 0);
console.log("ok  callback rejects bad/missing headers (401) and delivers nothing");

// 4. a forged CONFIRMED callback while Platega says PENDING must not deliver
r = await cb(good, body("CONFIRMED")); assert.equal(r.status, 200); assert.equal(delivered(), 0);
// 5. amount mismatch from Platega -> no delivery
txStatus = "CONFIRMED"; txAmount = 1;
r = await cb(good, body("CONFIRMED")); assert.equal(r.status, 200); assert.equal(delivered(), 0);
// 6. correct confirmation -> delivered exactly once, replay-safe
txAmount = 500;
r = await cb(good, body("CONFIRMED")); assert.equal(r.status, 200); assert.equal(delivered(), 1);
r = await cb(good, body("CONFIRMED")); assert.equal(r.status, 200); assert.equal(delivered(), 1);
console.log("ok  delivery only after Platega confirms status+amount; exactly once");

// 6b. USD invoice is converted to RUB at the CBR rate, rounded up, cached
const cbrCalls = () => calls.filter((c) => c[1].includes("cbr-xml-daily")).length;
r = await start("invoice=11&ref=u1&amount=0.01&currency=RUB"); // URL says 0.01 RUB: ignored
assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "https://pay.platega.io/?usd");
const rec11 = await env.STATE.get("inv:11", "json");
assert.equal(rec11.amount, "904.10"); assert.equal(rec11.currency, "RUB"); assert.equal(rec11.orig, "9.99 USD");
assert.equal(cbrCalls(), 1);
env.PLATEGA_MARKUP_PCT = "2"; kv.delete("inv:11");
await start("invoice=11&ref=u1"); assert.equal(cbrCalls(), 1, "rate served from cache");
assert.equal((await env.STATE.get("inv:11", "json")).amount, "922.18"); // 904.095*1.02 = 922.1769 -> up
delete env.PLATEGA_MARKUP_PCT;
// rate source down: no cache -> refuse; stale cache -> still works
kv.delete("rate:USD"); kv.delete("inv:11"); cbrDown = true;
r = await start("invoice=11&ref=u1"); assert.equal(r.status, 502);
cbrDown = false; await start("invoice=11&ref=u1"); // repopulates cache
kv.set("rate:USD", JSON.stringify({ rate: 90.5, ts: Date.now() - 3 * 3600 * 1000 })); kv.delete("inv:11"); cbrDown = true;
r = await start("invoice=11&ref=u1"); assert.equal(r.status, 302); cbrDown = false;
// unsupported currency without a rate -> refused, not charged at face value
r = await start("invoice=12&ref=u2"); assert.equal(r.status, 502);
// root page
r = await worker.fetch(new Request("https://w.example/"), env); assert.equal(r.status, 200);
console.log("ok  USD->RUB conversion (CBR rate, round up, markup, cache, stale fallback, fail closed) + root page");

// 7. unknown transaction acknowledged, nothing happens
r = await cb(good, { ...body("CONFIRMED"), id: "00000000-0000-0000-0000-000000000000" }); assert.equal(r.status, 200);
// 8. paid invoice -> back to SellAuth checkout
r = await start("invoice=7&ref=abc123"); assert.equal(r.headers.get("location"), "https://shop.mysellauth.com/checkout/abc123");
// 9. cron path delivers a missed callback
kv.clear(); calls.length = 0; txStatus = "PENDING";
await start("invoice=7&ref=abc123"); txStatus = "CONFIRMED";
const waits = []; await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) }); await Promise.all(waits);
assert.equal(delivered(), 1);
console.log("ok  cron delivers when callback was missed");

// 10. configuration self-check and callback hardening
const bare = { STATE: env.STATE };
let rr = await worker.fetch(new Request("https://w.example/"), bare);
assert.equal(rr.status, 503); const body0 = await rr.text();
assert.ok(body0.includes("PLATEGA_SECRET") && body0.includes("SELLAUTH_API_KEY"));
rr = await worker.fetch(new Request("https://w.example/start?invoice=7"), bare); assert.equal(rr.status, 503);
// unset secrets must NOT match missing/empty headers
for (const h of [{}, { "X-MerchantId": "", "X-Secret": "" }]) {
  rr = await worker.fetch(new Request("https://w.example/platega/callback", { method: "POST", headers: h, body: "{}" }), bare);
  assert.equal(rr.status, 401);
}
// template placeholders count as missing
const ph = { ...env, PLATEGA_SECRET: "your-platega-api-key" };
rr = await worker.fetch(new Request("https://w.example/"), ph); assert.equal(rr.status, 503);
rr = await worker.fetch(new Request("https://w.example/platega/callback"), env); assert.equal(rr.status, 200); // browser GET
rr = await worker.fetch(new Request("https://w.example/"), env); assert.equal(rr.status, 200);
console.log("ok  setup self-check, empty-secret callback bypass closed, GET callback page");
