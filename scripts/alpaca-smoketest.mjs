#!/usr/bin/env node
// =============================================================================
// alpaca-smoketest.mjs — validate the Alpaca adapter against a REAL account.
//
// READ-ONLY: hits account, clock, positions, and the latest-price data endpoint.
// It confirms your keys, base URLs, and the response shapes the worker depends
// on — without placing any order. Run this before trusting the worker.
//
// Usage (PowerShell):
//   $env:ALPACA_KEY="...";  $env:ALPACA_SECRET="..."; node scripts/alpaca-smoketest.mjs
// Usage (bash):
//   ALPACA_KEY=... ALPACA_SECRET=... node scripts/alpaca-smoketest.mjs
//
// Env:
//   ALPACA_KEY, ALPACA_SECRET   (required)
//   ALPACA_BASE   default https://paper-api.alpaca.markets  (use the live base only deliberately)
//   ALPACA_DATA   default https://data.alpaca.markets
//   SYMBOL        default AAPL
//
// To exercise the ORDER path, don't add it here — run the worker against paper:
//   DRY_RUN=false ONLY_UID=<your-uid> node scripts/auto-trade.mjs
// =============================================================================

import { createAlpacaClient } from '../src/broker/alpaca.js';

const apiKey = process.env.ALPACA_KEY;
const apiSecret = process.env.ALPACA_SECRET;
const baseUrl = process.env.ALPACA_BASE || 'https://paper-api.alpaca.markets';
const dataBaseUrl = process.env.ALPACA_DATA || 'https://data.alpaca.markets';
const symbol = process.env.SYMBOL || 'AAPL';

if (!apiKey || !apiSecret) {
  console.error('Set ALPACA_KEY and ALPACA_SECRET in the environment.');
  process.exit(2);
}

const live = /\/\/api\.alpaca\.markets/.test(baseUrl);
console.log(`[smoketest] base=${baseUrl} ${live ? '*** LIVE ACCOUNT ***' : '(paper)'} data=${dataBaseUrl} symbol=${symbol}`);

const client = createAlpacaClient({ baseUrl, apiKey, apiSecret, dataBaseUrl });

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

try {
  const acct = await client.getAccount();
  ok('getAccount', Number.isFinite(acct.equity) && !!acct.status,
    `status=${acct.status} equity=$${acct.equity?.toFixed(2)} buyingPower=$${acct.buyingPower?.toFixed(2)}`);

  const clock = await client.getClock();
  ok('getClock', typeof clock.isOpen === 'boolean',
    `marketOpen=${clock.isOpen} nextOpen=${clock.nextOpen}`);

  const positions = await client.getPositions();
  ok('getPositions', Array.isArray(positions), `${positions.length} open`);

  const price = await client.getLatestPrice(symbol);
  ok('getLatestPrice', Number.isFinite(price), `${symbol}=$${price}`);
  if (price == null) {
    console.log('    (note: latest-price needs market-data entitlement; free IEX data works for paper)');
  }
} catch (e) {
  console.error(`  ✗ request threw: ${e.message}`);
  failures++;
}

console.log(failures ? `\n[smoketest] FAILED (${failures})` : '\n[smoketest] OK — adapter talks to Alpaca correctly.');
process.exit(failures ? 1 : 0);
