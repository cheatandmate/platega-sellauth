# PayCek x SellAuth on Cloudflare Workers

Uses SellAuth's **Custom Payment Method > Redirect to URL** and `invoices/{id}/process?mark_as_paid=true`.

## 0. One-click deploy
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_USER/YOUR_REPO)
Replace `YOUR_USER/YOUR_REPO` with this repo's path (repo must be **public**). Cloudflare shows a form for every
key below and creates the KV namespace for you. Then skip to step 2.

## 1. Deploy manually (alternative)
```bash
npm install
npx wrangler deploy --dry-run >/dev/null        # KV namespace STATE is auto-created on first deploy
# edit SELLAUTH_SHOP_URL in wrangler.toml
npx wrangler secret put PAYCEK_API_KEY        # PayCek > account settings
npx wrangler secret put PAYCEK_API_SECRET
npx wrangler secret put PAYCEK_PROFILE_CODE   # PayCek > profile settings (id). Use a TEST profile first.
npx wrangler secret put SELLAUTH_API_KEY      # SellAuth > Account > Developers (scope to this shop)
npx wrangler secret put SELLAUTH_SHOP_ID
npm test && npx wrangler deploy
```

## 2. Add the payment method in SellAuth
Dashboard > Payment Methods > add **Redirect to URL** (needs a plan with custom payment methods), Redirect URL:
```
https://<your-worker>.workers.dev/start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}
```

## 3. Check the invoice shape (once)
The Worker reads the price from the SellAuth API, NOT from the URL, because the buyer can edit
`amount=` in the URL. The field names in `INVOICE` (top of `src/index.js`) are assumptions:
```bash
curl -s -H "Authorization: Bearer $SELLAUTH_API_KEY" \
  https://api.sellauth.com/v1/shops/$SHOP_ID/invoices/$INVOICE_ID | jq
```
If the amount can't be read the Worker refuses to start a payment; `npx wrangler tail` prints the keys it saw.

## Base URLs (settings in `wrangler.toml`)
| Var | Default |
|---|---|
| `PAYCEK_BASE_URL` | `https://paycek.io/processing/api` |
| `SELLAUTH_BASE_URL` | `https://api.sellauth.com/v1` |

Your own Worker address is `https://<worker-name>.<your-subdomain>.workers.dev` (enable **workers.dev** under the Worker's
Settings > Domains & Routes).

## Routes
| Route | Purpose |
|---|---|
| `GET /start?invoice=&ref=&...` | From SellAuth. Opens a PayCek payment, redirects the buyer |
| `GET /paycek/status/<invoiceId>` | PayCek status callback. MAC-verified, 401 if invalid |

## Test checklist (PayCek test profile)
1. Place a cheap order, choose the PayCek method, confirm you land on PayCek checkout.
2. `curl -i https://<worker>/paycek/status/1` must return **401** (PayCek tests this on every payment).
3. After paying, the invoice should show completed/Manually Completed and the items delivered, once.
