#!/usr/bin/env node
'use strict';

/**
 * Installs the offers reliability layer (GPT's four priorities).
 *
 *   node patch-offers-reliability.js
 *
 * Changes:
 *   1. express.json() gains a verify callback that stashes the raw request
 *      body on req.rawBody. Required for BOTH webhook signature checks -
 *      without it the raw bytes are consumed before any route runs.
 *   2. Appends the webhook + cleanup routes.
 *   3. Storefront offers now persist shopify_customer_id.
 *   4. Storefront offer creation expires stale pending_card rows.
 *
 * Requires patch-storefront-offers.js to have been run first.
 * Writes server.js.backup. Re-running is a no-op.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'server.js');
const BLOCK = path.join(__dirname, 'offers-reliability-block.js');

if (!fs.existsSync(BLOCK)) {
  console.error('Missing offers-reliability-block.js - unzip it here first.');
  process.exit(1);
}

let src = fs.readFileSync(FILE, 'utf8');
const original = src;

if (!src.includes('/storefront-offers')) {
  console.error('Storefront offers routes not found. Run patch-storefront-offers.js first.');
  process.exit(1);
}

if (src.includes('/stripe-webhook')) {
  console.log('Already patched.');
  process.exit(0);
}

let failed = false;

function edit(name, from, to) {
  const count = src.split(from).length - 1;
  if (count !== 1) {
    console.error('FAILED: ' + name + ' matched ' + count + ' times (expected 1)');
    failed = true;
    return;
  }
  src = src.replace(from, to);
  console.log('ok: ' + name);
}

// 1. Capture the raw body so webhook signatures can be verified.
edit(
  'express.json captures raw body',
  'app.use(express.json());',
  'app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));'
);

// 3. Persist the Shopify customer ID on storefront offers.
var INSERT_COLS_OLD = "status, stripe_customer_id, created_at, updated_at)\n       VALUES (?, ?, ?, ?, ?, ?, 'pending_card', ?, ?, ?)";
var INSERT_COLS_NEW = "status, stripe_customer_id, shopify_customer_id, created_at, updated_at)\n       VALUES (?, ?, ?, ?, ?, ?, 'pending_card', ?, ?, ?, ?)";
edit('offers INSERT stores shopify_customer_id', INSERT_COLS_OLD, INSERT_COLS_NEW);

edit(
  'offers INSERT params include customer id',
  "        stripeCustomer.id,\n        now,\n        now,\n      ]",
  "        stripeCustomer.id,\n        String(req.shopifyCustomerId),\n        now,\n        now,\n      ]"
);

// 4. Make sure the columns exist and stale rows get expired before inserting.
edit(
  'storefront offer creation runs schema + cleanup',
  "    const database = await getDb();\n    database.run(\n      `INSERT INTO offers (id, buyer_name, buyer_email, message, open_to_counter, items, status, stripe_customer_id, shopify_customer_id, created_at, updated_at)",
  "    const database = await getDb();\n    ensureOfferColumns(database);\n    expirePendingCardOffers(database);\n    database.run(\n      `INSERT INTO offers (id, buyer_name, buyer_email, message, open_to_counter, items, status, stripe_customer_id, shopify_customer_id, created_at, updated_at)"
);

if (failed) {
  console.error('\nNo changes written.');
  process.exit(1);
}

// 2. Append the webhook routes.
src = src.trimEnd() + '\n\n' + fs.readFileSync(BLOCK, 'utf8');
console.log('ok: added webhook + cleanup routes');

fs.writeFileSync(FILE + '.backup', original);
fs.writeFileSync(FILE, src);
console.log('\nPatched server.js (backup saved as server.js.backup)');
console.log('Run: node -c server.js   then commit and push.');
