import fs from 'fs';

let code = fs.readFileSync('usaspending.js', 'utf8');

// Fix 1: Add persistent memory to scanContracts
code = code.replace(
  'async function scanContracts(dryRun = false) {',
  `async function scanContracts(dryRun = false) {
  const seenFile = './data/seen_awards.json';
  let persistentSeen = new Set();
  try {
    if (fs.existsSync(seenFile)) {
      const saved = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
      persistentSeen = new Set(saved);
    }
  } catch(e) { console.log('Starting fresh seen list.'); }`
);

// Fix 2: After targets filtered, split into new vs seen
code = code.replace(
  "console.log(`\\n📋 Total contracts pulled: ${allResults.length}`);",
  `console.log(\`\\n📋 Total contracts pulled: \${allResults.length}\`);
  const newTargets = dryRun ? targets : targets.filter(c => c['Award ID'] && !persistentSeen.has(c['Award ID']));
  if (!dryRun) {
    const allIds = [...persistentSeen, ...targets.map(c => c['Award ID']).filter(Boolean)];
    fs.mkdirSync('./data', { recursive: true });
    fs.writeFileSync(seenFile, JSON.stringify([...new Set(allIds)], null, 2));
  }`
);

// Fix 3: Use newTargets for alerts
code = code.replace(
  'for (const c of targets.slice(0, 15)) {',
  'for (const c of (dryRun ? targets : newTargets).slice(0, 15)) {'
);

// Fix 4: Full descriptions
code = code.replace(
  "(c['Description'] || 'Federal Contract').substring(0, 70)",
  "c['Description'] || 'Federal Contract'"
);

fs.writeFileSync('usaspending.js', code);
console.log('Both fixes applied.');
