#!/usr/bin/env node
'use strict';

/**
 * Adds 48-hour offer expiration with customer notification.
 *
 *   node patch-offer-expiry.js
 *
 * Expired offers become status 'declined' with void_reason = 'expired', and
 * the buyer gets an email telling them the card hold is released.
 *
 * There is no scheduler on this host, so the sweep runs whenever the admin
 * offers queue is read - i.e. the moment Steve opens the dashboard, which is
 * when stale offers actually matter. A manual POST /admin-expire-offers is
 * also added for testing.
 *
 * Requires the storefront offers block (for ensureOfferColumns).
 * Writes server.js.backup. Safe to re-run.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'server.js');
const BLOCK = path.join(__dirname, 'offer-expiry-block.js');

if (!fs.existsSync(BLOCK)) {
  console.error('Missing offer-expiry-block.js - unzip it here first.');
  process.exit(1);
}

let src = fs.readFileSync(FILE, 'utf8');
const original = src;

if (!src.includes('function ensureOfferColumns')) {
  console.error('Storefront offers block not found. Apply patch-offers-fix.js first.');
  process.exit(1);
}

if (src.includes('expireStaleOffers')) {
  console.log('Already patched.');
  process.exit(0);
}

// Sweep stale offers whenever the admin queue is read.
const adminOld = "app.get('/admin/offers', requireAuth, requireAdmin, async (req, res) => {";
const adminNew =
  "app.get('/admin/offers', requireAuth, requireAdmin, async (req, res) => {\n" +
  "  await expireStaleOffers();";

const count = src.split(adminOld).length - 1;
if (count !== 1) {
  console.error(
    'FAILED: admin offers route matched ' + count + ' times (expected 1). Nothing written.'
  );
  process.exit(1);
}
src = src.replace(adminOld, adminNew);
console.log('ok: admin queue sweeps stale offers on load');

src = src.trimEnd() + '\n\n' + fs.readFileSync(BLOCK, 'utf8');
console.log('ok: added expiration logic and email');

fs.writeFileSync(FILE + '.backup', original);
fs.writeFileSync(FILE, src);
console.log('\nPatched server.js (backup saved as server.js.backup)');
console.log('Run: node -c server.js   then commit and push.');
