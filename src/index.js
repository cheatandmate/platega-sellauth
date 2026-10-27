import { sha3_512 } from "@noble/hashes/sha3";

/* =====================================================================
 * PayCek  <->  SellAuth bridge for Cloudflare Workers
 *
 * Flow
 *   1. SellAuth "Redirect to URL" custom payment method sends the buyer to
 *        GET /start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}
 *      Worker reads the invoice from SellAuth by id (the amount in the URL is
 *      buyer-editable and is NOT trusted), opens a PayCek payment, redirects.
 *   2. PayCek calls          GET /paycek/status/<invoiceId>?status=...
 *      Worker verifies the MAC header (401 if invalid), re-checks the
 *      payment with payment/get, then tells SellAuth to process the invoice.
 *   3. Cron (every 5 min) re-checks payments that are still pending, in case
 *      a callback was missed.
 * ===================================================================== */

// ---- SellAuth invoice field mapping ---------------------------------
// ASSUMPTION: field names below are guesses. Run the curl in the README,
// look at the real invoice JSON, and adjust these if needed.
const INVOICE = {
  amount: (i) => i.price ?? i.total ?? i.amount ?? i.total_price,
  email: (i) => i.email ?? i.customer_email ?? i.customer?.email,
  currency: (i) => i.currency,
  status: (i) => i.status,
  doneStatuses: ["completed", "paid", "processed", "delivered"],
};
// ---------------------------------------------------------------------

const enc = new TextEncoder();
// Overridable with the PAYCEK_BASE_URL / SELLAUTH_BASE_URL vars (see wrangler.toml).
const DEFAULT_PAYCEK_BASE = "https://paycek.io/processing/api";
const DEFAULT_SELLAUTH_BASE = "https://api.sellauth.com/v1";
const trimSlash = (u) => u.replace(/\/+$/, "");

/* ------------------------------ PayCek ------------------------------ */

// SHA3-512 over \0-delimited fields, secret included (not an HMAC).
// Mirrors #generateMacHash in the official `paycek` npm package.
export function generateMac(env, nonce, endpoint, bodyBytes, method = "POST", contentType = "application/json") {
  const Z = new Uint8Array([0]);
  const parts = [
    Z, enc.encode(env.PAYCEK_API_KEY),
    Z, enc.encode(env.PAYCEK_API_SECRET),
    Z, enc.encode(nonce),
    Z, enc.encode(method),
    Z, enc.encode(endpoint),
    Z, enc.encode(contentType),
    Z, bodyBytes,
    Z,
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.length; }
  return [...sha3_512(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Verifies the ApiKeyAuth-* headers on a PayCek callback (GET, empty body,
// empty content type). PayCek's docs don't say whether the signed endpoint
// includes the query string, so both forms are accepted; each one still has
// to match a hash that includes your secret.
export function verifyCallback(env, request) {
  const nonce = request.headers.get("ApiKeyAuth-Nonce");
  const mac = request.headers.get("ApiKeyAuth-MAC");
  if (!nonce || !mac) return false;
  const url = new URL(request.url);
  const candidates = [url.pathname, url.pathname + url.search];
  return candidates.some((ep) =>
    timingSafeEqualStr(generateMac(env, nonce, ep, new Uint8Array(0), "GET", ""), mac.toLowerCase())
  );
}

async function paycekCall(env, endpoint, body) {
  const base = new URL(trimSlash(env.PAYCEK_BASE_URL || DEFAULT_PAYCEK_BASE));
  const path = `${trimSlash(base.pathname)}/${endpoint}`; // this exact path is what gets signed
  const bodyStr = JSON.stringify(body);
  const nonce = Date.now().toString();
  const mac = generateMac(env, nonce, path, enc.encode(bodyStr));
  const res = await fetch(base.origin + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ApiKeyAuth-Key": env.PAYCEK_API_KEY,
      "ApiKeyAuth-Nonce": nonce,
      "ApiKeyAuth-MAC": mac,
    },
    body: bodyStr,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.status !== "ok") {
    console.log("paycek error", endpoint, res.status, JSON.stringify(json));
    throw new Error(`PayCek ${endpoint} failed (${res.status})`);
  }
  return json.data;
}

/* ----------------------------- SellAuth ----------------------------- */

async function sellauth(env, method, path) {
  const res = await fetch(`${trimSlash(env.SELLAUTH_BASE_URL || DEFAULT_SELLAUTH_BASE)}/shops/${env.SELLAUTH_SHOP_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.SELLAUTH_API_KEY}`, Accept: "application/json" },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    console.log("sellauth error", method, path, res.status, text.slice(0, 500));
    throw new Error(`SellAuth ${method} ${path} failed (${res.status})`);
  }
  return json;
}

const getInvoice = async (env, id) => {
  const j = await sellauth(env, "GET", `/invoices/${encodeURIComponent(id)}`);
  return j?.data ?? j;
};
const processInvoice = (env, id) => sellauth(env, "GET", `/invoices/${encodeURIComponent(id)}/process?mark_as_paid=true`);

/* ------------------------------ Routes ------------------------------ */

const text = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const validId = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);

// GET /start?invoice=&ref=&currency=...  ->  302 to PayCek checkout
async function handleStart(env, request) {
  const q = new URL(request.url).searchParams;
  const invoiceId = q.get("invoice");
  const ref = q.get("ref");
  if (!validId(invoiceId)) return text("Bad invoice id", 400);
  const origin = new URL(request.url).origin;

  // Where the buyer lands afterwards: their SellAuth checkout page.
  const back = validId(ref) && env.SELLAUTH_SHOP_URL
    ? `${env.SELLAUTH_SHOP_URL.replace(/\/$/, "")}/checkout/${ref}`
    : `${origin}/done/${invoiceId}`;

  // Re-use an existing open payment for this invoice.
  const existing = await env.STATE.get(`inv:${invoiceId}`, "json");
  if (existing?.delivered) return Response.redirect(back, 302);
  if (existing?.payment_url && existing.status !== "expired" && existing.status !== "canceled") {
    return Response.redirect(existing.payment_url, 302);
  }

  // The amount comes from SellAuth, not from the URL.
  const invoice = await getInvoice(env, invoiceId);
  const amountRaw = INVOICE.amount(invoice);
  if (amountRaw == null || isNaN(Number(amountRaw))) {
    console.log("Could not read amount from invoice. Keys:", Object.keys(invoice || {}).join(","));
    return text("Invoice could not be read.", 502);
  }
  if (INVOICE.doneStatuses.includes(String(INVOICE.status(invoice) ?? "").toLowerCase())) {
    return Response.redirect(back, 302);
  }
  // PayCek charges in your profile currency; refuse a mismatch rather than mischarge.
  const want = (env.PAYCEK_CURRENCY || "EUR").toUpperCase();
  const have = String(INVOICE.currency(invoice) ?? q.get("currency") ?? "").toUpperCase();
  if (have !== want) {
    console.log("Currency mismatch", have, "expected", want);
    return text(`This payment method only supports ${want}.`, 400);
  }
  const amount = Number(amountRaw).toFixed(2);

  const body = {
    profile_code: env.PAYCEK_PROFILE_CODE,
    dst_amount: amount,
    payment_id: String(invoiceId),
    description: `Order ${validId(ref) ? ref : invoiceId}`.slice(0, 100),
    status_url_callback: `${origin}/paycek/status/${invoiceId}`,
    success_url: back,
    fail_url: back,
    back_url: back,
    language: "en",
  };
  const email = INVOICE.email(invoice) ?? q.get("email");
  if (email) body.email = email;
  if (env.PAYCEK_LOCATION_ID) body.location_id = env.PAYCEK_LOCATION_ID;

  const data = await paycekCall(env, "payment/open", body);
  await env.STATE.put(
    `inv:${invoiceId}`,
    JSON.stringify({
      payment_code: data.payment_code,
      payment_url: data.payment_url,
      amount,
      status: data.payment_status,
      delivered: false,
      created: Date.now(),
    }),
    { expirationTtl: 60 * 60 * 24 * 30 }
  );
  await env.STATE.put(`pending:${invoiceId}`, "1", { expirationTtl: 60 * 60 * 6 });
  return Response.redirect(data.payment_url, 302);
}

// Confirms with PayCek, then delivers via SellAuth. Idempotent.
async function settle(env, invoiceId) {
  const rec = await env.STATE.get(`inv:${invoiceId}`, "json");
  if (!rec) return { ok: false, reason: "unknown invoice" };
  if (rec.delivered) return { ok: true, reason: "already delivered" };

  const p = await paycekCall(env, "payment/get", { payment_code: rec.payment_code });
  rec.status = p.payment_status;

  if (p.payment_status === "successful") {
    if (String(p.payment_id) !== String(invoiceId) || Number(p.dst_amount) !== Number(rec.amount)) {
      console.log("MISMATCH", invoiceId, p.payment_id, p.dst_amount, rec.amount);
      await env.STATE.put(`inv:${invoiceId}`, JSON.stringify(rec));
      return { ok: false, reason: "mismatch" };
    }
    await processInvoice(env, invoiceId); // throws on failure -> not marked delivered
    rec.delivered = true;
    await env.STATE.delete(`pending:${invoiceId}`);
  } else if (["expired", "canceled"].includes(p.payment_status)) {
    await env.STATE.delete(`pending:${invoiceId}`);
  }
  await env.STATE.put(`inv:${invoiceId}`, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 30 });
  return { ok: true, reason: p.payment_status };
}

// GET /paycek/status/<invoiceId>?status=...
async function handleCallback(env, request, invoiceId) {
  // Auth first, always. PayCek's integration test sends an invalid header and
  // expects exactly 401, otherwise it cancels payments and blocks the profile.
  if (!verifyCallback(env, request)) return text("Unauthorized", 401);
  if (!validId(invoiceId)) return text("OK", 200);
  try {
    const r = await settle(env, invoiceId);
    console.log("callback", invoiceId, new URL(request.url).searchParams.get("status"), JSON.stringify(r));
  } catch (e) {
    console.log("settle failed", invoiceId, String(e));
    return text("Error", 500); // authorized but failed: cron will retry
  }
  return text("OK", 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [, a, id] = url.pathname.split("/");

    if (request.method === "GET" && a === "start") {
      try { return await handleStart(env, request); }
      catch (e) { console.log("start failed", String(e)); return text("Could not start payment.", 502); }
    }
    if (request.method === "GET" && a === "paycek" && id === "status") {
      return handleCallback(env, request, url.pathname.split("/")[3]);
    }
    if (request.method === "GET" && (a === "done" || a === "failed")) {
      // Display only. Never trust these pages to mark anything paid.
      return text(a === "done"
        ? "Thanks! Your payment is being confirmed. Your order is delivered automatically once the transaction is confirmed."
        : "The payment was not completed. You can go back to the shop and try again.");
    }
    return text("Not found", 404);
  },

  // Safety net for missed callbacks.
  async scheduled(_event, env, ctx) {
    const list = await env.STATE.list({ prefix: "pending:", limit: 50 });
    for (const k of list.keys) {
      ctx.waitUntil(settle(env, k.name.slice("pending:".length)).catch((e) => console.log("cron settle failed", k.name, String(e))));
    }
  },
};
