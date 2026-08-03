// ===== STOREFRONT OFFERS =====
//
// Shopify storefront entry point into the existing offers lifecycle.
//
// Mounted at /storefront-offers, NOT /offers - the App Proxy strips
// /apps/einstein before matching, so /offers would collide with the app's
// own route.
//
// WHY NO 'pending_card' STATUS:
// The offers table has CHECK(status IN ('pending','accepted','countered',
// 'declined')). SQLite can't alter a CHECK constraint without rebuilding the
// table, and that table holds live offers. So instead of inventing a status,
// the offer simply isn't created until the card is saved: offer details ride
// along in the Stripe Checkout Session's metadata, and the row is written
// when Stripe confirms the setup completed. Same end state as the app -
// an offer row exists only once it has a card, with status 'pending'.
//
// Voided offers use status 'declined' with void_reason explaining why.

async function getShopifyCustomerForOffer(customerId) {
  const token = await getShopifyAccessToken();
  const query = `
    query($id: ID!) {
      customer(id: $id) { email firstName lastName }
    }
  `;
  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2026-07/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({
        query,
        variables: { id: 'gid://shopify/Customer/' + String(customerId) },
      }),
    }
  );
  const data = await response.json();
  if (data.errors) {
    console.error('Storefront offer - customer lookup failed:', data.errors);
    throw new Error('Could not verify your account.');
  }
  return data.data ? data.data.customer : null;
}

async function getVariantForOffer(variantId) {
  const token = await getShopifyAccessToken();
  const query = `
    query($id: ID!) {
      productVariant(id: $id) {
        id price availableForSale title
        product { id title }
      }
    }
  `;
  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2026-07/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({
        query,
        variables: { id: 'gid://shopify/ProductVariant/' + String(variantId) },
      }),
    }
  );
  const data = await response.json();
  if (data.errors) {
    console.error('Storefront offer - variant lookup failed:', data.errors);
    throw new Error('Could not look up this tape.');
  }
  return data.data ? data.data.productVariant : null;
}

// Adds the columns the storefront flow needs. Idempotent.
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
  if (!columns.includes('price_match_link')) {
    database.run('ALTER TABLE offers ADD COLUMN price_match_link TEXT');
    console.log('[offers] added price_match_link column');
  }
}

app.post('/storefront-offers', requireShopifyCustomer, async (req, res) => {
  try {
    const { variant_id, amount_cents, message, open_to_counter, price_match_link } = req.body;

    if (!variant_id || !amount_cents) {
      return res.status(400).json({ error: 'Missing offer details.' });
    }

    const offerCents = parseInt(amount_cents, 10);
    if (!Number.isFinite(offerCents) || offerCents <= 0) {
      return res.status(400).json({ error: 'Enter a valid offer amount.' });
    }

    const customer = await getShopifyCustomerForOffer(req.shopifyCustomerId);
    if (!customer || !customer.email) {
      return res.status(400).json({ error: 'Could not verify your account.' });
    }

    const variant = await getVariantForOffer(variant_id);
    if (!variant || !variant.availableForSale) {
      return res.status(400).json({ error: 'This tape is no longer available.' });
    }

    const listCents = Math.round(parseFloat(variant.price) * 100);
    if (offerCents >= listCents) {
      return res
        .status(400)
        .json({ error: 'Your offer must be less than the listed price.' });
    }

    const buyerName =
      [customer.firstName, customer.lastName].filter(Boolean).join(' ') ||
      customer.email;

    // One Stripe customer per email, shared with the app's offers.
    const existing = await stripe.customers.list({ email: customer.email, limit: 1 });
    const stripeCustomer =
      existing.data[0] ??
      (await stripe.customers.create({ email: customer.email, name: buyerName }));

    // Offer details ride in metadata. Stripe caps values at 500 chars, so
    // anything free-text gets trimmed.
    const metadata = {
      source: 'storefront',
      shopify_customer_id: String(req.shopifyCustomerId),
      buyer_name: buyerName.slice(0, 200),
      buyer_email: customer.email.slice(0, 200),
      variant_id: String(variant_id),
      product_id: variant.product ? String(variant.product.id).replace(/^.*\//, '') : '',
      product_title: (variant.product ? variant.product.title : variant.title || '').slice(0, 400),
      list_price: (listCents / 100).toFixed(2),
      offer_price: (offerCents / 100).toFixed(2),
      open_to_counter: open_to_counter === false ? '0' : '1',
      price_match_link: String(price_match_link || '').slice(0, 400),
      offer_message: String(message || '').slice(0, 400),
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: stripeCustomer.id,
      success_url:
        'https://3rdfloortapes.com/pages/offer-card-saved?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://3rdfloortapes.com/pages/offer-card-setup-cancelled',
      metadata,
    });

    res.json({ checkout_url: session.url });
  } catch (e) {
    console.error('Storefront offer error:', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Creates the offer row from a completed Stripe setup session.
// Idempotent - the offer id is derived from the session id, so a webhook and
// a redirect arriving together produce one row, not two.
async function createOfferFromSession(session) {
  const m = session.metadata || {};
  if (m.source !== 'storefront') return null;

  const offerId = 'offer_' + session.id;
  const database = await getDb();
  ensureOfferColumns(database);

  const existing = database.exec('SELECT id FROM offers WHERE id = ?', [offerId]);
  if (existing.length && existing[0].values.length) {
    return offerId; // already created
  }

  const items = [
    {
      product_title: m.product_title || '',
      product_id: m.product_id || null,
      variant_id: m.variant_id || null,
      list_price: m.list_price || null,
      offer_price: m.offer_price || null,
    },
  ];

  const now = new Date().toISOString();
  database.run(
    `INSERT INTO offers (id, buyer_name, buyer_email, message, open_to_counter, items, status, stripe_customer_id, shopify_customer_id, price_match_link, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [
      offerId,
      m.buyer_name || '',
      m.buyer_email || '',
      m.offer_message || null,
      m.open_to_counter === '0' ? 0 : 1,
      JSON.stringify(items),
      session.customer || null,
      m.shopify_customer_id || null,
      m.price_match_link || null,
      now,
      now,
    ]
  );
  saveDb();
  console.log('[storefront-offers] created offer', offerId);
  return offerId;
}

// Fallback path: the Offer Card Saved page calls this on return from Stripe,
// so the offer appears immediately rather than waiting on the webhook.
app.post('/storefront-offers/activate', async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: 'Missing session.' });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (!session || session.status !== 'complete') {
      return res.status(400).json({ error: 'Card setup was not completed.' });
    }

    const offerId = await createOfferFromSession(session);
    res.json({ status: offerId ? 'created' : 'ignored' });
  } catch (e) {
    console.error('Storefront offer activation error:', e.message);
    res.status(500).json({ error: 'Could not finalize the offer.' });
  }
});

// --- Stripe webhook: authoritative offer creation ---------------------------
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
      await createOfferFromSession(event.data.object);
    }
  } catch (e) {
    console.error('[stripe-webhook] handler error:', e.message);
  }

  res.json({ received: true });
});

// --- Shopify orders/paid webhook: void offers on sold items -----------------
app.post('/shopify-order-webhook', async (req, res) => {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || SHOPIFY_CLIENT_SECRET;
  if (!secret) {
    console.error('[order-webhook] no webhook secret configured');
    return res.status(500).send('Webhook not configured');
  }

  const digest = crypto.createHmac('sha256', secret).update(req.rawBody).digest('base64');
  const valid =
    hmacHeader &&
    digest.length === hmacHeader.length &&
    crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));

  if (!valid) {
    console.error('[order-webhook] HMAC verification failed');
    return res.status(401).send('Invalid signature');
  }

  // Answer fast - Shopify times out at 5s and retries.
  res.json({ received: true });

  try {
    const order = req.body;
    const soldVariantIds = (order.line_items || [])
      .map((li) => String(li.variant_id))
      .filter(Boolean);
    if (!soldVariantIds.length) return;

    const database = await getDb();
    ensureOfferColumns(database);

    // items is JSON in one column - parse rather than LIKE, which would
    // false-positive on substrings of longer variant ids.
    const result = database.exec("SELECT id, items FROM offers WHERE status = 'pending'");
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

      // 'declined' is the closest allowed status; void_reason carries the why.
      database.run(
        "UPDATE offers SET status = 'declined', void_reason = 'sold_elsewhere', updated_at = ? WHERE id = ?",
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
// ===== END STOREFRONT OFFERS =====
