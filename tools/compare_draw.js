/**
 * tools/compare_draw.js — 毎ターンのドロー枚数（CG-010）の前後比較
 *
 * 使い方:
 *   SIM_GAMES=1000 SIM_SEED=1000 node tools/compare_draw.js "2026-08-12 00:30 JST" <HEAD短縮ハッシュ>
 *
 *   SIM_GAMES  試行回数（既定 1000）
 *   SIM_SEED   開始シード（既定 1000）
 *   SIM_OUT    出力ファイル名（docs/research/ 配下）
 *
 * 同じシード帯・同じ AI で、`data/cards.js` の `rules.drawPerTurn` だけを差し替えて並べる。
 *   前 … drawPerTurn: 2（CG-009 までの挙動。CG-007 の観測値がそのまま再現する）
 *   後 … drawPerTurn: 3（CG-010。data/cards.js の現在値）
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
const GAMES = Number.parseInt(process.env.SIM_GAMES || '1000', 10);
const BASE_SEED = Number.parseInt(process.env.SIM_SEED || '1000', 10);
const outName = process.env.SIM_OUT || 'ドロー3枚_前後比較_20260812_CG010.md';

/** rules.drawPerTurn だけを差し替えた cardData を作る（他のルール・データは触らない） */
function withDraw(data, n) {
  return { ...data, rules: { ...data.rules, drawPerTurn: n } };
}

const BEFORE_DRAW = 2;
const AFTER_DRAW = 3;

const drawNow = cardData.rules.drawPerTurn;
if (drawNow !== AFTER_DRAW) {
  console.log(`★ 注意: data/cards.js の drawPerTurn は ${drawNow}。「後」列は ${AFTER_DRAW} を明示指定して測る`);
}

const dataBefore = withDraw(cardData, BEFORE_DRAW);
const dataAfter = withDraw(cardData, AFTER_DRAW);

console.log(`前（ドロー ${BEFORE_DRAW}枚 / CPU）を実行中...`);
const before = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'cpu', cardData: dataBefore, aiData });
console.log(`後（ドロー ${AFTER_DRAW}枚 / CPU）を実行中...`);
const after = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'cpu', cardData: dataAfter, aiData });
console.log('ランダムAI（前 / 後）を実行中...');
const rndBefore = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'random', cardData: dataBefore, aiData });
const rndAfter = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'random', cardData: dataAfter, aiData });

// ---------------------------------------------------------------------------

const pct = (n, d) => (d ? (n / d) * 100 : 0);
const f1 = (x) => x.toFixed(1);
const f2 = (x) => x.toFixed(2);
const fill = (r) => (r.fillMean / r.boardSlots) * 100;

/** 前→後の差分を符号つきで（見落とし防止のため必ず併記する） */
const diff = (a, b, fmt = f1, unit = '') => {
  const d = b - a;
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  return `${sign}${fmt(Math.abs(d))}${unit}`;
};

/** 4列（指標・前・後・差）の行 */
const row = (label, a, b, d) => `| ${label} | ${a} | ${b} | ${d} |`;

const mainRows = [
  row(
    '★ 盤面の平均埋まり率',
    `${f1(fill(before))}%（${f2(before.fillMean)} / 6枠）`,
    `${f1(fill(after))}%（${f2(after.fillMean)} / 6枠）`,
    `${diff(fill(before), fill(after), f1, 'pt')}`
  ),
  row('★ 平均決着ターン数', f1(before.turnsMean), f1(after.turnsMean), diff(before.turnsMean, after.turnsMean)),
  row('未決着数', String(before.undecided), String(after.undecided), diff(before.undecided, after.undecided, (x) => String(x))),
  row('奪取（回/試合）', f2(before.stealsMean), f2(after.stealsMean), diff(before.stealsMean, after.stealsMean, f2)),
  row('先攻勝率', `${f1(before.firstWinRate)}%`, `${f1(after.firstWinRate)}%`, diff(before.firstWinRate, after.firstWinRate, f1, 'pt')),
].join('\n');

/**
 * 埋まり率の平均を、母数を絞って測り直す。
 *
 * ★ 全体平均は「1ターン＝1サンプル」なので、長引いた試合ほど重く効く。
 *   未決着の試合はターン上限まで回るため、1戦で決着した試合の数十倍のサンプルを出す。
 *   全体平均だけを見ると、その偏りが見えないまま結論を出すことになるので内訳も出す。
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

/** 未決着の試合がサンプル全体に占める割合 */
function undecidedShare(r) {
  const all = fillBreakdown(r, {});
  const dec = fillBreakdown(r, { decidedOnly: true });
  return pct(all.samples - dec.samples, all.samples);
}

const fillCell = (r, opt) => {
  const b = fillBreakdown(r, opt);
  return `${f1(pct(b.mean, r.boardSlots))}%（${f2(b.mean)} / 6枠）`;
};
const fillDiff = (opt) =>
  diff(
    pct(fillBreakdown(before, opt).mean, before.boardSlots),
    pct(fillBreakdown(after, opt).mean, after.boardSlots),
    f1,
    'pt'
  );
const fillRow = (label, opt) => row(label, fillCell(before, opt), fillCell(after, opt), fillDiff(opt));

const fillRows = [
  fillRow('全体（指示された定義。上の表と同じ値）', {}),
  fillRow('決着した試合のみ', { decidedOnly: true }),
  fillRow('ターン2〜10のみ（全試合）', { minTurn: 2, maxTurn: 10 }),
  fillRow('ターン2〜16のみ（全試合）', { minTurn: 2, maxTurn: 16 }),
  row(
    '未決着の試合がサンプルに占める割合',
    `${f1(undecidedShare(before))}%`,
    `${f1(undecidedShare(after))}%`,
    diff(undecidedShare(before), undecidedShare(after), f1, 'pt')
  ),
].join('\n');

const subRows = [
  row('決着 / 未決着', `${before.decided} / ${before.undecided}`, `${after.decided} / ${after.undecided}`, '—'),
  row('決着ターン 中央値', String(before.turnsMedian), String(after.turnsMedian), diff(before.turnsMedian, after.turnsMedian, f1)),
  row('決着ターン 範囲', `${before.turnsMin}〜${before.turnsMax}`, `${after.turnsMin}〜${after.turnsMax}`, '—'),
  row('最短 / 最長のシード', `${before.turnsMinSeed} / ${before.turnsMaxSeed}`, `${after.turnsMinSeed} / ${after.turnsMaxSeed}`, '—'),
  row('奪取 中央値 / 最大', `${before.stealsMedian} / ${before.stealsMax}`, `${after.stealsMedian} / ${after.stealsMax}`, '—'),
  row('召喚回数（合計）', String(before.totalSummons), String(after.totalSummons), diff(before.totalSummons, after.totalSummons, (x) => String(x))),
  row('召喚回数（回/試合）', f2(before.totalSummons / GAMES), f2(after.totalSummons / GAMES), diff(before.totalSummons / GAMES, after.totalSummons / GAMES, f2)),
  row('召喚元 墓地の割合', `${f1(before.graveSummonRate)}%`, `${f1(after.graveSummonRate)}%`, diff(before.graveSummonRate, after.graveSummonRate, f1, 'pt')),
  row('ピッチ0枚で成立した召喚', String(before.freeSummons), String(after.freeSummons), diff(before.freeSummons, after.freeSummons, (x) => String(x))),
  row('倒れて消滅した回数', String(before.vanished), String(after.vanished), diff(before.vanished, after.vanished, (x) => String(x))),
  row('里帰り（自分の持ち札が自分の墓地へ）', String(before.homecoming), String(after.homecoming), diff(before.homecoming, after.homecoming, (x) => String(x))),
  row('総手数（action 数）', String(before.steps), String(after.steps), diff(before.steps, after.steps, (x) => String(x))),
].join('\n');

const abilityRows = [
  row('c05 後列へ退いた / 不発', `${before.ability.retreat} / ${before.ability.retreatFailed}`, `${after.ability.retreat} / ${after.ability.retreatFailed}`, '—'),
  row('c06 トークン生成 / 不発', `${before.ability.token} / ${before.ability.tokenBlocked}`, `${after.ability.token} / ${after.ability.tokenBlocked}`, '—'),
  row('c07 デッキ送り', String(before.ability.mill), String(after.ability.mill), diff(before.ability.mill, after.ability.mill, (x) => String(x))),
  row('c08 呪い発動（合計pt）', `${before.ability.curse}（+${before.ability.curseTax}pt）`, `${after.ability.curse}（+${after.ability.curseTax}pt）`, '—'),
].join('\n');

// ターン別の盤面埋まり率
//   - 到達数がどちらの列でも試行の5%を下回るターンは省略
//   - MAX_TURN_ROWS で打ち切り、切った分は表の下に必ず明記する
//     （長引く試合ほど盤面が厚いので、黙って切ると「厚い側」だけが消える）
const MAX_TURN_ROWS = 40;
const cutoff = Math.max(3, GAMES * 0.05);
const turnKeys = [...new Set([...before.byTurn.keys(), ...after.byTurn.keys()])]
  .sort((a, b) => a - b)
  .filter((t) => Math.max(...[before, after].map((r) => r.byTurn.get(t)?.n || 0)) >= cutoff);
const shownTurns = turnKeys.filter((t) => t <= MAX_TURN_ROWS);
const cell = (r, t) => {
  const b = r.byTurn.get(t);
  if (!b) return '—';
  return `${f2((b.f1 + b.f2) / (2 * b.n))}（${b.n}）`;
};
const turnRows = shownTurns.map((t) => `| ${t} | ${cell(before, t)} | ${cell(after, t)} |`).join('\n');

/** 打ち切った先（ターン MAX_TURN_ROWS 超）の要約 */
function tailSummary(r) {
  let n = 0, sum = 0, samples = 0, last = 0;
  for (const [t, b] of r.byTurn) {
    if (t <= MAX_TURN_ROWS) continue;
    if (t === MAX_TURN_ROWS + 1) n = b.n;
    sum += b.f1 + b.f2;
    samples += 2 * b.n;
    last = Math.max(last, t);
  }
  if (!samples) return `ターン ${MAX_TURN_ROWS} より先へ進んだ試合なし`;
  return `ターン ${MAX_TURN_ROWS + 1} に到達 ${n} 試合 ／ 最終ターン ${last} ／ ターン ${MAX_TURN_ROWS + 1} 以降の平均 ${f2(sum / samples)} / 6枠`;
}
const tailRows = [
  `| 前（2枚） | ${tailSummary(before)} |`,
  `| 後（3枚） | ${tailSummary(after)} |`,
].join('\n');

const costKeys = [...new Set([...Object.keys(before.costCounts), ...Object.keys(after.costCounts)])]
  .map(Number)
  .sort((a, b) => a - b);
const costRows = costKeys
  .map(
    (c) =>
      `| ${c} | ${f1(pct(before.costCounts[c] || 0, before.totalSummons))}% | ${f1(
        pct(after.costCounts[c] || 0, after.totalSummons)
      )}% | ${f1(pct(before.deckCostCounts[c] || 0, before.deckTotal))}% |`
  )
  .join('\n');

/** 未決着になったシードの一覧（多いときは先頭だけ出して残数を明記する） */
function undecidedSeeds(r) {
  const seeds = r.perGame.filter((g) => !g.decided).map((g) => g.seed);
  if (seeds.length === 0) return 'なし';
  const head10 = seeds.slice(0, 10).join(' / ');
  return seeds.length > 10 ? `${head10} … ほか ${seeds.length - 10} 件` : head10;
}

const rndRows = [
  `| 盤面の平均埋まり率 | ${f1(fill(rndBefore))}%（${f2(rndBefore.fillMean)} / 6枠） | ${f1(fill(rndAfter))}%（${f2(rndAfter.fillMean)} / 6枠） | ${diff(fill(rndBefore), fill(rndAfter), f1, 'pt')} |`,
  `| 平均決着ターン数 | ${f1(rndBefore.turnsMean)} | ${f1(rndAfter.turnsMean)} | ${diff(rndBefore.turnsMean, rndAfter.turnsMean)} |`,
  `| 未決着数 | ${rndBefore.undecided} | ${rndAfter.undecided} | ${diff(rndBefore.undecided, rndAfter.undecided, (x) => String(x))} |`,
  `| 奪取（回/試合） | ${f2(rndBefore.stealsMean)} | ${f2(rndAfter.stealsMean)} | ${diff(rndBefore.stealsMean, rndAfter.stealsMean, f2)} |`,
  `| 先攻勝率 | ${f1(rndBefore.firstWinRate)}% | ${f1(rndAfter.firstWinRate)}% | ${diff(rndBefore.firstWinRate, rndAfter.firstWinRate, f1, 'pt')} |`,
].join('\n');

const md = `# ドローを3枚にした前後比較（CG-010）

調査日: ${stamp.slice(0, 10)}

## TL;DR

\`data/cards.js\` の \`rules.drawPerTurn\` だけを 2 → 3 に差し替えて、同じシード帯・同じ AI で
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
| シード | ${before.seedRange}（1試合ごとに +1） |
| 試行回数 | ${GAMES} 戦（列ごとに同じシード帯） |
| ターン上限 | ${before.turnCap}（打ち切り時は未決着として計上） |
| 前 | \`rules.drawPerTurn = ${BEFORE_DRAW}\`（CG-009 までの挙動） |
| 後 | \`rules.drawPerTurn = ${AFTER_DRAW}\`（CG-010。現在の \`data/cards.js\`） |
| AI | ${before.aiLabel}（${before.aiNote}）。重みは \`data/ai.js\` |
| デッキ | \`deck.lists.default\` 30枚・両者同一 |
| 初手 | 先攻 ${cardData.rules.openingHand.first} / 後攻 ${cardData.rules.openingHand.second}（変更なし） |
| 乱数 | engine の seeded RNG のみ。CPU は乱数を使わない（同一 state → 同一手） |

★ 「前」列は CG-007（HEAD \`a33888b\`）と同一シード帯・同一 AI・同一ルールであり、
当時の観測値が再現する（＝\`drawPerTurn\` を 2 に戻せば以前の挙動に戻ることの確認を兼ねる）。

---

## 1. 指示された項目（★ が指示で名指しされたもの）

| 指標 | 前（2枚） | 後（3枚） | 差 |
|---|---|---|---|
${mainRows}

---

## 1b. 平均埋まり率の内訳

★ **全体平均は母数の偏りをそのまま含んでいる。** 埋まり率は「1ターン＝1サンプル」で
採っているので、長引いた試合ほど重く効く。未決着の試合はターン上限 ${before.turnCap} まで
回るため、1戦で数百サンプルを出す。母数を変えて測り直したものを並べる。

| 母数 | 前（2枚） | 後（3枚） | 差 |
|---|---|---|---|
${fillRows}

---

## 2. その他の指標

| 指標 | 前（2枚） | 後（3枚） | 差 |
|---|---|---|---|
${subRows}

「里帰り」＝ 自分の持ち札が自分の墓地に入った回数。相手に渡ったカードが相手の場で
倒されると、倒した側＝元の持ち主の墓地へ戻るため発生する。

---

## 3. 未決着になったシード

ターン上限 ${before.turnCap} で打ち切ったもの。

| 列 | 件数 | シード |
|---|---|---|
| 前（2枚） | ${before.undecided} | ${undecidedSeeds(before)} |
| 後（3枚） | ${after.undecided} | ${undecidedSeeds(after)} |

---

## 4. ターン別の盤面埋まり率

各ターン開始時点で両プレイヤー分をサンプリングした平均（6枠中）。括弧内は到達試合数。
到達数がどちらの列でも試行の5%を下回るターンは省略。

| ターン | 前（2枚） | 後（3枚） |
|---|---|---|
${turnRows}

★ **表はターン ${MAX_TURN_ROWS} で打ち切っている。切り捨てた先は以下のとおり。**
長引く試合ほど盤面が厚いので、黙って切ると厚い側だけが表から消える。

| 列 | ターン ${MAX_TURN_ROWS} より先 |
|---|---|
${tailRows}

---

## 5. 能力の発動回数

${GAMES} 戦の合計。engine にカウンタは持たせず、\`tools/harness.js\` が state の差分から数えている。

| 能力 | 前（2枚） | 後（3枚） | 差 |
|---|---|---|---|
${abilityRows}

---

## 6. 召喚されたカードのコスト分布

召喚に占める割合。コスト0はデッキに存在しない（c06 が生成するトークン）。

| コスト | 前（2枚） | 後（3枚） | デッキ構成比 |
|---|---|---|---|
${costRows}

---

## 7. 参考：ランダムAI の前後

CG-001 から実装を変えていないランダムAI で同じ差し替えを行った場合。

| 指標 | 前（2枚） | 後（3枚） | 差 |
|---|---|---|---|
${rndRows}

---

## 再現手順

\`\`\`
node tools/simulate.js ${GAMES} ${BASE_SEED} cpu

SIM_GAMES=${GAMES} SIM_SEED=${BASE_SEED} SIM_OUT="${outName}" \\
  node tools/compare_draw.js "$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')" "$(git rev-parse --short HEAD)"
\`\`\`

「前」列を単体で回すときは \`data/cards.js\` の \`rules.drawPerTurn\` を \`2\` に戻す
（本スクリプトは JSON を書き換えず、読み込んだ値を差し替えて測っている）。
`;

const out = path.join(here, '..', 'docs', 'research', outName);
writeFileSync(out, md, 'utf8');
console.log(`書き出し: ${out}`);
