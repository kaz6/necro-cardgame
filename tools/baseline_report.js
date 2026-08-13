/**
 * tools/baseline_report.js — 現在の既定設定そのままの基準値を docs/research/ に書き出す（CG-016）
 *
 * 使い方: node tools/baseline_report.js "2026-08-14 09:00 JST" <HEAD短縮ハッシュ>
 *   SIM_GAMES  試行回数（既定 500・CG-011 で 1000 から半減）
 *   SIM_SEED   開始シード（既定 1000）
 *   SIM_AI     AI（既定 cpu）
 *   SIM_OUT    出力ファイル名（docs/research/ 配下）
 *   SIM_TITLE  見出しに添える名前
 *
 * compare_* と違い、何も差し替えない。`data/cards.js` に書かれている既定値のまま1回まわす。
 * 「比較」ではなく「この設定での基準値」を残すためのもの。
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
const AI = process.env.SIM_AI || 'cpu';
const outName = process.env.SIM_OUT || 'CG016_基準値_20260814.md';
const title = process.env.SIM_TITLE || '';

console.log(`基準値を測定中...（${AI}・${GAMES}戦・シード ${BASE_SEED}〜）`);
const r = runSimulation({ games: GAMES, baseSeed: BASE_SEED, ai: AI, cardData, aiData });

// ---------------------------------------------------------------------------

const pct = (n, d) => (d ? (n / d) * 100 : 0);
const f1 = (x) => x.toFixed(1);
const f2 = (x) => x.toFixed(2);
const fill = (x) => (x.fillMean / x.boardSlots) * 100;

/**
 * 埋まり率は「1ターン＝1サンプル」なので、未決着の試合ほど重く効く（CG-010 の教訓）。
 * 全体平均だけでなく、決着した試合のみ／ターン範囲を絞った平均も出す。
 */
function fillBreakdown(opt) {
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
const fillCell = (opt) => {
  const b = fillBreakdown(opt);
  return `${f1(pct(b.mean, r.boardSlots))}%（${f2(b.mean)} / 6枠）`;
};
const all = fillBreakdown({});
const dec = fillBreakdown({ decidedOnly: true });

// 主要なルールフラグ（この基準値がどの設定のものかを本文に固定する）
const rules = cardData.rules;
const settingsRows = [
  `| \`graveyardSummonBuffer\` | ${rules.graveyardSummonBuffer} |`,
  `| \`drawPerTurn\` | ${rules.drawPerTurn} |`,
  `| 後攻の初手 | ${rules.openingHand.second} |`,
  `| \`pitchCarryover\` | ${rules.pitchCarryover} |`,
  `| トークンの倒れ先 | ${cardData.tokens.list[0].onDeath} |`,
].join('\n');

const mainRows = [
  `| ★ 先攻勝率 | ${f1(r.firstWinRate)}% |`,
  `| 決着 / 未決着 | ${r.decided} / ${r.undecided} |`,
  `| 平均決着ターン数 | ${f1(r.turnsMean)} |`,
  `| 決着ターン 中央値 | ${r.turnsMedian} |`,
  `| 決着ターン 範囲 | ${r.turnsMin}〜${r.turnsMax} |`,
  `| 奪取（回/試合） | ${f2(r.stealsMean)} |`,
  `| 召喚回数（合計） | ${r.totalSummons} |`,
  `| 　うち手札から | ${r.fromHand} |`,
  `| 　うち墓地から | ${r.fromGrave}（${f1(r.graveSummonRate)}%） |`,
  `| ピッチ0枚で成立した召喚 | ${r.freeSummons} |`,
  `| 里帰り（自分の持ち札が自分の墓地へ） | ${r.homecoming} |`,
  `| 総手数（action 数） | ${r.steps} |`,
].join('\n');

const fillRows = [
  `| 全体 | ${fillCell({})} |`,
  `| 決着した試合のみ | ${fillCell({ decidedOnly: true })} |`,
  `| ターン2〜10のみ | ${fillCell({ minTurn: 2, maxTurn: 10 })} |`,
  `| ターン2〜16のみ | ${fillCell({ minTurn: 2, maxTurn: 16 })} |`,
  `| 未決着がサンプルに占める割合 | ${f1(pct(all.samples - dec.samples, all.samples))}% |`,
].join('\n');

const abilityRows = [
  `| c05 後列へ退いた / 不発 | ${r.ability.retreat} / ${r.ability.retreatFailed} |`,
  `| c06 トークン生成 / 不発 | ${r.ability.token} / ${r.ability.tokenBlocked} |`,
  `| c07 デッキ送り | ${r.ability.mill} |`,
  `| c08 呪い発動（合計pt） | ${r.ability.curse}（+${r.ability.curseTax}pt） |`,
].join('\n');

// ターン別の盤面埋まり率（打ち切ったら必ず明記する）
const MAX_TURN_ROWS = 30;
const cutoff = Math.max(3, GAMES * 0.05);
const turnKeys = [...r.byTurn.keys()].sort((a, b) => a - b).filter((t) => (r.byTurn.get(t)?.n || 0) >= cutoff);
const shownTurns = turnKeys.filter((t) => t <= MAX_TURN_ROWS);
const turnRows = shownTurns
  .map((t) => {
    const b = r.byTurn.get(t);
    return `| ${t} | ${b.n} | ${f1(pct((b.f1 + b.f2) / (b.n * 2), r.boardSlots))}% |`;
  })
  .join('\n');
const cutNote = turnKeys.length > shownTurns.length
  ? `\n※ ターン ${MAX_TURN_ROWS} で打ち切った。**切り捨てたのはターン ${shownTurns[shownTurns.length - 1] + 1}〜${turnKeys[turnKeys.length - 1]} の ${turnKeys.length - shownTurns.length} 行。** 長引く試合ほど盤面が厚いので、黙って切ると厚い側だけが消える。`
  : '';

const md = `# 既定設定の基準値${title ? `（${title}）` : ''}

調査日: ${stamp.slice(0, 10)}

## TL;DR

\`data/cards.js\` の既定値を**何も差し替えずに** ${AI === 'cpu' ? 'CPU 同士（評価関数ベース）' : 'ランダムAI同士'}で ${GAMES} 戦まわした基準値。
前後比較ではない。今後の測定の照合先として残す。
**本ファイルは観測値のみを記載する。解釈と結論は書かない。**

> ★ **自動対戦の結果は人間のプレイとは別物である。**
> 構造的な偏りを見るためのものであって、面白いかどうかの判定には使わない。

---

## 測定の条件

| 項目 | 値 |
|---|---|
| 実施日時 | ${stamp} |
| HEAD | \`${head}\` |
| シード | ${r.seedRange}（1試合ごとに +1） |
| 試行回数 | ${GAMES} 戦 |
| ターン上限 | ${r.turnCap}（打ち切り時は未決着として計上） |
| AI | ${AI === 'cpu' ? 'CPU 同士（`js/ai.js`・評価関数ベース）' : 'ランダムAI同士'} |
| 差し替えた値 | **なし**（\`data/cards.js\` の既定値のまま） |
| 再現方法 | \`SIM_GAMES=${GAMES} SIM_SEED=${BASE_SEED} SIM_AI=${AI} node tools/baseline_report.js\` |

このときの主要なルールフラグ:

| フラグ | 値 |
|---|---|
${settingsRows}

---

## 1. 主要指標

| 指標 | 値 |
|---|---|
${mainRows}

---

## 2. 盤面の平均埋まり率

| 範囲 | 値 |
|---|---|
${fillRows}

埋まり率は「1ターン＝1サンプル」。未決着の試合（1戦で数百サンプル）が全体平均を歪めるため、
範囲を絞った行を併記する（CG-010 の教訓）。

---

## 3. ターン別の盤面埋まり率

到達試合数が試行の5%（${cutoff} 戦）を下回るターンは省略。

| ターン | 到達試合数 | 両者平均の埋まり率 |
|---|---|---|
${turnRows}
${cutNote}

---

## 4. 能力の発動回数

| 能力 | 値 |
|---|---|
${abilityRows}
`;

const outPath = path.join(here, '..', 'docs', 'research', outName);
writeFileSync(outPath, md);
console.log(`書き出した: docs/research/${outName}`);
console.log(`先攻勝率 ${f1(r.firstWinRate)}% ／ 決着 ${r.decided}/${GAMES} ／ 平均決着ターン ${f1(r.turnsMean)} ／ 埋まり率 ${f1(fill(r))}%`);
