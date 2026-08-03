// ===== OFFERS RELIABILITY: WEBHOOKS + CLEANUP =====
//
// Implements GPT's four reliability priorities:
//   1. Stripe checkout.session.completed webhook (authoritative activation)
//   2. Shopify orders/paid webhook (void offers when the tape sells)
//   3. shopify_customer_id stored on offers
//   4. pending_card cleanup after 24h
//
// NOTE: express.json() is mounted globally, so it consumes the request stream
// before any route runs. Both webhooks need the EXACT original bytes to verify
// their signatures. The patch adds a `verify` callback that stashes the raw
// buffer on req.rawBody - that's why signature checks below use req.rawBody
// rather than re-serializing req.body (JSON.stringify would reorder keys and
// change whitespace, breaking every signature).

// Adds shopify_customer_id / void_reason to offers if they aren't there yet.
// Safe to call repeatedly - checks the schema first.
function ensureOfferColumns(database) {
  const info = database.exec('PRAGMA table_info(offers)');
  if (!info.length) return;
  const columns = info[0].values.map((row) => row[1]);

  if (!columns.includes('shopify_customer_id')) {
    database.run('ALTER TABLE offers ADD COLUMN shopify_customer_id TEXT');
    console.log('[offers] added shopify_customer_id column');
  }
  if (!columns.includes('void_reason')) {
    database.run('ALTER TABLE offers ADD COLUMN void_reason TEXT');
    console.log('[offers] added void_reason column');
  }
}

// --- Priority 4: expire abandoned card setups -------------------------------
function expirePendingCardOffers(database) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  database.run(
    "UPDATE offers SET status = 'expired', void_reason = 'card_setup_abandoned', updated_at = ? " +
      "WHERE status = 'pending_card' AND created_at < ?",
    [new Date().toISOString(), cutoff]
  );
}

// --- Priority 1: Stripe webhook, authoritative activation -------------------
app.post('/stripe-webhook', async (req, res) => {
  const signature = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set');
    return res.status(500).send('Webhook not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, signature, secret);
  } catch (e) {
    console.error('[stripe-webhook] signature verification failed:', e.message);
    return res.status(400).send('Invalid signature');
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const offerId = session.metadata && session.metadata.offer_id;

      if (offerId) {
        const database = await getDb();
        ensureOfferColumns(database);
        // Only promotes pending_card. If the redirect fallback already
        // activated it, this is a harmless no-op.
        database.run(
          "UPDATE offers SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'pending_card'",
          [new Date().toISOString(), offerId]
        );
        saveDb();
        console.log('[stripe-webhook] activated offer', offerId);
      }
    }
  } catch (e) {
    console.error('[stripe-webhook] handler error:', e.message);
    // Fall through to 200 - Stripe retries on non-2xx, and a retry won't fix
    // a logic error here. The failure is logged for manual follow-up.
  }

  res.json({ received: true });
});

// --- Priority 2: Shopify orders/paid webhook, void sold items ---------------
app.post('/shopify-order-webhook', async (req, res) => {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || SHOPIFY_CLIENT_SECRET;

  if (!secret) {
    console.error('[order-webhook] no webhook secret configured');
    return res.status(500).send('Webhook not configured');
  }

  const digest = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('base64');

  // Constant-time compare - a plain === leaks timing information.
  const valid =
    hmacHeader &&
    digest.length === hmacHeader.length &&
    crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));

  if (!valid) {
    console.error('[order-webhook] HMAC verification failed');
    return res.status(401).send('Invalid signature');
  }

  // Respond immediately - Shopify times out at 5s and retries.
  res.json({ received: true });

  try {
    const order = req.body;
    const soldVariantIds = (order.line_items || [])
      .map((li) => String(li.variant_id))
      .filter(Boolean);

    if (!soldVariantIds.length) return;

    const database = await getDb();
    ensureOfferColumns(database);

    // items is a JSON array in a single column, so parse in JS rather than
    // pattern-matching the raw text - a LIKE would false-positive on
    // substrings of longer variant IDs.
    const result = database.exec(
      "SELECT id, items FROM offers WHERE status = 'pending'"
    );
    const rows = result.length ? result[0].values : [];

    const now = new Date().toISOString();
    let voided = 0;

    for (const [offerId, itemsJson] of rows) {
      let items;
      try {
        items = JSON.parse(itemsJson);
      } catch (e) {
        continue;
      }
      const hit = (items || []).some((item) =>
        soldVariantIds.includes(String(item.variant_id))
      );
      if (!hit) continue;

      database.run(
        "UPDATE offers SET status = 'voided', void_reason = 'sold_elsewhere', updated_at = ? WHERE id = ?",
        [now, offerId]
      );
      voided += 1;
      console.log('[order-webhook] voided offer', offerId, '- item sold');
    }

    if (voided) saveDb();
  } catch (e) {
    console.error('[order-webhook] handler error:', e.message);
  }
});
// ===== END OFFERS RELIABILITY =====
