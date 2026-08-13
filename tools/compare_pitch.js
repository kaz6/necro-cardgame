/**
 * tools/compare_pitch.js — ピッチ pt のターン内持ち越し（CG-015）の前後比較
 *
 * 使い方:
 *   SIM_GAMES=500 SIM_SEED=1000 node tools/compare_pitch.js "2026-08-13 12:00 JST" <HEAD短縮ハッシュ>
 *
 *   SIM_GAMES  試行回数（既定 500・CG-011 の既定）
 *   SIM_SEED   開始シード（既定 1000）
 *   SIM_OUT    出力ファイル名（docs/research/ 配下）
 *
 * 同じシード帯・同じ AI（評価関数CPU）で、`rules.pitchCarryover` だけを差し替えて並べる。
 *   なし … pitchCarryover: false（従来の挙動。data/cards.js の既定）
 *   あり … pitchCarryover: true（余った pt をターン内で持ち越す）
 *
 * ★ 観測値だけを書く。解釈・結論は書かない。
 *
 * 【操作的定義】出力の「定義」節にも同じ内容を書く。
 *   - 手番: 片方のプレイヤーの番。state.turn が1増えるごとに1手番と数える
 *   - 1手番あたりの平均ピッチ枚数: 総ピッチ枚数 ÷ 開始された手番の総数
 *     （ピッチは summon action のもののみ。配置換えの支払いは現状コスト0で存在しない）
 *   - 1手番の最初のピッチ: 各手番で最初に確定した summon action のピッチ枚数。
 *     召喚を行わなかった手番は母数に含めない
 *   - 消えた pt: 使われずに消えた支払いポイント。
 *     持ち越しなし = 召喚ごとの（支払い − 使用 − 呪い）の合計。
 *     持ち越しあり = ターン終了時に失効した credit の合計（決着した手番の残りは数えない）
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
const outName = process.env.SIM_OUT || 'ピッチ持ち越し_前後比較_20260813_CG015.md';

/** rules.pitchCarryover だけを差し替えた cardData を作る（他は触らない） */
function withCarryover(data, on) {
  return { ...data, rules: { ...data.rules, pitchCarryover: on } };
}

if (cardData.rules.pitchCarryover !== false) {
  console.log(`★ 注意: data/cards.js の pitchCarryover は '${cardData.rules.pitchCarryover}'。両列とも明示指定で測る`);
}

console.log('なし（余りは消える・従来）を実行中...');
const off = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'cpu', cardData: withCarryover(cardData, false), aiData });
console.log('あり（ターン内で持ち越す）を実行中...');
const on = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: 'cpu', cardData: withCarryover(cardData, true), aiData });

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
    '盤面の平均埋まり率',
    `${f1(fill(off))}%（${f2(off.fillMean)} / 6枠）`,
    `${f1(fill(on))}%（${f2(on.fillMean)} / 6枠）`
  ),
  row('1手番あたりの平均ピッチ枚数', f2(off.pitchPerTurn), f2(on.pitchPerTurn)),
  row(
    '1手番の最初のピッチ枚数（平均）',
    `${f2(off.firstPitchMean)}（母数 ${off.firstPitchCount} 手番）`,
    `${f2(on.firstPitchMean)}（母数 ${on.firstPitchCount} 手番）`
  ),
].join('\n');

// 最初のピッチ枚数の分布
const fpKeys = [...new Set([...Object.keys(off.firstPitchDist), ...Object.keys(on.firstPitchDist)])]
  .map(Number)
  .sort((a, b) => a - b);
const fpRows = fpKeys
  .map((k) =>
    `| ${k} 枚 | ${off.firstPitchDist[k] || 0}（${f1(pct(off.firstPitchDist[k] || 0, off.firstPitchCount))}%） | ${
      on.firstPitchDist[k] || 0}（${f1(pct(on.firstPitchDist[k] || 0, on.firstPitchCount))}%） |`
  )
  .join('\n');

const subRows = [
  row('決着 / 未決着', `${off.decided} / ${off.undecided}`, `${on.decided} / ${on.undecided}`),
  row('決着ターン 中央値', String(off.turnsMedian), String(on.turnsMedian)),
  row('決着ターン 範囲', `${off.turnsMin}〜${off.turnsMax}`, `${on.turnsMin}〜${on.turnsMax}`),
  row('手番の総数', String(off.turnsTotal), String(on.turnsTotal)),
  row('召喚 action の回数', String(off.summonActionsCount), String(on.summonActionsCount)),
  row(
    '召喚 action / 手番',
    f2(off.turnsTotal ? off.summonActionsCount / off.turnsTotal : 0),
    f2(on.turnsTotal ? on.summonActionsCount / on.turnsTotal : 0)
  ),
  row('召喚されたカードの数', String(off.totalSummons), String(on.totalSummons)),
  row('ピッチされた総枚数', String(off.pitchedCards), String(on.pitchedCards)),
  row('ピッチ0枚で成立した召喚', String(off.freeSummons), String(on.freeSummons)),
  row('消えた pt（余り／失効）', String(off.wastedPt), String(on.wastedPt)),
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

// ターン別の盤面埋まり率（compare_tokens.js と同じ方針）
const MAX_TURN_ROWS = 40;
const cutoff = Math.max(3, GAMES * 0.05);
const turnKeys = [...new Set([...off.byTurn.keys(), ...on.byTurn.keys()])]
  .sort((a, b) => a - b)
  .filter((t) => Math.max(...[off, on].map((r) => r.byTurn.get(t)?.n || 0)) >= cutoff);
const shownTurns = turnKeys.filter((t) => t <= MAX_TURN_ROWS);
const cell = (r, t) => {
  const b = r.byTurn.get(t);
  if (!b) return '—';
  return `${f2((b.f1 + b.f2) / (2 * b.n))}（${b.n}）`;
};
const turnRows = shownTurns.map((t) => `| ${t} | ${cell(off, t)} | ${cell(on, t)} |`).join('\n');

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
const tailRows = [`| なし | ${tailSummary(off)} |`, `| あり | ${tailSummary(on)} |`].join('\n');

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

const md = `# ピッチ pt のターン内持ち越し：前後比較（CG-015）

調査日: 2026-08-13

## TL;DR

\`data/cards.js\` の \`rules.pitchCarryover\` だけを差し替えて、同じシード帯・同じ AI で
${GAMES} 戦ずつ回した。デッキ・AI の重み・他のルールは一切変えていない。
**本ファイルは観測値のみを記載する。解釈と結論は書かない。**

> ★ **自動対戦の結果は人間のプレイとは別物である。**
> これは「構造的に偏るか」を見るためのものであって、面白いかどうかの判定には使わない。

---

## 測定の条件

| 項目 | 値 |
|---|---|
| 実施日時 | ${stamp} |
| HEAD | \`${head}\` |
| シード | ${off.seedRange}（1試合ごとに +1） |
| 試行回数 | ${GAMES} 戦（列ごとに同じシード帯） |
| ターン上限 | ${off.turnCap}（打ち切り時は未決着として計上） |
| なし | \`rules.pitchCarryover = false\`（従来の挙動。\`data/cards.js\` の既定） |
| あり | \`rules.pitchCarryover = true\`（余った pt をターン内で持ち越す。ターン終了で失効） |
| AI | ${off.aiLabel}（${off.aiNote}）。重みは \`data/ai.js\`（両列とも同一） |
| デッキ | \`deck.lists.default\` 30枚・両者同一 |
| 乱数 | engine の seeded RNG のみ。CPU は乱数を使わない（同一 state → 同一手） |

★ CPU は持ち越し分だけピッチを減らす（\`js/ai.js\` が \`pitchCredit\` を差し引いて
必要ピッチを組む）。持ち越しなしの列ではこの差し引きは常に 0 で、
CG-014 までの CPU と同じ手を指す。

## 定義（この表の数え方）

- **手番**: 片方のプレイヤーの番。\`state.turn\` が1増えるごとに1手番と数える
- **1手番あたりの平均ピッチ枚数**: 総ピッチ枚数 ÷ 開始された手番の総数
  （ピッチは summon action のもののみ。配置換えの支払いは現状コスト0で存在しない）
- **1手番の最初のピッチ**: 各手番で最初に確定した summon action のピッチ枚数。
  召喚を行わなかった手番は母数に含めない
- **消えた pt**: 使われずに消えた支払いポイント。
  なし = 召喚ごとの（支払い − 使用 − 呪い）の合計 ／
  あり = ターン終了時に失効した持ち越しの合計（決着した手番の残りは数えない）

---

## 1. 指示された5項目

| 指標 | なし（従来） | あり（持ち越し） |
|---|---|---|
${mainRows}

---

## 2. 1手番の最初のピッチ枚数の分布

「まず多めに捨てる」が起きるかを見るための分布。母数は召喚を行った手番。

| 最初のピッチ | なし（従来） | あり（持ち越し） |
|---|---|---|
${fpRows}

---

## 3. その他の指標

| 指標 | なし（従来） | あり（持ち越し） |
|---|---|---|
${subRows}

---

## 4. 能力の発動回数

${GAMES} 戦の合計。engine にカウンタは持たせず、\`tools/harness.js\` が state の差分から数えている。

| 能力 | なし（従来） | あり（持ち越し） |
|---|---|---|
${abilityRows}

---

## 5. ターン別の盤面埋まり率

各ターン開始時点で両プレイヤー分をサンプリングした平均（6枠中）。括弧内は到達試合数。
到達数がどの列でも試行の5%を下回るターンは省略。

| ターン | なし（従来） | あり（持ち越し） |
|---|---|---|
${turnRows}

★ **表はターン ${MAX_TURN_ROWS} で打ち切っている。切り捨てた先は以下のとおり。**

| 列 | ターン ${MAX_TURN_ROWS} より先 |
|---|---|
${tailRows}

---

## 6. 召喚されたカードのコスト分布

召喚に占める割合。コスト0はデッキに存在しない（c06 が生成するトークン）。

| コスト | なし（従来） | あり（持ち越し） | デッキ構成比 |
|---|---|---|---|
${costRows}

---

## 再現手順

\`\`\`
SIM_GAMES=${GAMES} SIM_SEED=${BASE_SEED} SIM_OUT="${outName}" \\
  node tools/compare_pitch.js "$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')" "$(git rev-parse --short HEAD)"
\`\`\`

「あり」を単体で回すときはデバッグパネル（index.html）か、
\`data/cards.js\` の \`rules.pitchCarryover\` を \`true\` にする
（本スクリプトは JSON を書き換えず、読み込んだ値を差し替えて測っている）。
`;

const out = path.join(here, '..', 'docs', 'research', outName);
writeFileSync(out, md, 'utf8');
console.log(`書き出し: ${out}`);
