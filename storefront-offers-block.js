// ===== STOREFRONT OFFERS (Shopify entry point into the existing offers flow) =====
//
// Deliberately NOT mounted at /offers - that path is already the app's route,
// and the App Proxy strips /apps/einstein, so a storefront POST to
// /apps/einstein/offers would collide with it. Distinct path, shared table.
//
// Flow difference from the app, and why:
//   The app calls /create-setup-session first, holds the offer in memory
//   across the WebView, then posts /offers-batch with the stripe_customer_id.
//   A browser can't do that - redirecting to Stripe discards page state.
//   So the storefront creates the offer FIRST as 'pending_card', then
//   activates it to 'pending' when the customer returns from Stripe.

// Look up the logged-in Shopify customer's name and email via the Admin API.
// Offers key on buyer_email, so this is required, not decorative.
async function getShopifyCustomer(customerId) {
  const token = await getShopifyAccessToken();
  const query = `
    query($id: ID!) {
      customer(id: $id) {
        email
        firstName
        lastName
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
        variables: { id: 'gid://shopify/Customer/' + String(customerId) },
      }),
    }
  );
  const data = await response.json();
  if (data.errors) {
    console.error('Storefront offer - customer lookup failed:', data.errors);
    throw new Error('Could not verify your account.');
  }
  return data.data && data.data.customer ? data.data.customer : null;
}

// Fetch the live variant so price and availability come from Shopify,
// never from the browser.
async function getVariantForOffer(variantId) {
  const token = await getShopifyAccessToken();
  const query = `
    query($id: ID!) {
      productVariant(id: $id) {
        id
        price
        availableForSale
        title
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

app.post('/storefront-offers', requireShopifyCustomer, async (req, res) => {
  try {
    const { variant_id, amount_cents, message } = req.body;

    if (!variant_id || !amount_cents) {
      return res.status(400).json({ error: 'Missing offer details.' });
    }

    const offerCents = parseInt(amount_cents, 10);
    if (!Number.isFinite(offerCents) || offerCents <= 0) {
      return res.status(400).json({ error: 'Enter a valid offer amount.' });
    }

    const customer = await getShopifyCustomer(req.shopifyCustomerId);
    if (!customer || !customer.email) {
      return res.status(400).json({ error: 'Could not verify your account.' });
    }

    // Server-side truth: price and availability come from Shopify.
    const variant = await getVariantForOffer(variant_id);
    if (!variant) {
      return res.status(400).json({ error: 'This tape is no longer available.' });
    }
    if (!variant.availableForSale) {
      return res.status(400).json({ error: 'This tape is no longer available.' });
    }

    // variant.price is a decimal string of dollars, e.g. "5.00"
    const listCents = Math.round(parseFloat(variant.price) * 100);
    if (offerCents >= listCents) {
      return res
        .status(400)
        .json({ error: 'Your offer must be less than the listed price.' });
    }

    // The offers table stores dollars, matching the app's existing rows.
    const offerDollars = (offerCents / 100).toFixed(2);
    const listDollars = (listCents / 100).toFixed(2);

    const buyerName =
      [customer.firstName, customer.lastName].filter(Boolean).join(' ') ||
      customer.email;

    const items = [
      {
        product_title: variant.product ? variant.product.title : variant.title,
        product_id: variant.product
          ? String(variant.product.id).replace(/^.*\//, '')
          : null,
        variant_id: String(variant_id),
        list_price: listDollars,
        offer_price: offerDollars,
      },
    ];

    // Reuse the same Stripe customer the app would use - keyed on email,
    // so a shopper who has offered in the app keeps one Stripe customer.
    const existing = await stripe.customers.list({
      email: customer.email,
      limit: 1,
    });
    const stripeCustomer =
      existing.data[0] ??
      (await stripe.customers.create({
        email: customer.email,
        name: buyerName,
      }));

    const id = 'offer_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const now = new Date().toISOString();

    const database = await getDb();
    database.run(
      `INSERT INTO offers (id, buyer_name, buyer_email, message, open_to_counter, items, status, stripe_customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending_card', ?, ?, ?)`,
      [
        id,
        buyerName,
        customer.email,
        message || null,
        1,
        JSON.stringify(items),
        stripeCustomer.id,
        now,
        now,
      ]
    );
    saveDb();

    // Same setup-mode session and same return pages the app already uses.
    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: stripeCustomer.id,
      success_url:
        'https://3rdfloortapes.com/pages/offer-card-saved?session_id={CHECKOUT_SESSION_ID}&offer_id=' +
        id,
      cancel_url:
        'https://3rdfloortapes.com/pages/offer-card-setup-cancelled?offer_id=' + id,
      metadata: { offer_id: id, source: 'storefront' },
    });

    res.json({ checkout_url: session.url });
  } catch (e) {
    console.error('Storefront offer error:', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Called by the "Offer Card Saved" page after Stripe redirects back.
// Verifies the setup actually succeeded before making the offer live.
app.post('/storefront-offers/:id/activate', async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) {
      return res.status(400).json({ error: 'Missing session.' });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (!session || session.metadata.offer_id !== req.params.id) {
      return res.status(400).json({ error: 'Session does not match this offer.' });
    }
    if (session.status !== 'complete') {
      return res.status(400).json({ error: 'Card setup was not completed.' });
    }

    const database = await getDb();
    const now = new Date().toISOString();
    database.run(
      "UPDATE offers SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'pending_card'",
      [now, req.params.id]
    );
    saveDb();

    res.json({ status: 'active' });
  } catch (e) {
    console.error('Storefront offer activation error:', e.message);
    res.status(500).json({ error: 'Could not activate the offer.' });
  }
});
// ===== END STOREFRONT OFFERS =====
