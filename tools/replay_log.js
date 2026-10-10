/**
 * tools/replay_log.js — 画面から保存した対戦ログ（JSON）を engine で再生して検証する（CG-021）
 *
 *   node tools/replay_log.js ログ.json [ログ2.json ...]
 *
 * ログの settings・seed から初期 state を作り、actions を順に reduce して、
 * 保存された result・plies と一致するかを確かめる（人間のプレイテストのログの健全性確認）。
 */
const fs = require('node:fs');
const path = require('node:path');
const E = require('../js/engine.js');
const cardData = require(path.join(__dirname, '..', 'data', 'cards.js'));

let bad = 0;
for (const file of process.argv.slice(2)) {
  const log = JSON.parse(fs.readFileSync(file, 'utf8'));
  let s = E.createInitialState(log.seed, cardData, log.settings);
  try {
    for (const a of log.actions) s = E.reduce(s, a);
  } catch (e) {
    console.log(`NG ${file}: 再生できない（${e.message}）`);
    bad++;
    continue;
  }
  const same = JSON.stringify(s.result) === JSON.stringify(log.result) && s.ply === (log.plies === null ? s.ply : log.plies);
  console.log(`${same ? 'OK' : 'NG'} ${file}: ${log.actions.length} action・${s.ply} 手・結果 ${JSON.stringify(s.result)}`);
  if (!same) bad++;
}
process.exit(bad ? 1 : 0);
