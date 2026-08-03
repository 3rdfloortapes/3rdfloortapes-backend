#!/usr/bin/env node
'use strict';

/**
 * Adds the required `currency` parameter to the app's /create-setup-session.
 *
 *   node patch-app-setup-currency.js
 *
 * Why: current Stripe API versions reject setup-mode Checkout Sessions without
 * a currency. The storefront hit this and was fixed; the app's route has the
 * same omission and works only because it was created against an older API
 * version. This makes it explicit so it doesn't fail later.
 *
 * Writes server.js.backup. Safe to re-run.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'server.js');
let src = fs.readFileSync(FILE, 'utf8');
const original = src;

const old = `    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: customer.id,`;

const alt = `    const session = await stripe.checkout.sessions.create({
      mode: 'setup',`;

if (src.includes("mode: 'setup',\n      // Required on setup-mode sessions")) {
  // The storefront block already has it; check whether the APP route does too.
  const occurrences = src.split("mode: 'setup',").length - 1;
  const withCurrency = src.split("currency: 'usd',").length - 1;
  if (occurrences === withCurrency) {
    console.log('Already patched - every setup session specifies a currency.');
    process.exit(0);
  }
}

// Find the app's setup session (the one that is NOT already followed by currency).
const marker = "mode: 'setup',";
let idx = -1;
let searchFrom = 0;
while (true) {
  const found = src.indexOf(marker, searchFrom);
  if (found === -1) break;
  const following = src.slice(found, found + 200);
  if (!following.includes("currency:")) {
    idx = found;
    break;
  }
  searchFrom = found + marker.length;
}

if (idx === -1) {
  console.log('Nothing to patch - all setup sessions already specify a currency.');
  process.exit(0);
}

src =
  src.slice(0, idx + marker.length) +
  "\n      // Required on setup-mode sessions in current Stripe API versions." +
  "\n      currency: 'usd'," +
  src.slice(idx + marker.length);

fs.writeFileSync(FILE + '.backup', original);
fs.writeFileSync(FILE, src);
console.log('ok: added currency to the app\'s setup session');
console.log('\nPatched server.js (backup saved as server.js.backup)');
console.log('Run: node -c server.js   then commit and push.');
