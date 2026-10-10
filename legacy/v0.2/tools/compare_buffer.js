/**
 * tools/compare_buffer.js — 墓地召喚のバッファ（CG-011）の前後比較
 *
 * 使い方:
 *   SIM_GAMES=500 SIM_SEED=1000 node tools/compare_buffer.js "2026-08-12 12:00 JST" <HEAD短縮ハッシュ>
 *
 *   SIM_GAMES  試行回数（既定 500・CG-011 で 1000 から半減）
 *   SIM_SEED   開始シード（既定 1000）
 *   SIM_OUT    出力ファイル名（docs/research/ 配下）
 *
 * 同じシード帯・同じ AI で、`data/cards.js` の `rules.graveyardSummonBuffer` だけを
 * 差し替えて並べる。デッキ・カードの数値・能力・AI の重みは一切変えていない。
 *
 *   0 … CG-010 までの挙動（墓地に入ったカードを即座に召喚できる）
 *   1 … 墓地に入ったその手番中は召喚できない
 *   2 … 墓地の持ち主が自分の手番を1回またぐまで召喚できない（CG-011 の既定）
 *
 * ★ 観測値だけを書く。解釈・結論は書かない。
 */

const { writeFileSync } = require('node:fs');
const path = require('node:path');

const { runSimulation } = require('./harness.js');

const here = __dirname;
const cardData = require(path.join(here, '..', 'data', 'cards.js'));
const aiData = require(path.join(here, '..', 'data', 'ai.js'));

const stamp = process.argv[2] || '（日時未取得）';
const head = process.argv[3] || '（HEAD未取得）';
const GAMES = Number.parseInt(process.env.SIM_GAMES || '500', 10);
const BASE_SEED = Number.parseInt(process.env.SIM_SEED || '1000', 10);
const outName = process.env.SIM_OUT || 'CG011_墓地バッファ_前後比較_20260812.md';

/** rules.graveyardSummonBuffer だけを差し替えた cardData を作る */
function withBuffer(data, n) {
  return { ...data, rules: { ...data.rules, graveyardSummonBuffer: n } };
}

const now = cardData.rules.graveyardSummonBuffer;
if (now !== 0) {
  console.log(`★ 注意: data/cards.js の graveyardSummonBuffer は ${now}（既定は 0・CG-016）。各列は明示指定で測る`);
}

console.log('前（バッファなし・0）を実行中...');
const b0 = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'cpu', cardData: withBuffer(cardData, 0), aiData });
console.log('中（同手番のみ禁止・1）を実行中...');
const b1 = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'cpu', cardData: withBuffer(cardData, 1), aiData });
console.log('後（1手番またぎ・2）を実行中...');
const b2 = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'cpu', cardData: withBuffer(cardData, 2), aiData });
console.log('参考: ドロー枚数との2x2 を実行中...');
const grid = {};
for (const draw of [2, 3]) {
  for (const buf of [0, 2]) {
    const d = { ...cardData, rules: { ...cardData.rules, drawPerTurn: draw, graveyardSummonBuffer: buf } };
    grid[`${draw}-${buf}`] = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'cpu', cardData: d, aiData });
  }
}
console.log('ランダムAI（0 / 2）を実行中...');
const r0 = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'random', cardData: withBuffer(cardData, 0), aiData });
const r2 = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'random', cardData: withBuffer(cardData, 2), aiData });

// ---------------------------------------------------------------------------

const pct = (n, d) => (d ? (n / d) * 100 : 0);
const f1 = (x) => x.toFixed(1);
const f2 = (x) => x.toFixed(2);
const fill = (r) => (r.fillMean / r.boardSlots) * 100;
const row = (label, a, b, c) => `| ${label} | ${a} | ${b} | ${c} |`;

/**
 * 埋まり率は「1ターン＝1サンプル」なので、未決着の試合ほど重く効く（CG-010 の教訓）。
 * 全体平均だけでなく、決着した試合のみ／ターン範囲を絞った平均も出す。
 */
function fillBreakdown(r, opt) {
  let sum = 0, n = 0;
  for (const g of r.perGame) {
    if (opt.decidedOnly && !g.decided) continue;
    for (const s of g.perTurn) {
      if (opt.minTurn && s.turn < opt.minTurn) continue;
      if (opt.maxTurn && s.turn > opt.maxTurn) continue;
      sum += s.fill.p1 + s.fill.p2;
      n += 2;
    }
  }
  return { mean: n ? sum / n : 0, samples: n };
}
function undecidedShare(r) {
  const all = fillBreakdown(r, {});
  const dec = fillBreakdown(r, { decidedOnly: true });
  return pct(all.samples - dec.samples, all.samples);
}
const fillCell = (r, opt) => {
  const b = fillBreakdown(r, opt);
  return `${f1(pct(b.mean, r.boardSlots))}%（${f2(b.mean)} / 6枠）`;
};

const mainRows = [
  row('★ 先攻勝率', `${f1(b0.firstWinRate)}%`, `${f1(b1.firstWinRate)}%`, `${f1(b2.firstWinRate)}%`),
  row('平均決着ターン数', f1(b0.turnsMean), f1(b1.turnsMean), f1(b2.turnsMean)),
  row('盤面の平均埋まり率（全体）', `${f1(fill(b0))}%`, `${f1(fill(b1))}%`, `${f1(fill(b2))}%`),
  row('墓地からの召喚の割合', `${f1(b0.graveSummonRate)}%`, `${f1(b1.graveSummonRate)}%`, `${f1(b2.graveSummonRate)}%`),
].join('\n');

const fillRows = [
  row('全体', fillCell(b0, {}), fillCell(b1, {}), fillCell(b2, {})),
  row('決着した試合のみ', fillCell(b0, { decidedOnly: true }), fillCell(b1, { decidedOnly: true }), fillCell(b2, { decidedOnly: true })),
  row('ターン2〜10のみ', fillCell(b0, { minTurn: 2, maxTurn: 10 }), fillCell(b1, { minTurn: 2, maxTurn: 10 }), fillCell(b2, { minTurn: 2, maxTurn: 10 })),
  row('ターン2〜16のみ', fillCell(b0, { minTurn: 2, maxTurn: 16 }), fillCell(b1, { minTurn: 2, maxTurn: 16 }), fillCell(b2, { minTurn: 2, maxTurn: 16 })),
  row('未決着がサンプルに占める割合', `${f1(undecidedShare(b0))}%`, `${f1(undecidedShare(b1))}%`, `${f1(undecidedShare(b2))}%`),
].join('\n');

const subRows = [
  row('決着 / 未決着', `${b0.decided} / ${b0.undecided}`, `${b1.decided} / ${b1.undecided}`, `${b2.decided} / ${b2.undecided}`),
  row('決着ターン 中央値', String(b0.turnsMedian), String(b1.turnsMedian), String(b2.turnsMedian)),
  row('決着ターン 範囲', `${b0.turnsMin}〜${b0.turnsMax}`, `${b1.turnsMin}〜${b1.turnsMax}`, `${b2.turnsMin}〜${b2.turnsMax}`),
  row('奪取（回/試合）', f2(b0.stealsMean), f2(b1.stealsMean), f2(b2.stealsMean)),
  row('召喚回数（合計）', String(b0.totalSummons), String(b1.totalSummons), String(b2.totalSummons)),
  row('　うち手札から', String(b0.fromHand), String(b1.fromHand), String(b2.fromHand)),
  row('　うち墓地から', String(b0.fromGrave), String(b1.fromGrave), String(b2.fromGrave)),
  row('ピッチ0枚で成立した召喚', String(b0.freeSummons), String(b1.freeSummons), String(b2.freeSummons)),
  row('里帰り（自分の持ち札が自分の墓地へ）', String(b0.homecoming), String(b1.homecoming), String(b2.homecoming)),
  row('総手数（action 数）', String(b0.steps), String(b1.steps), String(b2.steps)),
].join('\n');

const abilityRows = [
  row('c05 後列へ退いた / 不発', `${b0.ability.retreat} / ${b0.ability.retreatFailed}`, `${b1.ability.retreat} / ${b1.ability.retreatFailed}`, `${b2.ability.retreat} / ${b2.ability.retreatFailed}`),
  row('c06 トークン生成 / 不発', `${b0.ability.token} / ${b0.ability.tokenBlocked}`, `${b1.ability.token} / ${b1.ability.tokenBlocked}`, `${b2.ability.token} / ${b2.ability.tokenBlocked}`),
  row('c07 デッキ送り', String(b0.ability.mill), String(b1.ability.mill), String(b2.ability.mill)),
  row('c08 呪い発動（合計pt）', `${b0.ability.curse}（+${b0.ability.curseTax}pt）`, `${b1.ability.curse}（+${b1.ability.curseTax}pt）`, `${b2.ability.curse}（+${b2.ability.curseTax}pt）`),
].join('\n');

const rndRows = [
  `| 指標 | 前（0） | 後（2） |`,
  `|---|---|---|`,
  `| 先攻勝率 | ${f1(r0.firstWinRate)}% | ${f1(r2.firstWinRate)}% |`,
  `| 平均決着ターン数 | ${f1(r0.turnsMean)} | ${f1(r2.turnsMean)} |`,
  `| 盤面の平均埋まり率 | ${f1(fill(r0))}% | ${f1(fill(r2))}% |`,
  `| 墓地からの召喚の割合 | ${f1(r0.graveSummonRate)}% | ${f1(r2.graveSummonRate)}% |`,
  `| 決着 / 未決着 | ${r0.decided} / ${r0.undecided} | ${r2.decided} / ${r2.undecided} |`,
].join('\n');

// ターン別の盤面埋まり率（打ち切ったら必ず明記する）
const MAX_TURN_ROWS = 30;
const cutoff = Math.max(3, GAMES * 0.05);
const turnKeys = [...new Set([...b0.byTurn.keys(), ...b1.byTurn.keys(), ...b2.byTurn.keys()])]
  .sort((a, b) => a - b)
  .filter((t) => Math.max(...[b0, b1, b2].map((r) => r.byTurn.get(t)?.n || 0)) >= cutoff);
const shownTurns = turnKeys.filter((t) => t <= MAX_TURN_ROWS);
const cell = (r, t) => {
  const b = r.byTurn.get(t);
  if (!b || b.n === 0) return '—';
  return `${f1(pct((b.f1 + b.f2) / (b.n * 2), r.boardSlots))}%`;
};
const turnRows = shownTurns
  .map((t) => `| ${t} | ${b0.byTurn.get(t)?.n || 0} | ${cell(b0, t)} | ${cell(b1, t)} | ${cell(b2, t)} |`)
  .join('\n');
const cutNote = turnKeys.length > shownTurns.length
  ? `\n※ ターン ${MAX_TURN_ROWS} で打ち切った。**切り捨てたのはターン ${shownTurns[shownTurns.length - 1] + 1}〜${turnKeys[turnKeys.length - 1]} の ${turnKeys.length - shownTurns.length} 行。** 長引く試合ほど盤面が厚いので、黙って切ると厚い側だけが消える。`
  : '';

const md = `# 墓地召喚のバッファ 前後比較（CG-011）

調査日: 2026-08-12

## TL;DR

\`data/cards.js\` の \`rules.graveyardSummonBuffer\` だけを 0 / 1 / 2 に差し替えて、同じシード帯・同じ AI で
${GAMES} 戦ずつ回した。デッキ・カードの数値・能力・AI の重みは一切変えていない。
**本ファイルは観測値のみを記載する。解釈と結論は書かない。**

> ★ **自動対戦の結果は人間のプレイとは別物である。**
> これは「構造的に偏るか」を見るためのものであって、面白いかどうかの判定には使わない。

---

## 測定の条件

| 項目 | 値 |
|---|---|
| 実施日時 | ${stamp} |
| HEAD | \`${head}\` |
| シード | ${BASE_SEED}〜${BASE_SEED + GAMES - 1}（1試合ごとに +1） |
| 試行回数 | ${GAMES} 戦（★ CG-011 で 1000 戦から半減） |
| AI | CPU 同士（\`js/ai.js\`・評価関数ベース）。補足でランダムAI も記載 |
| 差し替えた値 | \`rules.graveyardSummonBuffer\` のみ |
| 前（0） | 墓地に入ったカードを即座に召喚できる（現在の既定・CG-016） |
| 中（1） | 墓地に入ったその手番中は召喚できない |
| 後（2） | 墓地の持ち主が自分の手番を1回またぐまで召喚できない（CG-011〜CG-015 の既定） |

判定式は \`state.turn - enteredGraveyardTurn >= buffer\`。1ターン＝片方の手番。

---

## 1. 関心事（先攻勝率）を含む主要指標

| 指標 | 前（0） | 中（1） | 後（2） |
|---|---|---|---|
${mainRows}

---

## 2. 盤面の埋まり率の内訳

★ 埋まり率は「1ターン＝1サンプル」で採るため、ターン上限まで回る未決着の試合が
1戦で数百サンプルを出す。全体平均だけを見ると母数の偏りが見えない（CG-010 の教訓）。

| 母数 | 前（0） | 中（1） | 後（2） |
|---|---|---|---|
${fillRows}

---

## 3. その他の指標

| 指標 | 前（0） | 中（1） | 後（2） |
|---|---|---|---|
${subRows}

---

## 4. 能力の発動回数

| 指標 | 前（0） | 中（1） | 後（2） |
|---|---|---|---|
${abilityRows}

---

## 5. ドロー枚数との組み合わせ（2×2）

CG-010 で毎ターンのドローを 2 → 3 にしている。**その変更と今回のバッファは、
どちらも先攻勝率を動かす。** 交絡を分離するため、2×2 で測った。

| | バッファ 0 | バッファ 2 |
|---|---|---|
| **ドロー2**（CG-010 前） | 先攻 ${f1(grid['2-0'].firstWinRate)}% ／ 決着 ${f1(grid['2-0'].turnsMean)}T ／ 埋まり ${f1(fill(grid['2-0']))}% ／ 墓地召喚 ${f1(grid['2-0'].graveSummonRate)}% | 先攻 ${f1(grid['2-2'].firstWinRate)}% ／ 決着 ${f1(grid['2-2'].turnsMean)}T ／ 埋まり ${f1(fill(grid['2-2']))}% ／ 墓地召喚 ${f1(grid['2-2'].graveSummonRate)}% |
| **ドロー3**（現在） | 先攻 ${f1(grid['3-0'].firstWinRate)}% ／ 決着 ${f1(grid['3-0'].turnsMean)}T ／ 埋まり ${f1(fill(grid['3-0']))}% ／ 墓地召喚 ${f1(grid['3-0'].graveSummonRate)}% | 先攻 ${f1(grid['3-2'].firstWinRate)}% ／ 決着 ${f1(grid['3-2'].turnsMean)}T ／ 埋まり ${f1(fill(grid['3-2']))}% ／ 墓地召喚 ${f1(grid['3-2'].graveSummonRate)}% |

先攻勝率だけを取り出すと次のとおり。

| 設定 | 先攻勝率 | 50% との差 |
|---|---|---|
| ドロー2・バッファ0（CG-007 相当） | ${f1(grid['2-0'].firstWinRate)}% | ${f1(grid['2-0'].firstWinRate - 50)} pt |
| ドロー2・バッファ2 | ${f1(grid['2-2'].firstWinRate)}% | ${f1(grid['2-2'].firstWinRate - 50)} pt |
| ドロー3・バッファ0（CG-010 の状態） | ${f1(grid['3-0'].firstWinRate)}% | ${f1(grid['3-0'].firstWinRate - 50)} pt |
| ドロー3・バッファ2（現在の既定） | ${f1(grid['3-2'].firstWinRate)}% | ${f1(grid['3-2'].firstWinRate - 50)} pt |

---

## 6. ランダムAI（補足）

${rndRows}

---

## 7. ターン別の盤面埋まり率

到達数がどの列でも試行の5%（${Math.round(cutoff)} 戦）を下回るターンは省略。

| ターン | 到達試合数（前） | 前（0） | 中（1） | 後（2） |
|---|---|---|---|---|
${turnRows}
${cutNote}

---

## 再現手順

\`\`\`
SIM_GAMES=${GAMES} SIM_SEED=${BASE_SEED} node tools/compare_buffer.js "$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')" "$(git rev-parse --short HEAD)"
\`\`\`
`;

const out = path.join(here, '..', 'docs', 'research', outName);
writeFileSync(out, md, 'utf8');
console.log(`書き出し: ${out}`);
console.log(`先攻勝率  0: ${f1(b0.firstWinRate)}%  1: ${f1(b1.firstWinRate)}%  2: ${f1(b2.firstWinRate)}%`);
console.log(`決着ターン 0: ${f1(b0.turnsMean)}  1: ${f1(b1.turnsMean)}  2: ${f1(b2.turnsMean)}`);
console.log(`埋まり率   0: ${f1(fill(b0))}%  1: ${f1(fill(b1))}%  2: ${f1(fill(b2))}%`);
console.log(`墓地召喚率 0: ${f1(b0.graveSummonRate)}%  1: ${f1(b1.graveSummonRate)}%  2: ${f1(b2.graveSummonRate)}%`);
console.log(`未決着     0: ${b0.undecided}  1: ${b1.undecided}  2: ${b2.undecided}`);
