import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SAM_API_KEY = process.env.SAM_API_KEY;

const NAICS_CODES = [
  '561720','561730','562111','561210','561740',
  '561990','238320','561791','488490','238910','238990','562910'
];

const TARGET_STATES = [
  'GA','TN','SC','AL','NC','FL','MS','KY','VA','WV','AR','LA'
];

const ELIGIBLE_SET_ASIDES = ['SBA','SBP','HZC','VSB','ISBEE','HZS',''];

const SEEN_FILE = '/Users/ironstoneservices/Ironstone/openclaw/data/seen_sam_opps.json';

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE,'utf8'))); }
  catch { return new Set(); }
}

function saveSeen(seen) {
  const dir = '/Users/ironstoneservices/Ironstone/openclaw/data';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]));
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

async function sendTelegram(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text:message,parse_mode:'HTML',disable_web_page_preview:true})
    });
  } catch(e) { console.error('Telegram error:',e.message); }
}

function getDaysUntil(dateStr) {
  if (!dateStr) return null;
  const diff = Math.ceil((new Date(dateStr) - new Date())/(1000*60*60*24));
  return diff;
}

function urgencyFlag(days) {
  if (days===null) return '📋';
  if (days<=3) return '🚨 URGENT';
  if (days<=7) return '⚡ THIS WEEK';
  if (days<=14) return '📅 2 WEEKS';
  return '📋';
}

function setAsideLabel(code) {
  const map = {
    'SBA':'Total Small Business ✅',
    'SBP':'Small Business Partial ✅',
    'HZC':'HUBZone ✅',
    'HZS':'HUBZone + SB ✅',
    'VSB':'Veteran SB ✅',
    'SDVOSBC':'SDVOSB ❌ skip',
    'SDVOSBP':'SDVOSB Partial ❌ skip',
    '8A':'8(a) ❌ skip',
    'WOSB':'WOSB ❌ skip',
    'EDWOSB':'EDWOSB ❌ skip',
  };
  return map[code] || (code ? code : 'Full & Open ✅');
}

async function fetchSAMOpps(naics, state) {
  const postedFrom = new Date(Date.now() - 45*24*60*60*1000);
  const pf = `${String(postedFrom.getMonth()+1).padStart(2,'0')}/${String(postedFrom.getDate()).padStart(2,'0')}/${postedFrom.getFullYear()}`;

  const params = new URLSearchParams({
    api_key: SAM_API_KEY,
    naics: naics,
    postedFrom: pf,
    limit: '25',
    active: 'Yes',
    typeOfSetAside: '',
  });

  if (state) params.append('state', state);

  try {
    const res = await fetch(`https://api.sam.gov/opportunities/v2/search?${params}`);
    if (!res.ok) { console.error(`SAM ${res.status} ${naics}/${state}`); return []; }
    const data = await res.json();
    return data.opportunitiesData || [];
  } catch(e) {
    console.error(`SAM fetch error ${naics}/${state}:`, e.message);
    return [];
  }
}

export async function runSAMScan() {
  console.log(`\n[SAMclaw] Live SAM scan — ${new Date().toLocaleString()}`);
  const seen = loadSeen();
  const eligible = [];
  const skipped = [];

  for (const naics of NAICS_CODES) {
    for (const state of TARGET_STATES) {
      await sleep(400);
      const opps = await fetchSAMOpps(naics, state);

      for (const opp of opps) {
        const id = opp.noticeId || opp.solicitationNumber;
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const setAside = opp.typeOfSetAside || '';
        const isEligible = ELIGIBLE_SET_ASIDES.includes(setAside);

        const item = {
          id,
          title: opp.title || 'Untitled',
          agency: opp.fullParentPathName || 'Unknown Agency',
          naics,
          state,
          setAside,
          dueDate: opp.responseDeadLine || null,
          solNum: opp.solicitationNumber || id,
          oppId: opp.opportunityId || id,
          co: opp.pointOfContact?.[0] || {},
        };

        if (isEligible) eligible.push(item);
        else skipped.push(item);
      }
    }
    await sleep(800);
  }

  saveSeen(seen);

  console.log(`[SAMclaw] ${eligible.length} eligible | ${skipped.length} skipped`);

  if (eligible.length === 0 && skipped.length === 0) {
    console.log('[SAMclaw] No new opportunities this scan.');
    return;
  }

  if (eligible.length === 0) {
    console.log('[SAMclaw] No eligible new bids — skipped set only.');
    return;
  }

  // Sort soonest first
  eligible.sort((a,b) => {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return new Date(a.dueDate) - new Date(b.dueDate);
  });

  // Header
  await sendTelegram(
    `🎯 <b>IRONSTONE — NEW LIVE BIDS</b>\n` +
    `📡 SAM.gov scan · ${new Date().toLocaleString()}\n` +
    `✅ ${eligible.length} new eligible bids\n` +
    `⛔ ${skipped.length} skipped (wrong set-aside)\n` +
    `─────────────────────`
  );
  await sleep(1000);

  // One alert per eligible bid
  for (const opp of eligible) {
    const days = getDaysUntil(opp.dueDate);
    const flag = urgencyFlag(days);
    const dueStr = opp.dueDate
      ? `${new Date(opp.dueDate).toLocaleDateString()} (${days} days)`
      : 'No deadline listed';
    const coStr = opp.co?.fullName
      ? `${opp.co.fullName}${opp.co.email?' · '+opp.co.email:''}${opp.co.phone?' · '+opp.co.phone:''}`
      : 'Not listed';

    await sendTelegram(
      `${flag}\n` +
      `<b>${opp.title}</b>\n` +
      `📍 ${opp.state} · NAICS ${opp.naics}\n` +
      `🏛 ${opp.agency}\n` +
      `📋 ${setAsideLabel(opp.setAside)}\n` +
      `📅 Due: ${dueStr}\n` +
      `👤 CO: ${coStr}\n` +
      `🔗 <a href="https://sam.gov/opp/${opp.oppId}/view">View on SAM.gov</a>\n` +
      `─────────────────────`
    );
    await sleep(600);
  }
}
