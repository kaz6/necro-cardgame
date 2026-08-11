/**
 * tools/compare.js — ランダムAI と 評価関数CPU を同じ条件で回して並べる（CG-006）
 *
 * 使い方:
 *   SIM_GAMES=1000 SIM_SEED=1000 node tools/compare.js "2026-08-11 12:00 JST" <HEAD短縮ハッシュ>
 *
 *   SIM_GAMES  試行回数（既定 1000）
 *   SIM_SEED   開始シード（既定 1000）
 *   SIM_OUT    出力ファイル名（docs/research/ 配下）
 *
 * 同じシード帯・同じ試行回数で AI だけを差し替える。
 * 3列目の CPU は data/ai.js のとおり（＝ルールどおり）に打たせる。
 * 補足として、トークンの 0pt 再召喚だけを AI 側で自粛させた列も測る。
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
const outName = process.env.SIM_OUT || 'CPU対戦比較_20260811_CG006.md';

const noTokenRevive = { ...aiData, search: { ...aiData.search, reviveTokens: false } };
const common = { games: GAMES, baseSeed: BASE_SEED, cardData };

console.log('ランダムAI を実行中...');
const rnd = runSimulation({ ...common, ai: 'random', aiData });
console.log('評価関数CPU を実行中...');
const cpu = runSimulation({ ...common, ai: 'cpu', aiData });
console.log('評価関数CPU（トークン再召喚を自粛）を実行中...');
const cpuNT = runSimulation({ ...common, ai: 'cpu', aiData: noTokenRevive });

// ---------------------------------------------------------------------------

const pct = (n, d) => (d ? (n / d) * 100 : 0);
const f1 = (x) => x.toFixed(1);
const f2 = (x) => x.toFixed(2);
const fill = (r) => (r.fillMean / r.boardSlots) * 100;

/** 3列（指標・ランダム・CPU）の行 */
const row = (label, a, b) => `| ${label} | ${a} | ${b} |`;

const mainRows = [
  row('盤面の平均埋まり率', `${f1(fill(rnd))}%（${f2(rnd.fillMean)} / 6枠）`, `${f1(fill(cpu))}%（${f2(cpu.fillMean)} / 6枠）`),
  row(
    'c06 の発動 / 不発',
    `${rnd.ability.token} / ${rnd.ability.tokenBlocked}（不発 ${f1(pct(rnd.ability.tokenBlocked, rnd.ability.token + rnd.ability.tokenBlocked))}%）`,
    `${cpu.ability.token} / ${cpu.ability.tokenBlocked}（不発 ${f1(pct(cpu.ability.tokenBlocked, cpu.ability.token + cpu.ability.tokenBlocked))}%）`
  ),
  row('奪取（回/試合）', f2(rnd.stealsMean), f2(cpu.stealsMean)),
  row('平均決着ターン数', f1(rnd.turnsMean), f1(cpu.turnsMean)),
  row('先攻勝率', `${f1(rnd.firstWinRate)}%`, `${f1(cpu.firstWinRate)}%`),
].join('\n');

const subRows = [
  row('決着 / 未決着', `${rnd.decided} / ${rnd.undecided}`, `${cpu.decided} / ${cpu.undecided}`),
  row('決着ターン 中央値', String(rnd.turnsMedian), String(cpu.turnsMedian)),
  row('決着ターン 範囲', `${rnd.turnsMin}〜${rnd.turnsMax}`, `${cpu.turnsMin}〜${cpu.turnsMax}`),
  row('奪取 中央値 / 最大', `${rnd.stealsMedian} / ${rnd.stealsMax}`, `${cpu.stealsMedian} / ${cpu.stealsMax}`),
  row('召喚回数（合計）', String(rnd.totalSummons), String(cpu.totalSummons)),
  row('召喚元 墓地の割合', `${f1(rnd.graveSummonRate)}%`, `${f1(cpu.graveSummonRate)}%`),
  row('総手数（action 数）', String(rnd.steps), String(cpu.steps)),
].join('\n');

const abilityRows = [
  row('c05 後列へ退いた / 不発', `${rnd.ability.retreat} / ${rnd.ability.retreatFailed}`, `${cpu.ability.retreat} / ${cpu.ability.retreatFailed}`),
  row('c06 トークン生成 / 不発', `${rnd.ability.token} / ${rnd.ability.tokenBlocked}`, `${cpu.ability.token} / ${cpu.ability.tokenBlocked}`),
  row('c07 デッキ送り', String(rnd.ability.mill), String(cpu.ability.mill)),
  row('c08 呪い発動（合計pt）', `${rnd.ability.curse}（+${rnd.ability.curseTax}pt）`, `${cpu.ability.curse}（+${cpu.ability.curseTax}pt）`),
].join('\n');

const exploitRows = [
  row('トークンの召喚回数', String(rnd.tokenSummons), String(cpu.tokenSummons)),
  row('うち墓地から出し直した回数', String(rnd.tokenRevives), String(cpu.tokenRevives)),
  row('全召喚に占める割合', `${f1(pct(rnd.tokenRevives, rnd.totalSummons))}%`, `${f1(pct(cpu.tokenRevives, cpu.totalSummons))}%`),
  row('ピッチ0枚で成立した召喚', String(rnd.freeSummons), String(cpu.freeSummons)),
  row('里帰り（自分の持ち札が自分の墓地へ）', String(rnd.homecoming), String(cpu.homecoming)),
  row('　うちトークン', String(rnd.homecomingToken), String(cpu.homecomingToken)),
].join('\n');

// ターン別の盤面埋まり率
//   - 到達数がどの列でも試行の5%を下回るターンは省略
//   - 表が長くなりすぎるので MAX_TURN_ROWS で打ち切り、切った分は表の下に必ず明記する
//     （長引く試合ほど盤面が厚いので、黙って切ると「厚い側」だけが消える）
const MAX_TURN_ROWS = 40;
const cutoff = Math.max(3, GAMES * 0.05);
const turnKeys = [...new Set([...rnd.byTurn.keys(), ...cpu.byTurn.keys(), ...cpuNT.byTurn.keys()])]
  .sort((a, b) => a - b)
  .filter((t) => {
    const n = [rnd, cpu, cpuNT].map((r) => r.byTurn.get(t)?.n || 0);
    return Math.max(...n) >= cutoff;
  });
const shownTurns = turnKeys.filter((t) => t <= MAX_TURN_ROWS);
const cell = (r, t) => {
  const b = r.byTurn.get(t);
  if (!b) return '—';
  return `${f2((b.f1 + b.f2) / (2 * b.n))}（${b.n}）`;
};
const turnRows = shownTurns
  .map((t) => `| ${t} | ${cell(rnd, t)} | ${cell(cpu, t)} | ${cell(cpuNT, t)} |`)
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
  `| ランダムAI | ${tailSummary(rnd)} |`,
  `| 評価関数CPU | ${tailSummary(cpu)} |`,
  `| CPU（トークン再召喚を自粛） | ${tailSummary(cpuNT)} |`,
].join('\n');

const costKeys = [...new Set([...Object.keys(rnd.costCounts), ...Object.keys(cpu.costCounts)])]
  .map(Number)
  .sort((a, b) => a - b);
const costRows = costKeys
  .map((c) => {
    const deckShare = pct(rnd.deckCostCounts[c] || 0, rnd.deckTotal);
    return `| ${c} | ${f1(pct(rnd.costCounts[c] || 0, rnd.totalSummons))}% | ${f1(
      pct(cpu.costCounts[c] || 0, cpu.totalSummons)
    )}% | ${f1(pct(cpuNT.costCounts[c] || 0, cpuNT.totalSummons))}% | ${f1(deckShare)}% |`;
  })
  .join('\n');

const suppRows = [
  `| 盤面の平均埋まり率 | ${f1(fill(rnd))}% | ${f1(fill(cpu))}% | ${f1(fill(cpuNT))}% |`,
  `| c06 の発動 / 不発 | ${rnd.ability.token} / ${rnd.ability.tokenBlocked} | ${cpu.ability.token} / ${cpu.ability.tokenBlocked} | ${cpuNT.ability.token} / ${cpuNT.ability.tokenBlocked} |`,
  `| 奪取（回/試合） | ${f2(rnd.stealsMean)} | ${f2(cpu.stealsMean)} | ${f2(cpuNT.stealsMean)} |`,
  `| 平均決着ターン数 | ${f1(rnd.turnsMean)} | ${f1(cpu.turnsMean)} | ${f1(cpuNT.turnsMean)} |`,
  `| 先攻勝率 | ${f1(rnd.firstWinRate)}% | ${f1(cpu.firstWinRate)}% | ${f1(cpuNT.firstWinRate)}% |`,
  `| 決着 / 未決着 | ${rnd.decided} / ${rnd.undecided} | ${cpu.decided} / ${cpu.undecided} | ${cpuNT.decided} / ${cpuNT.undecided} |`,
  `| 召喚回数（合計） | ${rnd.totalSummons} | ${cpu.totalSummons} | ${cpuNT.totalSummons} |`,
  `| 総手数（action 数） | ${rnd.steps} | ${cpu.steps} | ${cpuNT.steps} |`,
].join('\n');

const md = `# 評価関数CPU とランダムAI の比較（CG-006）

調査日: 2026-08-11

## TL;DR

同じシード帯・同じ試行回数で、AI だけをランダムから評価関数ベースの CPU に差し替えて
${GAMES} 戦ずつ回した。盤面の平均埋まり率・c06 の発動比・奪取回数・平均決着ターン数・
先攻勝率の5項目を並べる。
**本ファイルは観測値のみを記載する。解釈と結論は書かない。**

> ★ **自動対戦の結果は人間のプレイとは別物である。**
> これは「構造的に偏るか」を見るためのものであって、面白いかどうかの判定には使わない。

---

## 測定の条件

| 項目 | 値 |
|---|---|
| 実施日時 | ${stamp} |
| HEAD | \`${head}\` |
| シード | ${rnd.seedRange}（1試合ごとに +1） |
| 試行回数 | ${GAMES} 戦（AI ごとに同じシード帯） |
| ターン上限 | ${rnd.turnCap}（打ち切り時は未決着として計上） |
| ルール | \`data/cards.js\` の \`rules\`（CG-005 から変更なし） |
| デッキ | \`deck.lists.default\` 30枚・両者同一 |
| ランダムAI | ${rnd.aiNote} |
| 評価関数CPU | ${cpu.aiNote}。重みは \`data/ai.js\` |
| 乱数 | engine の seeded RNG のみ。CPU は乱数を使わない（同一 state → 同一手） |

★ ランダムAI の値は CG-005（HEAD \`ec2bd24\`）と同一シード帯・同一実装であり、
当時の観測値と一致する。

---

## 1. 指示された5項目

| 指標 | ランダムAI | 評価関数CPU |
|---|---|---|
${mainRows}

---

## 2. その他の指標

| 指標 | ランダムAI | 評価関数CPU |
|---|---|---|
${subRows}

---

## 3. ターン別の盤面埋まり率

各ターン開始時点で両プレイヤー分をサンプリングした平均（6枠中）。括弧内は到達試合数。
到達数がどの列でも試行の5%を下回るターンは省略。
第4列は補足測定（第7節）の CPU。

| ターン | ランダムAI | 評価関数CPU | CPU（トークン再召喚を自粛） |
|---|---|---|---|
${turnRows}

★ **表はターン ${MAX_TURN_ROWS} で打ち切っている。切り捨てた先は以下のとおり。**
長引く試合ほど盤面が厚いので、黙って切ると厚い側だけが表から消える。

| AI | ターン ${MAX_TURN_ROWS} より先 |
|---|---|
${tailRows}

---

## 4. 能力の発動回数

${GAMES} 戦の合計。engine にカウンタは持たせず、\`tools/harness.js\` が state の差分から数えている。

| 能力 | ランダムAI | 評価関数CPU |
|---|---|---|
${abilityRows}

---

## 5. 召喚されたカードのコスト分布

召喚に占める割合。コスト0はデッキに存在しない（c06 が生成するトークン）。

| コスト | ランダムAI | 評価関数CPU | CPU（トークン再召喚を自粛） | デッキ構成比 |
|---|---|---|---|---|
${costRows}

---

## 6. トークンの 0pt 再召喚（未対応として残っている件）

トークンはコスト0なので、墓地から**ピッチ0枚**で出し直せる。
CPU がこれをどれだけ使ったかの観測。

| 指標 | ランダムAI | 評価関数CPU |
|---|---|---|
${exploitRows}

「里帰り」＝ 自分の持ち札が自分の墓地に入った回数。相手に渡ったカードが相手の場で
倒されると、倒した側＝元の持ち主の墓地へ戻るため発生する。

---

## 7. 補足測定：トークンの 0pt 再召喚だけを CPU に自粛させた場合

★ **ルールは変更していない。** \`data/ai.js\` の \`search.reviveTokens\` を false にして、
CPU が自分の墓地のトークンを召喚し直さないようにしただけ。同じシード帯・同じ試行回数。

| 指標 | ランダムAI | 評価関数CPU | CPU（トークン再召喚を自粛） |
|---|---|---|---|
${suppRows}

---

## 再現手順

\`\`\`
node tools/simulate.js ${GAMES} ${BASE_SEED} random
node tools/simulate.js ${GAMES} ${BASE_SEED} cpu
SIM_REVIVE_TOKENS=0 node tools/simulate.js ${GAMES} ${BASE_SEED} cpu

SIM_GAMES=${GAMES} SIM_SEED=${BASE_SEED} SIM_OUT="${outName}" \\
  node tools/compare.js "$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')" "$(git rev-parse --short HEAD)"
\`\`\`
`;

const out = path.join(here, '..', 'docs', 'research', outName);
writeFileSync(out, md, 'utf8');
console.log(`書き出し: ${out}`);
