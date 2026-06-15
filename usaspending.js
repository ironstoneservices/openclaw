import 'dotenv/config';
import fetch from 'node-fetch';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CONFIG = {
  naicsCodes: ['561720', '561730', '562111', '561210', '561740', '561790', '561990', '238320', '238390'],
  states: ['GA', 'SC', 'FL', 'TN'],
  baseUrl: 'https://api.usaspending.gov/api/v2',
};

// USAspending state FIPS codes
const STATE_FIPS = { GA: '13', SC: '45', FL: '12', TN: '47' };

const WATCH_LIST = [
  'NATIVE CONTRACTORS, INC.',
  'KEEP IT CLEAN',
  'CUSTOM LAWN SERVICE, INC.',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' }),
  });
}

async function apiPost(endpoint, body) {
  try {
    const res = await fetch(`${CONFIG.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`  HTTP ${res.status}: ${text.substring(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error(`  Fetch error: ${e.message}`);
    return null;
  }
}

async function searchContracts(naicsCode, state) {
  const body = {
    subawards: false,
    limit: 25,
    page: 1,
    filters: {
      award_type_codes: ['A', 'B', 'C', 'D'],
      naics_codes: [naicsCode],
      place_of_performance_scope: 'domestic',
      place_of_performance_locations: [{ country: 'USA', state: state }],
      time_period: [{ start_date: '2023-01-01', end_date: '2027-12-31' }],
    },
    fields: [
      'Award ID', 'Recipient Name', 'Award Amount',
      'Start Date', 'End Date',
      'Awarding Agency', 'Awarding Sub Agency',
      'Description', 'Place of Performance City Name',
      'Place of Performance State Code', 'NAICS Code',
      'Type of Set Aside', 'Contract Award Type',
    ],
    sort: 'End Date',
    order: 'asc',
  };

  const data = await apiPost('/search/spending_by_award/', body);
  return data?.results || [];
}

async function searchIncumbent(name) {
  const body = {
    subawards: false,
    limit: 20,
    page: 1,
    filters: {
      award_type_codes: ['A', 'B', 'C', 'D'],
      recipient_search_text: [name],
      time_period: [{ start_date: '2020-01-01', end_date: '2028-12-31' }],
    },
    fields: [
      'Award ID', 'Recipient Name', 'Award Amount',
      'Start Date', 'End Date',
      'Awarding Agency', 'Description',
      'Place of Performance City Name',
      'Place of Performance State Code', 'NAICS Code',
    ],
    sort: 'End Date',
    order: 'asc',
  };

  const data = await apiPost('/search/spending_by_award/', body);
  return data?.results || [];
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr) - Date.now()) / (1000 * 60 * 60 * 24));
}

function formatContract(c) {
  const days = daysUntil(c['End Date']);
  const daysLabel = days === null ? 'Unknown'
    : days < 0 ? `EXPIRED ${Math.abs(days)}d ago`
    : `${days}d remaining`;
  const amount = c['Award Amount'] ? `$${Number(c['Award Amount']).toLocaleString()}` : 'TBD';
  return [
    `🎯 RE-COMPETE TARGET`,
    `${(c['Description'] || 'Federal Contract').substring(0, 70)}`,
    `Incumbent: ${c['Recipient Name'] || 'Unknown'}`,
    `Location: ${c['Place of Performance City Name'] || ''}, ${c['Place of Performance State Code'] || ''}`,
    `Value: ${amount} | NAICS: ${c['NAICS Code'] || 'N/A'}`,
    `Set-Aside: ${c['Type of Set Aside'] || 'None'}`,
    `Period: ${c['Start Date'] || '?'} → ${c['End Date'] || '?'} (${daysLabel})`,
    `Agency: ${c['Awarding Sub Agency'] || c['Awarding Agency'] || 'Unknown'}`,
    `Award ID: ${c['Award ID'] || 'N/A'}`,
  ].join('\n');
}

async function scanContracts(dryRun = false) {
  console.log(`\n🦅 USAspending Scan — ${new Date().toLocaleString()}\n`);
  const allResults = [];
  const seen = new Set();

  for (const naics of CONFIG.naicsCodes) {
    for (const state of CONFIG.states) {
      const results = await searchContracts(naics, state);
      let newCount = 0;
      for (const c of results) {
        const id = c['Award ID'];
        if (id && !seen.has(id)) { seen.add(id); allResults.push(c); newCount++; }
      }
      console.log(`  NAICS ${naics} / ${state}: ${results.length} contracts (${newCount} unique)`);
      await sleep(400);
    }
  }

  const targets = allResults.filter(c => {
    const days = daysUntil(c['End Date']);
    return days !== null && days > -180 && days < 545;
  }).sort((a, b) => new Date(a['End Date']) - new Date(b['End Date']));

  console.log(`\n📋 Total contracts pulled: ${allResults.length}`);
  console.log(`🎯 Re-compete targets (expiring -6mo to +18mo): ${targets.length}\n`);

  if (targets.length === 0) {
    console.log('No targets in window. Try --watchlist to check specific incumbents.');
    return [];
  }

  for (const c of targets.slice(0, 15)) {
    const msg = formatContract(c);
    console.log(msg + '\n' + '─'.repeat(60));
    if (!dryRun) { await sendTelegram(msg); await sleep(1500); }
  }

  return targets;
}

async function incumbentDeepDive(name, dryRun = false) {
  console.log(`\n🔍 Incumbent Deep Dive: ${name}`);
  const contracts = await searchIncumbent(name);

  if (contracts.length === 0) {
    console.log('  No contracts found.');
    return;
  }

  const total = contracts.reduce((s, c) => s + (Number(c['Award Amount']) || 0), 0);
  console.log(`  Contracts found: ${contracts.length} | Total portfolio: $${total.toLocaleString()}\n`);

  for (const c of contracts) {
    const days = daysUntil(c['End Date']);
    const flag = days !== null && days > -180 && days < 545 ? ' ⚠️  EXPIRING' : '';
    const amount = c['Award Amount'] ? `$${Number(c['Award Amount']).toLocaleString()}` : 'TBD';
    console.log(`  ${flag}`);
    console.log(`    ${(c['Description'] || 'Contract').substring(0, 60)}`);
    console.log(`    ${amount} | ${c['Place of Performance City Name']}, ${c['Place of Performance State Code']} | ${c['Start Date']} → ${c['End Date']}`);
    console.log(`    Award ID: ${c['Award ID']}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  if (args.includes('--scan')) {
    await scanContracts(dryRun);
  } else if (args.includes('--watchlist')) {
    for (const name of WATCH_LIST) { await incumbentDeepDive(name, dryRun); await sleep(2000); }
  } else if (args.includes('--incumbent')) {
    const name = args[args.indexOf('--incumbent') + 1];
    if (!name) { console.log('Usage: node usaspending.js --incumbent "COMPANY NAME"'); return; }
    await incumbentDeepDive(name, dryRun);
  } else {
    await scanContracts(dryRun);
    await sleep(2000);
    for (const name of WATCH_LIST) { await incumbentDeepDive(name, dryRun); await sleep(2000); }
  }
}

main().catch(err => { console.error('💥 Crashed:', err); process.exit(1); });
