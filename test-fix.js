import 'dotenv/config';
import fetch from 'node-fetch';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

async function send(msg) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({chat_id: chatId, text: msg, parse_mode:'Markdown'})
  });
}

// Test Groq
const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
  method:'POST',
  headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,'Content-Type':'application/json'},
  body: JSON.stringify({model:'llama3-8b-8192',messages:[{role:'user',content:'Say: Groq confirmed.'}],max_tokens:20})
});
const groqData = await groqRes.json();
const groqOk = !!groqData.choices?.[0];

// Test Google
const geoRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=Atlanta,GA&key=${process.env.GOOGLE_MAPS_API_KEY}`);
const geoData = await geoRes.json();
const googleOk = geoData.results?.length > 0;

await send(`🦅 *OpenClaw Verified Results*\nTelegram: ✅\nGroq AI: ${groqOk?'✅':'❌'}\nGoogle Maps: ${googleOk?'✅':'❌'}\nSAM.gov: ⏳ Pending key\n\n${groqOk&&googleOk?'🟢 All systems go — ready for dry run':'🔴 Check errors'}`);
console.log(`Groq: ${groqOk} | Google: ${googleOk}`);
