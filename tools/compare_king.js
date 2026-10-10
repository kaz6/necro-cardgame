/**
 * tools/compare_king.js — キングの強さ別の自動対戦比較（CG-022）
 *
 *   キングの強さ 3／6／8／10 × 「勝った側の強さが減る」オフ／オン の8通りを、
 *   貪欲同士で同じシード帯に回して docs/research/ に Markdown で書き出す。
 *   他の設定（寝返りの置き場所など）は data/cards.js の既定のまま。
 *
 * 使い方:
 *   node tools/compare_king.js
 *   SIM_GAMES=500 SIM_SEED=1000 SIM_OUT=ファイル名.md node tools/compare_king.js
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

const KING = H.cardData.flags.list.find((f) => f.key === 'kingStrength').choices.map((c) => c.value);
const CONFIGS = [];
for (const lose of [false, true]) {
  for (const k of KING) {
    CONFIGS.push({
      key: `${lose ? '減' : '不'}${k}`,
      label: `キング${k} × ${lose ? '減る' : '減らない'}`,
      kingStrength: k,
      lose,
      overrides: { kingStrength: k, winnerLosesStrength: lose },
    });
  }
}
// 測定の経路が変わっていないことの確認：CG-021 の実測（HEAD 66e6eba・同じシード帯 1000〜1499・500戦）
// 出典 docs/research/v03モック1_自動対戦4通り_20261011_CG021.md の A・C 列
const CG021 = {
  '不3': { name: 'CG-021 A（減らない × キングの周囲・既定）', meanPlies: 20.6, medianPlies: 18.0, p1Rate: 0.530, drawRate: 0 },
  '減3': { name: 'CG-021 C（減る × キングの周囲）', meanPlies: 36.2, medianPlies: 31.0, p1Rate: 0.494, drawRate: 0 },
};

const t0 = Date.now();
const results = [];
for (const c of CONFIGS) {
  const games = H.runBatch({ seeds, kinds: { p1: 'greedy', p2: 'greedy' }, overrides: c.overrides });
  results.push({ ...c, games, sum: H.summarize(games, maxPlies) });
}
// 決定性：最初の設定の先頭20戦を回し直して一致を確かめる
const again = H.runBatch({ seeds: seeds.slice(0, 20), kinds: { p1: 'greedy', p2: 'greedy' }, overrides: CONFIGS[0].overrides });
const deterministic = again.every((g, i) => JSON.stringify(g) === JSON.stringify(results[0].games[i]));
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '-');
const defaults = H.cardData.rules;
const otherRules = Object.keys(defaults).filter((k) => k[0] !== '_' && k !== 'winnerLosesStrength')
  .map((k) => `${k}=${JSON.stringify(defaults[k])}`).join('・');
const byKey = Object.fromEntries(results.map((r) => [r.key, r]));

const lines = [];
lines.push('# v0.3 モック1 キングの強さ別 自動対戦（CG-022）');
lines.push('');
lines.push(`調査日: ${jst.slice(0, 10)}`);
lines.push('');
lines.push(`- **測定日時**: ${jst}`);
lines.push(`- **HEAD**: \`${head}\`${dirty ? '（★ 未コミットの変更あり）' : ''}`);
lines.push(`- **シード帯**: ${SEED}〜${SEED + GAMES - 1}（${GAMES}戦／設定・8通り）`);
lines.push('- **CPU**: 貪欲同士（js/ai.js の greedy）');
lines.push(`- **変えたもの**: キングの強さ（${KING.join('／')}。既定は ${H.cardData.king.strength}）× 勝った側の強さ（減らない＝既定／負けた側の分だけ減る）`);
lines.push(`- **他の設定（既定のまま）**: ${otherRules}`);
lines.push(`- **実行**: \`node tools/compare_king.js\`（所要 ${elapsed} 秒）。同一シードの再実行で一致: ${deterministic ? `する（${CONFIGS[0].label} の先頭20戦で確認）` : '★ しない'}`);
lines.push('');
lines.push('## TL;DR');
lines.push('');
for (const r of results) {
  lines.push(`- **${r.label}**: 決着まで平均 ${f1(r.sum.meanPlies)} 手（中央値 ${f1(r.sum.medianPlies)}）・先手勝率 ${pct(r.sum.p1Rate)}・引き分け ${pct(r.sum.drawRate)}・倒れたキングを削っていた駒 平均 ${f2(r.sum.chippersMean)} 体`);
}
lines.push('- ★ ここに並べたのは実測値だけ。解釈は書いていない（チャット側・DECISION_LOG に「推測」と明記して書く）');
lines.push('');

function table(title, group) {
  lines.push(`## ${title}`);
  lines.push('');
  lines.push('| | ' + group.map((r) => r.label).join(' | ') + ' |');
  lines.push('|---|' + group.map(() => '---').join('|') + '|');
  const row = (name, fn) => lines.push(`| ${name} | ${group.map((r) => fn(r.sum)).join(' | ')} |`);
  row('決着までの平均手数', (s) => f1(s.meanPlies));
  row('中央値', (s) => f1(s.medianPlies));
  row('10%点〜90%点', (s) => `${s.p10}〜${s.p90}`);
  row('先手の勝率', (s) => pct(s.p1Rate));
  row('後手の勝率', (s) => pct(s.p2 / s.n));
  row(`**引き分けの率（${maxPlies}手到達）**`, (s) => `**${pct(s.drawRate)}**（${s.draws} 戦）`);
  row('両キング同値の相討ち（引き分け）', (s) => `${s.both} 戦`);
  row('キングが倒れて決着した試合', (s) => `${s.kingFalls} 戦`);
  row('　うち 同値でキングが倒れた', (s) => `${s.kingTieEnds} 戦`);
  row('**倒れたキングを削っていた駒（平均）**', (s) => `**${f2(s.chippersMean)}**`);
  row('　0体 / 1体 / 2体 / 3体以上（試合数）', (s) => s.chippersDist.join(' / '));
  row('　最大', (s) => (Number.isFinite(s.chippersMax) ? `${s.chippersMax}` : '-'));
  row('倒れた時点のキングの強さ（平均）', (s) => f2(s.kingStrengthAtFallMean));
  row('戦闘 / 試合', (s) => f2(s.perGame.battles));
  row('寝返り / 試合', (s) => f2(s.perGame.defections));
  row('山へ還った / 試合', (s) => f2(s.perGame.returns));
  row('ドラフト / 試合', (s) => f2(s.perGame.drafts));
  row('両者の山が尽きた試合', (s) => `${s.decksOutGames} 戦（平均 ${f1(s.decksOutMeanPly)} 手目）`);
  lines.push('');
}
table('1. 勝った側の強さ「減らない」（既定）', results.filter((r) => !r.lose));
table('2. 勝った側の強さ「負けた側の分だけ減る」', results.filter((r) => r.lose));

lines.push('## 3. 決着手数の分布（試合数）');
lines.push('');
lines.push('| 手数 | ' + results.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
for (let i = 0; i < results[0].sum.buckets.length; i++) {
  const b = results[0].sum.buckets[i];
  if (results.every((r) => r.sum.buckets[i].count === 0) && i < results[0].sum.buckets.length - 1) continue;
  lines.push(`| ${b.label} | ${results.map((r) => r.sum.buckets[i].count).join(' | ')} |`);
}
lines.push('');

lines.push('## 4. 測定の経路の確認（キング3の列 ＝ CG-021 と一致するか）');
lines.push('');
lines.push('CG-021 の実測（HEAD `66e6eba`・2026-10-11 00:24 JST・シード 1000〜1499・500戦）と、この測定のキング3の列を並べた。');
lines.push('');
lines.push('| | 平均手数 | 中央値 | 先手勝率 | 引き分け | 一致 |');
lines.push('|---|---|---|---|---|---|');
let allMatch = true;
for (const key of Object.keys(CG021)) {
  const ref = CG021[key];
  const s = byKey[key].sum;
  const ok = f1(s.meanPlies) === f1(ref.meanPlies) && f1(s.medianPlies) === f1(ref.medianPlies) && pct(s.p1Rate) === pct(ref.p1Rate) && pct(s.drawRate) === pct(ref.drawRate);
  if (!ok) allMatch = false;
  lines.push(`| ${ref.name} | ${f1(ref.meanPlies)} | ${f1(ref.medianPlies)} | ${pct(ref.p1Rate)} | ${pct(ref.drawRate)} | |`);
  lines.push(`| この測定 ${byKey[key].label} | ${f1(s.meanPlies)} | ${f1(s.medianPlies)} | ${pct(s.p1Rate)} | ${pct(s.drawRate)} | ${ok ? '✅' : '⚠️ 不一致'} |`);
}
lines.push('');

lines.push('## 指標の定義');
lines.push('');
lines.push('- **手数**: 「動かす・置く・引く（引くを1行動にする設定のとき）・パス」の数。寝返りの配置とドラフトは手番を使わないので数えない');
lines.push('- **決着までの平均手数・中央値・分布**: 引き分け（打ち切り）を除いた試合の手数');
lines.push('- **勝率・引き分けの率**: 全試合が分母');
lines.push(`- **引き分け（${maxPlies}手到達）**: ${maxPlies}手に達しても決着しなかった試合`);
lines.push('- **倒れたキングを削っていた駒**: キングが倒れて決着した試合（両キング相討ちを除く）で、倒れたキングとの戦闘でキングに負けた駒の数（同じ駒は1体と数える。キングから攻めて勝った相手も含む。とどめを刺した駒は含まない）。');
lines.push('  「減る」設定ではこの駒の数だけキングの強さが削られている。「減らない」設定ではキングの強さは変わらないので、「キングに挑んで負けた駒の数」として読む');
lines.push('- **倒れた時点のキングの強さ**: 倒れる直前の戦闘に入ったときのキングの強さ（「減らない」設定では常に初期値）');
lines.push('');
lines.push('## 所見');
lines.push('');
lines.push('（このファイルの生成時点では空欄。所見はチャット側・DECISION_LOG に「推測」と明記して書く）');
lines.push('');

const outName = process.env.SIM_OUT || `v03モック1_キングの強さ別_${ymd}_CG022.md`;
const outPath = path.join(__dirname, '..', 'docs', 'research', outName);
fs.writeFileSync(outPath, lines.join('\n'));
console.log(`書き出した: docs/research/${outName}`);
for (const r of results) {
  console.log(`${r.label}: 平均 ${f1(r.sum.meanPlies)} 手・中央値 ${f1(r.sum.medianPlies)}・先手 ${pct(r.sum.p1Rate)}・引分 ${pct(r.sum.drawRate)}・削った駒 ${f2(r.sum.chippersMean)}`);
}
console.log(`CG-021 との一致: ${allMatch}`);
console.log(`HEAD ${head}${dirty ? '（未コミットの変更あり）' : ''}・${jst}・決定性 ${deterministic}`);
