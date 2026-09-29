// Sum realized PNL from "paper sell" log lines dumped to %TEMP%\sells.txt
const fs = require('fs');
const path = require('path');
const raw = fs.readFileSync(path.join(process.env.TEMP, 'sells.txt'), 'utf8');
const lines = raw.split('\n').filter((l) => l.includes('paper sell'));
const sells = [];
for (const l of lines) {
  const m = l.match(/token="([^"]+)"[\s\S]*?pnlUsd=(-?[0-9.eE+-]+)/);
  if (m) sells.push({ t: m[1], pnl: parseFloat(m[2]) });
}
sells.sort((a, b) => b.pnl - a.pnl);
console.log('sells logged:', sells.length);
console.log('sum pnl:', sells.reduce((s, x) => s + x.pnl, 0).toFixed(2));
console.log('top 8:');
sells.slice(0, 8).forEach((x) => console.log('  ', x.t, x.pnl >= 0 ? '+' : '', x.pnl.toFixed(2)));
console.log('bottom 5:');
sells.slice(-5).forEach((x) => console.log('  ', x.t, x.pnl.toFixed(2)));
