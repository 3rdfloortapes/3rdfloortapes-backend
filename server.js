const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

const {
  SHOPIFY_STORE_DOMAIN = '3rdfloortapes.com',
  SHOPIFY_ADMIN_ACCESS_TOKEN,
  SHOPIFY_API_VERSION = '2026-04',
  OWNER_EMAIL = '3rdfloortapes@gmail.com',
  SMTP_HOST,
  SMTP_USER,
  SMTP_PASS,
  API_SECRET,
  PORT = 3000,
} = process.env;

const db = new Database('./offers.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS offers (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    product_title TEXT NOT NULL,
    product_image TEXT,
    list_price REAL NOT NULL,
    offer_price REAL NOT NULL,
    counter_price REAL,
    buyer_name TEXT NOT NULL,
    buyer_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    discount_code TEXT,
    message TEXT,
    owner_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const mailer = nodemailer.createTransport({
  host: SMTP_HOST,
  port: 587,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

async function notifyOwner(offer) {
  await mailer.sendMail({
    from: SMTP_USER,
    to: OWNER_EMAIL,
    subject: `New offer on "${offer.product_title}" — $${offer.offer_price}`,
    html: `
      <h2>New Offer</h2>
      <p><strong>Item:</strong> ${offer.product_title}</p>
      <p><strong>List Price:</strong> $${offer.list_price}</p>
      <p><strong>Offer:</strong> $${offer.offer_price}</p>
      <p><strong>From:</strong> ${offer.buyer_name} (${offer.buyer_email})</p>
      ${offer.message ? `<p><strong>Message:</strong> ${offer.message}</p>` : ''}
      <p>
        <a href="${process.env.BASE_URL}/owner/offers/${offer.id}/accept?secret=${API_SECRET}">Accept</a> |
        <a href="${process.env.BASE_URL}/owner/offers/${offer.id}/decline?secret=${API_SECRET}">Decline</a>
      </p>
    `,
  });
}

app.post('/offers', async (req, res) => {
  const { product_id, variant_id, product_title, product_image, list_price, offer_price, buyer_name, buyer_email, message } = req.body;
  if (!product_id || !variant_id || !offer_price || !buyer_email || !buyer_name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (offer_price >= list_price) {
    return res.status(400).json({ error: 'Offer must be below list price' });
  }
  const id = crypto.randomUUID();
  const offer = { id, product_id, variant_id, product_title, product_image: product_image ?? null, list_price, offer_price, buyer_name, buyer_email, message: message ?? null };
  db.prepare(`INSERT INTO offers (id, product_id, variant_id, product_title, product_image, list_price, offer_price, buyer_name, buyer_email, message) VALUES (@id, @product_id, @variant_id, @product_title, @product_image, @list_price, @offer_price, @buyer_name, @buyer_email, @message)`).run(offer);
  try { await notifyOwner(offer); } catch (e) { console.error('Email failed:', e.message); }
  res.json({ id, status: 'pending' });
});

app.get('/offers/:id', (req, res) => {
  const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Not found' });
  res.json({ id: offer.id, product_title: offer.product_title, list_price: offer.list_price, offer_price: offer.offer_price, counter_price: offer.counter_price, status: offer.status, discount_code: offer.status === 'accepted' ? offer.discount_code : null, owner_note: offer.owner_note, created_at: offer.created_at });
});

function ownerAuth(req, res, next) {
  const secret = req.query.secret || req.headers['x-api-secret'];
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/owner/offers', ownerAuth, (req, res) => {
  const offers = db.prepare('SELECT * FROM offers ORDER BY created_at DESC').all();
  res.json(offers);
});

app.post('/owner/offers/:id/accept', ownerAuth, async (req, res) => {
  const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Not found' });
  const code = `OFFER-${offer.id.slice(0, 8).toUpperCase()}`;
  db.prepare(`UPDATE offers SET status = 'accepted', discount_code = ?, updated_at = datetime('now') WHERE id = ?`).run(code, offer.id);
  try {
    await mailer.sendMail({
      from: `3rd Floor Tapes <${SMTP_USER}>`,
      to: offer.buyer_email,
      subject: `Your offer on "${offer.product_title}" was accepted!`,
      html: `<h2>Offer Accepted!</h2><p>Use code <strong>${code}</strong> at checkout. Valid 7 days.</p>`,
    });
  } catch (e) { console.error('Email failed:', e.message); }
  res.json({ status: 'accepted', discount_code: code });
});

app.post('/owner/offers/:id/counter', ownerAuth, async (req, res) => {
  const { counter_price, owner_note } = req.body;
  const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE offers SET status = 'countered', counter_price = ?, owner_note = ?, updated_at = datetime('now') WHERE id = ?`).run(counter_price, owner_note ?? null, offer.id);
  try {
    await mailer.sendMail({
      from: `3rd Floor Tapes <${SMTP_USER}>`,
      to: offer.buyer_email,
      subject: `Counter-offer on "${offer.product_title}"`,
      html: `<h2>Counter-Offer</h2><p>Your offer of $${offer.offer_price} received a counter of <strong>$${counter_price}</strong>.</p>${owner_note ? `<p>${owner_note}</p>` : ''}`,
    });
  } catch (e) { console.error('Email failed:', e.message); }
  res.json({ status: 'countered', counter_price });
});

app.post('/owner/offers/:id/decline', ownerAuth, async (req, res) => {
  const { owner_note } = req.body;
  const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE offers SET status = 'declined', owner_note = ?, updated_at = datetime('now') WHERE id = ?`).run(owner_note ?? null, offer.id);
  try {
    await mailer.sendMail({
      from: `3rd Floor Tapes <${SMTP_USER}>`,
      to: offer.buyer_email,
      subject: `Your offer on "${offer.product_title}"`,
      html: `<h2>Offer Update</h2><p>Unfortunately your offer was not accepted this time.</p>${owner_note ? `<p>${owner_note}</p>` : ''}`,
    });
  } catch (e) { console.error('Email failed:', e.message); }
  res.json({ status: 'declined' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

