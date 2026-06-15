const fs = require('fs');
let code = fs.readFileSync('usaspending.js', 'utf8');
code = code.replace(
  'const allResults = [];',
  'const allResults = [];\n  const globalSeen = new Set();'
);
code = code.replace(
  "if (id && !seen.has(id)) { seen.add(id); allResults.push(c); newCount++; }",
  "if (id && !seen.has(id) && !globalSeen.has(id)) { seen.add(id); globalSeen.add(id); allResults.push(c); newCount++; }"
);
fs.writeFileSync('usaspending.js', code);
console.log('Duplicates fix applied.');
