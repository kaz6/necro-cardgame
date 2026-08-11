/**
 * tools/report.js — simulate.js の集計を docs/research/ の Markdown に書き出す（CG-001 / CG-005）
 *
 * 使い方: SIM_GAMES=1000 SIM_SEED=1000 node tools/report.js "2026-08-11 12:00 JST" <HEAD短縮ハッシュ>
 *
 * 試行回数とシードは環境変数で渡す。simulate.js は import されたとき
 * 呼び出し側の argv を読まない（読むと日時文字列を試行回数として拾う）。
 *
 *   SIM_OUT      出力ファイル名（docs/research/ 配下）。既定は CG-001 のファイル
 *   SIM_BASELINE 前後比較の基準にする JSON。既定は _baseline_CG001.json
 *   SIM_TITLE    見出しに添える版の名前
 *
 * ★ 観測値だけを書く。解釈・結論は書かない。
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { result as r } from './simulate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stamp = process.argv[2] || '（日時未取得）';
const head = process.argv[3] || '（HEAD未取得）';
const outName = process.env.SIM_OUT || '自動プレイ基礎統計_20260811.md';
const title = process.env.SIM_TITLE || '';

const baselinePath = path.join(
  here,
  '..',
  'docs',
  'research',
  process.env.SIM_BASELINE || '_baseline_CG001.json'
);
const base = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;

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

// 前後比較（基準ファイルがあるときだけ出す）
const diff = (now, before, digits = 1) => {
  const d = now - before;
  return `${d >= 0 ? '+' : ''}${d.toFixed(digits)}`;
};

const costShareNow = {};
for (const c of costKeys) costShareNow[c] = pct(r.costCounts[c], r.totalSummons);

const compareSection = !base
  ? ''
  : `## 0. 前後比較（${base.label} → 今回）

基準は \`docs/research/${process.env.SIM_BASELINE || '_baseline_CG001.json'}\`。
**${base.stamp} ／ HEAD \`${base.head}\` ／ シード ${base.seedRange} ／ ${base.games} 戦。**
今回と同じシード帯・同じ試行回数・同じランダムAI。デッキ構成はコスト比を保ったまま
c07 を1枚増やし c08 を1枚減らしてある（呪いを2枚投入する指示による）。

| 指標 | 前 \`${base.head}\` | 後 \`${head}\` | 差 |
|---|---|---|---|
| 盤面の平均埋まり率 | ${f1(base.fillRate)}%（${f2(base.fillMean)} / 6枠） | ${f1((r.fillMean / 6) * 100)}%（${f2(r.fillMean)} / 6枠） | ${diff((r.fillMean / 6) * 100, base.fillRate)} pt |
| 平均決着ターン数 | ${f1(base.turnsMean)} | ${f1(r.turnsMean)} | ${diff(r.turnsMean, base.turnsMean)} |
| 決着ターン中央値 | ${base.turnsMedian} | ${r.turnsMedian} | ${diff(r.turnsMedian, base.turnsMedian, 0)} |
| 先攻勝率 | ${f1(base.firstWinRate)}% | ${f1(r.firstWinRate)}% | ${diff(r.firstWinRate, base.firstWinRate)} pt |
| 奪取（回/試合） | ${f2(base.stealsMean)} | ${f2(r.stealsMean)} | ${diff(r.stealsMean, base.stealsMean, 2)} |
| 召喚回数（合計） | ${base.totalSummons} | ${r.totalSummons} | ${diff(r.totalSummons, base.totalSummons, 0)} |
| 召喚元 手札 | ${f1(base.handSummonRate)}% | ${f1(pct(r.fromHand, r.fromHand + r.fromGrave))}% | ${diff(pct(r.fromHand, r.fromHand + r.fromGrave), base.handSummonRate)} pt |
| 召喚元 墓地 | ${f1(base.graveSummonRate)}% | ${f1(r.graveSummonRate)}% | ${diff(r.graveSummonRate, base.graveSummonRate)} pt |

召喚されたカードのコスト分布（召喚に占める割合）。

| コスト | 前 \`${base.head}\` | 後 \`${head}\` | 差 | 今回のデッキ構成比 |
|---|---|---|---|---|
${costKeys
  .map((c) => {
    const now = costShareNow[c];
    const was = base.costShare[c];
    const deckShare = pct(r.deckCostCounts[c] || 0, r.deckTotal);
    return `| ${c} | ${was === undefined ? '—' : `${f1(was)}%`} | ${f1(now)}% | ${
      was === undefined ? '—' : `${diff(now, was)} pt`
    } | ${f1(deckShare)}% |`;
  })
  .join('\n')}

コスト0はデッキに存在しない（c06 が生成するトークン）。

---

`;

const md = `# 自動プレイによる基礎統計（ランダムAI同士）${title ? `／${title}` : ''}

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

${compareSection}## 1. 先攻勝率

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

## 8. 能力の発動回数

${r.games} 戦の合計。engine にカウンタは持たせず、\`tools/simulate.js\` が state の差分から数えている。

| 能力 | 発動 | 不発 | 1試合あたり（発動） |
|---|---|---|---|
| c05 倒されて後列へ退いた | ${r.ability.retreat} | ${r.ability.retreatFailed}（後列に空きなし） | ${f2(r.ability.retreat / r.games)} |
| c06 右の空き枠にトークン | ${r.ability.token} | ${r.ability.tokenBlocked}（右端／右が埋まり） | ${f2(r.ability.token / r.games)} |
| c07 相手のデッキ上を自分の墓地へ | ${r.ability.mill} | — | ${f2(r.ability.mill / r.games)} |
| c08 呪いによる追加支払い | ${r.ability.curse} | — | ${f2(r.ability.curse / r.games)} |

呪いで増えた支払いポイントの合計 ${r.ability.curseTax} pt（発動1回あたり ${
  r.ability.curse ? f2(r.ability.curseTax / r.ability.curse) : '0.00'
} pt）。

---

## 再現手順

\`\`\`
node tools/simulate.js ${r.games} ${r.baseSeed}
SIM_GAMES=${r.games} SIM_SEED=${r.baseSeed} SIM_OUT="${outName}" \\
  node tools/report.js "$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')" "$(git rev-parse --short HEAD)"
\`\`\`
`;

const out = path.join(here, '..', 'docs', 'research', outName);
writeFileSync(out, md, 'utf8');
console.log(`書き出し: ${out}`);
