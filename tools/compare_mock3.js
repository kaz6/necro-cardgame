/**
 * tools/compare_mock3.js — v0.3 モック3（運ぶ・投げる・前線基地）の自動対戦測定（CG-024）
 *
 *   「モック2／モック3」×「キング3・減らない／キング6・減る」の4列と、モック3・キング6・減る・前線基地なしの1列を、
 *   貪欲同士で同じシード帯に回して docs/research/ に Markdown で書き出す。
 *   ★ モック2の列は前線基地なし（CG-023 の時点の振る舞い）。モック2・キング3・減らないの列が CG-023 の数字と一致するかで、
 *     測定の経路が変わっていないことを確かめる。
 *   あわせて、作者の対戦ログ（2026-10-12・人間対貪欲・モック2・シード1000）を engine で再生し、駒の前進度を出す。
 *
 * 使い方:
 *   node tools/compare_mock3.js
 *   SIM_GAMES=500 SIM_SEED=1000 SIM_OUT=ファイル名.md node tools/compare_mock3.js
 *
 * ★ 測定値には日時・HEAD・シード帯を必ず添える（CLAUDE.md §4.1）。
 *   作業ツリーに未コミットの変更があると、HEAD の横に「未コミットの変更あり」と出す。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const H = require('./harness.js');
const E = require('../js/engine.js');

const GAMES = Number(process.env.SIM_GAMES || 500);
const SEED = Number(process.env.SIM_SEED || 1000);
const seeds = H.seedRange(SEED, GAMES);
const maxPlies = H.cardData.rules.maxPlies;
const AUTHOR_LOG = path.join(__dirname, '..', 'docs', 'research', 'playtest_logs', 'v03_mock2_20261012_seed1000_human_vs_greedy.json');

function git(cmd) {
  try { return execSync(`git ${cmd}`, { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim(); } catch (e) { return '?'; }
}
const head = git('rev-parse --short HEAD');
const dirty = git('status --porcelain -- js data tools index.html') !== '';
const now = new Date();
const jst = new Date(now.getTime() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' JST';
const ymd = jst.slice(0, 10).replace(/-/g, '');

const CONFIGS = [
  { key: 'm2k3', label: 'モック2・キング3 × 減らない', overrides: { pieceSet: 'mock2', frontBase: false, kingStrength: 3, winnerLosesStrength: false } },
  { key: 'm3k3', label: 'モック3・キング3 × 減らない', overrides: { pieceSet: 'mock3', frontBase: true, kingStrength: 3, winnerLosesStrength: false } },
  { key: 'm2k6', label: 'モック2・キング6 × 減る', overrides: { pieceSet: 'mock2', frontBase: false, kingStrength: 6, winnerLosesStrength: true } },
  { key: 'm3k6', label: 'モック3・キング6 × 減る', overrides: { pieceSet: 'mock3', frontBase: true, kingStrength: 6, winnerLosesStrength: true } },
  { key: 'm3k6nf', label: 'モック3・キング6 × 減る・前線基地なし', overrides: { pieceSet: 'mock3', frontBase: false, kingStrength: 6, winnerLosesStrength: true } },
];
// 測定の経路が変わっていないことの確認：CG-023 の実測（HEAD 3a262b2・2026-10-11 21:00 JST・同じシード帯 1000〜1499・500戦）
// 出典 docs/research/v03モック2_能力8種_20261011_CG023.md の「モック2・キング3 × 減らない」「モック2・キング6 × 減る」列
const CG023 = {
  m2k3: { name: 'CG-023 モック2・キング3 × 減らない', meanPlies: 24.0, medianPlies: 21.0, p1Rate: 0.550, drawRate: 0 },
  m2k6: { name: 'CG-023 モック2・キング6 × 減る', meanPlies: 64.8, medianPlies: 58.0, p1Rate: 0.490, drawRate: 0.004 },
};

const t0 = Date.now();
const results = [];
for (const c of CONFIGS) {
  const games = H.runBatch({ seeds, kinds: { p1: 'greedy', p2: 'greedy' }, overrides: c.overrides });
  results.push({ ...c, games, sum: H.summarize(games, maxPlies) });
}
// 決定性：モック3・キング3 の先頭20戦を回し直して一致を確かめる
const again = H.runBatch({ seeds: seeds.slice(0, 20), kinds: { p1: 'greedy', p2: 'greedy' }, overrides: CONFIGS[1].overrides });
const deterministic = again.every((g, i) => JSON.stringify(g) === JSON.stringify(results[1].games[i]));
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// 作者の対戦ログの前進度（engine で再生。★ ログには前線基地の設定がない＝CG-024 より前なので「なし」）
let authorLog = null;
if (fs.existsSync(AUTHOR_LOG)) {
  const log = JSON.parse(fs.readFileSync(AUTHOR_LOG, 'utf8'));
  let s = E.createInitialState(log.seed, H.cardData, { pieceSet: 'mock1', frontBase: false, ...log.settings });
  const adv = { p1: [H.advanceOf(s, 'p1')], p2: [H.advanceOf(s, 'p2')] };
  for (const a of log.actions) {
    s = E.reduce(s, a);
    adv.p1[s.ply] = H.advanceOf(s, 'p1');
    adv.p2[s.ply] = H.advanceOf(s, 'p2');
  }
  const ok = JSON.stringify(s.result) === JSON.stringify(log.result);
  const avg = (xs) => { const v = xs.filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
  const byPly = [];
  for (let k = 0; k <= s.ply; k += H.FILL_STEP) byPly.push({ ply: k, p1: adv.p1[k], p2: adv.p2[k] });
  authorLog = { file: path.relative(path.join(__dirname, '..'), AUTHOR_LOG), ok, plies: s.ply, result: s.result, players: log.players, p1: avg(adv.p1), p2: avg(adv.p2), byPly, settings: log.settings };
}

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '-');
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '-');
const defaults = H.cardData.rules;
const otherRules = Object.keys(defaults).filter((k) => k[0] !== '_' && !['winnerLosesStrength', 'pieceSet', 'frontBase'].includes(k))
  .map((k) => `${k}=${JSON.stringify(defaults[k])}`).join('・');
const abilityIds = Object.keys(H.cardData.abilities).filter((k) => k[0] !== '_');
const abilityName = (id) => H.cardData.abilities[id].name;
const totalChecks = results.reduce((n, r) => n + r.sum.previewChecks, 0);
const totalMismatch = results.reduce((n, r) => n + r.sum.previewMismatch, 0);
const byKey = Object.fromEntries(results.map((r) => [r.key, r]));

const lines = [];
lines.push('# v0.3 モック3 運ぶ・投げる・前線基地 自動対戦（CG-024）');
lines.push('');
lines.push(`調査日: ${jst.slice(0, 10)}`);
lines.push('');
lines.push(`- **測定日時**: ${jst}`);
lines.push(`- **HEAD**: \`${head}\`${dirty ? '（★ 未コミットの変更あり）' : ''}`);
lines.push(`- **シード帯**: ${SEED}〜${SEED + GAMES - 1}（${GAMES}戦／列・5列）`);
lines.push('- **CPU**: 貪欲同士（js/ai.js の greedy。勝敗は実際の強さで判断し、押し出しの連鎖と投げるの結果は打つ前の結果予測と同じ関数で読む。投げて勝てる攻撃も「取る」の候補。前線基地を狙う戦略は入れていない）');
lines.push('- **変えたもの**: 駒構成（モック2／モック3）× キングの強さと勝った側の強さ（キング3・減らない＝既定／キング6・減る）。モック3は前線基地あり（既定）、加えてモック3・キング6・減る・前線基地なしの1列');
lines.push('- ★ **モック2の列は前線基地なし**（CG-023 の時点の振る舞い。前線基地はどの駒構成でも効くが、測定の経路の確認のため切った）');
lines.push(`- **他の設定（既定のまま）**: ${otherRules}`);
lines.push(`- **実行**: \`node tools/compare_mock3.js\`（所要 ${elapsed} 秒）。同一シードの再実行で一致: ${deterministic ? `する（${CONFIGS[1].label} の先頭20戦で確認）` : '★ しない'}`);
lines.push(`- **予測と実際の解決の一致**: 全5列の移動・投げる ${totalChecks} 回のうち不一致 ${totalMismatch} 回（手を指すたびに、指す側の視点でフィルタした state で previewAction を呼び、reduce 後の盤・決着と比べた。200手の打ち切りは手の解決の後に手数で起きるので、比べる決着から除いた）`);
lines.push('');
lines.push('## TL;DR');
lines.push('');
for (const r of results) {
  lines.push(`- **${r.label}**: 決着まで平均 ${f1(r.sum.meanPlies)} 手（中央値 ${f1(r.sum.medianPlies)}）・先手勝率 ${pct(r.sum.p1Rate)}・引き分け ${pct(r.sum.drawRate)}・駒の前進度 ${pct(r.sum.advance.overall)}・前線基地が成立した試合 ${pct(r.sum.frontBaseGames / r.sum.n)}`);
}
if (authorLog) lines.push(`- **作者の対戦ログ**（モック2・人間対貪欲・${authorLog.plies}手）: 駒の前進度 作者（先手）${pct(authorLog.p1)}・CPU（後手）${pct(authorLog.p2)}`);
lines.push('- ★ ここに並べたのは実測値だけ。解釈は書いていない（チャット側・DECISION_LOG に「推測」と明記して書く）');
lines.push('');

lines.push('## 1. 主な指標');
lines.push('');
lines.push('| | ' + results.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
const row = (name, fn) => lines.push(`| ${name} | ${results.map((r) => fn(r.sum)).join(' | ')} |`);
row('決着までの平均手数', (s) => f1(s.meanPlies));
row('中央値', (s) => f1(s.medianPlies));
row('10%点〜90%点', (s) => (Number.isFinite(s.p10) ? `${s.p10}〜${s.p90}` : '-'));
row('先手の勝率', (s) => pct(s.p1Rate));
row('後手の勝率', (s) => pct(s.p2 / s.n));
row(`**引き分けの率（${maxPlies}手到達）**`, (s) => `**${pct(s.drawRate)}**（${s.draws} 戦）`);
row('両キング同値の相討ち（引き分け）', (s) => `${s.both} 戦`);
row('　うち 同値でキングが倒れた', (s) => `${s.kingTieEnds} 戦`);
row('**両者の山が尽きた試合（尽きた手数の平均）**', (s) => `**${s.decksOutGames} 戦（${f1(s.decksOutMeanPly)} 手目）**`);
row('キングを倒した駒の実際の強さ（平均）', (s) => `${f2(s.kingKillerStrengthMean)}（${s.kingKillerGames} 戦）`);
row('戦闘 / 試合', (s) => f2(s.perGame.battles));
row('　うち 押し出しの連鎖の中の戦闘', (s) => f2(s.chainBattlesPerGame));
row('寝返り / 試合', (s) => f2(s.perGame.defections));
row('山へ還った / 試合', (s) => f2(s.perGame.returns));
row('ドラフト / 試合', (s) => f2(s.perGame.drafts));
row('置く / 試合', (s) => f2(s.perGame.places));
row('動かす / 試合', (s) => f2(s.perGame.moves));
lines.push('');

lines.push('## 2. 運ぶ・投げる・前線基地・駒の前進度');
lines.push('');
lines.push('| | ' + results.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
row('**駒の前進度**（全試合・全手・両者の平均）', (s) => `**${pct(s.advance.overall)}**`);
row('　先手 / 後手', (s) => `${pct(s.advance.p1)} / ${pct(s.advance.p2)}`);
row('**運ぶで一緒に動いた回数** / 試合（計）', (s) => `**${f3(s.carriedPerGame)}**（計 ${s.carriedTotal}）`);
row('　隣に味方がいたが行き先が空いておらず動かなかった（計）', (s) => `${s.carryBlockedTotal}`);
row('**投げた回数** / 試合（計）', (s) => `**${f3(s.throwsPerGame)}**（計 ${s.throwsTotal}）`);
row('　うち 敵に着地して戦闘（計）', (s) => `${s.throwBattlesTotal}`);
row('　その勝ち / 同値 / 負け（勝率）', (s) => `${s.throwWinsTotal} / ${s.throwTiesTotal} / ${s.throwBattlesTotal - s.throwWinsTotal - s.throwTiesTotal}（${s.throwBattlesTotal ? pct(s.throwWinsTotal / s.throwBattlesTotal) : '-'}）`);
row('**前線基地が成立した試合の割合**（試合数）', (s) => `**${pct(s.frontBaseGames / s.n)}**（${s.frontBaseGames} 戦）`);
row('　最初に成立した手数（平均）', (s) => f1(s.frontBasePlyMean));
row('**前線基地に置いた回数** / 試合（計）', (s) => `**${f3(s.frontBasePlacesPerGame)}**（計 ${s.frontBasePlacesTotal}）`);
lines.push('');

lines.push('## 3. 駒の前進度の推移（その手数でまだ決着していない試合の、両者の平均）');
lines.push('');
lines.push('（ ）内はその手数で続いている試合数。');
lines.push('');
lines.push('| 手数 | ' + results.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
for (let i = 0; i < results[0].sum.advance.byPly.length; i++) {
  if (results.every((r) => r.sum.advance.byPly[i].games === 0)) break;
  const k = results[0].sum.advance.byPly[i].ply;
  lines.push(`| ${k} | ${results.map((r) => { const b = r.sum.advance.byPly[i]; return b.games === 0 ? '-' : `${pct(b.mean)}（${b.games}）`; }).join(' | ')} |`);
}
lines.push('');

lines.push('## 4. 能力ごとの発動回数（試合あたり）');
lines.push('');
lines.push('| 能力 | ' + results.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
for (const id of abilityIds) {
  lines.push(`| ${abilityName(id)}（${H.cardData.abilities[id].trigger}） | ${results.map((r) => `${f3(r.sum.fires[id])}（計 ${r.sum.firesTotal[id]}）`).join(' | ')} |`);
}
lines.push('');

lines.push('## 5. 押し出し・凱歌');
lines.push('');
lines.push('| | ' + results.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
row('押し出しが発動した回数（計）', (s) => `${s.chains}`);
row('連鎖の長さの分布（押された駒の数 0 / 1 / 2 / 3以上）', (s) => s.chainDist.join(' / '));
row('盤外への押し出し（計・試合あたり）', (s) => `${s.pushOffBoardTotal}（${f3(s.pushOffBoardPerGame)}）`);
row('凱歌の駒が盤に出た試合', (s) => `${s.triumphGames} 戦`);
row('凱歌の駒が到達した最大の基礎の強さ（試合ごとの最大の平均・全体の最大）', (s) => `${f2(s.triumphMaxBaseMean)}・${Number.isFinite(s.triumphMaxBaseMax) ? s.triumphMaxBaseMax : '-'}`);
lines.push('');

lines.push('## 6. 決着手数の分布（試合数）');
lines.push('');
lines.push('| 手数 | ' + results.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
for (let i = 0; i < results[0].sum.buckets.length; i++) {
  const b = results[0].sum.buckets[i];
  if (results.every((r) => r.sum.buckets[i].count === 0) && i < results[0].sum.buckets.length - 1) continue;
  lines.push(`| ${b.label} | ${results.map((r) => r.sum.buckets[i].count).join(' | ')} |`);
}
lines.push('');

lines.push('## 7. 測定の経路の確認（モック2の列 ＝ CG-023 と一致するか）');
lines.push('');
lines.push('CG-023 の実測（HEAD `3a262b2`・2026-10-11 21:00 JST・シード 1000〜1499・500戦）と、この測定のモック2の列を並べた。');
lines.push('');
lines.push('| | 平均手数 | 中央値 | 先手勝率 | 引き分け | 一致 |');
lines.push('|---|---|---|---|---|---|');
let allMatch = true;
for (const key of Object.keys(CG023)) {
  const ref = CG023[key];
  const s = byKey[key].sum;
  const ok = f1(s.meanPlies) === f1(ref.meanPlies) && f1(s.medianPlies) === f1(ref.medianPlies) && pct(s.p1Rate) === pct(ref.p1Rate) && pct(s.drawRate) === pct(ref.drawRate);
  if (!ok) allMatch = false;
  lines.push(`| ${ref.name} | ${f1(ref.meanPlies)} | ${f1(ref.medianPlies)} | ${pct(ref.p1Rate)} | ${pct(ref.drawRate)} | |`);
  lines.push(`| この測定 ${byKey[key].label} | ${f1(s.meanPlies)} | ${f1(s.medianPlies)} | ${pct(s.p1Rate)} | ${pct(s.drawRate)} | ${ok ? '✅' : '⚠️ 不一致'} |`);
}
lines.push('');

lines.push('## 8. 作者の対戦ログの駒の前進度');
lines.push('');
if (!authorLog) {
  lines.push('（ログが見つからないので飛ばした）');
} else {
  lines.push(`- ログ: \`${authorLog.file}\`（${authorLog.players.p1}（先手）対 ${authorLog.players.p2}（後手）・駒構成 ${authorLog.settings.pieceSet}・シード 1000）`);
  lines.push(`- engine で再生: ${authorLog.plies} 手・結果 ${JSON.stringify(authorLog.result)}・記録と一致 ${authorLog.ok ? 'する' : '★ しない'}（前線基地の設定はログになく、CG-024 より前なので「なし」で再生）`);
  lines.push(`- **駒の前進度（全手の平均）: 作者（先手）${pct(authorLog.p1)}・CPU（後手）${pct(authorLog.p2)}**`);
  lines.push('');
  lines.push('| 手数 | 作者（先手） | CPU（後手） |');
  lines.push('|---|---|---|');
  for (const b of authorLog.byPly) lines.push(`| ${b.ply} | ${b.p1 === null || b.p1 === undefined ? '-（駒なし）' : pct(b.p1)} | ${b.p2 === null || b.p2 === undefined ? '-（駒なし）' : pct(b.p2)} |`);
}
lines.push('');

lines.push('## 指標の定義');
lines.push('');
lines.push('- **手数**: 「動かす・投げる・置く・引く（引くを1行動にする設定のとき）・パス」の数。寝返りの配置とドラフトは手番を使わないので数えない');
lines.push('- **決着までの平均手数・中央値・分布**: 引き分け（打ち切り）を除いた試合の手数。勝率・引き分けの率は全試合が分母');
lines.push(`- **駒の前進度**: 各手の直後（保留の解決も済んだ時点）に、その側の今の持ち主の駒（キングを除く）のうち、自陣の奥の${H.ADVANCE_ROWS}列（最奥列から${H.ADVANCE_ROWS - 1}列前まで＝配置範囲 0〜2 の届く範囲）より前にいる駒の割合。盤上にその側の駒がない手は平均に入れない。表1・2の値は全試合・全手・両者の平均（0手目＝初期配置の直後を含む）`);
lines.push('- **運ぶで一緒に動いた回数**: 運ぶの駒が攻撃でない移動をし、右隣の味方が実際に一緒に動いた回数。「行き先が空いておらず動かなかった」は、隣に味方がいたが行き先に駒がいた・盤の外だった回数（能力の発動回数の「運ぶ」は、この2つの合計）');
lines.push('- **投げた回数**: 投げるを指した回数。敵に着地して戦闘になった回数と、その戦闘で投げられた駒が勝った・同値だった・負けた回数');
lines.push('- **前線基地が成立した試合**: どちらかの側のポーンが相手側の最奥列にいた時点（各手の直後）があった試合。最初に成立した手数はその最初の時点');
lines.push('- **前線基地に置いた回数**: 置いたマスが、その駒の普段の置き場所（配置範囲）ではなく、前線基地で加わったマスだった回数');
lines.push('- **能力ごとの発動回数**: 常時の効果（鼓舞・槍衾・威圧）は「戦闘に参加した駒の実際の強さに効いた回数」。不動は「押し出しを止めた回数」。運ぶは「隣に連れて動く味方がいた回数」。投げるは「投げた回数」。それ以外は発火点で発動した回数');
lines.push('- **キングを倒した駒の実際の強さ**: キングが倒れて決着した試合で、その戦闘での相手の駒の実際の強さ。両キング相討ち・盤外への押し出しで倒れた試合は除く');
lines.push('');
lines.push('## 所見');
lines.push('');
lines.push('（このファイルの生成時点では空欄。所見はチャット側・DECISION_LOG に「推測」と明記して書く）');
lines.push('');

const outName = process.env.SIM_OUT || `v03モック3_運ぶ投げる前線基地_${ymd}_CG024.md`;
const outPath = path.join(__dirname, '..', 'docs', 'research', outName);
fs.writeFileSync(outPath, lines.join('\n'));
console.log(`書き出した: docs/research/${outName}`);
for (const r of results) {
  const s = r.sum;
  console.log(`${r.label}: 平均 ${f1(s.meanPlies)} 手・中央値 ${f1(s.medianPlies)}・先手 ${pct(s.p1Rate)}・引分 ${pct(s.drawRate)}・前進度 ${pct(s.advance.overall)}・前線基地 ${s.frontBaseGames} 戦 / 置いた ${s.frontBasePlacesTotal}・運んだ ${s.carriedTotal}・投げた ${s.throwsTotal}（戦闘 ${s.throwBattlesTotal}・勝ち ${s.throwWinsTotal}）`);
}
if (authorLog) console.log(`作者のログ: 再生一致 ${authorLog.ok}・前進度 作者 ${pct(authorLog.p1)}・CPU ${pct(authorLog.p2)}`);
console.log(`CG-023 との一致: ${allMatch}・予測の不一致 ${totalMismatch}/${totalChecks}`);
console.log(`HEAD ${head}${dirty ? '（未コミットの変更あり）' : ''}・${jst}・決定性 ${deterministic}`);
