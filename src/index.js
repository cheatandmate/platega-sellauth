/* =====================================================================
 * Platega  <->  SellAuth bridge for Cloudflare Workers
 *
 *   1. SellAuth "Redirect to URL" custom payment method sends the buyer to
 *        GET /start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}
 *      The amount/currency in that URL are buyer-editable and are NOT trusted:
 *      the Worker reads the invoice from the SellAuth API by id.
 *      If the invoice currency differs from PLATEGA_CURRENCY (default RUB), the amount
 *      is converted at the Central Bank of Russia rate (+ optional markup), rounded UP.
 *   2. Worker creates a Platega transaction (POST /transaction/process) and
 *      redirects the buyer to Platega's payment page.
 *   3. Platega calls  POST /platega/callback  (URL set in the Platega dashboard,
 *      Settings > Callback URLs). The callback carries X-MerchantId / X-Secret
 *      headers, which must match yours. The Worker then re-checks the
 *      transaction with GET /transaction/{id} before delivering.
 *   4. Delivery = SellAuth  GET /invoices/{id}/process?mark_as_paid=true
 *   5. Cron (every 5 min) re-checks pending payments in case a callback is lost.
 * ===================================================================== */

// ---- SellAuth invoice field mapping ---------------------------------
// Adjust after looking at a real invoice (see README step 3).
const INVOICE = {
  amount: (i) => i.price ?? i.total ?? i.amount ?? i.total_price,
  currency: (i) => i.currency,
  email: (i) => i.email ?? i.customer_email ?? i.customer?.email,
  status: (i) => i.status,
  doneStatuses: ["completed", "paid", "processed", "delivered"],
};
// ---------------------------------------------------------------------

const DEFAULT_PLATEGA_BASE = "https://app.platega.io";
const DEFAULT_SELLAUTH_BASE = "https://api.sellauth.com/v1";
const trimSlash = (u) => u.replace(/\/+$/, "");
const text = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const validId = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);
const money = (n) => Number(n).toFixed(2);
// Round UP to the next cent, ignoring float noise (904.1 must not become 904.11).
const ceil2 = (x) => Math.ceil(Math.round(x * 100 * 1e4) / 1e4) / 100;

/* ----------------------- Currency conversion (to RUB) ---------------------- */

const CBR_URL = "https://www.cbr-xml-daily.ru/daily_json.js";

// RUB per 1 unit of `cur`, from the Central Bank of Russia. Cached 1h in KV;
// if the CBR is unreachable a cached rate up to 24h old is used; otherwise null.
async function rubRate(env, cur) {
  if (cur === "RUB") return 1;
  const key = `rate:${cur}`;
  const cached = await env.STATE.get(key, "json");
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) return cached.rate;
  try {
    const res = await fetch(env.CBR_URL || CBR_URL, { headers: { Accept: "application/json" } });
    const v = (await res.json())?.Valute?.[cur];
    const rate = Number(v?.Value) / Number(v?.Nominal || 1);
    if (res.ok && isFinite(rate) && rate > 0) {
      await env.STATE.put(key, JSON.stringify({ rate, ts: Date.now() }), { expirationTtl: 60 * 60 * 24 });
      return rate;
    }
    console.log("CBR rate unusable for", cur, res.status);
  } catch (e) {
    console.log("CBR fetch failed", String(e));
  }
  return cached ? cached.rate : null; // stale beats nothing
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ------------------------------ Platega ----------------------------- */

async function platega(env, method, path, body) {
  const res = await fetch(trimSlash(env.PLATEGA_BASE_URL || DEFAULT_PLATEGA_BASE) + path, {
    method,
    headers: {
      "X-MerchantId": env.PLATEGA_MERCHANT_ID,
      "X-Secret": env.PLATEGA_SECRET,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not json */ }
  if (!res.ok || !json) {
    console.log("platega error", method, path, res.status, raw.slice(0, 500));
    throw new Error(`Platega ${method} ${path} failed (${res.status})`);
  }
  return json;
}

// Callback authenticity: Platega sends your MerchantId and API key as headers.
export function verifyCallback(env, request) {
  const id = request.headers.get("X-MerchantId");
  const secret = request.headers.get("X-Secret");
  // Never authorize when either side is empty (an unset secret must not match a missing header).
  if (!id || !secret || !env.PLATEGA_MERCHANT_ID || !env.PLATEGA_SECRET) return false;
  return safeEqual(id, env.PLATEGA_MERCHANT_ID) && safeEqual(secret, env.PLATEGA_SECRET);
}

/* ------------------------- Configuration self-check ------------------------ */

const REQUIRED = ["PLATEGA_MERCHANT_ID", "PLATEGA_SECRET", "SELLAUTH_API_KEY", "SELLAUTH_SHOP_ID"];
// Names only, never values. Template placeholders ("your-...") count as missing.
export function missingConfig(env) {
  const m = REQUIRED.filter((k) => !env[k] || /^your-/i.test(String(env[k]).trim()));
  if (!env.STATE) m.push("STATE (KV binding)");
  return m;
}
const shopUrlIsPlaceholder = (env) => !env.SELLAUTH_SHOP_URL || /YOURSHOP/i.test(env.SELLAUTH_SHOP_URL);

/* ----------------------------- SellAuth ----------------------------- */

async function sellauth(env, path) {
  const base = trimSlash(env.SELLAUTH_BASE_URL || DEFAULT_SELLAUTH_BASE);
  const res = await fetch(`${base}/shops/${env.SELLAUTH_SHOP_ID}${path}`, {
    headers: { Authorization: `Bearer ${env.SELLAUTH_API_KEY}`, Accept: "application/json" },
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not json */ }
  if (!res.ok) {
    console.log("sellauth error", path, res.status, raw.slice(0, 500));
    throw new Error(`SellAuth ${path} failed (${res.status})`);
  }
  return json;
}
const getInvoice = async (env, id) => {
  const j = await sellauth(env, `/invoices/${encodeURIComponent(id)}`);
  return j?.data ?? j;
};
const processInvoice = (env, id) =>
  sellauth(env, `/invoices/${encodeURIComponent(id)}/process?mark_as_paid=true`);

/* ------------------------------ Routes ------------------------------ */

// GET /start?invoice=&ref=...  ->  302 to Platega
async function handleStart(env, request) {
  const q = new URL(request.url).searchParams;
  const invoiceId = q.get("invoice");
  const ref = q.get("ref");
  if (!validId(invoiceId)) return text("Bad invoice id", 400);

  const back = validId(ref) && env.SELLAUTH_SHOP_URL
    ? `${env.SELLAUTH_SHOP_URL.replace(/\/$/, "")}/checkout/${ref}`
    : null;
  const fallback = back ?? new URL(request.url).origin;

  // Existing payment for this invoice?
  const existing = await env.STATE.get(`inv:${invoiceId}`, "json");
  if (existing?.delivered) return Response.redirect(fallback, 302);
  if (existing?.redirect) {
    try {
      const s = await platega(env, "GET", `/transaction/${existing.transactionId}`);
      if (s.status === "PENDING") return Response.redirect(existing.redirect, 302);
    } catch { /* fall through and create a new one */ }
  }

  // Amount and currency come from SellAuth, never from the URL.
  const invoice = await getInvoice(env, invoiceId);
  const amountRaw = INVOICE.amount(invoice);
  const currency = String(INVOICE.currency(invoice) ?? "").toUpperCase();
  if (amountRaw == null || isNaN(Number(amountRaw)) || !currency) {
    console.log("Could not read amount/currency from invoice. Keys:", Object.keys(invoice || {}).join(","));
    return text("Invoice could not be read.", 502);
  }
  if (INVOICE.doneStatuses.includes(String(INVOICE.status(invoice) ?? "").toLowerCase())) {
    return Response.redirect(fallback, 302);
  }
  // Charge in PLATEGA_CURRENCY (default RUB). Convert from the invoice currency if needed.
  const target = String(env.PLATEGA_CURRENCY || "RUB").toUpperCase();
  let amount = money(amountRaw);
  let rate = 1;
  if (currency !== target) {
    if (target !== "RUB") {
      console.log("Currency mismatch", currency, "expected", target);
      return text(`This payment method only supports ${target}.`, 400);
    }
    rate = await rubRate(env, currency);
    if (!rate) return text("Exchange rate unavailable, please try again later.", 502);
    const markup = 1 + Number(env.PLATEGA_MARKUP_PCT || 0) / 100;
    amount = money(ceil2(Number(amountRaw) * rate * markup));
    console.log("convert", invoiceId, `${money(amountRaw)} ${currency}`, "x", rate, "->", `${amount} ${target}`);
  }

  // Do not send `id`: Platega generates the transaction id itself.
  const tx = await platega(env, "POST", "/transaction/process", {
    paymentMethod: Number(env.PLATEGA_PAYMENT_METHOD || 2),
    paymentDetails: { amount: Number(amount), currency: target },
    description: `Order ${validId(ref) ? ref : invoiceId}`.slice(0, 200),
    return: back ?? fallback,
    failedUrl: back ?? fallback,
    payload: String(invoiceId),
  });
  if (!tx.transactionId || !tx.redirect) {
    console.log("Unexpected Platega response", JSON.stringify(tx).slice(0, 500));
    return text("Could not start payment.", 502);
  }

  const ttl = { expirationTtl: 60 * 60 * 24 * 30 };
  await env.STATE.put(
    `inv:${invoiceId}`,
    JSON.stringify({ transactionId: tx.transactionId, redirect: tx.redirect, amount, currency: target, orig: `${money(amountRaw)} ${currency}`, rate, status: tx.status, delivered: false, created: Date.now() }),
    ttl
  );
  await env.STATE.put(`tx:${tx.transactionId}`, String(invoiceId), ttl);
  await env.STATE.put(`pending:${invoiceId}`, "1", { expirationTtl: 60 * 60 * 6 });
  return Response.redirect(tx.redirect, 302);
}

// Confirms with Platega, then delivers via SellAuth. Idempotent.
async function settle(env, invoiceId) {
  const rec = await env.STATE.get(`inv:${invoiceId}`, "json");
  if (!rec) return { ok: false, reason: "unknown invoice" };
  if (rec.delivered) return { ok: true, reason: "already delivered" };

  const s = await platega(env, "GET", `/transaction/${rec.transactionId}`);
  rec.status = s.status;

  if (s.status === "CONFIRMED") {
    const pd = s.paymentDetails ?? {};
    if (money(pd.amount) !== rec.amount || String(pd.currency ?? "").toUpperCase() !== rec.currency) {
      console.log("MISMATCH", invoiceId, JSON.stringify(pd), rec.amount, rec.currency);
      await env.STATE.put(`inv:${invoiceId}`, JSON.stringify(rec));
      return { ok: false, reason: "mismatch" };
    }
    await processInvoice(env, invoiceId); // throws on failure -> not marked delivered
    rec.delivered = true;
    await env.STATE.delete(`pending:${invoiceId}`);
  } else if (s.status === "CANCELED" || s.status === "CHARGEBACKED") {
    await env.STATE.delete(`pending:${invoiceId}`);
  }
  await env.STATE.put(`inv:${invoiceId}`, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 30 });
  return { ok: true, reason: s.status };
}

// POST /platega/callback
async function handleCallback(env, request) {
  if (!verifyCallback(env, request)) return text("Unauthorized", 401);
  let body;
  try { body = await request.json(); } catch { return text("OK", 200); }
  const txId = body?.id;
  if (typeof txId !== "string") return text("OK", 200);
  const invoiceId = await env.STATE.get(`tx:${txId}`);
  if (!invoiceId) return text("OK", 200); // not ours / unknown: acknowledge so it is not retried
  try {
    const r = await settle(env, invoiceId);
    console.log("callback", invoiceId, body.status, JSON.stringify(r));
  } catch (e) {
    console.log("settle failed", invoiceId, String(e));
    return text("Error", 500); // Platega retries up to 3 times, 5 min apart; cron also retries
  }
  return text("OK", 200);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/") {
      const missing = missingConfig(env);
      if (missing.length) return text(`Platega x SellAuth bridge: setup incomplete.\nMissing: ${missing.join(", ")}\nAdd them in Cloudflare > Worker > Settings > Variables and Secrets (type: Secret).`, 503);
      if (shopUrlIsPlaceholder(env)) return text("Platega x SellAuth bridge: running, but SELLAUTH_SHOP_URL is not set (edit wrangler.toml).");
      return text("Platega x SellAuth bridge is running.");
    }
    if (request.method === "GET" && pathname === "/platega/callback") {
      return text("Platega callback endpoint. Platega sends POST requests here; nothing to see in a browser.");
    }
    if (request.method === "GET" && pathname === "/start") {
      const missing = missingConfig(env);
      if (missing.length) { console.log("Not configured. Missing:", missing.join(", ")); return text("Service is not configured yet.", 503); }
      try { return await handleStart(env, request); }
      catch (e) { console.log("start failed", String(e)); return text("Could not start payment.", 502); }
    }
    if (request.method === "POST" && pathname === "/platega/callback") return handleCallback(env, request);
    return text("Not found", 404);
  },

  async scheduled(_event, env, ctx) {
    if (missingConfig(env).length) return;
    const list = await env.STATE.list({ prefix: "pending:", limit: 50 });
    for (const k of list.keys) {
      ctx.waitUntil(settle(env, k.name.slice("pending:".length)).catch((e) => console.log("cron settle failed", k.name, String(e))));
    }
  },
};
