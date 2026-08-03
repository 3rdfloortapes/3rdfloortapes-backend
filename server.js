const { registerSavedItemsDetailsRoute } = require('./saved-items-details');
const express = require('express');
const crypto = require('crypto');
const Stripe = require('stripe');

const fs = require('fs');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const DB_PATH = process.env.DB_PATH || (__dirname + '/app.db');
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-later';

let SQL;
let db;

function createFreshSchema(database) {
  database.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_active TEXT,
      is_admin INTEGER DEFAULT 0
    );
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS saved_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('wishlist','cart')),
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, item_id)
    );
  `);
  // SHOPPER ALERT (storefront) - included here for brand-new installs,
  // but see the unconditional creation below getDb()'s if/else - that's
  // what actually guarantees this table exists on the EXISTING production
  // database, since createFreshSchema() only ever runs once, on first-ever
  // startup with no db file present.
  database.run(`
    CREATE TABLE IF NOT EXISTS storefront_cart_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT,
      product_title TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

async function getDb() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  if (!db) {
    if (fs.existsSync(DB_PATH)) {
      const fileBuffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(fileBuffer);
    } else {
      console.log('No database found at', DB_PATH, '- creating a fresh one.');
      db = new SQL.Database();
      createFreshSchema(db);
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    }
    // SHOPPER ALERT (storefront) - runs every time regardless of whether
    // the db file already existed, so this table gets created on the
    // EXISTING production database the first time this updated server
    // starts, not just on a fresh install. IF NOT EXISTS makes this safe
    // to run every time without affecting anything already there.
    db.run(`
      CREATE TABLE IF NOT EXISTS storefront_cart_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id TEXT,
        product_title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    saveDb();
  }
  return db;
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use('/public', express.static('public'));

// SHOPPER ALERT (storefront) - CORS middleware. Required so the actual
// Shopify storefront (a different origin than this backend) can call the
// new storefront routes below. Restricted to your two real domains only,
// not a wildcard, so this doesn't open the API to arbitrary sites.
// This does NOT affect any existing route or behavior - it only adds
// permission headers for the listed origins.
app.use((req, res, next) => {
  const allowedOrigins = [
    'https://www.3rdfloortapes.com',
    'https://3rdfloortapes.com',
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

const {
  OWNER_EMAIL = 'support@3rdfloortapes.com',
  RESEND_API_KEY,
  FROM_EMAIL = 'onboarding@resend.dev',
  STRIPE_SECRET_KEY,
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_ACCESS_TOKEN,
  PORT = 3000,
} = process.env;

let shopifyToken = null;
let shopifyTokenExpiry = 0;

async function getShopifyAccessToken() {
  if (SHOPIFY_ACCESS_TOKEN) {
    return SHOPIFY_ACCESS_TOKEN;
  }
  if (shopifyToken && Date.now() < shopifyTokenExpiry) {
    return shopifyToken;
  }
  const response = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify token error: ${text}`);
  }
  const data = await response.json();
  shopifyToken = data.access_token;
  shopifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return shopifyToken;
}

const stripe = Stripe(STRIPE_SECRET_KEY);

async function chargeOfferCard(stripeCustomerId, amountDollars) {
  const paymentMethods = await stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'card' });
  if (paymentMethods.data.length === 0) {
    throw new Error('No saved card found for this customer.');
  }
  const paymentMethod = paymentMethods.data[paymentMethods.data.length - 1];

  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(amountDollars * 100),
    currency: 'usd',
    customer: stripeCustomerId,
    payment_method: paymentMethod.id,
    off_session: true,
    confirm: true,
  });

  return paymentIntent;
}

async function createShopifyOrder({ buyer_name, buyer_email, items }) {
  const token = await getShopifyAccessToken();

  const nameParts = buyer_name.trim().split(' ');
  const firstName = nameParts[0] || buyer_name;
  const lastName = nameParts.slice(1).join(' ') || '';

  const lineItems = items.map((i) => ({
    variantId: i.variant_id,
    quantity: 1,
    priceSet: {
      shopMoney: {
        amount: String(i.offer_price),
        currencyCode: 'USD',
      },
    },
  }));

  const mutation = `
    mutation orderCreate($order: OrderCreateOrderInput!) {
      orderCreate(order: $order) {
        userErrors { field message }
        order { id name }
      }
    }
  `;

  const variables = {
    order: {
      lineItems,
      email: buyer_email,
      customer: {
        toUpsert: {
          email: buyer_email,
          firstName,
          lastName,
        },
      },
      financialStatus: 'PAID',
      tags: ['App Offer Accepted'],
    },
  };

  const response = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2026-07/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query: mutation, variables }),
  });

  const data = await response.json();

  if (data.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(data.errors)}`);
  }
  if (data.data.orderCreate.userErrors.length > 0) {
    throw new Error(`Shopify order error: ${JSON.stringify(data.data.orderCreate.userErrors)}`);
  }

  return data.data.orderCreate.order;
}

async function sendOfferEmail({ buyer_name, buyer_email, message, open_to_counter, items, id, card_on_file }) {
  const total = items.reduce((sum, i) => sum + parseFloat(i.offer_price), 0);

  const rows = items.map((i) => {
    const savings = (i.list_price - i.offer_price).toFixed(2);
    const pct = Math.round(((i.list_price - i.offer_price) / i.list_price) * 100);
    return `<tr>
      <td>${i.product_title}${i.competitor_link ? `<br><small>Competitor link: ${i.competitor_link}</small>` : ''}</td>
      <td>$${parseFloat(i.list_price).toFixed(2)}</td>
      <td>$${parseFloat(i.offer_price).toFixed(2)} (${pct}% off, saves $${savings})</td>
    </tr>`;
  }).join('');

  const emailHtml = `
    <h2>New Offers Cart — 3rd Floor Tapes App</h2>
    <table style="border-collapse:collapse;width:100%">
      <tr><td><b>Buyer</b></td><td>${buyer_name}</td></tr>
      <tr><td><b>Email</b></td><td>${buyer_email}</td></tr>
      <tr><td><b>Open to Counter?</b></td><td>${open_to_counter ? 'YES' : 'No'}</td></tr>
      <tr><td><b>Card on File?</b></td><td>${card_on_file ? 'YES — see Stripe dashboard' : 'No'}</td></tr>
      ${message ? `<tr><td><b>Message</b></td><td>${message}</td></tr>` : ''}
      <tr><td><b>Offer ID</b></td><td>${id}</td></tr>
    </table>
    <h3>Items (${items.length})</h3>
    <table style="border-collapse:collapse;width:100%;border:1px solid #ccc">
      <tr><th>Item</th><th>List Price</th><th>Offer</th></tr>
      ${rows}
    </table>
    <p><b>Total Offer: $${total.toFixed(2)}</b></p>
  `;

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `3rd Floor Tapes <${FROM_EMAIL}>`,
      to: OWNER_EMAIL,
      reply_to: buyer_email,
      subject: `New Offers Cart: ${buyer_name} — ${items.length} item(s), $${total.toFixed(2)} total`,
      html: emailHtml,
    }),
  });

  if (!resendRes.ok) {
    const errText = await resendRes.text();
    throw new Error(`Resend error: ${errText}`);
  }
}

async function sendOfferDecisionEmail({ buyer_name, buyer_email, items, status }) {
  const total = items.reduce((sum, i) => sum + parseFloat(i.offer_price), 0);
  const itemRows = items.map((i) => `<li>${i.product_title} — $${parseFloat(i.offer_price).toFixed(2)}</li>`).join('');

  const subject = status === 'accepted'
    ? 'Your offer was accepted! — 3rd Floor Tapes'
    : 'Update on your offer — 3rd Floor Tapes';

  const bodyHtml = status === 'accepted'
    ? `<h2>Good news, ${buyer_name}!</h2>
       <p>Your offer of $${total.toFixed(2)} for the following item(s) has been accepted:</p>
       <ul>${itemRows}</ul>
       <p>We'll be in touch shortly to complete your order.</p>`
    : `<h2>Hi ${buyer_name},</h2>
       <p>Thanks for your offer on the following item(s):</p>
       <ul>${itemRows}</ul>
       <p>Unfortunately we're not able to accept this offer at this time. Feel free to check back or make another offer anytime!</p>`;

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `3rd Floor Tapes <${FROM_EMAIL}>`,
      to: buyer_email,
      subject,
      html: bodyHtml,
    }),
  });

  if (!resendRes.ok) {
    const errText = await resendRes.text();
    throw new Error(`Resend error: ${errText}`);
  }
}

// Create a Stripe Checkout Session in setup mode — saves a card, charges nothing
app.post('/create-setup-session', async (req, res) => {
  try {
    const { buyer_email, buyer_name } = req.body;
    if (!buyer_email) return res.status(400).json({ error: 'Missing buyer_email' });

    const customers = await stripe.customers.list({ email: buyer_email, limit: 1 });
    const customer = customers.data[0]
      ?? await stripe.customers.create({ email: buyer_email, name: buyer_name });

    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: customer.id,
      payment_method_types: ['card'],
      success_url: 'https://3rdfloortapes.com/pages/offer-card-saved?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://3rdfloortapes.com/pages/offer-card-setup-cancelled',
    });

    res.json({ url: session.url, customer_id: customer.id });
  } catch (e) {
    console.error('Stripe setup session error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/offers', async (req, res) => {
  try {
    const {
      product_title, product_id, variant_id, list_price, offer_price,
      buyer_name, buyer_email, message, multi_item, open_to_counter,
    } = req.body;

    if (!product_title || !offer_price || !buyer_name || !buyer_email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const id = crypto.randomUUID();
    await sendOfferEmail({
      buyer_name, buyer_email, message, open_to_counter,
      items: [{ product_title, product_id, variant_id, list_price, offer_price }],
      id,
    });

    res.json({ status: 'ok', id });
  } catch (e) {
    console.error('Offer error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/offers-batch', async (req, res) => {
  try {
    const { buyer_name, buyer_email, message, open_to_counter, items, stripe_customer_id } = req.body;

    if (!buyer_name || !buyer_email || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const id = crypto.randomUUID();

    const database = await getDb();
    const now = new Date().toISOString();
    database.run(
      `INSERT INTO offers (id, buyer_name, buyer_email, message, open_to_counter, items, status, stripe_customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [id, buyer_name, buyer_email, message || null, open_to_counter ? 1 : 0, JSON.stringify(items), stripe_customer_id || null, now, now]
    );
    saveDb();

    await sendOfferEmail({
      buyer_name, buyer_email, message, open_to_counter, items, id,
      card_on_file: !!stripe_customer_id,
    });

    res.json({ status: 'ok', id });
  } catch (e) {
    console.error('Batch offer error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  const database = await getDb();
  const password_hash = bcrypt.hashSync(password, 10);
  const created_at = new Date().toISOString();
  try {
    database.run(
      'INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)',
      [email, password_hash, created_at]
    );
    saveDb();
  } catch (err) {
    return res.status(400).json({ error: 'An account with that email already exists.' });
  }
  const result = database.exec('SELECT id FROM users WHERE email = ?', [email]);
  const userId = result[0].values[0][0];
  const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, email });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  const database = await getDb();
  const result = database.exec('SELECT id, email, password_hash, is_admin FROM users WHERE email = ?', [email]);
  if (result.length === 0 || result[0].values.length === 0) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const [id, foundEmail, storedHash, is_admin] = result[0].values[0];
  const matches = bcrypt.compareSync(password, storedHash);
  if (!matches) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  database.run('UPDATE users SET last_active = ? WHERE id = ?', [new Date().toISOString(), id]);
  saveDb();
  const token = jwt.sign({ userId: id, email: foundEmail }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, email: foundEmail, is_admin: !!is_admin });
});



function requireShopifyCustomer(req, res, next) {
  const providedSignature = String(req.query.signature || '');
  const customerId = String(req.query.logged_in_customer_id || '');

  if (!providedSignature) {
    return res.status(401).json({ error: 'Missing Shopify proxy signature.' });
  }

  const message = Object.keys(req.query)
    .filter((key) => key !== 'signature')
    .sort()
    .map((key) => `${key}=${Array.isArray(req.query[key]) ? req.query[key].join(',') : req.query[key]}`)
    .join('');

  const expectedSignature = crypto
    .createHmac('sha256', SHOPIFY_CLIENT_SECRET)
    .update(message)
    .digest('hex');

  const valid =
    providedSignature.length === expectedSignature.length &&
    crypto.timingSafeEqual(
      Buffer.from(providedSignature, 'utf8'),
      Buffer.from(expectedSignature, 'utf8')
    );

  if (!valid) {
    return res.status(401).json({ error: 'Invalid Shopify proxy signature.' });
  }

  if (!customerId) {
    return res.status(401).json({ error: 'Shopify customer login required.' });
  }

  req.shopifyCustomerId = customerId;
  req.userId = customerId;
  next();
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired login.' });
  }
}

async function requireAdmin(req, res, next) {
  const database = await getDb();
  const result = database.exec('SELECT is_admin FROM users WHERE id = ?', [req.userId]);
  const isAdmin = result.length > 0 && result[0].values.length > 0 && result[0].values[0][0] === 1;
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

function expireOldCartItems(database) {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  database.run(
    "UPDATE saved_items SET state = 'wishlist', updated_at = ? WHERE state = 'cart' AND updated_at < ?",
    [now, cutoff]
  );
}

app.post('/saved-items', requireShopifyCustomer, async (req, res) => {
  const { item_id, state } = req.body;
  if (!item_id || (state !== 'wishlist' && state !== 'cart')) {
    return res.status(400).json({ error: 'item_id and a valid state (wishlist or cart) are required.' });
  }
  const database = await getDb();
  expireOldCartItems(database);
  const now = new Date().toISOString();
  database.run(
    `INSERT INTO saved_items (user_id, item_id, state, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, item_id) DO UPDATE SET state = ?, updated_at = ?`,
    [req.userId, toNumericId(item_id), state, now, state, now]
  );
  saveDb();
  res.json({ item_id, state });
});

app.delete('/saved-items/:item_id', requireShopifyCustomer, async (req, res) => {
  const database = await getDb();
  database.run('DELETE FROM saved_items WHERE user_id = ? AND item_id = ?', [req.userId, toNumericId(req.params.item_id)]);
  saveDb();
  res.json({ removed: req.params.item_id });
});

app.get('/saved-items', requireShopifyCustomer, async (req, res) => {
  const database = await getDb();
  expireOldCartItems(database);
  saveDb();
  const result = database.exec('SELECT item_id, state, updated_at FROM saved_items WHERE user_id = ?', [req.userId]);
  const rows = result.length > 0 ? result[0].values : [];
  const items = rows.map(([item_id, state, updated_at]) => ({ item_id, state, updated_at }));
  res.json({ items });
});

app.get('/saved-items/counts/:item_id', async (req, res) => {
  const database = await getDb();
  expireOldCartItems(database);
  saveDb();
  const result = database.exec(
    'SELECT state, COUNT(*) as count FROM saved_items WHERE item_id = ? GROUP BY state',
    [toNumericId(req.params.item_id)]
  );
  let wishlistCount = 0;
  let cartCount = 0;
  if (result.length > 0) {
    for (const row of result[0].values) {
      const [state, count] = row;
      if (state === 'wishlist') wishlistCount = count;
      if (state === 'cart') cartCount = count;
    }
  }
  res.json({ item_id: req.params.item_id, wishlist_count: wishlistCount, cart_count: cartCount });
});


app.get('/popular', async (req, res) => {
  const database = await getDb();
  expireOldCartItems(database);
  saveDb();
  const limit = parseInt(req.query.limit, 10) || 15;
  const minWishlist = parseInt(req.query.minWishlist, 10) || 0;
  const result = database.exec(`
    SELECT
      item_id,
      SUM(CASE WHEN state = 'wishlist' THEN 1 ELSE 0 END) AS wishlist_count,
      SUM(CASE WHEN state = 'cart' THEN 1 ELSE 0 END) AS cart_count,
      COUNT(*) AS total
    FROM saved_items
    GROUP BY item_id
    HAVING wishlist_count >= ?
    ORDER BY wishlist_count DESC, total DESC
    LIMIT ?
  `, [minWishlist, limit]);

  const rows = result.length > 0 ? result[0].values : [];
  const items = rows.map(([item_id, wishlist_count, cart_count, total]) => ({
    item_id,
    wishlist_count,
    cart_count,
    total
  }));
  res.json({ items });
});


app.post('/saved-items/counts-bulk', async (req, res) => {
  const { item_ids } = req.body;
  if (!Array.isArray(item_ids) || item_ids.length === 0) {
    return res.status(400).json({ error: 'item_ids must be a non-empty array.' });
  }
  const database = await getDb();
  expireOldCartItems(database);
  saveDb();

  const placeholders = item_ids.map(() => '?').join(',');
  const result = database.exec(
    `SELECT item_id, state, COUNT(*) as count FROM saved_items WHERE item_id IN (${placeholders}) GROUP BY item_id, state`,
    item_ids
  );

  const counts = {};
  item_ids.forEach((id) => { counts[id] = { wishlist_count: 0, cart_count: 0 }; });

  if (result.length > 0) {
    for (const row of result[0].values) {
      const [item_id, state, count] = row;
      if (!counts[item_id]) counts[item_id] = { wishlist_count: 0, cart_count: 0 };
      if (state === 'wishlist') counts[item_id].wishlist_count = count;
      if (state === 'cart') counts[item_id].cart_count = count;
    }
  }

  res.json({ counts });
});


app.get('/shopper-alert', requireAuth, async (req, res) => {
  const database = await getDb();
  expireOldCartItems(database);
  saveDb();
  const limit = parseInt(req.query.limit, 10) || 10;
  const result = database.exec(
    `SELECT DISTINCT item_id, MAX(updated_at) as latest
     FROM saved_items
     WHERE state = 'cart' AND user_id != ?
     GROUP BY item_id
     ORDER BY latest DESC
     LIMIT ?`,
    [req.userId, limit]
  );
  const rows = result.length > 0 ? result[0].values : [];
  const items = rows.map(([item_id]) => item_id);
  res.json({ items });
});


// ============================================================
// SHOPPER ALERT (storefront) - NEW routes below.
// These are separate and additional to the app-only /shopper-alert
// route above - that one requires app login (requireAuth) and reads
// from saved_items, which only the app writes to. Storefront visitors
// aren't logged into the app, so they need their own, unauthenticated
// path writing to a separate table (storefront_cart_activity).
// Nothing above this comment block was changed.
// ============================================================

function expireOldStorefrontActivity(database) {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  database.run(
    'DELETE FROM storefront_cart_activity WHERE created_at < ?',
    [cutoff]
  );
}

// Log a real add-to-cart from the actual Shopify storefront. No auth -
// storefront visitors aren't logged into the app. No user identity is
// ever captured - this only ever needs to know WHAT was added, never WHO.
app.post('/storefront-cart-ping', async (req, res) => {
  const { product_id, product_title } = req.body;
  if (!product_title) {
    return res.status(400).json({ error: 'product_title is required.' });
  }
  const database = await getDb();
  expireOldStorefrontActivity(database);
  const now = new Date().toISOString();
  database.run(
    'INSERT INTO storefront_cart_activity (product_id, product_title, created_at) VALUES (?, ?, ?)',
    [product_id || null, product_title, now]
  );
  saveDb();
  res.json({ ok: true });
});

// Public read endpoint for the storefront ticker - recent distinct
// titles, newest first, last 30 minutes only (same window used
// elsewhere for cart-to-wishlist expiry).
app.get('/storefront-shopper-alert', async (req, res) => {
  const database = await getDb();
  expireOldStorefrontActivity(database);
  const limit = parseInt(req.query.limit, 10) || 10;
  const result = database.exec(
    `SELECT product_title, MAX(created_at) as latest
     FROM storefront_cart_activity
     GROUP BY product_title
     ORDER BY latest DESC
     LIMIT ?`,
    [limit]
  );
  const rows = result.length > 0 ? result[0].values : [];
  const titles = rows.map(([title]) => title);
  res.json({ titles });
});


app.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const database = await getDb();
  const result = database.exec(
    'SELECT id, email, created_at, last_active, is_admin FROM users ORDER BY created_at DESC'
  );
  const rows = result.length > 0 ? result[0].values : [];
  const users = rows.map(([id, email, created_at, last_active, is_admin]) => ({
    id,
    email,
    created_at,
    last_active,
    is_admin: !!is_admin,
  }));
  res.json({ users });
});


app.get('/admin/offers', requireAuth, requireAdmin, async (req, res) => {
  const database = await getDb();
  const result = database.exec(
    'SELECT id, buyer_name, buyer_email, message, open_to_counter, items, status, counter_note, created_at, updated_at FROM offers ORDER BY created_at DESC'
  );
  const rows = result.length > 0 ? result[0].values : [];
  const offers = rows.map(([id, buyer_name, buyer_email, message, open_to_counter, items, status, counter_note, created_at, updated_at]) => ({
    id,
    buyer_name,
    buyer_email,
    message,
    open_to_counter: !!open_to_counter,
    items: JSON.parse(items),
    status,
    counter_note,
    created_at,
    updated_at,
  }));
  res.json({ offers });
});


app.post('/admin/offers/:id/decision', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (status !== 'accepted' && status !== 'declined') {
      return res.status(400).json({ error: 'status must be accepted or declined.' });
    }

    const database = await getDb();
    const result = database.exec('SELECT buyer_name, buyer_email, items, stripe_customer_id FROM offers WHERE id = ?', [req.params.id]);
    if (result.length === 0 || result[0].values.length === 0) {
      return res.status(404).json({ error: 'Offer not found.' });
    }
    const [buyer_name, buyer_email, itemsJson, stripe_customer_id] = result[0].values[0];
    const items = JSON.parse(itemsJson);
    const now = new Date().toISOString();

    if (status === 'declined') {
      database.run('UPDATE offers SET status = ?, updated_at = ? WHERE id = ?', [status, now, req.params.id]);
      saveDb();
      await sendOfferDecisionEmail({ buyer_name, buyer_email, items, status });
      return res.json({ status: 'ok' });
    }

    // status === 'accepted': charge the card first, only then create the order.
    if (!stripe_customer_id) {
      return res.status(400).json({ error: 'No card on file for this offer - cannot accept.' });
    }

    const total = items.reduce((sum, i) => sum + parseFloat(i.offer_price), 0);

    let paymentIntent;
    try {
      paymentIntent = await chargeOfferCard(stripe_customer_id, total);
    } catch (chargeError) {
      console.error('Offer charge failed:', chargeError.message);
      return res.status(402).json({ error: `Charge failed: ${chargeError.message}` });
    }

    let orderNote = null;
    try {
      const order = await createShopifyOrder({ buyer_name, buyer_email, items });
      orderNote = `Shopify order created: ${order.name}`;
    } catch (orderError) {
      console.error('Shopify order creation failed after successful charge:', orderError.message);
      orderNote = `CHARGED (payment intent ${paymentIntent.id}) BUT SHOPIFY ORDER CREATION FAILED: ${orderError.message} - create this order manually.`;
    }

    database.run('UPDATE offers SET status = ?, updated_at = ?, counter_note = ? WHERE id = ?', [status, now, orderNote, req.params.id]);
    saveDb();

    await sendOfferDecisionEmail({ buyer_name, buyer_email, items, status });

    res.json({ status: 'ok', note: orderNote });
  } catch (e) {
    console.error('Offer decision error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.get('/admin/shopify-token-test', requireAuth, requireAdmin, async (req, res) => {
  try {
    await getShopifyAccessToken();
    res.json({ success: true, message: 'Successfully fetched a Shopify access token.' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


app.get('/featured-collections', async (req, res) => {
  const database = await getDb();
  const result = database.exec('SELECT handle FROM featured_collections ORDER BY position');
  const rows = result.length > 0 ? result[0].values : [];
  const handles = rows.map(([handle]) => handle);
  res.json({ handles });
});

app.put('/admin/featured-collections', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { handles } = req.body;
    if (!Array.isArray(handles) || handles.length === 0) {
      return res.status(400).json({ error: 'handles must be a non-empty array.' });
    }

    const database = await getDb();
    database.run('DELETE FROM featured_collections');
    handles.forEach((handle, i) => {
      database.run('INSERT INTO featured_collections (handle, position) VALUES (?, ?)', [handle, i]);
    });
    saveDb();

    res.json({ status: 'ok', handles });
  } catch (e) {
    console.error('Update featured collections error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.get('/fire-department', async (req, res) => {
  try {
    const database = await getDb();
    expireOldCartItems(database);
    normalizeSavedItemIds(database);
    saveDb();
    const limit = parseInt(req.query.limit, 10) || 8;
    const threshold = parseInt(req.query.threshold, 10) || 2;

    const result = database.exec(`
      SELECT item_id, SUM(CASE WHEN state = 'wishlist' THEN 1 ELSE 0 END) AS wishlist_count
      FROM saved_items
      GROUP BY item_id
      HAVING wishlist_count >= ?
      ORDER BY wishlist_count DESC
      LIMIT ?
    `, [threshold, limit]);

    const rows = result.length > 0 ? result[0].values : [];
    const popular = rows.map(([item_id, wishlist_count]) => ({ item_id, wishlist_count }));

    if (popular.length === 0) {
      return res.json({ items: [] });
    }

    const token = await getShopifyAccessToken();
    const gids = popular.map((p) => toProductGid(p.item_id));

    const query = `
      query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            handle
            featuredImage { url }
            priceRangeV2 { minVariantPrice { amount currencyCode } }
          }
        }
      }
    `;

    const response = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2026-07/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables: { ids: gids } }),
    });

    const data = await response.json();
    if (data.errors) {
      console.error('Fire Department Admin API error:', data.errors);
      return res.status(500).json({ error: 'Shopify Admin API error', details: data.errors });
    }

    const nodes = (data.data && data.data.nodes ? data.data.nodes : []).filter(Boolean);
    const byId = {};
    nodes.forEach((n) => { byId[n.id] = n; });

    const items = popular
      .map((p) => {
        const product = byId[toProductGid(p.item_id)];
        if (!product) return null;
        return {
          item_id: p.item_id,
          wishlist_count: p.wishlist_count,
          title: product.title,
          handle: product.handle,
          image: product.featuredImage ? product.featuredImage.url : null,
          price: product.priceRangeV2 && product.priceRangeV2.minVariantPrice
            ? product.priceRangeV2.minVariantPrice.amount
            : null,
        };
      })
      .filter(Boolean);

    res.json({ items });
  } catch (e) {
    console.error('Fire Department route error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', source: 'shopify-app-proxy' }));
app.get('/proxy-inspect', (req, res) => res.json({ query: req.query, headers: req.headers }));
app.get('/customer-test', requireShopifyCustomer, (req, res) => res.json({ status: 'ok', shopify_customer_id: req.shopifyCustomerId }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
registerSavedItemsDetailsRoute({
  app,
  requireShopifyCustomer,

  // NOTE: route is '/saved-items/details', NOT '/apps/einstein/...'.
  // The Shopify App Proxy strips the /apps/einstein prefix before forwarding,
  // which is why every existing route here is registered bare.
  route: '/saved-items/details',

  // Existing saved-items routes key off req.userId (set by requireShopifyCustomer),
  // so this must match them exactly.
  getCustomerId: (req) => req.userId,

  // sql.js: database.exec(sql, params) -> [{ columns, values }]
  loadSavedItems: async ({ customerId, state }) => {
    const database = await getDb();
    expireOldCartItems(database);
    saveDb();
    const result = database.exec(
      `SELECT item_id
         FROM saved_items
        WHERE user_id = ?
          AND state = ?
        ORDER BY updated_at DESC`,
      [customerId, state]
    );
    const rows = result.length > 0 ? result[0].values : [];
    return rows.map(([item_id]) => ({ item_id }));
  },

  // Same authenticated Admin GraphQL call Fire Department uses.
  shopifyGraphql: async (query, variables) => {
    const token = await getShopifyAccessToken();
    const response = await fetch(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2026-07/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query, variables }),
      }
    );
    const data = await response.json();
    if (data.errors) {
      console.error('Dream Stack Admin API error:', data.errors);
      throw new Error('Shopify Admin API error');
    }
    return data.data;
  },
});


// ---------------------------------------------------------------------------
// ITEM ID NORMALIZATION
// Canonical storage form for saved_items.item_id is a BARE NUMERIC string.
// Shopify GraphQL requires a full GID, so convert only at that boundary.
// (Function declarations hoist, so these are usable above.)
// ---------------------------------------------------------------------------
function toNumericId(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/(\d+)$/);
  return match ? match[1] : null;
}

function toProductGid(value) {
  const raw = String(value == null ? '' : value);
  if (raw.startsWith('gid://')) return raw;
  return 'gid://shopify/Product/' + raw;
}

let savedItemIdsNormalized = false;
function normalizeSavedItemIds(database) {
  if (savedItemIdsNormalized) return;

  const check = database.exec(
    "SELECT COUNT(*) FROM saved_items WHERE item_id LIKE 'gid://%'"
  );
  const pending = check.length > 0 ? check[0].values[0][0] : 0;
  if (!pending) {
    savedItemIdsNormalized = true;
    return;
  }

  console.log('[normalize] converting ' + pending + ' GID rows to numeric');

  // Drop the GID row when a numeric row already exists for the same
  // user + product. Keeps the storefront row, which is the newer format.
  database.run(`
    DELETE FROM saved_items
     WHERE item_id LIKE 'gid://shopify/Product/%'
       AND EXISTS (
         SELECT 1 FROM saved_items other
          WHERE other.user_id = saved_items.user_id
            AND other.item_id = replace(saved_items.item_id, 'gid://shopify/Product/', '')
       )
  `);

  database.run(`
    UPDATE saved_items
       SET item_id = replace(item_id, 'gid://shopify/Product/', '')
     WHERE item_id LIKE 'gid://shopify/Product/%'
  `);

  saveDb();
  savedItemIdsNormalized = true;
  console.log('[normalize] done');
}

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
  // This matches what the app writes.
  const variantGid = m.variant_id
    ? (String(m.variant_id).startsWith('gid://')
        ? String(m.variant_id)
        : 'gid://shopify/ProductVariant/' + String(m.variant_id))
    : null;

  const items = [
    {
      product_title: m.product_title || '',
      product_id: m.product_id || null,
      variant_id: variantGid,
      // MUST be numbers, not strings. The app's admin dashboard does
      //   items.reduce((sum, i) => sum + (i.offer_price ?? 0), 0).toFixed(2)
      // and a string turns that reduce into concatenation, producing a string
      // with no .toFixed() - which crashes the whole dashboard.
      list_price: m.list_price ? parseFloat(m.list_price) : null,
      offer_price: m.offer_price ? parseFloat(m.offer_price) : null,
      competitor_link: m.price_match_link || null,
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



