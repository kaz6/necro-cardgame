/**
 * tools/compare_mock2.js — v0.3 モック2（能力8種と実際の強さ）の自動対戦測定（CG-023）
 *
 *   モック2の駒構成で、キングの強さ 3／6／10 × 「勝った側の強さが減る」オフ／オン の6通りを、
 *   貪欲同士で同じシード帯に回して docs/research/ に Markdown で書き出す。
 *   他の設定（寝返りの置き場所など）は data/cards.js の既定のまま。
 *   測定の経路が変わっていない確認として、モック1の駒構成・キング3・減らないの列も測り、
 *   CG-021 の既定の数字と並べる。
 *
 * 使い方:
 *   node tools/compare_mock2.js
 *   SIM_GAMES=500 SIM_SEED=1000 SIM_OUT=ファイル名.md node tools/compare_mock2.js
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

const KING = [3, 6, 10];
const CONFIGS = [];
for (const lose of [false, true]) {
  for (const k of KING) {
    CONFIGS.push({
      key: `${lose ? '減' : '不'}${k}`,
      label: `モック2・キング${k} × ${lose ? '減る' : '減らない'}`,
      lose,
      overrides: { pieceSet: 'mock2', frontBase: false, kingStrength: k, winnerLosesStrength: lose },   // 前線基地（CG-024）は CG-023 の時点ではなかったので切る
    });
  }
}
const CHECK = { key: 'M1', label: '確認：モック1・キング3 × 減らない', overrides: { pieceSet: 'mock1', frontBase: false, kingStrength: 3, winnerLosesStrength: false } };
// 測定の経路が変わっていないことの確認：CG-021 の実測（HEAD 66e6eba・同じシード帯 1000〜1499・500戦）
// 出典 docs/research/v03モック1_自動対戦4通り_20261011_CG021.md の A 列（既定）
const CG021 = { name: 'CG-021 A（減らない × キングの周囲・既定）', meanPlies: 20.6, medianPlies: 18.0, p1Rate: 0.530, drawRate: 0 };

const t0 = Date.now();
const results = [];
for (const c of [...CONFIGS, CHECK]) {
  const games = H.runBatch({ seeds, kinds: { p1: 'greedy', p2: 'greedy' }, overrides: c.overrides });
  results.push({ ...c, games, sum: H.summarize(games, maxPlies) });
}
// 決定性：最初の設定の先頭20戦を回し直して一致を確かめる
const again = H.runBatch({ seeds: seeds.slice(0, 20), kinds: { p1: 'greedy', p2: 'greedy' }, overrides: CONFIGS[0].overrides });
const deterministic = again.every((g, i) => JSON.stringify(g) === JSON.stringify(results[0].games[i]));
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '-');
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '-');
const defaults = H.cardData.rules;
const otherRules = 'frontBase=false（固定）・' + Object.keys(defaults).filter((k) => k[0] !== '_' && !['winnerLosesStrength', 'pieceSet', 'frontBase'].includes(k))
  .map((k) => `${k}=${JSON.stringify(defaults[k])}`).join('・');
const abilityIds = Object.keys(H.cardData.abilities).filter((k) => k[0] !== '_');
const abilityName = (id) => H.cardData.abilities[id].name;
const check = results[results.length - 1];
const main = results.slice(0, -1);
const totalChecks = results.reduce((n, r) => n + r.sum.previewChecks, 0);
const totalMismatch = results.reduce((n, r) => n + r.sum.previewMismatch, 0);

const lines = [];
lines.push('# v0.3 モック2 能力8種と実際の強さ 自動対戦（CG-023）');
lines.push('');
lines.push(`調査日: ${jst.slice(0, 10)}`);
lines.push('');
lines.push(`- **測定日時**: ${jst}`);
lines.push(`- **HEAD**: \`${head}\`${dirty ? '（★ 未コミットの変更あり）' : ''}`);
lines.push(`- **シード帯**: ${SEED}〜${SEED + GAMES - 1}（${GAMES}戦／設定・6通り＋確認1列）`);
lines.push('- **CPU**: 貪欲同士（js/ai.js の greedy。勝敗は実際の強さで判断し、押し出しの連鎖は打つ前の結果予測と同じ関数で読む）');
lines.push(`- **変えたもの**: 駒構成＝モック2（data の pieceSets.mock2）で、キングの強さ（${KING.join('／')}）× 勝った側の強さ（減らない＝既定／負けた側の実際の強さぶん減る）`);
lines.push(`- **他の設定（既定のまま）**: ${otherRules}`);
lines.push(`- **実行**: \`node tools/compare_mock2.js\`（所要 ${elapsed} 秒）。同一シードの再実行で一致: ${deterministic ? `する（${CONFIGS[0].label} の先頭20戦で確認）` : '★ しない'}`);
lines.push(`- **予測と実際の解決の一致**: 全7列の移動 ${totalChecks} 回のうち不一致 ${totalMismatch} 回（移動のたびに、動かす側の視点でフィルタした state で previewMove を呼び、reduce 後の盤・決着と比べた。200手の打ち切りは移動の解決の後に手数で起きるので、比べる決着から除いた）`);
lines.push('');
lines.push('## TL;DR');
lines.push('');
for (const r of results) {
  lines.push(`- **${r.label}**: 決着まで平均 ${f1(r.sum.meanPlies)} 手（中央値 ${f1(r.sum.medianPlies)}）・先手勝率 ${pct(r.sum.p1Rate)}・引き分け ${pct(r.sum.drawRate)}・両者の山が尽きた試合 ${r.sum.decksOutGames} 戦（平均 ${f1(r.sum.decksOutMeanPly)} 手目）`);
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
  row('10%点〜90%点', (s) => (Number.isFinite(s.p10) ? `${s.p10}〜${s.p90}` : '-'));
  row('先手の勝率', (s) => pct(s.p1Rate));
  row('後手の勝率', (s) => pct(s.p2 / s.n));
  row(`**引き分けの率（${maxPlies}手到達）**`, (s) => `**${pct(s.drawRate)}**（${s.draws} 戦）`);
  row('両キング同値の相討ち（引き分け）', (s) => `${s.both} 戦`);
  row('　うち 同値でキングが倒れた', (s) => `${s.kingTieEnds} 戦`);
  row('**両者の山が尽きた試合（尽きた手数の平均）**', (s) => `**${s.decksOutGames} 戦（${f1(s.decksOutMeanPly)} 手目）**`);
  row('**キングを倒した駒の実際の強さ（平均）**', (s) => `**${f2(s.kingKillerStrengthMean)}**（${s.kingKillerGames} 戦）`);
  row('戦闘 / 試合', (s) => f2(s.perGame.battles));
  row('　うち 押し出しの連鎖の中の戦闘', (s) => f2(s.chainBattlesPerGame));
  row('寝返り / 試合', (s) => f2(s.perGame.defections));
  row('山へ還った / 試合', (s) => f2(s.perGame.returns));
  row('ドラフト / 試合', (s) => f2(s.perGame.drafts));
  lines.push('');
}
table('1. 勝った側の強さ「減らない」（既定）', main.filter((r) => !r.lose));
table('2. 勝った側の強さ「負けた側の実際の強さぶん減る」', main.filter((r) => r.lose));

lines.push('## 3. 能力ごとの発動回数（試合あたり）');
lines.push('');
lines.push('| 能力 | ' + main.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + main.map(() => '---').join('|') + '|');
for (const id of abilityIds) {
  lines.push(`| ${abilityName(id)}（${H.cardData.abilities[id].trigger}） | ${main.map((r) => `${f3(r.sum.fires[id])}（計 ${r.sum.firesTotal[id]}）`).join(' | ')} |`);
}
lines.push('');

lines.push('## 4. 押し出し・凱歌');
lines.push('');
lines.push('| | ' + main.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + main.map(() => '---').join('|') + '|');
const mrow = (name, fn) => lines.push(`| ${name} | ${main.map((r) => fn(r.sum)).join(' | ')} |`);
mrow('押し出しが発動した回数（計）', (s) => `${s.chains}`);
mrow('**連鎖の長さの分布**（押された駒の数 0 / 1 / 2 / 3以上）', (s) => `**${s.chainDist.join(' / ')}**`);
mrow('連鎖の長さの最大', (s) => `${s.chainMax}`);
mrow('**盤外への押し出し**（計・試合あたり）', (s) => `**${s.pushOffBoardTotal}**（${f3(s.pushOffBoardPerGame)}）`);
mrow('凱歌の駒が盤に出た試合', (s) => `${s.triumphGames} 戦`);
mrow('**凱歌の駒が到達した最大の基礎の強さ**（試合ごとの最大の平均・全体の最大）', (s) => `**${f2(s.triumphMaxBaseMean)}・${Number.isFinite(s.triumphMaxBaseMax) ? s.triumphMaxBaseMax : '-'}**`);
mrow('　その試合数の分布（最大の基礎 1 / 2 / 3 / 4以上）', (s) => s.triumphBaseDist.join(' / '));
mrow('凱歌の駒が到達した最大の実際の強さ（同上）', (s) => `${f2(s.triumphMaxEffMean)}・${Number.isFinite(s.triumphMaxEffMax) ? s.triumphMaxEffMax : '-'}`);
lines.push('');

lines.push('## 5. 決着手数の分布（試合数）');
lines.push('');
lines.push('| 手数 | ' + results.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
for (let i = 0; i < results[0].sum.buckets.length; i++) {
  const b = results[0].sum.buckets[i];
  if (results.every((r) => r.sum.buckets[i].count === 0) && i < results[0].sum.buckets.length - 1) continue;
  lines.push(`| ${b.label} | ${results.map((r) => r.sum.buckets[i].count).join(' | ')} |`);
}
lines.push('');

lines.push('## 6. 測定の経路の確認（モック1・キング3・減らない ＝ CG-021 と一致するか）');
lines.push('');
lines.push('CG-021 の実測（HEAD `66e6eba`・2026-10-11 00:24 JST・シード 1000〜1499・500戦）と、この測定の確認列を並べた。');
lines.push('');
lines.push('| | 平均手数 | 中央値 | 先手勝率 | 引き分け | 一致 |');
lines.push('|---|---|---|---|---|---|');
const cs = check.sum;
const allMatch = f1(cs.meanPlies) === f1(CG021.meanPlies) && f1(cs.medianPlies) === f1(CG021.medianPlies) && pct(cs.p1Rate) === pct(CG021.p1Rate) && pct(cs.drawRate) === pct(CG021.drawRate);
lines.push(`| ${CG021.name} | ${f1(CG021.meanPlies)} | ${f1(CG021.medianPlies)} | ${pct(CG021.p1Rate)} | ${pct(CG021.drawRate)} | |`);
lines.push(`| この測定 ${check.label} | ${f1(cs.meanPlies)} | ${f1(cs.medianPlies)} | ${pct(cs.p1Rate)} | ${pct(cs.drawRate)} | ${allMatch ? '✅' : '⚠️ 不一致'} |`);
lines.push('');
lines.push(`確認列のそのほかの値：両者の山が尽きた試合 ${cs.decksOutGames} 戦（平均 ${f1(cs.decksOutMeanPly)} 手目）・戦闘 ${f2(cs.perGame.battles)}・寝返り ${f2(cs.perGame.defections)}・山へ還った ${f2(cs.perGame.returns)}・ドラフト ${f2(cs.perGame.drafts)}（/試合）・キングを倒した駒の実際の強さ 平均 ${f2(cs.kingKillerStrengthMean)}`);
lines.push('');

lines.push('## 指標の定義');
lines.push('');
lines.push('- **手数**: 「動かす・置く・引く（引くを1行動にする設定のとき）・パス」の数。寝返りの配置とドラフトは手番を使わないので数えない');
lines.push('- **決着までの平均手数・中央値・分布**: 引き分け（打ち切り）を除いた試合の手数');
lines.push('- **勝率・引き分けの率**: 全試合が分母');
lines.push('- **両者の山が尽きた試合**: 両者の山が同時に 0 枚になった時点があった試合。手数はその最初の時点');
lines.push('- **能力ごとの発動回数**: 常時の効果（鼓舞・槍衾・威圧）は「戦闘に参加した駒の実際の強さに効いた回数」（1戦闘で、効果の出どころの駒1つにつき1回）。不動は「押し出しを止めた回数」。それ以外は発火点で発動した回数（凱歌＝勝った回数、裏切り者＝寝返った回数、遺言＝山へ還った回数、押し出し＝攻めて勝った回数。押された先で何も起きなくても1回）');
lines.push('- **連鎖の長さ**: 押し出しが1回発動するたびに（連鎖の中の押し出しは同じ1回に含める）、押された駒の数。0＝先に駒がない・不動・キング・盤の端で止まった');
lines.push('- **盤外への押し出し**: 押された先が盤の外で、元の持ち主の山へ還った回数');
lines.push('- **凱歌の駒が到達した最大の強さ**: 各手の直後に盤上の凱歌の駒を見て、その試合での最大値（基礎の強さ・実際の強さ）。凱歌の駒が盤に出なかった試合は除く');
lines.push('- **キングを倒した駒の実際の強さ**: キングが倒れて決着した試合で、その戦闘での相手の駒の実際の強さ（同値で倒れたときは同じ値）。両キング相討ち・盤外への押し出しで倒れた試合は除く');
lines.push('');
lines.push('## 所見');
lines.push('');
lines.push('（このファイルの生成時点では空欄。所見はチャット側・DECISION_LOG に「推測」と明記して書く）');
lines.push('');

const outName = process.env.SIM_OUT || `v03モック2_能力8種_${ymd}_CG023.md`;
const outPath = path.join(__dirname, '..', 'docs', 'research', outName);
fs.writeFileSync(outPath, lines.join('\n'));
console.log(`書き出した: docs/research/${outName}`);
for (const r of results) {
  console.log(`${r.label}: 平均 ${f1(r.sum.meanPlies)} 手・中央値 ${f1(r.sum.medianPlies)}・先手 ${pct(r.sum.p1Rate)}・引分 ${pct(r.sum.drawRate)}・山尽き ${r.sum.decksOutGames} 戦 ${f1(r.sum.decksOutMeanPly)} 手目・連鎖 ${r.sum.chainDist.join('/')}・盤外 ${r.sum.pushOffBoardTotal}・凱歌最大 ${f2(r.sum.triumphMaxBaseMean)}/${r.sum.triumphMaxBaseMax}・王殺し ${f2(r.sum.kingKillerStrengthMean)}`);
}
console.log(`CG-021 との一致: ${allMatch}・予測の不一致 ${totalMismatch}/${totalChecks}`);
console.log(`HEAD ${head}${dirty ? '（未コミットの変更あり）' : ''}・${jst}・決定性 ${deterministic}`);
