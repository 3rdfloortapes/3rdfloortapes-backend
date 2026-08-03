#!/usr/bin/env node
'use strict';

/**
 * Replaces the earlier storefront-offers implementation with the corrected one.
 *
 *   node patch-offers-fix.js
 *
 * Why: the offers table enforces
 *   CHECK(status IN ('pending','accepted','countered','declined'))
 * and the previous version tried to insert 'pending_card', so every offer
 * failed at the INSERT. SQLite can't alter a CHECK constraint without
 * rebuilding the table, and that table holds live offers - so instead the
 * offer is now created only after the card is saved, carrying its details in
 * the Stripe session metadata. Status is plain 'pending', exactly like the app.
 *
 * Also reverts the admin-queue filter, which is no longer needed: 'pending_card'
 * rows never exist now, so there's nothing to hide.
 *
 * Writes server.js.backup. Safe to re-run.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'server.js');
const BLOCK = path.join(__dirname, 'storefront-offers-v2.js');

if (!fs.existsSync(BLOCK)) {
  console.error('Missing storefront-offers-v2.js - unzip it here first.');
  process.exit(1);
}

let src = fs.readFileSync(FILE, 'utf8');
const original = src;

function cutBlock(startMarker, endMarker, label) {
  const start = src.indexOf(startMarker);
  if (start === -1) {
    console.log('  (no existing ' + label + ' block found - nothing to remove)');
    return;
  }
  const end = src.indexOf(endMarker);
  if (end === -1) {
    console.error('FAILED: found the start of ' + label + ' but not its end marker.');
    process.exit(1);
  }
  src = src.slice(0, start) + src.slice(end + endMarker.length);
  console.log('  ok: removed old ' + label + ' block');
}

console.log('Removing superseded blocks:');
cutBlock(
  '// ===== OFFERS RELIABILITY: WEBHOOKS + CLEANUP =====',
  '// ===== END OFFERS RELIABILITY =====',
  'reliability'
);
cutBlock(
  '// ===== STOREFRONT OFFERS (Shopify entry point into the existing offers flow) =====',
  '// ===== END STOREFRONT OFFERS =====',
  'storefront offers'
);
cutBlock(
  '// ===== STOREFRONT OFFERS =====',
  '// ===== END STOREFRONT OFFERS =====',
  'storefront offers (v2)'
);

// Revert the admin filter - pending_card rows no longer exist.
const filtered =
  "'SELECT id, buyer_name, buyer_email, message, open_to_counter, items, status, counter_note, created_at, updated_at FROM offers WHERE status != \\'pending_card\\' ORDER BY created_at DESC'";
const plain =
  "'SELECT id, buyer_name, buyer_email, message, open_to_counter, items, status, counter_note, created_at, updated_at FROM offers ORDER BY created_at DESC'";

if (src.includes(filtered)) {
  src = src.replace(filtered, plain);
  console.log('  ok: reverted admin queue filter');
}

// Raw body capture must survive - both webhooks need it for signatures.
if (!src.includes('req.rawBody = buf')) {
  const jsonOld = 'app.use(express.json());';
  if (src.split(jsonOld).length - 1 !== 1) {
    console.error('FAILED: could not find express.json() to add raw body capture.');
    process.exit(1);
  }
  src = src.replace(
    jsonOld,
    'app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));'
  );
  console.log('  ok: express.json captures raw body');
} else {
  console.log('  ok: raw body capture already present');
}

src = src.trimEnd() + '\n\n' + fs.readFileSync(BLOCK, 'utf8');
console.log('  ok: added corrected storefront offers block');

// One-time repair endpoint for offers already written with string prices.
// Removes itself is not automatic - see REPAIR note printed at the end.
if (!src.includes('/admin-repair-offer-prices')) {
  src +=
    "\n\n// ===== TEMP: one-time repair of string prices in offers.items =====\n" +
    "// Early storefront offers stored offer_price/list_price as strings, which\n" +
    "// crashes the app dashboard's reduce().toFixed(). Converts them to numbers.\n" +
    "app.post('/admin-repair-offer-prices', async (req, res) => {\n" +
    "  if (req.query.secret !== 'repair-offer-prices-once') {\n" +
    "    return res.status(403).json({ error: 'Forbidden' });\n" +
    "  }\n" +
    "  try {\n" +
    "    const database = await getDb();\n" +
    "    const result = database.exec('SELECT id, items FROM offers');\n" +
    "    const rows = result.length ? result[0].values : [];\n" +
    "    let fixed = 0;\n" +
    "    for (const [id, itemsJson] of rows) {\n" +
    "      let items;\n" +
    "      try { items = JSON.parse(itemsJson); } catch (e) { continue; }\n" +
    "      if (!Array.isArray(items)) continue;\n" +
    "      let touched = false;\n" +
    "      const next = items.map((item) => {\n" +
    "        const copy = Object.assign({}, item);\n" +
    "        if (typeof copy.offer_price === 'string') { copy.offer_price = parseFloat(copy.offer_price); touched = true; }\n" +
    "        if (typeof copy.list_price === 'string') { copy.list_price = parseFloat(copy.list_price); touched = true; }\n" +
    "        return copy;\n" +
    "      });\n" +
    "      if (!touched) continue;\n" +
    "      database.run('UPDATE offers SET items = ? WHERE id = ?', [JSON.stringify(next), id]);\n" +
    "      fixed += 1;\n" +
    "    }\n" +
    "    if (fixed) saveDb();\n" +
    "    res.json({ repaired: fixed });\n" +
    "  } catch (e) {\n" +
    "    console.error('[repair] failed:', e.message);\n" +
    "    res.status(500).json({ error: e.message });\n" +
    "  }\n" +
    "});\n" +
    "// ===== END TEMP REPAIR =====\n";
  console.log('  ok: added one-time price repair endpoint');
}

fs.writeFileSync(FILE + '.backup', original);
fs.writeFileSync(FILE, src);
console.log('\nPatched server.js (backup saved as server.js.backup)');
console.log('Run: node -c server.js   then commit and push.');
