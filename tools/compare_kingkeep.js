/**
 * tools/compare_kingkeep.js — 「キングは勝っても強さが減らない」（rules.kingKeepsStrength）の自動対戦測定（CG-026）
 *
 *   「モック4・キング6・勝った側が減る」で、キングも減る（既定）／キングは減らない、の2列だけを
 *   貪欲同士で同じシード帯に回して docs/research/ に Markdown で書き出す（★ 壊れていない確認と大つかみの影響だけ）。
 *   ★ キングも減るの列は CG-025 の「モック4・キング6 × 減る」と同じ設定。CG-025 の数字と一致するかで、
 *     測定の経路が変わっていないことを確かめる。
 *
 * 使い方:
 *   node tools/compare_kingkeep.js
 *   SIM_GAMES=500 SIM_SEED=1000 SIM_OUT=ファイル名.md node tools/compare_kingkeep.js
 *
 * ★ 測定値には日時・HEAD・シード帯を必ず添える（CLAUDE.md §4.1）。
 *   作業ツリーに未コミットの変更があると、HEAD の横に「未コミットの変更あり」と出す。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const H = require('./harness.js');

const GAMES = Number(process.env.SIM_GAMES || 500);
const SEED = Number(process.env.SIM_SEED || 1000);
const seeds = H.seedRange(SEED, GAMES);
const maxPlies = H.cardData.rules.maxPlies;

function git(cmd) {
  try { return execSync(`git ${cmd}`, { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim(); } catch (e) { return '?'; }
}
const head = git('rev-parse --short HEAD');
const dirty = git('status --porcelain -- js data tools index.html') !== '';
const now = new Date();
const jst = new Date(now.getTime() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' JST';
const ymd = jst.slice(0, 10).replace(/-/g, '');

const BASE = { pieceSet: 'mock4', frontBase: true, kingStrength: 6, winnerLosesStrength: true };
const CONFIGS = [
  { key: 'kingLoses', label: 'モック4・キング6 × 減る・キングも減る（既定）', overrides: { ...BASE, kingKeepsStrength: false } },
  { key: 'kingKeeps', label: 'モック4・キング6 × 減る・キングは減らない', overrides: { ...BASE, kingKeepsStrength: true } },
];
// 測定の経路が変わっていないことの確認：CG-025 の実測（HEAD e3bd13c・2026-10-13 17:46 JST・同じシード帯 1000〜1499・500戦）
// 出典 docs/research/v03モック4_解放と連鎖_20261013_CG025.md の「モック4・キング6 × 減る」列
const CG025 = { name: 'CG-025 モック4・キング6 × 減る', meanPlies: 60.2, medianPlies: 57.5, p1Rate: 0.436, drawRate: 0, deepActions: 29, deepGames: 27, pushOff: 104 };

const t0 = Date.now();
const results = [];
for (const c of CONFIGS) {
  const games = H.runBatch({ seeds, kinds: { p1: 'greedy', p2: 'greedy' }, overrides: c.overrides });
  results.push({ ...c, games, sum: H.summarize(games, maxPlies) });
}
// 決定性：キングは減らないの先頭20戦を回し直して一致を確かめる
const again = H.runBatch({ seeds: seeds.slice(0, 20), kinds: { p1: 'greedy', p2: 'greedy' }, overrides: CONFIGS[1].overrides });
const deterministic = again.every((g, i) => JSON.stringify(g) === JSON.stringify(results[1].games[i]));
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '-');
const defaults = H.cardData.rules;
const otherRules = Object.keys(defaults).filter((k) => k[0] !== '_' && !['winnerLosesStrength', 'pieceSet', 'frontBase', 'kingKeepsStrength'].includes(k))
  .map((k) => `${k}=${JSON.stringify(defaults[k])}`).join('・');
const totalChecks = results.reduce((n, r) => n + r.sum.previewChecks, 0);
const totalMismatch = results.reduce((n, r) => n + r.sum.previewMismatch, 0);

const lines = [];
lines.push('# v0.3 モック4 キングは勝っても強さが減らない 自動対戦（CG-026）');
lines.push('');
lines.push(`調査日: ${jst.slice(0, 10)}`);
lines.push('');
lines.push(`- **測定日時**: ${jst}`);
lines.push(`- **HEAD**: \`${head}\`${dirty ? '（★ 未コミットの変更あり）' : ''}`);
lines.push(`- **シード帯**: ${SEED}〜${SEED + GAMES - 1}（${GAMES}戦／列・2列）`);
lines.push('- **CPU**: 貪欲同士（js/ai.js の greedy。CG-025 から変えていない。勝敗は実際の強さで判断し、連鎖の先は打つ前の結果予測と同じ関数で読む。強くはしていない）');
lines.push('- **列**: モック4・キング6・勝った側が減る の上で、キングも減る（rules.kingKeepsStrength=false・既定＝CG-025 と同じ設定）／キングは減らない（true・推奨設定と同じ）。どちらも前線基地あり（既定）');
lines.push(`- **他の設定（既定のまま）**: ${otherRules}`);
lines.push(`- **実行**: \`node tools/compare_kingkeep.js\`（所要 ${elapsed} 秒）。同一シードの再実行で一致: ${deterministic ? `する（${CONFIGS[1].label} の先頭20戦で確認）` : '★ しない'}`);
lines.push(`- **予測と実際の解決の一致**: 2列の移動・投げる・入れ替え ${totalChecks} 回のうち不一致 ${totalMismatch} 回（CG-025 と同じ検査）`);
lines.push('');
lines.push('## TL;DR');
lines.push('');
for (const r of results) {
  const s = r.sum;
  lines.push(`- **${r.label}**: 決着まで平均 ${f1(s.meanPlies)} 手（中央値 ${f1(s.medianPlies)}）・引き分け ${pct(s.drawRate)}・先手の勝率 ${pct(s.p1Rate)}・キングを倒した駒の実際の強さ 平均 ${f2(s.kingKillerStrengthMean)}・2段以上の連鎖 ${s.deepActions} 回（${s.deepGames} 戦）`);
}
lines.push('- ★ ここに並べたのは実測値だけ。解釈は書いていない（チャット側・DECISION_LOG に「推測」と明記して書く）');
lines.push('');

lines.push('## 1. 主な指標');
lines.push('');
lines.push('| | ' + results.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
const row = (name, fn) => lines.push(`| ${name} | ${results.map((r) => fn(r.sum)).join(' | ')} |`);
row('**決着までの平均手数**', (s) => `**${f1(s.meanPlies)}**`);
row('**中央値**', (s) => `**${f1(s.medianPlies)}**`);
row('10%点〜90%点', (s) => (Number.isFinite(s.p10) ? `${s.p10}〜${s.p90}` : '-'));
row(`**引き分けの率（${maxPlies}手到達）**`, (s) => `**${pct(s.drawRate)}**（${s.draws} 戦）`);
row('両キング同値の相討ち（引き分け）', (s) => `${s.both} 戦`);
row('**先手の勝率**', (s) => `**${pct(s.p1Rate)}**`);
row('後手の勝率', (s) => pct(s.p2 / s.n));
row('**キングを倒した駒の実際の強さ（平均）**', (s) => `**${f2(s.kingKillerStrengthMean)}**（${s.kingKillerGames} 戦）`);
row('**2段以上の連鎖が起きた手（計）／起きた試合**', (s) => `**${s.deepActions} 回／${s.deepGames} 戦**`);
row('連鎖の段の分布（段 0 / 1 / 2 / 3 / 4以上）', (s) => s.depthDist.join(' / '));
row('盤外へ押し出された回数（計）', (s) => `${s.pushOffBoardTotal}`);
row('駒の前進度（全試合・全手・両者の平均）', (s) => pct(s.advance.overall));
row('両者の山が尽きた試合（尽きた手数の平均）', (s) => `${s.decksOutGames} 戦（${f1(s.decksOutMeanPly)} 手目）`);
row('戦闘 / 試合', (s) => f2(s.perGame.battles));
lines.push('');

lines.push('## 2. 決着手数の分布（試合数）');
lines.push('');
lines.push('| 手数 | ' + results.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
for (let i = 0; i < results[0].sum.buckets.length; i++) {
  const b = results[0].sum.buckets[i];
  if (results.every((r) => r.sum.buckets[i].count === 0) && i < results[0].sum.buckets.length - 1) continue;
  lines.push(`| ${b.label} | ${results.map((r) => r.sum.buckets[i].count).join(' | ')} |`);
}
lines.push('');

lines.push('## 3. 測定の経路の確認（キングも減るの列 ＝ CG-025 と一致するか）');
lines.push('');
lines.push('CG-025 の実測（HEAD `e3bd13c`・2026-10-13 17:46 JST・シード 1000〜1499・500戦）と、この測定のキングも減るの列を並べた。');
lines.push('');
lines.push('| | 平均手数 | 中央値 | 先手勝率 | 引き分け | 2段以上の連鎖（手／試合） | 盤外 | 一致 |');
lines.push('|---|---|---|---|---|---|---|---|');
const s0 = results[0].sum;
const match = f1(s0.meanPlies) === f1(CG025.meanPlies) && f1(s0.medianPlies) === f1(CG025.medianPlies) && pct(s0.p1Rate) === pct(CG025.p1Rate)
  && pct(s0.drawRate) === pct(CG025.drawRate) && s0.deepActions === CG025.deepActions && s0.deepGames === CG025.deepGames && s0.pushOffBoardTotal === CG025.pushOff;
lines.push(`| ${CG025.name} | ${f1(CG025.meanPlies)} | ${f1(CG025.medianPlies)} | ${pct(CG025.p1Rate)} | ${pct(CG025.drawRate)} | ${CG025.deepActions}／${CG025.deepGames} | ${CG025.pushOff} | |`);
lines.push(`| この測定 ${results[0].label} | ${f1(s0.meanPlies)} | ${f1(s0.medianPlies)} | ${pct(s0.p1Rate)} | ${pct(s0.drawRate)} | ${s0.deepActions}／${s0.deepGames} | ${s0.pushOffBoardTotal} | ${match ? '✅' : '⚠️ 不一致'} |`);
lines.push('');

lines.push('## 指標の定義');
lines.push('');
lines.push('- **手数**: 「動かす・投げる・入れ替える・置く・引く（引くを1行動にする設定のとき）・パス」の数。寝返りの配置とドラフトは手番を使わないので数えない');
lines.push('- **決着までの平均手数・中央値・分布**: 引き分け（打ち切り）を除いた試合の手数。勝率・引き分けの率は全試合が分母');
lines.push('- **キングを倒した駒の実際の強さ**: キングが倒れて決着した試合で、その戦闘での相手の駒の実際の強さ（同値で倒れた場合はその値）。両キング相討ち・盤外への押し出しで倒れた試合は除く（CG-024 と同じ定義）');
lines.push('- **連鎖の段**: 手番の行動1回の解決で出たイベントの depth の最大（CG-025 と同じ定義）。2段以上＝動かされた駒の能力がさらに駒を動かした');
lines.push(`- **駒の前進度**: 各手の直後に、その側の今の持ち主の駒（キングを除く）のうち、自陣の奥の${H.ADVANCE_ROWS}列より前にいる駒の割合（CG-024 と同じ定義）`);
lines.push('');
lines.push('## 所見');
lines.push('');
lines.push('（このファイルの生成時点では空欄。所見はチャット側・DECISION_LOG に「推測」と明記して書く）');
lines.push('');

const outName = process.env.SIM_OUT || `v03モック4_キングは減らない_${ymd}_CG026.md`;
const outPath = path.join(__dirname, '..', 'docs', 'research', outName);
fs.writeFileSync(outPath, lines.join('\n'));
console.log(`書き出した: docs/research/${outName}`);
for (const r of results) {
  const s = r.sum;
  console.log(`${r.label}: 平均 ${f1(s.meanPlies)} 手・中央値 ${f1(s.medianPlies)}・先手 ${pct(s.p1Rate)}・引分 ${pct(s.drawRate)}（${s.draws} 戦）・キングを倒した強さ ${f2(s.kingKillerStrengthMean)}（${s.kingKillerGames} 戦）・2段以上 ${s.deepActions} 回（${s.deepGames} 戦）・盤外 ${s.pushOffBoardTotal}`);
}
console.log(`CG-025 との一致: ${match}・予測の不一致 ${totalMismatch}/${totalChecks}`);
console.log(`HEAD ${head}${dirty ? '（未コミットの変更あり）' : ''}・${jst}・決定性 ${deterministic}`);
