/**
 * tools/report.js — simulate.js の集計を docs/research/ の Markdown に書き出す（CG-001）
 *
 * 使い方: SIM_GAMES=1000 SIM_SEED=1000 node tools/report.js "2026-08-11 12:00 JST" <HEAD短縮ハッシュ>
 *
 * 試行回数とシードは環境変数で渡す。simulate.js は import されたとき
 * 呼び出し側の argv を読まない（読むと日時文字列を試行回数として拾う）。
 *
 * ★ 観測値だけを書く。解釈・結論は書かない。
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { result as r } from './simulate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stamp = process.argv[2] || '（日時未取得）';
const head = process.argv[3] || '（HEAD未取得）';

const pct = (n, d) => (d ? (n / d) * 100 : 0);
const f1 = (x) => x.toFixed(1);
const f2 = (x) => x.toFixed(2);

const costKeys = Object.keys(r.costCounts).sort((a, b) => a - b);

const costRows = costKeys
  .map((c) => {
    const share = pct(r.costCounts[c], r.totalSummons);
    const deckShare = pct(r.deckCostCounts[c] || 0, r.deckTotal);
    return `| ${c} | ${r.costCounts[c]} | ${f1(share)}% | ${f1(deckShare)}% | ${(share - deckShare >= 0 ? '+' : '')}${f1(share - deckShare)} pt |`;
  })
  .join('\n');

const histRows = Object.keys(r.hist)
  .map(Number)
  .sort((a, b) => a - b)
  .map((b) => {
    const n = r.hist[b];
    const share = pct(n, r.decided);
    const bar = '█'.repeat(Math.max(0, Math.round(share / 2)));
    return `| ${b}〜${b + 4} | ${n} | ${f1(share)}% | ${bar} |`;
  })
  .join('\n');

// ターンごとの平均（到達数が試行の5%未満になったら打ち切る）
const turnKeys = [...r.byTurn.keys()].sort((a, b) => a - b);
const cutoff = Math.max(3, r.games * 0.05);
const turnRows = turnKeys
  .filter((t) => r.byTurn.get(t).n >= cutoff)
  .map((t) => {
    const b = r.byTurn.get(t);
    return `| ${t} | ${b.n} | ${f1(b.g1 / b.n)} | ${f1(b.g2 / b.n)} | ${f2(b.f1 / b.n)} | ${f2(b.f2 / b.n)} |`;
  })
  .join('\n');

const md = `# 自動プレイによる基礎統計（ランダムAI同士）

調査日: 2026-08-11

## TL;DR

ランダムAI同士の自動対戦 ${r.games} 戦から、先攻勝率・決着ターン・奪取回数・墓地総コストの推移・
召喚カードのコスト分布・盤面埋まり率・墓地からの召喚割合の7項目を観測した。
**本ファイルは観測値のみを記載する。解釈と結論は書かない。**

> ★ **ランダムAIの結果は人間のプレイとは別物である。**
> これは「構造的に偏るか」を見るためのものであって、面白いかどうかの判定には使わない。

---

## 測定の条件

| 項目 | 値 |
|---|---|
| 実施日時 | ${stamp} |
| HEAD | \`${head}\` |
| シード | ${r.seedRange}（1試合ごとに +1） |
| 試行回数 | ${r.games} 戦 |
| ターン上限 | ${r.turnCap}（打ち切り時は未決着として計上） |
| ルール | \`data/cards.json\` の \`rules\`（summonSource = ownGraveyard） |
| デッキ | \`deck.lists.default\` 30枚・両者同一 |
| AI | 合法手から一様ランダムに選択。召喚はピッチ枚数・出すカード・枠をすべて乱択 |
| 乱数 | engine の seeded RNG のみ（AI の選択も含む）。同一シードで同一結果 |
| 再現方法 | \`node tools/simulate.js ${r.games} ${r.baseSeed}\` |

決着 ${r.decided} 戦 ／ 未決着 ${r.undecided} 戦。

---

## 1. 先攻勝率

| 項目 | 値 |
|---|---|
| 先攻（p1）勝利 | ${r.firstWins} |
| 後攻（p2）勝利 | ${r.secondWins} |
| **先攻勝率** | **${f1(r.firstWinRate)}%** |

初期手札は先攻6枚・後攻7枚。先攻も1ターン目にドローする設定（\`firstPlayerDrawsOnTurn1: true\`）。

---

## 2. 決着ターン数と分布

| 項目 | 値 |
|---|---|
| 平均 | ${f1(r.turnsMean)} |
| 中央値 | ${r.turnsMedian} |
| 最小 | ${r.turnsMin} |
| 最大 | ${r.turnsMax} |

1ターン＝片方のプレイヤーの手番。両者が1回ずつ動くと2ターン進む。

| ターン帯 | 試合数 | 割合 | |
|---|---|---|---|
${histRows}

---

## 3. 奪取の発生回数

**定義: 攻撃でユニットを撃破し、自分の墓地に入れた回数。** ピッチによる墓地送りは含まない。

| 項目 | 値 |
|---|---|
| 平均 | ${f2(r.stealsMean)} 回 / 試合 |
| 中央値 | ${r.stealsMedian} |
| 最大 | ${r.stealsMax} |

---

## 4. 墓地の総コストの推移

そのターンに到達した試合だけで平均した値。到達数が試行の5%を下回るターンは省略。

| ターン | 到達試合数 | p1 墓地総コスト | p2 墓地総コスト | p1 盤面 | p2 盤面 |
|---|---|---|---|---|---|
${turnRows}

盤面の列は埋まっている枠数（6枠中）。

---

## 5. 召喚されたカードのコスト分布

召喚 ${r.totalSummons} 回（${r.games} 戦の合計）。デッキ構成比はデッキ30枚に占める同コストの枚数比。

| コスト | 召喚回数 | 召喚に占める割合 | デッキ構成比 | 差 |
|---|---|---|---|---|
${costRows}

---

## 6. 盤面の埋まり率

| 項目 | 値 |
|---|---|
| 平均埋まり枠数 | ${f2(r.fillMean)} / 6 |
| **平均埋まり率** | **${f1((r.fillMean / 6) * 100)}%** |

各ターン開始時点で両プレイヤー分をサンプリングした値。

---

## 7. 墓地からの召喚が全召喚に占める割合

| 召喚元 | 回数 | 割合 |
|---|---|---|
| 手札から | ${r.fromHand} | ${f1(pct(r.fromHand, r.fromHand + r.fromGrave))}% |
| 墓地から | ${r.fromGrave} | ${f1(r.graveSummonRate)}% |

---

## 再現手順

\`\`\`
node tools/simulate.js ${r.games} ${r.baseSeed}
SIM_GAMES=${r.games} SIM_SEED=${r.baseSeed} node tools/report.js "$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')" "$(git rev-parse --short HEAD)"
\`\`\`
`;

const out = path.join(here, '..', 'docs', 'research', '自動プレイ基礎統計_20260811.md');
writeFileSync(out, md, 'utf8');
console.log(`書き出し: ${out}`);
