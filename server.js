const express = require('express');
const crypto = require('crypto');
const Stripe = require('stripe');

const app = express();
app.use(express.json());

const {
  OWNER_EMAIL = 'support@3rdfloortapes.com',
  RESEND_API_KEY,
  FROM_EMAIL = 'onboarding@resend.dev',
  STRIPE_SECRET_KEY,
  PORT = 3000,
} = process.env;

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
      cancel_url: 'https://3rdfloortapes.com/pages/offer-card-cancelled',
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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
