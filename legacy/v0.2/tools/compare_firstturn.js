/**
 * tools/compare_firstturn.js — 先攻1ターン目の攻撃制限（CG-017）の前後比較
 *
 * 使い方:
 *   SIM_GAMES=500 SIM_SEED=1000 node tools/compare_firstturn.js "2026-08-14 12:00 JST" <HEAD短縮ハッシュ>
 *
 *   SIM_GAMES  試行回数（既定 500・CG-011 の既定）
 *   SIM_SEED   開始シード（既定 1000）
 *   SIM_OUT    出力ファイル名（docs/research/ 配下）
 *
 * 同じシード帯・同じ AI（評価関数CPU）で、`rules.firstPlayerAttacksOnTurn1` だけを差し替えて並べる。
 *   制限なし … firstPlayerAttacksOnTurn1: true（従来の挙動。data/cards.js の既定）
 *   制限あり … firstPlayerAttacksOnTurn1: false（先攻の最初の手番は攻撃不可）
 *
 * ★ 観測値だけを書く。解釈・結論は書かない。
 *
 * 【操作的定義】出力の「定義」節にも同じ内容を書く。
 *   - 1ターン目: 先攻プレイヤーの最初の手番（state.turn === 1）
 *   - 1ターン目終了時点の後攻ネクロマンサーの残り体力:
 *     turn が 1 → 2 に変わった瞬間（＝先攻の最初の手番の endTurn 直後）の
 *     後攻ネクロマンサーの（体力 − 受けたダメージ）。
 *     1ターン目中に決着した試合はその時点の値（下限0）で数える。全試合が母数
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
const outName = process.env.SIM_OUT || '先攻1ターン目攻撃制限_前後比較_20260814_CG017.md';

/** rules.firstPlayerAttacksOnTurn1 だけを差し替えた cardData を作る（他は触らない） */
function withFirstTurnAttack(data, on) {
  return { ...data, rules: { ...data.rules, firstPlayerAttacksOnTurn1: on } };
}

if (cardData.rules.firstPlayerAttacksOnTurn1 !== true) {
  console.log(`★ 注意: data/cards.js の firstPlayerAttacksOnTurn1 は '${cardData.rules.firstPlayerAttacksOnTurn1}'。両列とも明示指定で測る`);
}

console.log('制限なし（先攻1ターン目も攻撃できる・従来）を実行中...');
const off = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'cpu', cardData: withFirstTurnAttack(cardData, true), aiData });
console.log('制限あり（先攻1ターン目は攻撃できない）を実行中...');
const on = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'cpu', cardData: withFirstTurnAttack(cardData, false), aiData });

// ---------------------------------------------------------------------------

const pct = (n, d) => (d ? (n / d) * 100 : 0);
const f1 = (x) => x.toFixed(1);
const f2 = (x) => x.toFixed(2);
const fill = (r) => (r.fillMean / r.boardSlots) * 100;

const row = (label, a, b) => `| ${label} | ${a} | ${b} |`;

const mainRows = [
  row('先攻勝率', `${f1(off.firstWinRate)}%`, `${f1(on.firstWinRate)}%`),
  row('平均決着ターン数', f1(off.turnsMean), f1(on.turnsMean)),
  row(
    '★ 1ターン目終了時点の後攻ネクロマンサーの残り体力（平均）',
    `${f2(off.necroHpSecondEndT1Mean)}（最小 ${off.necroHpSecondEndT1Min}・母数 ${off.necroHpSecondEndT1Count} 戦）`,
    `${f2(on.necroHpSecondEndT1Mean)}（最小 ${on.necroHpSecondEndT1Min}・母数 ${on.necroHpSecondEndT1Count} 戦）`
  ),
].join('\n');

const subRows = [
  row('決着 / 未決着', `${off.decided} / ${off.undecided}`, `${on.decided} / ${on.undecided}`),
  row('決着ターン 中央値', String(off.turnsMedian), String(on.turnsMedian)),
  row('決着ターン 範囲', `${off.turnsMin}〜${off.turnsMax}`, `${on.turnsMin}〜${on.turnsMax}`),
  row('最短試合のシード', String(off.turnsMinSeed), String(on.turnsMinSeed)),
  row(
    '盤面の平均埋まり率',
    `${f1(fill(off))}%（${f2(off.fillMean)} / 6枠）`,
    `${f1(fill(on))}%（${f2(on.fillMean)} / 6枠）`
  ),
  row('召喚元 墓地の割合', `${f1(off.graveSummonRate)}%`, `${f1(on.graveSummonRate)}%`),
  row('奪取（回/試合）', f2(off.stealsMean), f2(on.stealsMean)),
  row('総手数（action 数）', String(off.steps), String(on.steps)),
].join('\n');

const abilityRows = [
  row('c05 後列へ退いた / 不発', `${off.ability.retreat} / ${off.ability.retreatFailed}`, `${on.ability.retreat} / ${on.ability.retreatFailed}`),
  row('c06 トークン生成 / 不発', `${off.ability.token} / ${off.ability.tokenBlocked}`, `${on.ability.token} / ${on.ability.tokenBlocked}`),
  row('c07 デッキ送り', String(off.ability.mill), String(on.ability.mill)),
  row('c08 呪い発動（合計pt）', `${off.ability.curse}（+${off.ability.curseTax}pt）`, `${on.ability.curse}（+${on.ability.curseTax}pt）`),
].join('\n');

// 決着ターンのヒストグラム（5ターン刻み）
const histKeys = [...new Set([...Object.keys(off.hist), ...Object.keys(on.hist)])]
  .map(Number)
  .sort((a, b) => a - b);
const histRows = histKeys
  .map((k) => `| ${k}〜${k + 4} | ${off.hist[k] || 0} | ${on.hist[k] || 0} |`)
  .join('\n');

const costKeys = [...new Set([...Object.keys(off.costCounts), ...Object.keys(on.costCounts)])]
  .map(Number)
  .sort((a, b) => a - b);
const costRows = costKeys
  .map((c) =>
    `| ${c} | ${f1(pct(off.costCounts[c] || 0, off.totalSummons))}% | ${f1(
      pct(on.costCounts[c] || 0, on.totalSummons)
    )}% | ${f1(pct(off.deckCostCounts[c] || 0, off.deckTotal))}% |`
  )
  .join('\n');

const md = `# 先攻1ターン目の攻撃制限：前後比較（CG-017）

調査日: ${stamp.split(' ')[0]}

## TL;DR

\`data/cards.js\` の \`rules.firstPlayerAttacksOnTurn1\` だけを差し替えて、同じシード帯・同じ AI で
${GAMES} 戦ずつ回した。デッキ・AI の重み・他のルールは一切変えていない。
**本ファイルは観測値のみを記載する。解釈と結論は書かない。**

> ★ **自動対戦の結果は人間のプレイとは別物である。**
> これは「構造的に偏るか」を見るためのものであって、面白いかどうかの判定には使わない。
> 本フラグは CPU では差が出ない可能性を承知のうえで、作者が人間プレイで
> 比較するために用意した（CG-017 の指示）。

---

## 測定の条件

| 項目 | 値 |
|---|---|
| 実施日時 | ${stamp} |
| HEAD | \`${head}\` |
| シード | ${off.seedRange}（1試合ごとに +1） |
| 試行回数 | ${GAMES} 戦（列ごとに同じシード帯） |
| ターン上限 | ${off.turnCap}（打ち切り時は未決着として計上） |
| 制限なし | \`rules.firstPlayerAttacksOnTurn1 = true\`（従来の挙動。\`data/cards.js\` の既定） |
| 制限あり | \`rules.firstPlayerAttacksOnTurn1 = false\`（先攻の最初の手番は攻撃不可。召喚・配置換えは可能） |
| AI | ${off.aiLabel}（${off.aiNote}）。重みは \`data/ai.js\`（両列とも同一） |
| デッキ | \`deck.lists.default\` 30枚・両者同一 |
| 乱数 | engine の seeded RNG のみ。CPU は乱数を使わない（同一 state → 同一手） |

## 定義（この表の数え方）

- **1ターン目**: 先攻プレイヤーの最初の手番（\`state.turn === 1\`）
- **1ターン目終了時点の後攻ネクロマンサーの残り体力**:
  turn が 1 → 2 に変わった瞬間（＝先攻の最初の手番の endTurn 直後）の
  後攻ネクロマンサーの（体力 − 受けたダメージ）。初期体力は 12。
  1ターン目中に決着した試合はその時点の値（下限0）で数える。全試合が母数

---

## 1. 指示された3項目

| 指標 | 制限なし（従来） | 制限あり |
|---|---|---|
${mainRows}

---

## 2. その他の指標

| 指標 | 制限なし（従来） | 制限あり |
|---|---|---|
${subRows}

---

## 3. 決着ターンの分布（5ターン刻み・決着した試合のみ）

| ターン | 制限なし（従来） | 制限あり |
|---|---|---|
${histRows}

---

## 4. 能力の発動回数

${GAMES} 戦の合計。engine にカウンタは持たせず、\`tools/harness.js\` が state の差分から数えている。

| 能力 | 制限なし（従来） | 制限あり |
|---|---|---|
${abilityRows}

---

## 5. 召喚されたカードのコスト分布

召喚に占める割合。コスト0はデッキに存在しない（c06 が生成するトークン）。

| コスト | 制限なし（従来） | 制限あり | デッキ構成比 |
|---|---|---|---|
${costRows}

---

## 再現手順

\`\`\`
SIM_GAMES=${GAMES} SIM_SEED=${BASE_SEED} SIM_OUT="${outName}" \\
  node tools/compare_firstturn.js "$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')" "$(git rev-parse --short HEAD)"
\`\`\`

「制限あり」を単体で回すときはデバッグパネル（index.html）か、
\`data/cards.js\` の \`rules.firstPlayerAttacksOnTurn1\` を \`false\` にする
（本スクリプトは JSON を書き換えず、読み込んだ値を差し替えて測っている）。
`;

const out = path.join(here, '..', 'docs', 'research', outName);
writeFileSync(out, md, 'utf8');
console.log(`書き出し: ${out}`);
