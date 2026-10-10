/**
 * tools/compare_v03.js — v0.3 モック1 の4通り比較（CG-021）
 *
 *   「勝った側が減る／減らない」×「寝返った駒の置き場所（キングの周囲／勝った駒の周囲）」の
 *   4通りを、貪欲同士で同じシード帯に回して docs/research/ に Markdown で書き出す。
 *   他の設定は data/cards.js の既定のまま。参考として、既定の設定でのランダム同士・
 *   貪欲対ランダムも1行ずつ添える（CPU の質の物差し）。
 *
 * 使い方:
 *   node tools/compare_v03.js
 *   SIM_GAMES=500 SIM_SEED=1000 SIM_OUT=ファイル名.md node tools/compare_v03.js
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

const CONFIGS = [
  { key: 'A', label: '減らない × キングの周囲（既定）', overrides: { winnerLosesStrength: false, defectorPlacement: 'king' } },
  { key: 'B', label: '減らない × 勝った駒の周囲', overrides: { winnerLosesStrength: false, defectorPlacement: 'winner' } },
  { key: 'C', label: '減る × キングの周囲', overrides: { winnerLosesStrength: true, defectorPlacement: 'king' } },
  { key: 'D', label: '減る × 勝った駒の周囲', overrides: { winnerLosesStrength: true, defectorPlacement: 'winner' } },
];
const REFS = [
  { key: 'R1', label: '参考：ランダム同士（既定の設定）', kinds: { p1: 'random', p2: 'random' }, overrides: {} },
  { key: 'R2', label: '参考：先手 貪欲 × 後手 ランダム（既定の設定）', kinds: { p1: 'greedy', p2: 'random' }, overrides: {} },
  { key: 'R3', label: '参考：先手 ランダム × 後手 貪欲（既定の設定）', kinds: { p1: 'random', p2: 'greedy' }, overrides: {} },
];

const t0 = Date.now();
const results = [];
for (const c of CONFIGS) {
  const games = H.runBatch({ seeds, kinds: { p1: 'greedy', p2: 'greedy' }, overrides: c.overrides });
  results.push({ ...c, games, sum: H.summarize(games, maxPlies) });
}
const refs = [];
for (const c of REFS) {
  const games = H.runBatch({ seeds, kinds: c.kinds, overrides: c.overrides });
  refs.push({ ...c, sum: H.summarize(games, maxPlies) });
}
// 決定性：A の最初の20戦を回し直して一致を確かめる
const again = H.runBatch({ seeds: seeds.slice(0, 20), kinds: { p1: 'greedy', p2: 'greedy' }, overrides: CONFIGS[0].overrides });
const deterministic = again.every((g, i) => JSON.stringify(g) === JSON.stringify(results[0].games[i]));
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '-');
const cells = H.cardData.board.cols * H.cardData.board.rows;
const defaults = H.cardData.rules;
const otherRules = Object.keys(defaults).filter((k) => k[0] !== '_' && k !== 'winnerLosesStrength' && k !== 'defectorPlacement')
  .map((k) => `${k}=${JSON.stringify(defaults[k])}`).join('・');

const lines = [];
lines.push('# v0.3 モック1 自動対戦 4通り比較（CG-021）');
lines.push('');
lines.push(`調査日: ${jst.slice(0, 10)}`);
lines.push('');
lines.push(`- **測定日時**: ${jst}`);
lines.push(`- **HEAD**: \`${head}\`${dirty ? '（★ 未コミットの変更あり）' : ''}`);
lines.push(`- **シード帯**: ${SEED}〜${SEED + GAMES - 1}（${GAMES}戦／設定）`);
lines.push('- **CPU**: 貪欲同士（js/ai.js の greedy。キングを取れるなら取る → 勝てる攻撃で強い駒から取る → それ以外は負ける攻撃・同値の攻撃を外した合法手から、盤面のハッシュで一様に選ぶ）');
lines.push(`- **他の設定（既定のまま）**: ${otherRules}`);
lines.push(`- **実行**: \`node tools/compare_v03.js\`（所要 ${elapsed} 秒）。同一シードの再実行で一致: ${deterministic ? 'する（A の先頭20戦で確認）' : '★ しない'}`);
lines.push('');
lines.push('## TL;DR');
lines.push('');
for (const r of results) {
  lines.push(`- **${r.key} ${r.label}**: 決着まで平均 ${f1(r.sum.meanPlies)} 手（中央値 ${f1(r.sum.medianPlies)}）・先手勝率 ${pct(r.sum.p1Rate)}・引き分け ${pct(r.sum.drawRate)}`);
}
lines.push('- ★ ここに並べたのは実測値だけ。解釈は下の「所見」に「推測」と明記して分けた');
lines.push('');
lines.push('## 1. 主な指標（貪欲同士）');
lines.push('');
lines.push('| | ' + results.map((r) => `${r.key} ${r.label}`).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
const row = (name, fn) => lines.push(`| ${name} | ${results.map((r) => fn(r.sum)).join(' | ')} |`);
row('決着までの平均手数', (s) => f1(s.meanPlies));
row('中央値', (s) => f1(s.medianPlies));
row('10%点〜90%点', (s) => `${s.p10}〜${s.p90}`);
row('先手の勝率', (s) => pct(s.p1Rate));
row('後手の勝率', (s) => pct(s.p2 / s.n));
row(`引き分けの率（${maxPlies}手打ち切り）`, (s) => pct(s.drawRate));
row('両キング同値の相討ち（引き分け）', (s) => `${s.both} 戦`);
row('同値でキングが倒れた決着', (s) => `${s.kingTieEnds} 戦`);
row('戦闘 / 試合', (s) => f2(s.perGame.battles));
row('寝返り / 試合', (s) => f2(s.perGame.defections));
row('山へ還った / 試合', (s) => f2(s.perGame.returns));
row('　うち N 回目に倒された', (s) => f2(s.perGame.returnsNth));
row('　うち 同値', (s) => f2(s.perGame.returnsTie));
row('　うち 置く空きがない', (s) => f2(s.perGame.returnsNoSpace));
row('ドラフト / 試合', (s) => f2(s.perGame.drafts));
row('置く / 試合', (s) => f2(s.perGame.places));
row('動かす / 試合', (s) => f2(s.perGame.moves));
row('両者の山が尽きた試合', (s) => `${s.decksOutGames} 戦（平均 ${f1(s.decksOutMeanPly)} 手目）`);
lines.push('');
lines.push('## 2. 決着手数の分布（試合数）');
lines.push('');
lines.push('| 手数 | ' + results.map((r) => r.key).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
for (let i = 0; i < results[0].sum.buckets.length; i++) {
  const b = results[0].sum.buckets[i];
  if (results.every((r) => r.sum.buckets[i].count === 0) && i < results[0].sum.buckets.length - 1) continue;
  lines.push(`| ${b.label} | ${results.map((r) => r.sum.buckets[i].count).join(' | ')} |`);
}
lines.push('');
lines.push(`## 3. 盤の埋まり具合の推移（盤上の駒の平均数・キング込み／全 ${cells} マス）`);
lines.push('');
lines.push('その手数の時点でまだ決着していない試合だけの平均。（ ）内はその時点で続いている試合数。');
lines.push('');
lines.push('| 手数 | ' + results.map((r) => r.key).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
for (let i = 0; i < results[0].sum.fill.length; i++) {
  if (results.every((r) => r.sum.fill[i].games === 0)) break;
  const k = results[0].sum.fill[i].ply;
  lines.push(`| ${k} | ${results.map((r) => {
    const f = r.sum.fill[i];
    return f.games === 0 ? '-' : `${f1(f.mean)}（${pct(f.mean / cells)}・${f.games}）`;
  }).join(' | ')} |`);
}
lines.push('');
lines.push('## 4. 参考：CPU の組み合わせ（既定の設定）');
lines.push('');
lines.push('| | 平均手数 | 中央値 | 先手勝率 | 後手勝率 | 引き分け | 寝返り/試合 | 山へ還った/試合 | ドラフト/試合 |');
lines.push('|---|---|---|---|---|---|---|---|---|');
for (const r of [{ ...results[0], label: 'A 貪欲同士（上の表と同じ）' }, ...refs]) {
  const s = r.sum;
  lines.push(`| ${r.key === 'A' ? r.label : `${r.key} ${r.label}`} | ${f1(s.meanPlies)} | ${f1(s.medianPlies)} | ${pct(s.p1Rate)} | ${pct(s.p2 / s.n)} | ${pct(s.drawRate)} | ${f2(s.perGame.defections)} | ${f2(s.perGame.returns)} | ${f2(s.perGame.drafts)} |`);
}
lines.push('');
lines.push('## 指標の定義');
lines.push('');
lines.push('- **手数**: 「動かす・置く・引く（引くを1行動にする設定のとき）・パス」の数。寝返りの配置とドラフトは手番を使わないので数えない');
lines.push('- **決着までの平均手数・中央値・分布**: 引き分け（打ち切り）を除いた試合の手数');
lines.push('- **勝率・引き分けの率**: 全試合が分母');
lines.push('- **寝返り**: 倒された駒が倒した側の駒になって盤に置かれた回数（置く空きがなくて山へ還った分は含めない）');
lines.push('- **山へ還った**: N 回目に倒された／同値／置く空きがない、のいずれかで元の持ち主の山の底へ還った駒の数');
lines.push('- **ドラフト**: 取られた側ドラフトが起きた回数（山が1枚で自動的に自分の手札へ入った回も数える。山が空で何も起きなかった回は数えない）');
lines.push('- **盤の埋まり具合**: その手を指し終え、寝返りの配置も済んだ時点の盤上の駒の数（キング2つを含む）');
lines.push('');
lines.push('## 所見');
lines.push('');
lines.push('（このファイルの生成時点では空欄。所見はチャット側・DECISION_LOG に「推測」と明記して書く）');
lines.push('');

const outName = process.env.SIM_OUT || `v03モック1_自動対戦4通り_${ymd}_CG021.md`;
const outPath = path.join(__dirname, '..', 'docs', 'research', outName);
fs.writeFileSync(outPath, lines.join('\n'));
console.log(`書き出した: docs/research/${outName}`);
for (const r of results) {
  console.log(`${r.key} ${r.label}: 平均 ${f1(r.sum.meanPlies)} 手・中央値 ${f1(r.sum.medianPlies)}・先手 ${pct(r.sum.p1Rate)}・引分 ${pct(r.sum.drawRate)}`);
}
for (const r of refs) console.log(`${r.key} ${r.label}: 平均 ${f1(r.sum.meanPlies)} 手・先手 ${pct(r.sum.p1Rate)}・後手 ${pct(r.sum.p2 / r.sum.n)}・引分 ${pct(r.sum.drawRate)}`);
console.log(`HEAD ${head}${dirty ? '（未コミットの変更あり）' : ''}・${jst}・決定性 ${deterministic}`);
