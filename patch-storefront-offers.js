#!/usr/bin/env node
'use strict';

/**
 * Installs the storefront offers endpoint into server.js.
 *
 *   node patch-storefront-offers.js
 *
 * Two changes:
 *   1. Appends the /storefront-offers routes (from storefront-offers-block.js)
 *   2. Filters 'pending_card' out of the admin offers list, so abandoned
 *      card setups don't clutter the queue. The admin query currently has
 *      no WHERE clause and returns every row.
 *
 * Writes server.js.backup. Re-running is a no-op.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'server.js');
const BLOCK = path.join(__dirname, 'storefront-offers-block.js');

if (!fs.existsSync(BLOCK)) {
  console.error('Missing storefront-offers-block.js - unzip it into this folder first.');
  process.exit(1);
}

let src = fs.readFileSync(FILE, 'utf8');
const original = src;

if (src.includes('/storefront-offers')) {
  console.log('Already patched.');
  process.exit(0);
}

// --- 1. Hide pending_card offers from the admin queue -----------------------
const adminOld =
  "'SELECT id, buyer_name, buyer_email, message, open_to_counter, items, status, counter_note, created_at, updated_at FROM offers ORDER BY created_at DESC'";
const adminNew =
  "'SELECT id, buyer_name, buyer_email, message, open_to_counter, items, status, counter_note, created_at, updated_at FROM offers WHERE status != \\'pending_card\\' ORDER BY created_at DESC'";

const adminCount = src.split(adminOld).length - 1;
if (adminCount !== 1) {
  console.error(
    'FAILED: admin offers query matched ' + adminCount + ' times (expected 1). Nothing written.'
  );
  process.exit(1);
}
src = src.replace(adminOld, adminNew);
console.log('ok: admin queue now hides pending_card offers');

// --- 2. Append the storefront routes ----------------------------------------
const block = fs.readFileSync(BLOCK, 'utf8');
src = src.trimEnd() + '\n\n' + block;
console.log('ok: added /storefront-offers routes');

fs.writeFileSync(FILE + '.backup', original);
fs.writeFileSync(FILE, src);
console.log('\nPatched server.js (backup saved as server.js.backup)');
console.log('Run: node -c server.js   then commit and push.');
