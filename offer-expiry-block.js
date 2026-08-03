// ===== OFFER EXPIRATION =====
//
// Offers auto-expire 48 hours after submission if not actioned.
//
// Uses status 'declined' with void_reason = 'expired', since the offers table
// enforces CHECK(status IN ('pending','accepted','countered','declined')) and
// that constraint cannot be altered without rebuilding a live table.
//
// No cron/scheduler on this host, so expiration runs opportunistically: any
// time the admin queue is read or an offer is created, stale offers are swept
// first. That means they clear the moment Steve looks at the dashboard, which
// is when it actually matters.

const OFFER_EXPIRY_HOURS = 48;

let expiryRunning = false;

async function expireStaleOffers() {
  // Guard against overlapping runs - the sweep sends emails, and two
  // concurrent passes could double-send.
  if (expiryRunning) return 0;
  expiryRunning = true;

  try {
    const database = await getDb();
    ensureOfferColumns(database);

    const cutoff = new Date(
      Date.now() - OFFER_EXPIRY_HOURS * 60 * 60 * 1000
    ).toISOString();

    const result = database.exec(
      "SELECT id, buyer_name, buyer_email, items FROM offers " +
        "WHERE status = 'pending' AND created_at < ?",
      [cutoff]
    );
    const rows = result.length ? result[0].values : [];
    if (!rows.length) return 0;

    const now = new Date().toISOString();
    const notify = [];

    // Write all the status changes first, then send emails. Keeps the DB
    // transaction short and means a mail failure can't leave rows unexpired.
    for (const [id, buyerName, buyerEmail, itemsJson] of rows) {
      database.run(
        "UPDATE offers SET status = 'declined', void_reason = 'expired', updated_at = ? WHERE id = ?",
        [now, id]
      );
      let items = [];
      try {
        items = JSON.parse(itemsJson) || [];
      } catch (e) {
        items = [];
      }
      notify.push({ id, buyerName, buyerEmail, items });
    }
    saveDb();

    for (const entry of notify) {
      if (!entry.buyerEmail) continue;
      try {
        await sendOfferExpiredEmail({
          buyer_name: entry.buyerName,
          buyer_email: entry.buyerEmail,
          items: entry.items,
        });
      } catch (e) {
        console.error(
          '[offer-expiry] expired ' + entry.id + ' but email failed:',
          e.message
        );
      }
    }

    console.log('[offer-expiry] expired ' + notify.length + ' offer(s)');
    return notify.length;
  } catch (e) {
    console.error('[offer-expiry] failed:', e.message);
    return 0;
  } finally {
    expiryRunning = false;
  }
}

async function sendOfferExpiredEmail({ buyer_name, buyer_email, items }) {
  const total = (items || []).reduce(
    (sum, i) => sum + (parseFloat(i.offer_price) || 0),
    0
  );
  const itemRows = (items || [])
    .map(
      (i) =>
        '<li>' +
        (i.product_title || 'Item') +
        ' &mdash; $' +
        (parseFloat(i.offer_price) || 0).toFixed(2) +
        '</li>'
    )
    .join('');

  const bodyHtml =
    '<h2>Hi ' + (buyer_name || 'there') + ',</h2>' +
    '<p>Your offer of $' + total.toFixed(2) + ' on the following item(s) has expired:</p>' +
    '<ul>' + itemRows + '</ul>' +
    '<p>No charge was made, and the hold on your card has been released. ' +
    'The tape may still be available &mdash; feel free to make another offer or grab it outright.</p>' +
    '<p>Thanks for shopping with us.<br>3rd Floor Tapes</p>';

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `3rd Floor Tapes <${FROM_EMAIL}>`,
      to: buyer_email,
      subject: 'Your offer has expired — 3rd Floor Tapes',
      html: bodyHtml,
    }),
  });

  if (!resendRes.ok) {
    const errText = await resendRes.text();
    throw new Error(`Resend error: ${errText}`);
  }
}

// Manual trigger, useful for testing without waiting 48 hours.
app.post('/admin-expire-offers', requireAuth, requireAdmin, async (req, res) => {
  const expired = await expireStaleOffers();
  res.json({ expired });
});
// ===== END OFFER EXPIRATION =====
