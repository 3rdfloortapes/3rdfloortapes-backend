const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const {
  OWNER_EMAIL = 'support@3rdfloortapes.com',
  SMTP_HOST = 'smtp.gmail.com',
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  API_SECRET = '3rdfloor2026secret',
  PORT = 3000,
} = process.env;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: parseInt(SMTP_PORT),
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

app.post('/offers', async (req, res) => {
  try {
    const {
      product_title,
      product_id,
      variant_id,
      list_price,
      offer_price,
      buyer_name,
      buyer_email,
      message,
      multi_item,
      open_to_counter,
    } = req.body;

    if (!product_title || !offer_price || !buyer_name || !buyer_email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const id = crypto.randomUUID();
    const savings = (list_price - offer_price).toFixed(2);
    const savingsPct = Math.round(((list_price - offer_price) / list_price) * 100);

    const emailHtml = `
      <h2>New Offer — 3rd Floor Tapes App</h2>
      <table style="border-collapse:collapse;width:100%">
        <tr><td><b>Item</b></td><td>${product_title}</td></tr>
        <tr><td><b>List Price</b></td><td>$${parseFloat(list_price).toFixed(2)}</td></tr>
        <tr><td><b>Offer Price</b></td><td>$${parseFloat(offer_price).toFixed(2)} (${savingsPct}% off, saves $${savings})</td></tr>
        <tr><td><b>Buyer</b></td><td>${buyer_name}</td></tr>
        <tr><td><b>Email</b></td><td>${buyer_email}</td></tr>
        <tr><td><b>Multiple Items?</b></td><td>${multi_item ? 'YES — send invoice if accepted' : 'No — single item'}</td></tr>
        <tr><td><b>Open to Counter?</b></td><td>${open_to_counter ? 'YES' : 'No'}</td></tr>
        ${message ? `<tr><td><b>Message</b></td><td>${message}</td></tr>` : ''}
        <tr><td><b>Offer ID</b></td><td>${id}</td></tr>
      </table>
    `;

    await transporter.sendMail({
      from: `"3rd Floor Tapes" <${SMTP_USER}>`,
      to: OWNER_EMAIL,
      replyTo: buyer_email,
      subject: `New Offer: ${buyer_name} offered $${parseFloat(offer_price).toFixed(2)} for ${product_title}`,
      html: emailHtml,
    });

    res.json({ status: 'ok', id });
  } catch (e) {
    console.error('Offer error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
