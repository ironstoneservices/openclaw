import { createRequire } from 'module'; const require = createRequire(import.meta.url); require('dotenv').config();
import fetch from 'node-fetch';
import cron from 'node-cron';

const CONFIG = {
  telegram: { token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID },
  groq: { apiKey: process.env.GROQ_API_KEY, model: 'llama-3.1-8b-instant' },
  google: { apiKey: process.env.GOOGLE_MAPS_API_KEY },
  sam: { apiKey: process.env.SAM_API_KEY || null, baseUrl: 'https://api.sam.gov/opportunities/v2/search' },
  ironstone: {
    naicsCodes: ['561720','561730','562111','561210','561740','561990','238320'],
    states: ['GA','SC','FL','TN'],
    minAmount: 10000, maxAmount: 350000,
    setAsideTypes: ['SBA','HZC','HZS','SBP'],
  },
};

async function sendTelegram(message) {
  const res = await fetch(`https://api.telegram.org/bot${CONFIG.telegram.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CONFIG.telegram.chatId, text: message, parse_mode: 'Markdown' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram error: ${JSON.stringify(data)}`);
  return data;
}

async function fetchSAMOpportunities() {
  if (!CONFIG.sam.apiKey || CONFIG.sam.apiKey === 'your_sam_key_here') {
    console.log('SAM_API_KEY not set — using mock data');
    return getMockOpportunities();
  }
  const opportunities = [];
  const postedFrom = new Date(Date.now() - 48*60*60*1000).toISOString().split('T')[0].replace(/-/g,'/');
  for (const naics of CONFIG.ironstone.naicsCodes) {
    for (const state of CONFIG.ironstone.states) {
      try {
        const params = new URLSearchParams({ api_key: CONFIG.sam.apiKey, naicsCode: naics, placeOfPerformanceState: state, postedFrom, limit: '25', active: 'Yes' });
        const res = await fetch(`${CONFIG.sam.baseUrl}?${params}`);
        const data = await res.json();
        if (data.opportunitiesData) opportunities.push(...data.opportunitiesData.filter(o => (o.award?.amount||0) >= CONFIG.ironstone.minAmount && (o.award?.amount||0) <= CONFIG.ironstone.maxAmount));
        await sleep(500);
      } catch(e) { console.error(`SAM error ${naics}/${state}: ${e.message}`); }
    }
  }
  const seen = new Set();
  return opportunities.filter(o => { if(seen.has(o.noticeId)) return false; seen.add(o.noticeId); return true; });
}

function getMockOpportunities() {
  return [
    { noticeId:'MOCK-001', title:'Janitorial Services — Federal Building Atlanta GA', naicsCode:'561720', placeOfPerformanceState:'GA', placeOfPerformanceCity:'Atlanta', responseDeadLine: new Date(Date.now()+14*24*60*60*1000).toISOString(), award:{amount:85000}, typeOfSetAside:'SBA', uiLink:'https://sam.gov', isMock:true },
    { noticeId:'MOCK-002', title:'Grounds Maintenance — Canton National Cemetery', naicsCode:'561730', placeOfPerformanceState:'GA', placeOfPerformanceCity:'Canton', responseDeadLine: new Date(Date.now()+21*24*60*60*1000).toISOString(), award:{amount:239000}, typeOfSetAside:'SBA', uiLink:'https://sam.gov', isMock:true },
  ];
}

const NAICS_TO_SEARCH = { '561720':'janitorial cleaning service','561730':'landscaping lawn care service','562111':'waste removal hauling service','561210':'facility management service','561740':'carpet cleaning service','561990':'building maintenance service','238320':'commercial painting contractor' };

async function findNearbySubcontractors(city, state, naicsCode) {
  const searchTerm = NAICS_TO_SEARCH[naicsCode] || 'facility services contractor';
  try {
    const geoRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(city+', '+state)}&key=${CONFIG.google.apiKey}`);
    const geoData = await geoRes.json();
    if (!geoData.results?.length) return [];
    const { lat, lng } = geoData.results[0].geometry.location;
    const placesRes = await fetch(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=40000&keyword=${encodeURIComponent(searchTerm)}&type=establishment&key=${CONFIG.google.apiKey}`);
    const placesData = await placesRes.json();
    if (!placesData.results) return [];
    return placesData.results.slice(0,5).map(p => ({ name:p.name, address:p.vicinity, rating:p.rating||'N/A' }));
  } catch(e) { console.error(`Google Places error: ${e.message}`); return []; }
}

async function generateOutreachEmail(subName, subAddress, opportunity) {
  const prompt = `Write a short professional subcontractor outreach email (under 150 words) from Brett Manning, Co-Founder of Ironstone Services LLC (federal prime contractor in Georgia) to ${subName} at ${subAddress}. Contract: ${opportunity.title} in ${opportunity.placeOfPerformanceCity}, ${opportunity.placeOfPerformanceState}. NAICS: ${opportunity.naicsCode}. Value: $${(opportunity.award?.amount||0).toLocaleString()}. Deadline: ${new Date(opportunity.responseDeadLine).toLocaleDateString()}. Key points: Ironstone is the prime seeking a local sub, federal contract means guaranteed payment net-30, ask if interested and request license/insurance info. Sign off: Brett Manning, Co-Founder, Ironstone Services LLC, 678-707-9801, ironstoneservicesllc@gmail.com. Email body only.`;
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers:{ Authorization:`Bearer ${CONFIG.groq.apiKey}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ model:CONFIG.groq.model, messages:[{role:'user',content:prompt}], max_tokens:300, temperature:0.7 }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || 'Email generation failed.';
}

async function processOpportunity(opp, dryRun=false) {
  const deadline = new Date(opp.responseDeadLine);
  const daysLeft = Math.ceil((deadline - Date.now())/(1000*60*60*24));
  const city = opp.placeOfPerformanceCity||'Unknown';
  const state = opp.placeOfPerformanceState||'';
  const alert = `🦅 *NEW OPPORTUNITY${opp.isMock?' [MOCK TEST]':''}*\n*${opp.title}*\n\n📍 ${city}, ${state}\n💰 ~$${(opp.award?.amount||0).toLocaleString()}\n🏷️ NAICS: ${opp.naicsCode} | Set-Aside: ${opp.typeOfSetAside||'None'}\n⏰ Due: ${deadline.toLocaleDateString()} (${daysLeft} days)\n🔗 ${opp.uiLink||'sam.gov'}`;
  if (!dryRun) await sendTelegram(alert);
  else console.log('[DRY RUN] Telegram alert:\n', alert);
  console.log(`  Finding subs near ${city}, ${state}...`);
  const subs = await findNearbySubcontractors(city, state, opp.naicsCode);
  console.log(`  Found ${subs.length} subs`);
  for (const sub of subs.slice(0,3)) {
    const email = await generateOutreachEmail(sub.name, sub.address, opp);
    if (!dryRun) await sendTelegram(`📧 *Sub: ${sub.name}*\n📍 ${sub.address}\n⭐ ${sub.rating}\n\n_Draft outreach ready_`);
    else console.log(`\n[DRY RUN] Sub: ${sub.name}\nEmail preview: ${email.substring(0,150)}...`);
    await sleep(1000);
  }
}

async function runCycle(options={}) {
  const { dryRun=false, reportOnly=false } = options;
  console.log(`\n🦅 OpenClaw cycle — ${new Date().toLocaleString()}`);
  const opportunities = await fetchSAMOpportunities();
  console.log(`Found ${opportunities.length} opportunities`);
  if (reportOnly) {
    const now = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
    const report = `☀️ *IRONSTONE MORNING REPORT — ${now}*\n\n📋 New Opportunities: ${opportunities.length}\n\n`+(opportunities.length>0?opportunities.map((o,i)=>`${i+1}. ${o.title}\n   $${(o.award?.amount||0).toLocaleString()} | ${o.placeOfPerformanceCity}, ${o.placeOfPerformanceState} | Due: ${new Date(o.responseDeadLine).toLocaleDateString()}`).join('\n\n'):'No new opportunities in last 48 hours.')+'\n\n⚙️ Next check in 2 hours.\n_Ironstone OpenClaw v1.0_';
    await sendTelegram(report);
    return;
  }
  for (const opp of opportunities) {
    console.log(`\n→ ${opp.title}`);
    await processOpportunity(opp, dryRun);
    await sleep(2000);
  }
}

async function runTest() {
  console.log('\n🧪 OPENCLAW SYSTEM TEST\n');
  const results = { telegram:false, groq:false, google:false };
  try {
    await sendTelegram('🦅 *OpenClaw Test* — Telegram connection confirmed. System is online.');
    results.telegram = true;
    console.log('✅ Telegram — connected');
  } catch(e) { console.log('❌ Telegram —', e.message); }
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', { method:'POST', headers:{Authorization:`Bearer ${CONFIG.groq.apiKey}`,'Content-Type':'application/json'}, body:JSON.stringify({model:CONFIG.groq.model,messages:[{role:'user',content:'Say: Groq confirmed.'}],max_tokens:20}) });
    const d = await res.json();
    if (d.choices?.[0]) results.groq = true;
    console.log('✅ Groq AI — connected');
  } catch(e) { console.log('❌ Groq —', e.message); }
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=Atlanta,GA&key=${CONFIG.google.apiKey}`);
    const d = await res.json();
    if (d.results?.length>0) results.google = true;
    console.log('✅ Google Maps — connected');
  } catch(e) { console.log('❌ Google Maps —', e.message); }
  const samStatus = CONFIG.sam.apiKey && CONFIG.sam.apiKey !== 'your_sam_key_here' ? '✅' : '⏳ Pending key';
  const summary = `\n🦅 *OpenClaw Test Results*\nTelegram: ${results.telegram?'✅':'❌'}\nGroq AI: ${results.groq?'✅':'❌'}\nGoogle Maps: ${results.google?'✅':'❌'}\nSAM.gov: ${samStatus}\n\n${Object.values(results).filter(Boolean).length>=3?'🟢 System ready to go live':'🔴 Fix errors above'}`;
  await sendTelegram(summary);
  console.log(summary.replace(/\*/g,''));
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--test')) { await runTest(); return; }
  if (args.includes('--dry-run')) { await runCycle({dryRun:true}); return; }
  if (args.includes('--report')) { await runCycle({reportOnly:true}); return; }
  console.log('🦅 OpenClaw LIVE — starting...');
  await sendTelegram('🦅 *OpenClaw is online.* Monitoring SAM.gov every 2 hours. Morning reports at 7:00 AM.');
  await runCycle();
  cron.schedule('0 */2 * * *', async () => { await runCycle(); });
  cron.schedule('0 7 * * *', async () => { await runCycle({reportOnly:true}); });
  console.log('\n✅ OpenClaw running. Ctrl+C to stop. Use pm2 to run permanently.\n');
}

main().catch(err => { console.error('💥 OpenClaw crashed:', err); process.exit(1); });
