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
  }
  return db;
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

const app = express();
app.use(express.json());

const {
  OWNER_EMAIL = 'support@3rdfloortapes.com',
  RESEND_API_KEY,
  FROM_EMAIL = 'onboarding@resend.dev',
  STRIPE_SECRET_KEY,
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  PORT = 3000,
} = process.env;

let shopifyToken = null;
let shopifyTokenExpiry = 0;

async function getShopifyAccessToken() {
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

app.post('/saved-items', requireAuth, async (req, res) => {
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
    [req.userId, item_id, state, now, state, now]
  );
  saveDb();
  res.json({ item_id, state });
});

app.delete('/saved-items/:item_id', requireAuth, async (req, res) => {
  const database = await getDb();
  database.run('DELETE FROM saved_items WHERE user_id = ? AND item_id = ?', [req.userId, req.params.item_id]);
  saveDb();
  res.json({ removed: req.params.item_id });
});

app.get('/saved-items', requireAuth, async (req, res) => {
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
    [req.params.item_id]
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
    const result = database.exec('SELECT buyer_name, buyer_email, items FROM offers WHERE id = ?', [req.params.id]);
    if (result.length === 0 || result[0].values.length === 0) {
      return res.status(404).json({ error: 'Offer not found.' });
    }
    const [buyer_name, buyer_email, itemsJson] = result[0].values[0];

    const now = new Date().toISOString();
    database.run('UPDATE offers SET status = ?, updated_at = ? WHERE id = ?', [status, now, req.params.id]);
    saveDb();

    const items = JSON.parse(itemsJson);
    await sendOfferDecisionEmail({ buyer_name, buyer_email, items, status });

    res.json({ status: 'ok' });
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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
