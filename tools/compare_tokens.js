/**
 * tools/compare_tokens.js — トークンの消滅（CG-007）の前後比較
 *
 * 使い方:
 *   SIM_GAMES=1000 SIM_SEED=1000 node tools/compare_tokens.js "2026-08-11 23:00 JST" <HEAD短縮ハッシュ>
 *
 *   SIM_GAMES  試行回数（既定 500・CG-011 で 1000 から半減）
 *   SIM_SEED   開始シード（既定 1000）
 *   SIM_OUT    出力ファイル名（docs/research/ 配下）
 *
 * 同じシード帯・同じ AI で、`data/cards.js` の tokens 側 `onDeath` だけを差し替えて並べる。
 *   前     … onDeath: 'toGraveyard'（CG-006 までの挙動。当時の数値がそのまま再現する）
 *   前・自粛 … 同上のルールで、CPU にトークンの 0pt 再召喚を自粛させた補足測定の再現
 *   後     … onDeath: 'vanish'（CG-007 の裁定A。data/cards.js の現在値）
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
const outName = process.env.SIM_OUT || 'トークン消滅_前後比較_20260811_CG007.md';

/** tokens 側の onDeath だけを差し替えた cardData を作る（rules は触らない） */
function withTokenOnDeath(data, mode) {
  return {
    ...data,
    tokens: {
      ...data.tokens,
      list: data.tokens.list.map((t) => ({ ...t, onDeath: mode })),
    },
  };
}

const dataBefore = withTokenOnDeath(cardData, 'toGraveyard');
const dataAfter = withTokenOnDeath(cardData, 'vanish');
const noTokenRevive = { ...aiData, search: { ...aiData.search, reviveTokens: false } };

const onDeathNow = cardData.tokens.list[0].onDeath || 'toGraveyard';
if (onDeathNow !== 'vanish') {
  console.log(`★ 注意: data/cards.js の onDeath は '${onDeathNow}'。「後」列は 'vanish' を明示指定して測る`);
}

console.log('前（トークンは相手の墓地へ）を実行中...');
const before = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'cpu', cardData: dataBefore, aiData });
console.log('前・自粛（同ルール／CPU がトークン再召喚を自粛）を実行中...');
const beforeNT = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'cpu', cardData: dataBefore, aiData: noTokenRevive });
console.log('後（トークンは消滅）を実行中...');
const after = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'cpu', cardData: dataAfter, aiData });
console.log('ランダムAI（前 / 後）を実行中...');
const rndBefore = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'random', cardData: dataBefore, aiData });
const rndAfter = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'random', cardData: dataAfter, aiData });

// ---------------------------------------------------------------------------

const pct = (n, d) => (d ? (n / d) * 100 : 0);
const f1 = (x) => x.toFixed(1);
const f2 = (x) => x.toFixed(2);
const fill = (r) => (r.fillMean / r.boardSlots) * 100;

/** 4列（指標・前・前/自粛・後）の行 */
const row = (label, a, b, c) => `| ${label} | ${a} | ${b} | ${c} |`;

const mainRows = [
  row(
    '盤面の平均埋まり率',
    `${f1(fill(before))}%（${f2(before.fillMean)} / 6枠）`,
    `${f1(fill(beforeNT))}%（${f2(beforeNT.fillMean)} / 6枠）`,
    `${f1(fill(after))}%（${f2(after.fillMean)} / 6枠）`
  ),
  row('未決着数', String(before.undecided), String(beforeNT.undecided), String(after.undecided)),
  row('奪取（回/試合）', f2(before.stealsMean), f2(beforeNT.stealsMean), f2(after.stealsMean)),
  row('平均決着ターン数', f1(before.turnsMean), f1(beforeNT.turnsMean), f1(after.turnsMean)),
  row('先攻勝率', `${f1(before.firstWinRate)}%`, `${f1(beforeNT.firstWinRate)}%`, `${f1(after.firstWinRate)}%`),
].join('\n');

const subRows = [
  row('決着 / 未決着', `${before.decided} / ${before.undecided}`, `${beforeNT.decided} / ${beforeNT.undecided}`, `${after.decided} / ${after.undecided}`),
  row('決着ターン 中央値', String(before.turnsMedian), String(beforeNT.turnsMedian), String(after.turnsMedian)),
  row('決着ターン 範囲', `${before.turnsMin}〜${before.turnsMax}`, `${beforeNT.turnsMin}〜${beforeNT.turnsMax}`, `${after.turnsMin}〜${after.turnsMax}`),
  row('奪取 中央値 / 最大', `${before.stealsMedian} / ${before.stealsMax}`, `${beforeNT.stealsMedian} / ${beforeNT.stealsMax}`, `${after.stealsMedian} / ${after.stealsMax}`),
  row('召喚回数（合計）', String(before.totalSummons), String(beforeNT.totalSummons), String(after.totalSummons)),
  row('召喚元 墓地の割合', `${f1(before.graveSummonRate)}%`, `${f1(beforeNT.graveSummonRate)}%`, `${f1(after.graveSummonRate)}%`),
  row('総手数（action 数）', String(before.steps), String(beforeNT.steps), String(after.steps)),
].join('\n');

const tokenRows = [
  row('トークンの召喚回数', String(before.tokenSummons), String(beforeNT.tokenSummons), String(after.tokenSummons)),
  row('うち墓地から出し直した回数', String(before.tokenRevives), String(beforeNT.tokenRevives), String(after.tokenRevives)),
  row(
    '全召喚に占める割合',
    `${f1(pct(before.tokenRevives, before.totalSummons))}%`,
    `${f1(pct(beforeNT.tokenRevives, beforeNT.totalSummons))}%`,
    `${f1(pct(after.tokenRevives, after.totalSummons))}%`
  ),
  row('ピッチ0枚で成立した召喚', String(before.freeSummons), String(beforeNT.freeSummons), String(after.freeSummons)),
  row('倒れて消滅した回数', String(before.vanished), String(beforeNT.vanished), String(after.vanished)),
  row('里帰り（自分の持ち札が自分の墓地へ）', String(before.homecoming), String(beforeNT.homecoming), String(after.homecoming)),
  row('　うちトークン', String(before.homecomingToken), String(beforeNT.homecomingToken), String(after.homecomingToken)),
].join('\n');

const abilityRows = [
  row('c05 後列へ退いた / 不発', `${before.ability.retreat} / ${before.ability.retreatFailed}`, `${beforeNT.ability.retreat} / ${beforeNT.ability.retreatFailed}`, `${after.ability.retreat} / ${after.ability.retreatFailed}`),
  row('c06 トークン生成 / 不発', `${before.ability.token} / ${before.ability.tokenBlocked}`, `${beforeNT.ability.token} / ${beforeNT.ability.tokenBlocked}`, `${after.ability.token} / ${after.ability.tokenBlocked}`),
  row('c07 デッキ送り', String(before.ability.mill), String(beforeNT.ability.mill), String(after.ability.mill)),
  row('c08 呪い発動（合計pt）', `${before.ability.curse}（+${before.ability.curseTax}pt）`, `${beforeNT.ability.curse}（+${beforeNT.ability.curseTax}pt）`, `${after.ability.curse}（+${after.ability.curseTax}pt）`),
].join('\n');

// ターン別の盤面埋まり率
//   - 到達数がどの列でも試行の5%を下回るターンは省略
//   - MAX_TURN_ROWS で打ち切り、切った分は表の下に必ず明記する
//     （長引く試合ほど盤面が厚いので、黙って切ると「厚い側」だけが消える）
const MAX_TURN_ROWS = 40;
const cutoff = Math.max(3, GAMES * 0.05);
const turnKeys = [...new Set([...before.byTurn.keys(), ...beforeNT.byTurn.keys(), ...after.byTurn.keys()])]
  .sort((a, b) => a - b)
  .filter((t) => Math.max(...[before, beforeNT, after].map((r) => r.byTurn.get(t)?.n || 0)) >= cutoff);
const shownTurns = turnKeys.filter((t) => t <= MAX_TURN_ROWS);
const cell = (r, t) => {
  const b = r.byTurn.get(t);
  if (!b) return '—';
  return `${f2((b.f1 + b.f2) / (2 * b.n))}（${b.n}）`;
};
const turnRows = shownTurns
  .map((t) => `| ${t} | ${cell(before, t)} | ${cell(beforeNT, t)} | ${cell(after, t)} |`)
  .join('\n');

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
  `| 前（墓地へ） | ${tailSummary(before)} |`,
  `| 前・自粛 | ${tailSummary(beforeNT)} |`,
  `| 後（消滅） | ${tailSummary(after)} |`,
].join('\n');

const costKeys = [...new Set([
  ...Object.keys(before.costCounts),
  ...Object.keys(beforeNT.costCounts),
  ...Object.keys(after.costCounts),
])]
  .map(Number)
  .sort((a, b) => a - b);
const costRows = costKeys
  .map((c) =>
    `| ${c} | ${f1(pct(before.costCounts[c] || 0, before.totalSummons))}% | ${f1(
      pct(beforeNT.costCounts[c] || 0, beforeNT.totalSummons)
    )}% | ${f1(pct(after.costCounts[c] || 0, after.totalSummons))}% | ${f1(
      pct(before.deckCostCounts[c] || 0, before.deckTotal)
    )}% |`
  )
  .join('\n');

const rndRows = [
  `| 盤面の平均埋まり率 | ${f1(fill(rndBefore))}%（${f2(rndBefore.fillMean)} / 6枠） | ${f1(fill(rndAfter))}%（${f2(rndAfter.fillMean)} / 6枠） |`,
  `| 未決着数 | ${rndBefore.undecided} | ${rndAfter.undecided} |`,
  `| 奪取（回/試合） | ${f2(rndBefore.stealsMean)} | ${f2(rndAfter.stealsMean)} |`,
  `| 平均決着ターン数 | ${f1(rndBefore.turnsMean)} | ${f1(rndAfter.turnsMean)} |`,
  `| 先攻勝率 | ${f1(rndBefore.firstWinRate)}% | ${f1(rndAfter.firstWinRate)}% |`,
  `| トークンの墓地からの再召喚 | ${rndBefore.tokenRevives} | ${rndAfter.tokenRevives} |`,
].join('\n');

const md = `# トークンの消滅：前後比較（CG-007）

調査日: 2026-08-11

## TL;DR

\`data/cards.js\` の \`tokens\` 側 \`onDeath\` だけを差し替えて、同じシード帯・同じ AI で
${GAMES} 戦ずつ回した。engine のルール（\`rules\`）・デッキ・AI の重みは一切変えていない。
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
| 前 | \`tokens.list[].onDeath = 'toGraveyard'\`（CG-006 までの挙動） |
| 前・自粛 | 同上のルール ＋ \`data/ai.js\` の \`search.reviveTokens = false\`（AI 側の自粛。ルールは変えていない） |
| 後 | \`tokens.list[].onDeath = 'vanish'\`（CG-007 の裁定A。現在の \`data/cards.js\`） |
| AI | ${before.aiLabel}（${before.aiNote}）。重みは \`data/ai.js\` |
| デッキ | \`deck.lists.default\` 30枚・両者同一 |
| 乱数 | engine の seeded RNG のみ。CPU は乱数を使わない（同一 state → 同一手） |

★ 「前」「前・自粛」の2列は CG-006（HEAD \`446d259\`）と同一シード帯・同一 AI であり、
当時の観測値が再現する（＝フラグを戻せば以前の挙動に戻ることの確認を兼ねる）。

---

## 1. 指示された5項目

| 指標 | 前（墓地へ） | 前・自粛 | 後（消滅） |
|---|---|---|---|
${mainRows}

---

## 2. その他の指標

| 指標 | 前（墓地へ） | 前・自粛 | 後（消滅） |
|---|---|---|---|
${subRows}

---

## 3. トークンまわりの観測

| 指標 | 前（墓地へ） | 前・自粛 | 後（消滅） |
|---|---|---|---|
${tokenRows}

「里帰り」＝ 自分の持ち札が自分の墓地に入った回数。相手に渡ったカードが相手の場で
倒されると、倒した側＝元の持ち主の墓地へ戻るため発生する。

---

## 4. ターン別の盤面埋まり率

各ターン開始時点で両プレイヤー分をサンプリングした平均（6枠中）。括弧内は到達試合数。
到達数がどの列でも試行の5%を下回るターンは省略。

| ターン | 前（墓地へ） | 前・自粛 | 後（消滅） |
|---|---|---|---|
${turnRows}

★ **表はターン ${MAX_TURN_ROWS} で打ち切っている。切り捨てた先は以下のとおり。**
長引く試合ほど盤面が厚いので、黙って切ると厚い側だけが表から消える。

| 列 | ターン ${MAX_TURN_ROWS} より先 |
|---|---|
${tailRows}

---

## 5. 能力の発動回数

${GAMES} 戦の合計。engine にカウンタは持たせず、\`tools/harness.js\` が state の差分から数えている。

| 能力 | 前（墓地へ） | 前・自粛 | 後（消滅） |
|---|---|---|---|
${abilityRows}

---

## 6. 召喚されたカードのコスト分布

召喚に占める割合。コスト0はデッキに存在しない（c06 が生成するトークン）。

| コスト | 前（墓地へ） | 前・自粛 | 後（消滅） | デッキ構成比 |
|---|---|---|---|---|
${costRows}

---

## 7. 参考：ランダムAI の前後

CG-001 から実装を変えていないランダムAI で同じ差し替えを行った場合。

| 指標 | 前（墓地へ） | 後（消滅） |
|---|---|---|
${rndRows}

---

## 再現手順

\`\`\`
node tools/simulate.js ${GAMES} ${BASE_SEED} cpu

SIM_GAMES=${GAMES} SIM_SEED=${BASE_SEED} SIM_OUT="${outName}" \\
  node tools/compare_tokens.js "$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')" "$(git rev-parse --short HEAD)"
\`\`\`

「前」列を単体で回すときは \`data/cards.js\` の \`tokens.list[].onDeath\` を
\`'toGraveyard'\` に戻す（本スクリプトは JSON を書き換えず、読み込んだ値を差し替えて測っている）。
`;

const out = path.join(here, '..', 'docs', 'research', outName);
writeFileSync(out, md, 'utf8');
console.log(`書き出し: ${out}`);
