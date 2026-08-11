/**
 * tools/simulate.js — 自動対戦ハーネスの CLI（CG-001 / CG-005 / CG-006）
 *
 * 中身は tools/harness.js。ここは「引数を読んで1回まわし、要約を出す」だけ。
 * tools/report.js は本ファイルの `result` を import する。
 *
 * 使い方:
 *   node tools/simulate.js [試行回数] [開始シード] [AI]
 *   SIM_GAMES=1000 SIM_SEED=1000 SIM_AI=cpu node tools/simulate.js
 *
 *   AI: random（既定・CG-001 から使っている一様ランダム）／ cpu（CG-006 の評価関数CPU）
 */

const path = require('node:path');

const { runSimulation, AGENTS } = require('./harness.js');

const here = __dirname;
const cardData = require(path.join(here, '..', 'data', 'cards.js'));
const aiData = require(path.join(here, '..', 'data', 'ai.js'));

// 直接実行のときだけ argv を読む。import されたときに呼び出し側の argv を
// 拾わないよう、環境変数を優先する。
const isMain = typeof process.argv[1] === 'string' && /simulate\.js$/.test(process.argv[1]);
const argGames = isMain ? process.argv[2] : undefined;
const argSeed = isMain ? process.argv[3] : undefined;
const argAi = isMain ? process.argv[4] : undefined;

const GAMES = Number.parseInt(process.env.SIM_GAMES || argGames || '300', 10);
const BASE_SEED = Number.parseInt(process.env.SIM_SEED || argSeed || '1000', 10);
const AI = process.env.SIM_AI || argAi || 'random';

// SIM_REVIVE_TOKENS=0 で、CPU にトークンの 0pt 再召喚を自粛させる。
// ルールは変えない。抜け道を含まない盤面を測るための AI 側のスイッチ。
const aiConfig =
  process.env.SIM_REVIVE_TOKENS === '0'
    ? { ...aiData, search: { ...aiData.search, reviveTokens: false } }
    : aiData;

const result = runSimulation({
  games: GAMES,
  baseSeed: BASE_SEED,
  ai: AI,
  cardData,
  aiData: aiConfig,
});

/** 1試合ごとの生の統計。個別の試合を追いたいときに使う */
const perGame = result.perGame;

module.exports = { result, perGame };

// 直接実行されたときだけ標準出力に要約を出す
if (isMain) {
  const r = result;
  const pct = (n, d) => (d ? (n / d) * 100 : 0);
  console.log(`AI ${r.aiLabel}（${r.ai}） ／ 試行 ${r.games} 戦 ／ シード ${r.seedRange} ／ ターン上限 ${r.turnCap}`);
  console.log(`決着 ${r.decided} ／ 未決着 ${r.undecided}`);
  console.log(`先攻勝率 ${r.firstWinRate.toFixed(1)}%（先攻 ${r.firstWins} / 後攻 ${r.secondWins}）`);
  console.log(`決着ターン 平均 ${r.turnsMean.toFixed(1)} ／ 中央 ${r.turnsMedian} ／ 範囲 ${r.turnsMin}〜${r.turnsMax}`);
  console.log(`奪取 平均 ${r.stealsMean.toFixed(2)} 回/試合 ／ 中央 ${r.stealsMedian} ／ 最大 ${r.stealsMax}`);
  console.log(`召喚 ${r.totalSummons} 回 ／ 墓地から ${r.graveSummonRate.toFixed(1)}%`);
  console.log(`盤面埋まり率 ${(r.fillMean / 6 * 100).toFixed(1)}%（平均 ${r.fillMean.toFixed(2)} / 6枠）`);
  console.log(
    `能力: c05退避 ${r.ability.retreat}（不発 ${r.ability.retreatFailed}） ／ ` +
      `c06トークン ${r.ability.token}（不発 ${r.ability.tokenBlocked}） ／ ` +
      `c07デッキ送り ${r.ability.mill} ／ c08呪い発動 ${r.ability.curse}（合計 +${r.ability.curseTax}pt）`
  );
  console.log(
    `トークン召喚 ${r.tokenSummons} 回（うち墓地から ${r.tokenRevives}） ／ ` +
      `ピッチ0枚の召喚 ${r.freeSummons} 回（全召喚の ${pct(r.freeSummons, r.totalSummons).toFixed(1)}%）`
  );
  console.log(`里帰り（自分の持ち札が自分の墓地へ） ${r.homecoming} 回（うちトークン ${r.homecomingToken}）`);
  console.log(`倒れて消滅したカード ${r.vanished} 回（onDeath: 'vanish'）`);
  console.log('コスト分布:');
  for (const c of Object.keys(r.costCounts).sort((a, b) => a - b)) {
    const share = pct(r.costCounts[c], r.totalSummons);
    const deckShare = pct(r.deckCostCounts[c] || 0, r.deckTotal);
    console.log(`  コスト${c}: ${r.costCounts[c]}回 ${share.toFixed(1)}% （デッキ構成比 ${deckShare.toFixed(1)}%）`);
  }
  void AGENTS;
}
