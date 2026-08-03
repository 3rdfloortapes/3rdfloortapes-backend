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

// Accepts EITHER a single item (legacy shape) or an items array (basket).
// The basket is deliberately NOT persisted server-side: it lives in the
// browser until submitted. Per-item detail rides in Stripe metadata, one key
// per item - Stripe allows 50 keys of 500 chars, which comfortably covers a
// basket of this size without any new table.
const MAX_BASKET_ITEMS = 20;

app.post('/storefront-offers', requireShopifyCustomer, async (req, res) => {
  try {
    const body = req.body || {};
    const { message, open_to_counter } = body;

    // Normalize to an array so single and basket offers share one code path.
    const requested = Array.isArray(body.items)
      ? body.items
      : [
          {
            variant_id: body.variant_id,
            amount_cents: body.amount_cents,
            price_match_link: body.price_match_link,
          },
        ];

    if (!requested.length) {
      return res.status(400).json({ error: 'Your offer is empty.' });
    }
    if (requested.length > MAX_BASKET_ITEMS) {
      return res
        .status(400)
        .json({ error: 'You can offer on up to ' + MAX_BASKET_ITEMS + ' tapes at once.' });
    }

    const customer = await getShopifyCustomerForOffer(req.shopifyCustomerId);
    if (!customer || !customer.email) {
      return res.status(400).json({ error: 'Could not verify your account.' });
    }

    // Validate every line against Shopify. Browser-supplied prices are never
    // trusted - list price and availability come from the Admin API.
    const validated = [];
    for (const line of requested) {
      if (!line || !line.variant_id || !line.amount_cents) {
        return res.status(400).json({ error: 'Missing offer details.' });
      }

      const offerCents = parseInt(line.amount_cents, 10);
      if (!Number.isFinite(offerCents) || offerCents <= 0) {
        return res.status(400).json({ error: 'Enter a valid offer amount for every tape.' });
      }

      const variant = await getVariantForOffer(line.variant_id);
      if (!variant || !variant.availableForSale) {
        return res.status(400).json({
          error: 'One of these tapes is no longer available. Please remove it and try again.',
        });
      }

      const listCents = Math.round(parseFloat(variant.price) * 100);
      if (offerCents >= listCents) {
        const title = variant.product ? variant.product.title : variant.title || 'a tape';
        return res.status(400).json({
          error: 'Your offer on "' + title + '" must be less than the listed price.',
        });
      }

      validated.push({
        variant_id: String(line.variant_id),
        product_id: variant.product ? String(variant.product.id).replace(/^.*\//, '') : '',
        product_title: (variant.product ? variant.product.title : variant.title || ''),
        list_price: (listCents / 100).toFixed(2),
        offer_price: (offerCents / 100).toFixed(2),
        price_match_link: String(line.price_match_link || ''),
      });
    }

    const buyerName =
      [customer.firstName, customer.lastName].filter(Boolean).join(' ') ||
      customer.email;

    const existing = await stripe.customers.list({ email: customer.email, limit: 1 });
    const stripeCustomer =
      existing.data[0] ??
      (await stripe.customers.create({ email: customer.email, name: buyerName }));

    // One metadata key per item. Short property names and trimmed strings keep
    // each value well under Stripe's 500-character ceiling.
    const metadata = {
      source: 'storefront',
      shopify_customer_id: String(req.shopifyCustomerId),
      buyer_name: buyerName.slice(0, 200),
      buyer_email: customer.email.slice(0, 200),
      open_to_counter: open_to_counter === false ? '0' : '1',
      offer_message: String(message || '').slice(0, 400),
      item_count: String(validated.length),
    };

    validated.forEach((item, index) => {
      metadata['item_' + index] = JSON.stringify({
        v: item.variant_id,
        p: item.product_id,
        t: item.product_title.slice(0, 160),
        l: item.list_price,
        o: item.offer_price,
        c: item.price_match_link.slice(0, 160),
      }).slice(0, 490);
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      // Required on setup-mode sessions in current Stripe API versions.
      currency: 'usd',
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

  // variant_id MUST be a full GID: createShopifyOrder() feeds it straight into
  // a GraphQL mutation when an offer is accepted, and that requires a GID.
  function toVariantGid(v) {
    if (!v) return null;
    const s = String(v);
    return s.startsWith('gid://') ? s : 'gid://shopify/ProductVariant/' + s;
  }

  // Rebuild the item list from metadata. Newer offers use item_0..item_N;
  // the single-item shape is kept for any session created before the basket
  // work landed.
  const items = [];
  const count = parseInt(m.item_count, 10);

  if (Number.isFinite(count) && count > 0) {
    for (let i = 0; i < count; i += 1) {
      const raw = m['item_' + i];
      if (!raw) continue;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        console.error('[storefront-offers] could not parse item_' + i);
        continue;
      }
      items.push({
        product_title: parsed.t || '',
        product_id: parsed.p || null,
        variant_id: toVariantGid(parsed.v),
        // Numbers, not strings - the admin dashboard sums these and calls
        // .toFixed(), which breaks on string concatenation.
        list_price: parsed.l ? parseFloat(parsed.l) : null,
        offer_price: parsed.o ? parseFloat(parsed.o) : null,
        competitor_link: parsed.c || null,
      });
    }
  } else if (m.variant_id) {
    items.push({
      product_title: m.product_title || '',
      product_id: m.product_id || null,
      variant_id: toVariantGid(m.variant_id),
      list_price: m.list_price ? parseFloat(m.list_price) : null,
      offer_price: m.offer_price ? parseFloat(m.offer_price) : null,
      competitor_link: m.price_match_link || null,
    });
  }

  if (!items.length) {
    console.error('[storefront-offers] session ' + session.id + ' had no usable items');
    return null;
  }

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
      // Links are per-item (items[].competitor_link, which the email renders).
      // This column only carries a value for single-item offers.
      items.length === 1 ? items[0].competitor_link : null,
      now,
      now,
    ]
  );
  saveDb();
  console.log('[storefront-offers] created offer', offerId);

  // Same notification the app's /offers-batch sends. Failure here must not
  // undo the offer - it's already saved and visible in the admin queue.
  try {
    await sendOfferEmail({
      buyer_name: m.buyer_name || '',
      buyer_email: m.buyer_email || '',
      message: m.offer_message || null,
      open_to_counter: m.open_to_counter !== '0',
      items,
      id: offerId,
      card_on_file: true,
    });
  } catch (e) {
    console.error('[storefront-offers] offer saved but email failed:', e.message);
  }

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
      // Stored variant ids are GIDs; Shopify's webhook sends bare numbers.
      // Compare on the numeric tail so both formats match.
      const hit = (items || []).some((item) => {
        const tail = String(item.variant_id || '').replace(/^.*\//, '');
        return tail && soldVariantIds.includes(tail);
      });
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
