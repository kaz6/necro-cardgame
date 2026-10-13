/**
 * tools/compare_mock4.js — v0.3 モック4（解放と連鎖）の自動対戦測定（CG-025）
 *
 *   「モック3・キング6・減る」と「モック4・キング6・減る」の2列だけを、貪欲同士で同じシード帯に回して
 *   docs/research/ に Markdown で書き出す（★ 指示で列はこの2つだけ。面白さは人間が触って決める方針なので、壊れていない確認が主目的）。
 *   ★ モック3の列は CG-024 の「モック3・キング6 × 減る」（前線基地あり＝既定）と同じ設定。CG-024 の数字と一致するかで、
 *     測定の経路が変わっていないことを確かめる。
 *
 * 使い方:
 *   node tools/compare_mock4.js
 *   SIM_GAMES=500 SIM_SEED=1000 SIM_OUT=ファイル名.md node tools/compare_mock4.js
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
  { key: 'm3k6', label: 'モック3・キング6 × 減る', overrides: { pieceSet: 'mock3', frontBase: true, kingStrength: 6, winnerLosesStrength: true } },
  { key: 'm4k6', label: 'モック4・キング6 × 減る', overrides: { pieceSet: 'mock4', frontBase: true, kingStrength: 6, winnerLosesStrength: true } },
];
// 測定の経路が変わっていないことの確認：CG-024 の実測（HEAD 6d625ce・2026-10-12 23:36 JST・同じシード帯 1000〜1499・500戦）
// 出典 docs/research/v03モック3_運ぶ投げる前線基地_20261012_CG024.md の「モック3・キング6 × 減る」列
const CG024 = { name: 'CG-024 モック3・キング6 × 減る', meanPlies: 65.3, medianPlies: 60.0, p1Rate: 0.494, drawRate: 0, advance: 0.087, carried: 97, throws: 167 };

const t0 = Date.now();
const results = [];
for (const c of CONFIGS) {
  const games = H.runBatch({ seeds, kinds: { p1: 'greedy', p2: 'greedy' }, overrides: c.overrides });
  results.push({ ...c, games, sum: H.summarize(games, maxPlies) });
}
// 決定性：モック4 の先頭20戦を回し直して一致を確かめる
const again = H.runBatch({ seeds: seeds.slice(0, 20), kinds: { p1: 'greedy', p2: 'greedy' }, overrides: CONFIGS[1].overrides });
const deterministic = again.every((g, i) => JSON.stringify(g) === JSON.stringify(results[1].games[i]));
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

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
lines.push('# v0.3 モック4 解放と連鎖 自動対戦（CG-025）');
lines.push('');
lines.push(`調査日: ${jst.slice(0, 10)}`);
lines.push('');
lines.push(`- **測定日時**: ${jst}`);
lines.push(`- **HEAD**: \`${head}\`${dirty ? '（★ 未コミットの変更あり）' : ''}`);
lines.push(`- **シード帯**: ${SEED}〜${SEED + GAMES - 1}（${GAMES}戦／列・2列）`);
lines.push('- **CPU**: 貪欲同士（js/ai.js の greedy。勝敗は実際の強さで判断し、押し出し・爆風などの連鎖の先は打つ前の結果予測と同じ関数で読む。投げる・入れ替えも「動かす」と同じに扱う。運ぶ（改）の選択は決め打ちの順番の先頭。強くはしていない）');
lines.push('- **列**: モック3・キング6・勝った側が減る（CG-024 と同じ設定）／モック4・キング6・勝った側が減る。どちらも前線基地あり（既定）');
lines.push(`- **他の設定（既定のまま）**: ${otherRules}`);
lines.push(`- **実行**: \`node tools/compare_mock4.js\`（所要 ${elapsed} 秒）。同一シードの再実行で一致: ${deterministic ? `する（${CONFIGS[1].label} の先頭20戦で確認）` : '★ しない'}`);
lines.push(`- **予測と実際の解決の一致**: 2列の移動・投げる・入れ替え ${totalChecks} 回のうち不一致 ${totalMismatch} 回（手を指すたびに、指す側の視点でフィルタした state で previewAction を呼び、reduce 後の盤・決着と比べた。200手の打ち切りは手の解決の後に手数で起きるので、比べる決着から除いた）`);
lines.push('');
lines.push('## TL;DR');
lines.push('');
for (const r of results) {
  const s = r.sum;
  lines.push(`- **${r.label}**: 決着まで平均 ${f1(s.meanPlies)} 手（中央値 ${f1(s.medianPlies)}）・引き分け ${pct(s.drawRate)}・駒の前進度 ${pct(s.advance.overall)}・2段以上の連鎖 ${s.deepActions} 回（${s.deepGames} 戦）・盤外への押し出し ${s.pushOffBoardTotal} 回`);
}
lines.push('- ★ ここに並べたのは実測値だけ。解釈は書いていない（チャット側・DECISION_LOG に「推測」と明記して書く）');
lines.push('');

lines.push('## 1. 主な指標');
lines.push('');
lines.push('| | ' + results.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
const row = (name, fn) => lines.push(`| ${name} | ${results.map((r) => fn(r.sum)).join(' | ')} |`);
row('**決着までの平均手数**', (s) => `**${f1(s.meanPlies)}**`);
row('中央値', (s) => f1(s.medianPlies));
row('10%点〜90%点', (s) => (Number.isFinite(s.p10) ? `${s.p10}〜${s.p90}` : '-'));
row('先手の勝率', (s) => pct(s.p1Rate));
row('後手の勝率', (s) => pct(s.p2 / s.n));
row(`**引き分けの率（${maxPlies}手到達）**`, (s) => `**${pct(s.drawRate)}**（${s.draws} 戦）`);
row('両キング同値の相討ち（引き分け）', (s) => `${s.both} 戦`);
row('**駒の前進度**（全試合・全手・両者の平均）', (s) => `**${pct(s.advance.overall)}**`);
row('　先手 / 後手', (s) => `${pct(s.advance.p1)} / ${pct(s.advance.p2)}`);
row('両者の山が尽きた試合（尽きた手数の平均）', (s) => `${s.decksOutGames} 戦（${f1(s.decksOutMeanPly)} 手目）`);
row('戦闘 / 試合', (s) => f2(s.perGame.battles));
row('寝返り / 試合', (s) => f2(s.perGame.defections));
row('山へ還った / 試合', (s) => f2(s.perGame.returns));
row('置く / 試合', (s) => f2(s.perGame.places));
row('動かす / 試合', (s) => f2(s.perGame.moves));
lines.push('');

lines.push('## 2. 連鎖の長さの分布（手番の行動1回ごとの、連鎖の段の最大）');
lines.push('');
lines.push('段＝能力で動かされた駒の世代。1段目＝手の直接の結果として動いた駒（押し出しで押された・運ばれた・投げられた・入れ替えられた）、2段目以上＝動かされた駒の能力がさらに駒を動かした（反動・爆風・道連れ・押し出しの連鎖など）。');
lines.push('');
lines.push('| | ' + results.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
row('手番の行動（移動・投げる・入れ替え）の数（計）', (s) => `${s.actionsCompared}`);
row('段 0（能力で動いた駒なし）', (s) => `${s.depthDist[0]}`);
row('段 1', (s) => `${s.depthDist[1]}`);
row('**段 2**', (s) => `**${s.depthDist[2]}**`);
row('**段 3**', (s) => `**${s.depthDist[3]}**`);
row('**段 4 以上**', (s) => `**${s.depthDist[4]}**`);
row('**2段以上の連鎖が起きた手（計）／起きた試合**', (s) => `**${s.deepActions} 回／${s.deepGames} 戦**`);
row('最も深い段', (s) => `${s.depthMax}`);
lines.push('');

lines.push('## 3. 押し出し・盤の外');
lines.push('');
lines.push('| | ' + results.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
row('**盤外へ押し出された回数（計・試合あたり）**（押し出し・反動・爆風の合計）', (s) => `**${s.pushOffBoardTotal}**（${f3(s.pushOffBoardPerGame)}）`);
row('押された駒の数の分布（押しが始まった手ごと：0 / 1 / 2 / 3以上）', (s) => s.chainDist.join(' / '));
row('押しの中の戦闘 / 試合', (s) => f2(s.chainBattlesPerGame));
lines.push('');

lines.push('## 4. 能力ごとの発動回数（試合あたり・計）');
lines.push('');
lines.push('| 能力 | ' + results.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
for (const id of abilityIds) {
  lines.push(`| ${abilityName(id)}（${H.cardData.abilities[id].trigger}） | ${results.map((r) => `${f3(r.sum.fires[id])}（計 ${r.sum.firesTotal[id]}）`).join(' | ')} |`);
}
lines.push('');
lines.push('| 能力の中身（計） | ' + results.map((r) => r.label).join(' | ') + ' |');
lines.push('|---|' + results.map(() => '---').join('|') + '|');
row('運ぶ・運ぶ（改）で一緒に動いた', (s) => `${s.carriedTotal}`);
row('運ぶ（改）の選択肢がある移動を CPU が指した', (s) => `${s.carryOfferedTotal}`);
row('投げた（うち敵に着地して戦闘）', (s) => `${s.throwsTotal}（${s.throwBattlesTotal}）`);
row('入れ替えた', (s) => `${s.swapsTotal}`);
row('すり抜けで味方を飛び越えた', (s) => `${s.allyPassesTotal}`);
row('道連れで引きずった／引きずれなかった', (s) => `${s.draggedTotal}／${s.dragBlockedTotal}`);
lines.push('');

lines.push('## 5. 駒の前進度の推移（その手数でまだ決着していない試合の、両者の平均）');
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

lines.push('## 7. 測定の経路の確認（モック3の列 ＝ CG-024 と一致するか）');
lines.push('');
lines.push('CG-024 の実測（HEAD `6d625ce`・2026-10-12 23:36 JST・シード 1000〜1499・500戦）と、この測定のモック3の列を並べた。');
lines.push('');
lines.push('| | 平均手数 | 中央値 | 先手勝率 | 引き分け | 駒の前進度 | 運んだ／投げた（計） | 一致 |');
lines.push('|---|---|---|---|---|---|---|---|');
const s3 = byKey.m3k6.sum;
const match = f1(s3.meanPlies) === f1(CG024.meanPlies) && f1(s3.medianPlies) === f1(CG024.medianPlies) && pct(s3.p1Rate) === pct(CG024.p1Rate)
  && pct(s3.drawRate) === pct(CG024.drawRate) && pct(s3.advance.overall) === pct(CG024.advance) && s3.carriedTotal === CG024.carried && s3.throwsTotal === CG024.throws;
lines.push(`| ${CG024.name} | ${f1(CG024.meanPlies)} | ${f1(CG024.medianPlies)} | ${pct(CG024.p1Rate)} | ${pct(CG024.drawRate)} | ${pct(CG024.advance)} | ${CG024.carried}／${CG024.throws} | |`);
lines.push(`| この測定 ${byKey.m3k6.label} | ${f1(s3.meanPlies)} | ${f1(s3.medianPlies)} | ${pct(s3.p1Rate)} | ${pct(s3.drawRate)} | ${pct(s3.advance.overall)} | ${s3.carriedTotal}／${s3.throwsTotal} | ${match ? '✅' : '⚠️ 不一致'} |`);
lines.push('');

lines.push('## 指標の定義');
lines.push('');
lines.push('- **手数**: 「動かす・投げる・入れ替える・置く・引く（引くを1行動にする設定のとき）・パス」の数。寝返りの配置とドラフトは手番を使わないので数えない');
lines.push('- **決着までの平均手数・中央値・分布**: 引き分け（打ち切り）を除いた試合の手数。勝率・引き分けの率は全試合が分母');
lines.push(`- **駒の前進度**: 各手の直後に、その側の今の持ち主の駒（キングを除く）のうち、自陣の奥の${H.ADVANCE_ROWS}列より前にいる駒の割合（CG-024 と同じ定義）`);
lines.push('- **連鎖の段**: 手番の行動1回の解決で出たイベントの depth の最大。手番の行動で動いた駒・投げる駒・入れ替える駒は 0 段、その能力や手で動かされた駒は 1 段、1 段の駒の能力で動かされた駒は 2 段…と数える（engine の markMoved）。押し出しで押された駒が戦闘に勝ってさらに押す（モック2からある押し出しの連鎖）も 2 段に数える');
lines.push('- **盤外へ押し出された回数**: 押し出し・反動・爆風で押されて盤の外へ出た（元の持ち主の山へ還った）駒の数');
lines.push('- **押された駒の数の分布**: 押し（押し出し・反動・爆風）が始まった手ごとの、押されて動いた駒の数（CG-023 からある指標。反動・爆風の押しも数える）');
lines.push('- **能力ごとの発動回数**: 常時の効果（威圧ほか）は「戦闘に参加した駒の実際の強さに効いた回数」。不動は「押しを止めた回数（道連れを止めた回数も含む）」。運ぶ・運ぶ（改）は「実際に一緒に動かした（モック3の運ぶは隣に連れて動く味方がいた）回数」。投げる・入れ替えは「指した回数」。すり抜けは「味方を飛び越えた移動の回数」。道連れは「後ろに敵がいた回数」（引きずれなかった回数を含む）。それ以外は発火点で発動した回数');
lines.push('');
lines.push('## 所見');
lines.push('');
lines.push('（このファイルの生成時点では空欄。所見はチャット側・DECISION_LOG に「推測」と明記して書く）');
lines.push('');

const outName = process.env.SIM_OUT || `v03モック4_解放と連鎖_${ymd}_CG025.md`;
const outPath = path.join(__dirname, '..', 'docs', 'research', outName);
fs.writeFileSync(outPath, lines.join('\n'));
console.log(`書き出した: docs/research/${outName}`);
for (const r of results) {
  const s = r.sum;
  console.log(`${r.label}: 平均 ${f1(s.meanPlies)} 手・中央値 ${f1(s.medianPlies)}・先手 ${pct(s.p1Rate)}・引分 ${pct(s.drawRate)}・前進度 ${pct(s.advance.overall)}・段 ${s.depthDist.join('/')}・2段以上 ${s.deepActions} 回（${s.deepGames} 戦）・盤外 ${s.pushOffBoardTotal}・発動 ${JSON.stringify(s.firesTotal)}`);
}
console.log(`CG-024 との一致: ${match}・予測の不一致 ${totalMismatch}/${totalChecks}`);
console.log(`HEAD ${head}${dirty ? '（未コミットの変更あり）' : ''}・${jst}・決定性 ${deterministic}`);
