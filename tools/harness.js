/**
 * tools/harness.js — 自動対戦の中身（v0.3 モック1・CG-021 ＋ モック2・CG-023 ＋ モック3・CG-024 ＋ モック4・CG-025）
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
 *   - ★ 移動・投げるのたびに、打つ前の結果予測（フィルタ済みの state で previewAction）と実際の解決（reduce）の
 *     盤・決着が一致するかを検査する（CG-023・CG-024。不一致の数を previewMismatch に返す）
 *   - 駒の前進度（CG-024）：advanceOf の定義を見ること
 *   - 連鎖の段（CG-025）：手番の行動（移動・投げる・入れ替え）1回ごとに、能力で動かされた駒の段（イベントの depth）の最大を数える。
 *     0＝能力で動いた駒がない／1＝手の直接の結果として動いた（押し出しで押された・運ばれた・投げられた・入れ替えられた）／
 *     2 以上＝動かされた駒の能力がさらに駒を動かした（反動・爆風・道連れ・押し出しの連鎖など）
 *
 * このファイルは計算するだけで、出力はしない。CLI は tools/simulate.js・compare_v03.js・compare_king.js・compare_mock2.js。
 */

const path = require('node:path');
const E = require('../js/engine.js');
const AI = require('../js/ai.js');

const cardData = require(path.join(__dirname, '..', 'data', 'cards.js'));
const aiData = require(path.join(__dirname, '..', 'data', 'ai.js'));

/** 盤の埋まり具合を記録する手数（0手目＝初期配置の直後） */
const FILL_STEP = 10;

/**
 * 駒の前進度（CG-024）：pid の今の持ち主の駒（キングを除く）のうち、自陣の奥の3列（最奥列から2列前まで）より
 * 前にいる駒の割合。盤上に該当の駒がなければ null（平均に入れない）。
 * ★ 「奥の3列」は配置範囲 0〜2（＝普段の置き場所が届く範囲）と同じ。そこから出た駒＝前に出た駒
 */
const ADVANCE_ROWS = 3;
function advanceOf(s, pid) {
  const home = s.board.homeRow[pid];
  let n = 0;
  let fwd = 0;
  for (let i = 0; i < s.cells.length; i++) {
    const id = s.cells[i];
    if (!id) continue;
    const pc = s.pieces[id];
    if (pc.controller !== pid || pc.kind === s.kingKind) continue;
    n++;
    const y = Math.floor(i / s.board.cols) + 1;
    if (Math.abs(y - home) >= ADVANCE_ROWS) fwd++;
  }
  return n === 0 ? null : fwd / n;
}

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
  // キングとの戦闘でキングが勝った相手（CG-022）。キング id → 駒 id の集合。
  // 「勝った側の強さが減る」設定では、ここに入った駒がそのキングを削った駒になる
  const kingBeat = { 'p1-K': new Set(), 'p2-K': new Set() };
  let kingFall = null;
  // モック2（CG-023）
  let previewChecks = 0;
  let previewMismatch = 0;
  const chainLengths = [];          // 押し出しが発動するたびの、押された駒の数
  let triumphMaxBase = null;        // 凱歌の駒が盤上で到達した最大の基礎の強さ
  let triumphMaxEff = null;         // 同じく実際の強さ
  let kingKillerStrength = null;    // キングを倒した駒の実際の強さ（その戦闘での値）
  // モック3（CG-024）
  const advance = { p1: [], p2: [] };   // advance[pid][ply] = その手の直後の前進度（null＝駒なし）
  // モック4（CG-025）
  const depths = [];                    // 手番の行動（move・throw・swap）ごとの、連鎖の段の最大
  let carryOffered = 0;                 // 運ぶ（改）の選択肢がある移動を CPU が指した回数（CPU は決め打ちの順番の先頭を選ぶ）
  let frontBaseSeen = false;            // 前線基地が成立した時点があったか（どちらかの側）
  let frontBasePly = null;              // 最初に成立した手数
  const recordAdvance = () => {
    for (const pid of E.PLAYERS) advance[pid][s.ply] = advanceOf(s, pid);
    if (!frontBaseSeen && s.rules.frontBase && E.PLAYERS.some((pid) => E.frontBaseSquares(s, pid).length > 0 || frontBasePawn(s, pid))) {
      frontBaseSeen = true;
      frontBasePly = s.ply;
    }
  };
  recordAdvance();
  while (!s.result) {
    const who = E.decider(s);
    const a = AI.decide(s, who, aiData, { kind: kinds[who], salt: seed });
    actions.push(a);
    const pv = a.type === 'move' || a.type === 'throw' || a.type === 'swap' ? E.previewAction(E.filterStateFor(s, who), a) : null;
    if (a.carry !== undefined) carryOffered++;
    s = E.reduce(s, a);
    if (pv) {
      // ★ 200手の打ち切り（引き分け）は移動の解決の後で手数を数えて起きるもので、移動の結果ではない。比べる対象から外す
      const moveResult = s.result && s.result.reason !== 'maxPlies' ? s.result : null;
      previewChecks++;
      if (JSON.stringify(pv.cells) !== JSON.stringify(s.cells) || JSON.stringify(pv.result) !== JSON.stringify(moveResult)) previewMismatch++;
      depths.push(Math.max(0, ...s.lastEvents.map((e) => (typeof e.depth === 'number' ? e.depth : 0))));
    }
    for (const e of s.lastEvents) {
      if (e.type === 'pushChain') chainLengths.push(e.length);
      if (e.type === 'kingFell' && typeof e.byStrength === 'number' && s.result && s.result.reason === 'king') kingKillerStrength = e.byStrength;
    }
    for (const id of s.cells) {
      if (!id || s.defs[s.pieces[id].kind].ability !== 'triumph') continue;
      const base = s.pieces[id].strength;
      const eff = E.effectiveStrength(s, E.pieceSquare(s, id));
      if (triumphMaxBase === null || base > triumphMaxBase) triumphMaxBase = base;
      if (triumphMaxEff === null || eff > triumphMaxEff) triumphMaxEff = eff;
    }
    fill[s.ply] = E.boardCount(s);   // 保留の解決（寝返りの配置）で増えた分は同じ手数に上書きで反映
    recordAdvance();
    if (s.lastEvents.some((e) => e.type === 'kingFell' && e.tie)) kingTie = true;
    if (decksOutPly === null && s.players.p1.deck.length === 0 && s.players.p2.deck.length === 0) decksOutPly = s.ply;
    for (const e of s.lastEvents) {
      if (e.type !== 'battle') continue;
      const kingWon = (e.defenderId in kingBeat && e.outcome === 'lose') || (e.attackerId in kingBeat && e.outcome === 'win');
      if (kingWon) {
        const kingId = e.defenderId in kingBeat ? e.defenderId : e.attackerId;
        kingBeat[kingId].add(kingId === e.defenderId ? e.attackerId : e.defenderId);
      }
    }
    if (s.result && s.result.reason === 'king') {
      // 倒れたキング（相討ちの bothKings は除く）
      const fallen = s.result.winner === 'p1' ? 'p2-K' : 'p1-K';
      kingFall = { kingId: fallen, chippers: kingBeat[fallen].size, strengthAtFall: s.pieces[fallen].strength };
    }
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
    kingFall,
    previewChecks,
    previewMismatch,
    chainLengths,
    triumphMaxBase,
    triumphMaxEff,
    kingKillerStrength,
    advance,
    frontBaseSeen,
    frontBasePly,
    depths,
    carryOffered,
    actions,
  };
}

/** 前線基地が成立しているか：相手側の最奥列に今の持ち主の moveType（ポーン）の駒がいる（周りに空きがなくても成立に数える） */
function frontBasePawn(s, pid) {
  const fb = s.frontBase;
  if (!fb || !s.rules.frontBase) return false;
  const row = s.board.homeRow[E.opponentOf(pid)];
  for (let x = 0; x < s.board.cols; x++) {
    const pc = E.pieceAt(s, E.squareName(s, x, row));
    if (pc && pc.controller === pid && s.defs[pc.kind].move === fb.moveType) return true;
  }
  return false;
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
  const falls = games.filter((g) => g.kingFall).map((g) => g.kingFall);
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
    kingFalls: falls.length,
    chippersMean: mean(falls.map((f) => f.chippers)),
    chippersMax: falls.length ? Math.max(...falls.map((f) => f.chippers)) : NaN,
    chippersDist: [0, 1, 2, 3].map((n) => falls.filter((f) => (n < 3 ? f.chippers === n : f.chippers >= n)).length),
    kingStrengthAtFallMean: mean(falls.map((f) => f.strengthAtFall)),
    // モック2（CG-023）
    fires: Object.fromEntries(Object.keys(games[0].stats.fires || {}).map((k) => [k, mean(games.map((g) => g.stats.fires[k]))])),
    firesTotal: Object.fromEntries(Object.keys(games[0].stats.fires || {}).map((k) => [k, games.reduce((n, g) => n + g.stats.fires[k], 0)])),
    previewChecks: games.reduce((n, g) => n + g.previewChecks, 0),
    previewMismatch: games.reduce((n, g) => n + g.previewMismatch, 0),
    chains: games.reduce((n, g) => n + g.chainLengths.length, 0),
    chainDist: [0, 1, 2, 3].map((k) => games.reduce((n, g) => n + g.chainLengths.filter((l) => (k < 3 ? l === k : l >= k)).length, 0)),
    chainMax: Math.max(0, ...games.map((g) => Math.max(0, ...g.chainLengths))),
    chainBattlesPerGame: per('chainBattles'),
    pushOffBoardPerGame: per('pushOffBoard'),
    pushOffBoardTotal: games.reduce((n, g) => n + g.stats.pushOffBoard, 0),
    triumphGames: games.filter((g) => g.triumphMaxBase !== null).length,
    triumphMaxBaseMean: mean(games.filter((g) => g.triumphMaxBase !== null).map((g) => g.triumphMaxBase)),
    triumphMaxBaseMax: Math.max(-Infinity, ...games.filter((g) => g.triumphMaxBase !== null).map((g) => g.triumphMaxBase)),
    triumphMaxEffMean: mean(games.filter((g) => g.triumphMaxEff !== null).map((g) => g.triumphMaxEff)),
    triumphMaxEffMax: Math.max(-Infinity, ...games.filter((g) => g.triumphMaxEff !== null).map((g) => g.triumphMaxEff)),
    triumphBaseDist: [1, 2, 3, 4].map((k) => games.filter((g) => g.triumphMaxBase !== null && (k < 4 ? g.triumphMaxBase === k : g.triumphMaxBase >= k)).length),
    kingKillerStrengthMean: mean(games.filter((g) => g.kingKillerStrength !== null).map((g) => g.kingKillerStrength)),
    kingKillerGames: games.filter((g) => g.kingKillerStrength !== null).length,
    // モック3（CG-024）
    throwsPerGame: per('throws'),
    throwsTotal: games.reduce((n, g) => n + g.stats.throws, 0),
    throwBattlesTotal: games.reduce((n, g) => n + g.stats.throwBattles, 0),
    throwWinsTotal: games.reduce((n, g) => n + g.stats.throwWins, 0),
    throwTiesTotal: games.reduce((n, g) => n + g.stats.throwTies, 0),
    carriedPerGame: per('carried'),
    carriedTotal: games.reduce((n, g) => n + g.stats.carried, 0),
    carryBlockedTotal: games.reduce((n, g) => n + g.stats.carryBlocked, 0),
    frontBaseGames: games.filter((g) => g.frontBaseSeen).length,
    frontBasePlyMean: mean(games.filter((g) => g.frontBaseSeen).map((g) => g.frontBasePly)),
    frontBasePlacesPerGame: per('frontBasePlaces'),
    frontBasePlacesTotal: games.reduce((n, g) => n + g.stats.frontBasePlaces, 0),
    advance: summarizeAdvance(games, maxPlies),
    // モック4（CG-025）
    depthDist: [0, 1, 2, 3, 4].map((k) => games.reduce((n, g) => n + g.depths.filter((d) => (k < 4 ? d === k : d >= k)).length, 0)),
    depthMax: Math.max(0, ...games.map((g) => Math.max(0, ...g.depths))),
    deepActions: games.reduce((n, g) => n + g.depths.filter((d) => d >= 2).length, 0),
    deepGames: games.filter((g) => g.depths.some((d) => d >= 2)).length,
    actionsCompared: games.reduce((n, g) => n + g.depths.length, 0),
    swapsTotal: games.reduce((n, g) => n + g.stats.swaps, 0),
    draggedTotal: games.reduce((n, g) => n + g.stats.dragged, 0),
    dragBlockedTotal: games.reduce((n, g) => n + g.stats.dragBlocked, 0),
    allyPassesTotal: games.reduce((n, g) => n + g.stats.allyPasses, 0),
    carryOfferedTotal: games.reduce((n, g) => n + g.carryOffered, 0),
  };
}

/**
 * 駒の前進度の集計（CG-024）。
 *   overall … 全試合・全手（両者）の前進度の平均（駒がない手は除く）
 *   byPly   … 10手ごとの、その手数でまだ決着していない試合の平均（両者・先手・後手）
 */
function summarizeAdvance(games, maxPlies) {
  const all = [];
  const p1 = [];
  const p2 = [];
  for (const g of games) {
    for (const pid of ['p1', 'p2']) {
      for (const v of g.advance[pid]) if (v !== null && v !== undefined) { all.push(v); (pid === 'p1' ? p1 : p2).push(v); }
    }
  }
  const byPly = [];
  for (let k = 0; k <= maxPlies; k += FILL_STEP) {
    const vals = [];
    let alive = 0;
    for (const g of games) {
      if (!(g.plies >= k)) continue;
      alive++;
      for (const pid of ['p1', 'p2']) { const v = g.advance[pid][k]; if (v !== null && v !== undefined) vals.push(v); }
    }
    byPly.push({ ply: k, games: alive, mean: mean(vals) });
  }
  return { overall: mean(all), p1: mean(p1), p2: mean(p2), byPly };
}

function seedRange(from, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(from + i);
  return out;
}

module.exports = { playMatch, runBatch, summarize, summarizeAdvance, seedRange, advanceOf, ADVANCE_ROWS, frontBasePawn, cardData, aiData, FILL_STEP };
