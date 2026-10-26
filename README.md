# Platega x SellAuth on Cloudflare Workers

Uses SellAuth's **Custom Payment Method > Redirect to URL** and `invoices/{id}/process?mark_as_paid=true`,
and Platega's `POST /transaction/process`, `GET /transaction/{id}` and the status callback.

## 0. One-click deploy
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_USER/YOUR_REPO)
Replace `YOUR_USER/YOUR_REPO` (repo must be public). Fill in the form, deploy, then do steps 2-4.

Manual alternative: `npm install`, `npx wrangler deploy`, then `npx wrangler secret put` for
`PLATEGA_MERCHANT_ID`, `PLATEGA_SECRET`, `SELLAUTH_API_KEY`, `SELLAUTH_SHOP_ID`.

## 1. Settings (`wrangler.toml` > `[vars]`)
| Var | Meaning |
|---|---|
| `PLATEGA_PAYMENT_METHOD` | 2 SBP QR, 3 ERIP, 11 card acquiring, 12 international, 13 crypto, 14 Sberpay. Must be enabled on your Platega account |
| `PLATEGA_CURRENCY` | Currency the buyer is charged in (default `RUB`). Invoices in other currencies (USD, EUR...) are converted to RUB at the Central Bank of Russia rate and rounded up to the next kopeck |
| `PLATEGA_MARKUP_PCT` | Safety margin added to converted amounts, e.g. `2` = +2% (default `0`) |
| `SELLAUTH_SHOP_URL` | Buyers return to `<this>/checkout/<ref>` |
| `PLATEGA_BASE_URL`, `SELLAUTH_BASE_URL` | API bases (defaults are correct) |

Conversion: rate source is `cbr-xml-daily.ru` (CBR), cached 1 h; if it is down a rate up to 24 h old is used,
otherwise the payment is refused (never charged at face value). `GET /` shows a "running" page.

## 2. Platega dashboard
**Settings > Callback URLs**: `https://<your-worker>.workers.dev/platega/callback`
(one URL for all events; Platega sends your MerchantId / API key as headers, the Worker checks them).

## 3. SellAuth payment method
Payment Methods > add **Redirect to URL** (plan must include custom payment methods):
```
https://<your-worker>.workers.dev/start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}
```

## 4. Check the invoice shape (once)
The price and currency are read from the SellAuth API, NOT the URL (buyers can edit the URL).
Field names in `INVOICE` (top of `src/index.js`) are assumptions:
```bash
curl -s -H "Authorization: Bearer $SELLAUTH_API_KEY" \
  https://api.sellauth.com/v1/shops/$SHOP_ID/invoices/$INVOICE_ID | jq
```
If something can't be read the Worker refuses to start a payment and `npx wrangler tail` prints the keys it saw.

## Test checklist
1. Cheap order > choose the method > you land on Platega's payment page.
2. `curl -i -X POST https://<worker>/platega/callback` must return **401**.
3. After paying, the invoice is delivered once; a Platega callback retry doesn't re-deliver.
Note: a CHARGEBACKED status is only logged; it cannot undo a delivery.
