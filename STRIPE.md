# Stripe integration

Northvale Financial uses Stripe for **Payments** (card deposits through Stripe
Checkout) and **Stripe Tax** (automatic sales tax at checkout). Both are
env-gated: with no key the app refuses to start a payment and says so, so the
ledger can never be credited from a client-side claim.

## 1. Environment variables

Add these in **Settings → Environment variables**, then redeploy.

| Variable | Required | Purpose |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | yes | Server-side API key (`sk_test_…` or `sk_live_…`). Never exposed to the browser. |
| `STRIPE_WEBHOOK_SECRET` | yes | Signing secret of the webhook endpoint (`whsec_…`). Without it every delivery is rejected. |
| `STRIPE_PUBLISHABLE_KEY` | optional | Only needed if you later add Stripe.js/Elements directly. Checkout is hosted by Stripe. |
| `STRIPE_TAX_ENABLED` | optional | Defaults to on. Set to `false` to disable automatic tax. |
| `STRIPE_TAX_CODE` | optional | Product tax code for the deposit line item. Default `txcd_10000000` (general services). |
| `STRIPE_CARD_FEE_PERCENT` | optional | Passes a card fee to the payer as its own line item, e.g. `2.9`. Default off. |

## 2. Webhook endpoint

Create the endpoint in the Stripe dashboard (Developers → Webhooks) pointing at:

```
https://<your-app-url>/api/webhooks/stripe
```

Subscribe to exactly these events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `payment_intent.payment_failed`
- `charge.refunded`
- `charge.dispute.created`

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`. The route is registered
before `express.json()` so the raw body is available for signature verification.

Local development:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
stripe trigger checkout.session.completed
```

## 3. Stripe Tax

1. Turn on Tax in the Stripe dashboard and complete your origin address.
2. Add at least one **registration** (Tax → Registrations). Without one Stripe
   calculates no tax and the app shows a warning in the admin console.
3. Deposits are created with `automatic_tax.enabled`, `tax_id_collection.enabled`
   and `billing_address_collection: 'required'`, so tax is calculated from the
   payer's billing address and business tax IDs are captured when supplied.

The **Admin → Stripe & tax** tab shows the gateway mode, webhook configuration,
active registrations, tax and fees collected on settled deposits, card deposits
by status, and the most recent webhook deliveries.

## 4. How money is credited

1. The customer starts a deposit → a `pending` transaction is written with a
   unique reference, then a Checkout Session is created with an idempotency key
   (`northvale-checkout-<transactionId>`).
2. Stripe hosts the payment page and returns the customer to `/#/deposit?session_id=…`.
3. **Crediting happens only from a signature-verified webhook** (or the return
   page, which re-reads the session from Stripe's API). The amount credited is
   the deposit principal: `amount_total − tax − our fee line`.
4. Every event ID is stored in `stripe_events`, so redeliveries are idempotent.
5. A payment whose principal, currency or reference does not match the pending
   deposit is moved to `review`, nothing is credited, and a high-severity fraud
   alert is raised for staff.
6. Refunds and disputes are recorded against the transaction with a fraud alert;
   an operator reconciles the ledger before any balance adjustment, because the
   funds may already have moved.

## 5. Testing

```bash
npm test          # includes tests/stripe.test.js
```

The Stripe tests sign payloads locally with the webhook secret and never call
the Stripe API, so they run offline. Test cards in test mode:

| Card | Result |
| --- | --- |
| `4242 4242 4242 4242` | succeeds |
| `4000 0000 0000 9995` | declined (insufficient funds) |
| `4000 0027 6000 3184` | requires authentication (3DS) |

## 6. Go-live checklist

- [ ] Swap `sk_test_…` for `sk_live_…` and create a **live-mode** webhook endpoint.
- [ ] Register your tax obligations before enabling automatic tax in live mode.
- [ ] Confirm the disclosure text ("not a bank") stays visible on the deposit page.
- [ ] Decide who watches the `review` queue and the fraud alerts daily.
- [ ] Keep the webhook secret out of Git — it belongs in environment variables only.
