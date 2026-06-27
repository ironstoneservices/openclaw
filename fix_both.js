const fs = require('fs');
let code = fs.readFileSync('usaspending.js', 'utf8');

// Fix 1: Add persistent seen file to top of scanContracts
code = code.replace(
  'async function scanContracts(dryRun = false) {',
  `async function scanContracts(dryRun = false) {
  // Load persistent seen IDs
  const seenFile = './data/seen_awards.json';
  let persistentSeen = new Set();
  try {
    if (fs.existsSync(seenFile)) {
      const saved = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
      persistentSeen = new Set(saved);
    }
  } catch(e) { console.log('No seen file yet — starting fresh.'); }`
);

// Fix 2: Save new IDs after scan and only alert on new ones
code = code.replace(
  'if (targets.length === 0) {',
  `// Filter to only NEW targets not seen before
  const newTargets = dryRun ? targets : targets.filter(c => {
    const id = c['Award ID'];
    return id && !persistentSeen.has(id);
  });

  // Save all seen IDs
  if (!dryRun) {
    const allIds = [...persistentSeen, ...targets.map(c => c['Award ID']).filter(Boolean)];
    fs.mkdirSync('./data', { recursive: true });
    fs.writeFileSync(seenFile, JSON.stringify([...new Set(allIds)], null, 2));
  }

  console.log(\`📋 Total contracts pulled: \${targets.length} | New since last scan: \${newTargets.length}\`);

  if (newTargets.length === 0 && !dryRun) {
    await sendTelegram('🦅 OpenClaw scan complete — no new targets since last run.');
    return [];
  }

  if (targets.length === 0) {`
);

// Fix 3: Use newTargets for Telegram alerts
code = code.replace(
  'for (const c of targets.slice(0, 15)) {',
  'for (const c of (dryRun ? targets : newTargets).slice(0, 15)) {'
);

// Fix 4: Fix description truncation
code = code.replace(
  "(c['Description'] || 'Federal Contract').substring(0, 70)",
  "c['Description'] || 'Federal Contract'"
);

fs.writeFileSync('usaspending.js', code);
console.log('Both fixes applied.');
