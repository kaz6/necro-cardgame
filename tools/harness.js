/**
 * tools/harness.js — 自動対戦の中身（v0.3 モック1・CG-021）
 *
 * 【位置づけ】
 *   ★ 自動対戦の結果は人間のプレイとは別物。構造的な偏り（試合の長さ・先手の有利・
 *     盤の埋まり方）を見るためのもので、面白いかどうかの判定には使わない。
 *
 * 【制約】
 *   - engine は純粋関数のまま。ハーネスはここに閉じる。view は使わない（Node のみ）
 *   - CPU は js/ai.js（必ず filterStateFor を通す）。salt は試合のシード
 *   - 同一シード → 同一結果
 *
 * このファイルは計算するだけで、出力はしない。CLI は tools/simulate.js と tools/compare_v03.js。
 */

const path = require('node:path');
const E = require('../js/engine.js');
const AI = require('../js/ai.js');

const cardData = require(path.join(__dirname, '..', 'data', 'cards.js'));
const aiData = require(path.join(__dirname, '..', 'data', 'ai.js'));

/** 盤の埋まり具合を記録する手数（0手目＝初期配置の直後） */
const FILL_STEP = 10;

/**
 * 1試合。
 * @param {number} seed
 * @param {{p1: string, p2: string}} kinds CPU の種類
 * @param {object} [overrides] rules の上書き
 */
function playMatch(seed, kinds, overrides) {
  let s = E.createInitialState(seed, cardData, overrides);
  const fill = [E.boardCount(s)];        // fill[k] = k 手目の直後の盤上の駒数（キング込み）
  const actions = [];
  let kingTie = false;
  let decksOutPly = null;
  while (!s.result) {
    const who = E.decider(s);
    const a = AI.decide(s, who, aiData, { kind: kinds[who], salt: seed });
    actions.push(a);
    s = E.reduce(s, a);
    fill[s.ply] = E.boardCount(s);   // 保留の解決（寝返りの配置）で増えた分は同じ手数に上書きで反映
    if (s.lastEvents.some((e) => e.type === 'kingFell' && e.tie)) kingTie = true;
    if (decksOutPly === null && s.players.p1.deck.length === 0 && s.players.p2.deck.length === 0) decksOutPly = s.ply;
  }
  return {
    seed,
    winner: s.result.winner,
    reason: s.result.reason,
    plies: s.ply,
    stats: s.stats,
    fill,
    kingTie,
    decksOutPly,
    actions,
  };
}

/** シード帯をまとめて回す */
function runBatch({ seeds, kinds, overrides }) {
  const games = [];
  for (const seed of seeds) games.push(playMatch(seed, kinds, overrides));
  return games;
}

function mean(xs) {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs) {
  if (xs.length === 0) return NaN;
  const v = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function percentile(xs, p) {
  if (xs.length === 0) return NaN;
  const v = xs.slice().sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(p * v.length))];
}

/** 集計 */
function summarize(games, maxPlies) {
  const n = games.length;
  const decided = games.filter((g) => g.winner !== null || g.reason === 'bothKings');
  const decidedPlies = games.filter((g) => g.reason !== 'maxPlies').map((g) => g.plies);
  const p1 = games.filter((g) => g.winner === 'p1').length;
  const p2 = games.filter((g) => g.winner === 'p2').length;
  const draws = games.filter((g) => g.reason === 'maxPlies').length;
  const both = games.filter((g) => g.reason === 'bothKings').length;
  const per = (key) => mean(games.map((g) => g.stats[key]));
  const buckets = [];
  for (let lo = 0; lo < maxPlies; lo += 20) {
    const hi = lo + 19;
    buckets.push({ label: `${lo + 1}〜${hi + 1}`, count: games.filter((g) => g.reason !== 'maxPlies' && g.plies >= lo + 1 && g.plies <= hi + 1).length });
  }
  buckets.push({ label: `${maxPlies}（打ち切り）`, count: draws });
  const fill = [];
  for (let k = 0; k <= maxPlies; k += FILL_STEP) {
    const alive = games.filter((g) => g.plies > k || (k === 0));
    const vals = alive.map((g) => g.fill[k]).filter((v) => v !== undefined);
    fill.push({ ply: k, games: vals.length, mean: mean(vals) });
  }
  const decksOut = games.filter((g) => g.decksOutPly !== null).map((g) => g.decksOutPly);
  return {
    n,
    decided: decided.length,
    p1, p2, draws, both,
    p1Rate: p1 / n,
    p1RateDecided: decided.length ? p1 / (p1 + p2) : NaN,
    drawRate: draws / n,
    meanPlies: mean(decidedPlies),
    medianPlies: median(decidedPlies),
    p10: percentile(decidedPlies, 0.1),
    p90: percentile(decidedPlies, 0.9),
    meanPliesAll: mean(games.map((g) => g.plies)),
    buckets,
    fill,
    perGame: {
      battles: per('battles'),
      defections: per('defections'),
      returnsNth: per('returnsNth'),
      returnsTie: per('returnsTie'),
      returnsNoSpace: per('returnsNoSpace'),
      returns: mean(games.map((g) => g.stats.returnsNth + g.stats.returnsTie + g.stats.returnsNoSpace)),
      drafts: per('drafts'),
      places: per('places'),
      moves: per('moves'),
      draws: per('draws'),
      passes: per('passes'),
    },
    kingTieEnds: games.filter((g) => g.kingTie).length,
    decksOutGames: decksOut.length,
    decksOutMeanPly: mean(decksOut),
  };
}

function seedRange(from, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(from + i);
  return out;
}

module.exports = { playMatch, runBatch, summarize, seedRange, cardData, aiData, FILL_STEP };
