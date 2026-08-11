/**
 * tools/harness.js — 自動対戦の中身（CG-001 / CG-005 / CG-006）
 *
 * 【位置づけ】
 *   ★ 自動対戦の結果は人間のプレイとは別物である。
 *     これは「構造的に偏るか」を見るためのものであって、
 *     面白いかどうかの判定には使わない。
 *
 * 【制約】
 *   - engine.js は DOM 非依存・純粋関数のまま。ハーネスはここに閉じる
 *   - view.js は使わない。Node のみ
 *   - 乱数は engine の seeded RNG のみ。Math.random は使わない（AI の選択も含む）
 *   - 同一シード → 同一結果
 *
 * 【AI】
 *   'random' … CG-001 から使っている一様ランダム。基準として残す
 *   'cpu'    … js/ai.js の評価関数ベース CPU（CG-006）
 *   ★ random 側の乱数の消費順は CG-001 / CG-005 から変えていない。
 *     同じシード帯を回せば当時と同じ数値が再現する。
 *
 * このファイルは計算するだけで、実行も出力もしない。
 * CLI は tools/simulate.js、比較レポートは tools/compare.js。
 */

import {
  createInitialState,
  reduce,
  legalActions,
  canSummon,
  createRng,
  nextRandom,
  boardSize,
  defOf,
  graveyardCostTotal,
  graveyardSummonTax,
  summonSourceOwner,
  PLAYERS,
} from '../js/engine.js';

import { chooseCpuAction } from '../js/ai.js';

export const TURN_CAP = 300;

// ---------------------------------------------------------------------------
// seeded な選択の小道具
// ---------------------------------------------------------------------------

function pick(arr, rng) {
  const d = nextRandom(rng);
  return { value: arr[Math.floor(d.value * arr.length)], rng: d.rng };
}

function shuffled(arr, rng) {
  const out = arr.slice();
  let r = rng;
  for (let i = out.length - 1; i > 0; i--) {
    const d = nextRandom(r);
    r = d.rng;
    const j = Math.floor(d.value * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return { items: out, rng: r };
}

// ---------------------------------------------------------------------------
// ランダムAI（CG-001）
// ---------------------------------------------------------------------------

/**
 * ランダムな召喚 action を1つ提案する。作れなければ null。
 * ピッチ枚数と、出すカード・枠をすべて乱択する。
 */
function proposeSummon(state, pid, rng) {
  const me = state.players[pid];
  if (me.hand.length < 2) return { action: null, rng };

  const empties = [];
  for (let s = 0; s < boardSize(state.rules); s++) if (!me.board[s]) empties.push(s);
  if (empties.length === 0) return { action: null, rng };

  // ピッチ枚数: 1〜min(3, 手札-1)
  const maxPitch = Math.min(3, me.hand.length - 1);
  const d = nextRandom(rng);
  let r = d.rng;
  const k = 1 + Math.floor(d.value * maxPitch);

  const sh = shuffled(me.hand, r);
  r = sh.rng;
  const pitch = sh.items.slice(0, k);
  const pitchSet = new Set(pitch);

  // 召喚元: 手札（ピッチ分を除く）＋ 召喚元の墓地
  const srcGrave = state.players[summonSourceOwner(state, pid)].graveyard;
  const cands = [
    ...me.hand.filter((i) => !pitchSet.has(i)).map((iid) => ({ iid, from: 'hand' })),
    ...srcGrave.map((iid) => ({ iid, from: 'graveyard' })),
  ];
  const shc = shuffled(cands, r);
  r = shc.rng;
  const she = shuffled(empties, r);
  r = she.rng;

  const plays = [];
  let slotIdx = 0;
  for (const c of shc.items) {
    if (slotIdx >= she.items.length) break;
    const trial = [...plays, { ...c, slot: she.items[slotIdx] }];
    if (canSummon(state, pid, pitch, trial).ok) {
      plays.push(trial[trial.length - 1]);
      slotIdx++;
    }
  }
  if (plays.length === 0) return { action: null, rng: r };
  return { action: { type: 'summon', pitch, plays }, rng: r };
}

/** 合法手の中から一様ランダムに1つ選ぶ */
function randomChoose(state, pid, rng) {
  const acts = legalActions(state, pid);
  const prop = proposeSummon(state, pid, rng);
  let r = prop.rng;
  if (prop.action) acts.push(prop.action);
  const p = pick(acts, r);
  return { action: p.value, rng: p.rng };
}

// ---------------------------------------------------------------------------
// AI の一覧
//
// choose(state, pid, rng, ctx) => { action, rng }
// ★ rng を返すのはランダムAIの都合。CPU は乱数を使わないのでそのまま返す。
// ---------------------------------------------------------------------------

export const AGENTS = {
  random: {
    key: 'random',
    label: 'ランダムAI',
    note: '合法手から一様ランダムに選択。召喚はピッチ枚数・出すカード・枠をすべて乱択',
    choose: randomChoose,
  },
  cpu: {
    key: 'cpu',
    label: '評価関数CPU',
    note: 'js/ai.js。filterStateFor 済みの state だけを見て1手先を評価する貪欲法',
    choose: (state, pid, rng, ctx) => ({ action: chooseCpuAction(state, pid, ctx.aiData), rng }),
  },
};

// ---------------------------------------------------------------------------
// 能力の発動回数を state の差分から数える（CG-005）
//
// engine にカウンタを持たせると純粋関数でなくなるので、ハーネス側で差分を見る。
// ---------------------------------------------------------------------------

function abilityEffect(state, iid) {
  const inst = state.cards[iid];
  if (!inst) return null;
  return state.defs[inst.cardId]?.ability?.effect || null;
}

/** 召喚で発動する能力: c06（トークン生成）と c08（呪いの追加支払い） */
function countSummonAbilities(before, next, pid, action, stat) {
  const created = Object.keys(next.cards).filter((iid) => !before.cards[iid]);
  stat.ability.token += created.length;
  const spawners = action.plays.filter(
    (p) => abilityEffect(before, p.iid) === 'spawnTokenRight'
  ).length;
  stat.ability.tokenBlocked += Math.max(0, spawners - created.length);

  if (action.plays.some((p) => p.from === 'graveyard')) {
    const tax = graveyardSummonTax(before, pid);
    if (tax > 0) {
      stat.ability.curse++;
      stat.ability.curseTax += tax;
    }
  }
}

/** 戦闘で発動する能力: c05（後列へ退く）と c07（デッキ上を墓地へ） */
function countCombatAbilities(before, next, stat) {
  for (const iid of Object.keys(next.cards)) {
    const b = before.cards[iid];
    if (b && !b.transformed && next.cards[iid].transformed) stat.ability.retreat++;
  }

  // 場から墓地へ落ちたカードのうち、退避できなかった c05 を数える。
  // c07 で「デッキから」墓地へ送られたカードを拾わないよう、場に居たものだけを見る。
  const onBoard = new Set(
    [...before.players.p1.board, ...before.players.p2.board].filter(Boolean)
  );
  for (const owner of PLAYERS) {
    const had = new Set(before.players[owner].graveyard);
    for (const iid of next.players[owner].graveyard) {
      if (had.has(iid) || !onBoard.has(iid)) continue;
      if (abilityEffect(before, iid) === 'retreatToBackRow' && !before.cards[iid].transformed) {
        stat.ability.retreatFailed++;
      }
    }
  }

  for (const owner of PLAYERS) {
    const d = before.players[owner].deck.length - next.players[owner].deck.length;
    if (d > 0) stat.ability.mill += d;
  }
}

/**
 * 「里帰り」を数える（CG-006 で発見）。
 * 自分の持ち札が自分の墓地に入った回数。相手に渡ったカードが相手の場で倒されると、
 * 倒した側＝元の持ち主の墓地へ戻ってくる。
 */
function countHomecoming(before, next, stat) {
  for (const pid of PLAYERS) {
    const had = new Set(before.players[pid].graveyard);
    for (const iid of next.players[pid].graveyard) {
      if (had.has(iid)) continue;
      if (next.cards[iid].owner !== pid) continue;
      stat.homecoming++;
      if (next.cards[iid].token) stat.homecomingToken++;
    }
  }
}

// ---------------------------------------------------------------------------
// 1試合
// ---------------------------------------------------------------------------

export function playGame(seed, agent, ctx) {
  const { cardData } = ctx;
  let state = createInitialState(seed, cardData);
  let rng = createRng(seed ^ 0x5f3759df);

  const stat = {
    seed,
    winner: null,
    turns: 0,
    steps: 0,
    decided: false,
    steals: 0,                 // 撃破して自分の墓地に入れた回数
    summonCosts: [],           // 召喚されたカードのコスト
    summonFrom: { hand: 0, graveyard: 0 },
    freeSummons: 0,            // ピッチ0枚（＝実質ノーコスト）で成立した召喚
    tokenSummons: 0,           // 召喚されたカードがトークンだった回数
    tokenRevives: 0,           // うち墓地から出し直したもの（★ 未対応として残っている件）
    homecoming: 0,             // 自分の持ち札が自分の墓地に入った回数
    homecomingToken: 0,        // うちトークン
    perTurn: [],               // {turn, gcost:{p1,p2}, fill:{p1,p2}}
    // 能力の発動回数（CG-005）。engine にカウンタを持たせず、state の差分で数える
    ability: {
      retreat: 0,              // c05 が後列へ退いた
      retreatFailed: 0,        // c05 が後列に空きがなく不発
      token: 0,                // c06 がトークンを出した
      tokenBlocked: 0,         // c06 が右端／右埋まりで不発
      mill: 0,                 // c07 が相手のデッキ上を自分の墓地へ送った
      curse: 0,                // c08 が発動した（支払いが増えた回数）
      curseTax: 0,             // c08 で増えた支払いポイントの合計
    },
  };

  // ターン開始時点のサンプルを取る
  const sample = (s) => {
    stat.perTurn.push({
      turn: s.turn,
      gcost: { p1: graveyardCostTotal(s, 'p1'), p2: graveyardCostTotal(s, 'p2') },
      fill: {
        p1: s.players.p1.board.filter(Boolean).length,
        p2: s.players.p2.board.filter(Boolean).length,
      },
    });
  };
  sample(state);

  let guard = 0;
  while (!state.winner && state.turn <= TURN_CAP && guard++ < TURN_CAP * 40) {
    const pid = state.active;
    const before = state;
    const ch = agent.choose(state, pid, rng, ctx);
    rng = ch.rng;
    const action = ch.action;

    let next;
    try {
      next = reduce(state, action);
    } catch {
      // 合法手のはずなので通常は来ない。来たらターンを畳んで進める
      next = reduce(state, { type: 'endTurn' });
    }
    stat.steps++;

    // --- 統計の採取 ---
    if (action.type === 'attack') {
      // 自分の墓地に増えた分＝自分が倒して奪ったカード
      stat.steals += next.players[pid].graveyard.length - before.players[pid].graveyard.length;
    }
    if (action.type === 'summon') {
      if ((action.pitch || []).length === 0) stat.freeSummons++;
      for (const p of action.plays) {
        const def = defOf(before, p.iid);
        stat.summonCosts.push(def.cost);
        stat.summonFrom[p.from]++;
        if (def.token) {
          stat.tokenSummons++;
          if (p.from === 'graveyard') stat.tokenRevives++;
        }
      }
      countSummonAbilities(before, next, pid, action, stat);
    }
    if (action.type === 'attack') countCombatAbilities(before, next, stat);
    countHomecoming(before, next, stat);
    if (action.type === 'endTurn' && next.turn !== before.turn && !next.winner) {
      sample(next);
    }

    state = next;
  }

  stat.winner = state.winner;
  stat.turns = state.turn;
  stat.decided = state.winner !== null;
  return stat;
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(n, d) {
  return d ? (n / d) * 100 : 0;
}

/**
 * 自動対戦をまとめて回し、集計を返す。
 * @param {object} opts { games, baseSeed, ai, cardData, aiData }
 */
export function runSimulation(opts) {
  const { games: GAMES, baseSeed: BASE_SEED, cardData } = opts;
  const agent = AGENTS[opts.ai];
  if (!agent) throw new Error(`未知の AI: ${opts.ai}（${Object.keys(AGENTS).join(' / ')}）`);
  const ctx = { cardData, aiData: opts.aiData };

  const games = [];
  for (let i = 0; i < GAMES; i++) games.push(playGame(BASE_SEED + i, agent, ctx));

  const decided = games.filter((g) => g.decided);
  const firstId = 'p1'; // createInitialState の既定で p1 が先攻
  const firstWins = decided.filter((g) => g.winner === firstId).length;

  const turnsList = decided.map((g) => g.turns);
  const stealsList = games.map((g) => g.steals);

  // コスト分布
  const costCounts = {};
  let totalSummons = 0;
  for (const g of games) {
    for (const c of g.summonCosts) {
      costCounts[c] = (costCounts[c] || 0) + 1;
      totalSummons++;
    }
  }
  // デッキ内のコスト構成（比較用の母数）
  const deckCostCounts = {};
  let deckTotal = 0;
  for (const e of cardData.deck.lists.default) {
    const def = cardData.cards.find((c) => c.id === e.cardId);
    deckCostCounts[def.cost] = (deckCostCounts[def.cost] || 0) + e.copies;
    deckTotal += e.copies;
  }

  const fromHand = games.reduce((a, g) => a + g.summonFrom.hand, 0);
  const fromGrave = games.reduce((a, g) => a + g.summonFrom.graveyard, 0);

  // ターンごとの平均（そのターンに到達した試合だけで平均）
  const byTurn = new Map();
  for (const g of games) {
    for (const s of g.perTurn) {
      if (!byTurn.has(s.turn)) byTurn.set(s.turn, { n: 0, g1: 0, g2: 0, f1: 0, f2: 0 });
      const b = byTurn.get(s.turn);
      b.n++;
      b.g1 += s.gcost.p1;
      b.g2 += s.gcost.p2;
      b.f1 += s.fill.p1;
      b.f2 += s.fill.p2;
    }
  }

  // 決着ターンのヒストグラム（5ターン刻み）
  const hist = {};
  for (const t of turnsList) {
    const bucket = Math.floor((t - 1) / 5) * 5 + 1;
    hist[bucket] = (hist[bucket] || 0) + 1;
  }

  // 盤面埋まり率の全体平均
  let fillSum = 0, fillN = 0;
  for (const g of games) {
    for (const s of g.perTurn) {
      fillSum += s.fill.p1 + s.fill.p2;
      fillN += 2;
    }
  }

  // 能力の発動回数（全試合の合計）
  const ability = { retreat: 0, retreatFailed: 0, token: 0, tokenBlocked: 0, mill: 0, curse: 0, curseTax: 0 };
  for (const g of games) for (const k of Object.keys(ability)) ability[k] += g.ability[k];

  const sum = (f) => games.reduce((a, g) => a + f(g), 0);

  return {
    ai: agent.key,
    aiLabel: agent.label,
    aiNote: agent.note,
    perGame: games,
    ability,
    games: GAMES,
    baseSeed: BASE_SEED,
    seedRange: `${BASE_SEED}〜${BASE_SEED + GAMES - 1}`,
    turnCap: TURN_CAP,
    decided: decided.length,
    undecided: GAMES - decided.length,
    firstWinRate: pct(firstWins, decided.length),
    firstWins,
    secondWins: decided.length - firstWins,
    turnsMean: mean(turnsList),
    turnsMedian: median(turnsList),
    turnsMin: turnsList.length ? Math.min(...turnsList) : 0,
    turnsMax: turnsList.length ? Math.max(...turnsList) : 0,
    // 最短・最長の試合のシード（外れ値をそのまま再現できるように残す）
    turnsMinSeed: decided.reduce((a, g) => (a === null || g.turns < a.turns ? g : a), null)?.seed ?? null,
    turnsMaxSeed: decided.reduce((a, g) => (a === null || g.turns > a.turns ? g : a), null)?.seed ?? null,
    hist,
    stealsMean: mean(stealsList),
    stealsMedian: median(stealsList),
    stealsMax: stealsList.length ? Math.max(...stealsList) : 0,
    costCounts,
    totalSummons,
    deckCostCounts,
    deckTotal,
    fromHand,
    fromGrave,
    graveSummonRate: pct(fromGrave, fromHand + fromGrave),
    byTurn,
    fillMean: fillN ? fillSum / fillN : 0,
    boardSlots: boardSize({ board: cardData.rules.board }),
    // CG-006 で足した観測
    freeSummons: sum((g) => g.freeSummons),
    tokenSummons: sum((g) => g.tokenSummons),
    tokenRevives: sum((g) => g.tokenRevives),
    homecoming: sum((g) => g.homecoming),
    homecomingToken: sum((g) => g.homecomingToken),
    steps: sum((g) => g.steps),
  };
}
