/**
 * tools/analyze_logs.js — 対戦ログ（necro-match-log）をまとめて読み、傾向を出す（CG-013）
 *
 * 【入力】
 *   index.html のデバッグパネルが書き出す JSON（コピー or 保存）。
 *   ログには設定値・シード・action 列・結果だけが入っている。統計は持っていない。
 *   engine は決定的（同一シード + 同一 action 列 → 同一結果）なので、
 *   このツールが同じ engine で再生して数える。
 *
 * 【使い方】
 *   node tools/analyze_logs.js <ログ.json | ディレクトリ> [...]
 *   ANALYZE_OUT="解析_YYYYMMDD.md" ANALYZE_STAMP="2026-08-12 12:00 JST" ANALYZE_HEAD="abcdef0" \
 *     node tools/analyze_logs.js logs/
 *
 *   ANALYZE_OUT を指定すると docs/research/ 配下へ Markdown を書き出す。
 *   指定しなければ標準出力へ出す。
 *
 * 【集計の単位】
 *   設定値（settings）が同じログをひとつのグループにまとめ、グループごとに表を出す。
 *   墓地バッファ 0/2 のように条件を切り替えて遊んだログを、並べて比べるための形。
 *
 * 【操作的定義】★ 指示の言葉をどう数えたかは、出力の「定義」節にも同じ内容を書く。
 *   - ピッチ専用: ピッチされた後、その試合中に一度も召喚され直さなかったカード
 *   - 欲しいカードが無い: 手番開始時、召喚元の墓地が「空」「全部準備中（バッファ）」
 *     「準備済みの最大コストが LOW_COST_MAX 以下」のいずれか
 *   - 呪いが召喚判断を変えた: 直接は観測できないので、3つの観測可能な近似で数える
 *     （税を払って召喚した／税のせいで届かなくなった／払えるのに見送った）
 *   - 攻撃寄り/体力寄り: 刷られた数値で attack > health / health > attack（同値は中立）
 *   - 手を替えた（CG-014）: カードの所在ゾーン（デッキ/手札/場/墓地）の持ち主が
 *     変わった回数。iid 単位。トークン・ネクロマンサーは除く
 *   - 再召喚までの手番差（CG-014）: ピッチされた手番から、そのカードが墓地から
 *     召喚され直した手番までの差（1ターン＝片方の手番）
 *
 * 【制約】
 *   - engine.js は触らない。view.js にも依存しない（Node 単体）
 *   - ★ 観測値だけを書く。解釈・結論は書かない
 */

const { readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const {
  createInitialState,
  reduce,
  defOf,
  graveyardSummonTax,
  graveyardReady,
  summonSourceOwner,
  PLAYERS,
} = require('../js/engine.js');

const here = __dirname;
const cardDataBase = require(path.join(here, '..', 'data', 'cards.js'));

/**
 * 「欲しいカードが無い」判定の閾値。準備済みカードの最大コストがこの値以下なら
 * 「低コストしか無い」として数える。ゲームのルールではなく解析側の観測窓。
 */
const LOW_COST_MAX = 1;

// ---------------------------------------------------------------------------
// 入力の読み込み
// ---------------------------------------------------------------------------

function collectFiles(args) {
  const files = [];
  for (const a of args) {
    let st;
    try {
      st = statSync(a);
    } catch {
      console.error(`★ 見つからない: ${a}`);
      continue;
    }
    if (st.isDirectory()) {
      for (const f of readdirSync(a).sort()) {
        if (f.endsWith('.json')) files.push(path.join(a, f));
      }
    } else {
      files.push(a);
    }
  }
  return files;
}

function loadLogs(files, warnings) {
  const logs = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      warnings.push(`${file}: JSON として読めない（${e.message}）`);
      continue;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const log of list) {
      if (!log || log.format !== 'necro-match-log') {
        warnings.push(`${file}: 対戦ログ（format: necro-match-log）ではないので飛ばした`);
        continue;
      }
      logs.push({ ...log, _file: path.basename(file) });
    }
  }
  return logs;
}

// ---------------------------------------------------------------------------
// 設定値の適用（view.js のデバッグパネルと同じ意味の上書き）
// ---------------------------------------------------------------------------

function applySettings(data, s) {
  if (s.graveyardSummonBuffer !== undefined) data.rules.graveyardSummonBuffer = s.graveyardSummonBuffer;
  if (s.drawPerTurn !== undefined) data.rules.drawPerTurn = s.drawPerTurn;
  if (s.openingHandSecond !== undefined) {
    data.rules.openingHand = { ...data.rules.openingHand, second: s.openingHandSecond };
  }
  if (s.tokenOnDeath !== undefined) {
    data.tokens.list = data.tokens.list.map((t) => ({ ...t, onDeath: s.tokenOnDeath }));
  }
  // CG-015。これを適用しないと、持ち越しありのログが再生時に不正な召喚として弾かれる
  if (s.pitchCarryover !== undefined) data.rules.pitchCarryover = s.pitchCarryover;
  return data;
}

function settingsKey(s) {
  const entries = Object.entries(s || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}

function settingsLabel(s) {
  const t = s || {};
  const death = { vanish: '消滅', toGraveyard: '墓地へ' }[t.tokenOnDeath] || t.tokenOnDeath;
  const carry = t.pitchCarryover === undefined ? '?' : t.pitchCarryover ? 'あり' : 'なし';
  return (
    `墓地バッファ ${t.graveyardSummonBuffer ?? '?'}／ドロー ${t.drawPerTurn ?? '?'}／` +
    `後攻初手 ${t.openingHandSecond ?? '?'}／トークン ${death ?? '?'}／持ち越し ${carry}`
  );
}

// ---------------------------------------------------------------------------
// 1試合の再生と観測
// ---------------------------------------------------------------------------

function analyzeGame(log, warnings) {
  const data = applySettings(JSON.parse(JSON.stringify(cardDataBase)), log.settings || {});
  const g = {
    file: log._file,
    seed: log.seed,
    matchup: log.matchup || '?',
    settings: log.settings || {},
    replayOk: true,
    replayNote: '',
    winner: null,
    turns: 0,
    decided: false,
    ev: [],            // 手札を離れた/召喚された イベント {i, turn, type, iid, from, cost}
    graveSamples: [],  // 手番開始時の召喚元墓地 {turn, cat}
    curse: { faced: 0, paidTurns: 0, avoided: 0, blocked: 0, paidSummons: 0, taxTotal: 0 },
    survival: [],      // 召喚されたカードの在場記録 {hp, atk, cost, turns, censored}
    taken: [],         // 倒れて相手の墓地へ行ったカード {hp, atk, cost}
    ownerChanges: new Map(),   // iid → 所有者（所在ゾーンの持ち主）が変わった回数（CG-014）
    pitchGaps: [],     // ピッチ → 墓地から召喚され直すまでの手番差 {delta, pitchTurn}（CG-014）
    pitchNever: 0,     // ピッチ後、一度も召喚され直さなかった件数（＝ピッチ専用と同値）
  };

  let s;
  try {
    s = createInitialState(log.seed, data);
  } catch (e) {
    warnings.push(`${g.file}（シード ${g.seed}）: 初期化できない（${e.message}）`);
    return null;
  }

  let cur = null;   // いま進行中の手番の呪い観測

  const beginTurn = (st) => {
    const pid = st.active;
    const grave = st.players[summonSourceOwner(st, pid)].graveyard;
    const ready = grave.filter((iid) => graveyardReady(st, iid));
    const readyCosts = ready.map((iid) => defOf(st, iid).cost);
    let cat;
    if (grave.length === 0) cat = 'empty';
    else if (ready.length === 0) cat = 'napping';
    else if (Math.max(...readyCosts) <= LOW_COST_MAX) cat = 'lowOnly';
    else cat = 'good';
    g.graveSamples.push({ turn: st.turn, cat });

    const tax = graveyardSummonTax(st, pid);
    cur = { faced: false, blocked: false, affordable: false, usedGrave: false };
    const hasEmpty = st.players[pid].board.some((x) => !x);
    if (tax > 0 && ready.length > 0 && hasEmpty) {
      cur.faced = true;
      const handTotal = st.players[pid].hand.reduce((a, iid) => a + defOf(st, iid).cost, 0);
      for (const c of readyCosts) {
        if (handTotal >= c + tax) cur.affordable = true;
        else if (handTotal >= c) cur.blocked = true;
      }
    }
  };

  const endTurnFinalize = () => {
    if (!cur) return;
    if (cur.faced) {
      g.curse.faced++;
      if (cur.usedGrave) g.curse.paidTurns++;
      else if (cur.affordable) g.curse.avoided++;
      else if (cur.blocked) g.curse.blocked++;
    }
    cur = null;
  };

  /** 場に居るカードの在場開始記録。iid → {turn, hp, atk, cost} */
  const alive = new Map();

  const closeSurvival = (iid, leaveTurn, censored) => {
    const a = alive.get(iid);
    if (!a) return;
    alive.delete(iid);
    g.survival.push({ hp: a.hp, atk: a.atk, cost: a.cost, turns: leaveTurn - a.turn, censored });
  };

  // 所有者の追跡（CG-014）。所有者＝そのカードがどちらのゾーン（デッキ/手札/場/墓地）に
  // あるか。初期 state に居るカード（＝デッキ由来）だけを見る。トークンは対局中に生まれ、
  // onDeath='vanish' では墓地に入らず消えるので対象外。ネクロマンサーはゾーンに居ないので入らない。
  const ownerOf = new Map();
  for (const pid of PLAYERS) {
    const P = s.players[pid];
    for (const iid of [...P.deck, ...P.hand, ...P.graveyard, ...P.board.filter(Boolean)]) {
      ownerOf.set(iid, pid);
      g.ownerChanges.set(iid, 0);
    }
  }
  const trackOwners = (st) => {
    for (const pid of PLAYERS) {
      const P = st.players[pid];
      for (const zone of [P.deck, P.hand, P.graveyard, P.board]) {
        for (const iid of zone) {
          if (!iid || !ownerOf.has(iid)) continue;
          if (ownerOf.get(iid) !== pid) {
            ownerOf.set(iid, pid);
            g.ownerChanges.set(iid, g.ownerChanges.get(iid) + 1);
          }
        }
      }
    }
  };

  let i = 0;
  beginTurn(s);
  for (const rec of log.actions || []) {
    const action = rec && rec.action ? rec.action : rec;   // {turn,pid,action} でも素の action 列でもよい
    const before = s;
    try {
      s = reduce(s, action);
    } catch (e) {
      g.replayOk = false;
      g.replayNote = `action ${i}（${action && action.type}）で再生失敗: ${e.message}`;
      warnings.push(`${g.file}（シード ${g.seed}）: ${g.replayNote}`);
      break;
    }

    if (action.type === 'summon') {
      for (const iid of action.pitch || []) {
        g.ev.push({ i, turn: before.turn, type: 'pitch', iid, cost: defOf(before, iid).cost });
      }
      for (const p of action.plays || []) {
        const def = defOf(before, p.iid);
        g.ev.push({ i, turn: before.turn, type: 'play', from: p.from, iid: p.iid, cost: def.cost });
        if (!def.token) {
          alive.set(p.iid, { turn: before.turn, hp: def.health, atk: def.attack, cost: def.cost });
        }
      }
      if ((action.plays || []).some((p) => p.from === 'graveyard')) {
        if (cur) cur.usedGrave = true;
        const tax = graveyardSummonTax(before, before.active);
        if (tax > 0) {
          g.curse.paidSummons++;
          g.curse.taxTotal += tax;
        }
      }
    }

    if (action.type === 'reposition') {
      // 配置換えに支払いがあるルール（repositionCost > 0）でもピッチとして数える
      for (const iid of action.pitch || []) {
        g.ev.push({ i, turn: before.turn, type: 'pitch', iid, cost: defOf(before, iid).cost });
      }
    }

    if (action.type === 'attack') {
      // 場から離れたカードを数える。墓地へ行った＝相手に渡った、実体が消えた＝消滅
      const onBoard = new Set(
        [...before.players.p1.board, ...before.players.p2.board].filter(Boolean)
      );
      for (const owner of PLAYERS) {
        const had = new Set(before.players[owner].graveyard);
        for (const iid of s.players[owner].graveyard) {
          if (had.has(iid) || !onBoard.has(iid)) continue;   // c07 のデッキ送りは拾わない
          const def = defOf(before, iid);
          g.taken.push({ hp: def.health, atk: def.attack, cost: def.cost });
          closeSurvival(iid, before.turn, false);
        }
      }
      for (const iid of onBoard) {
        if (!s.cards[iid]) closeSurvival(iid, before.turn, false);   // 消滅（トークン等）
      }
    }

    if (action.type === 'endTurn') {
      endTurnFinalize();
      if (!s.winner && s.turn !== before.turn) beginTurn(s);
    }
    trackOwners(s);
    i++;
  }
  endTurnFinalize();

  // 試合終了時点で場に残っていたカード（打ち切り扱いで生存に数える）
  for (const iid of [...alive.keys()]) closeSurvival(iid, s.turn, true);

  g.winner = s.winner;
  g.turns = s.turn;
  g.decided = s.winner !== null;

  // 記録された結果と突き合わせる（食い違うログはルール版がずれている可能性がある）
  const rec = log.result || {};
  if ((rec.winner ?? null) !== (s.winner ?? null) || (rec.decided && rec.turns !== s.turn)) {
    g.replayOk = false;
    g.replayNote = g.replayNote ||
      `記録（勝者 ${rec.winner ?? 'なし'}・ターン ${rec.turns ?? '?'}）と再生（勝者 ${s.winner ?? 'なし'}・ターン ${s.turn}）が一致しない`;
    warnings.push(`${g.file}（シード ${g.seed}）: ${g.replayNote}`);
  }

  // ピッチ専用（そのピッチの後、同じカードが一度も召喚され直していない）
  const playIdx = new Map();
  for (const e of g.ev) {
    if (e.type !== 'play') continue;
    if (!playIdx.has(e.iid)) playIdx.set(e.iid, []);
    playIdx.get(e.iid).push(e.i);
  }
  for (const e of g.ev) {
    if (e.type === 'pitch') e.deadEnd = !(playIdx.get(e.iid) || []).some((j) => j > e.i);
  }

  // ピッチ → 墓地から召喚され直すまでの手番差（CG-014）。ピッチされたカードは相手の墓地へ
  // 入るので、召喚し直すのは常に相手。差＝召喚の手番 − ピッチの手番（1ターン＝片方の手番）。
  const playEvents = new Map();
  for (const e of g.ev) {
    if (e.type !== 'play') continue;
    if (!playEvents.has(e.iid)) playEvents.set(e.iid, []);
    playEvents.get(e.iid).push(e);
  }
  for (const e of g.ev) {
    if (e.type !== 'pitch') continue;
    const later = (playEvents.get(e.iid) || []).find((p) => p.i > e.i);
    if (later) g.pitchGaps.push({ delta: later.turn - e.turn, pitchTurn: e.turn });
    else g.pitchNever++;
  }

  return g;
}

// ---------------------------------------------------------------------------
// グループ集計
// ---------------------------------------------------------------------------

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
const pct = (n, d) => (d ? (n / d) * 100 : 0);
const f1 = (x) => x.toFixed(1);
const f2 = (x) => x.toFixed(2);

/** デッキ構成（コスト・攻撃力・体力・型の母数）。データ側から引く */
function deckComposition(data) {
  const byCost = {};
  const byAtk = {};
  const byHp = {};
  const byShape = { atk: 0, hp: 0, even: 0 };
  const byCard = {};
  let total = 0;
  for (const e of data.deck.lists.default) {
    const def = data.cards.find((c) => c.id === e.cardId);
    byCost[def.cost] = (byCost[def.cost] || 0) + e.copies;
    byAtk[def.attack] = (byAtk[def.attack] || 0) + e.copies;
    byHp[def.health] = (byHp[def.health] || 0) + e.copies;
    byShape[shapeOf(def)] += e.copies;
    byCard[def.id] = { def, copies: e.copies };
    total += e.copies;
  }
  return { byCost, byAtk, byHp, byShape, byCard, total };
}

/** 攻撃寄り / 体力寄り / 中立（刷られた数値で判定） */
function shapeOf(def) {
  if (def.attack > def.health) return 'atk';
  if (def.health > def.attack) return 'hp';
  return 'even';
}
const SHAPE_LABEL = { atk: '攻撃寄り（攻>体）', hp: '体力寄り（体>攻）', even: '中立（攻=体）' };

function aggregateGroup(games, data) {
  const deck = deckComposition(data);

  const agg = {
    games,
    deck,
    byTurn: new Map(),          // turn → {pitch, playHand, playGrave, deadEnd}
    byCost: new Map(),          // cost → {playHand, playGrave, pitch}
    grave: { samples: 0, empty: 0, napping: 0, lowOnly: 0, good: 0 },
    curse: { faced: 0, paidTurns: 0, avoided: 0, blocked: 0, paidSummons: 0, taxTotal: 0 },
    // 攻撃力/体力の偏り（追加指示）
    summonByAtk: new Map(),     // attack 値 → 召喚回数（トークン除く）
    summonByHp: new Map(),      // health 値 → 召喚回数（同上）
    summonByShape: { atk: 0, hp: 0, even: 0 },
    summonByCard: new Map(),    // cardId → 召喚回数（同上）
    summonTotal: 0,             // トークンを除いた召喚回数
    survivalByHp: new Map(),    // health 値 → {n, turnsSum, censored}
    takenByAtk: new Map(),      // attack 値 → 相手の墓地へ行った回数
    takenByHp: new Map(),
    takenByShape: { atk: 0, hp: 0, even: 0 },
    takenTotal: 0,
    // CG-014 追加分
    earlyPitchByGame: [],       // 試合ごとの {file, seed, t1, t2}（ターン1〜2のピッチ枚数）
    ownerChangeDist: new Map(), // 変わった回数 → 枚数（iid 単位・全試合の合算）
    ownerChangeCards: 0,        // 追跡対象カード数（試合×デッキ由来カード）
    transferTotal: 0,           // 所有者変更ののべ回数
    pitchGapDist: new Map(),    // 手番差 → 件数
    pitchNever: 0,              // 召喚され直さなかったピッチ件数
  };

  const bump = (map, key, field, n = 1) => {
    if (!map.has(key)) map.set(key, {});
    const o = map.get(key);
    o[field] = (o[field] || 0) + n;
  };

  for (const game of games) {
    for (const e of game.ev) {
      if (e.type === 'pitch') {
        bump(agg.byTurn, e.turn, 'pitch');
        if (e.deadEnd) bump(agg.byTurn, e.turn, 'deadEnd');
        bump(agg.byCost, e.cost, 'pitch');
      } else {
        bump(agg.byTurn, e.turn, e.from === 'hand' ? 'playHand' : 'playGrave');
        bump(agg.byCost, e.cost, e.from === 'hand' ? 'playHand' : 'playGrave');
      }
    }
    for (const sm of game.graveSamples) {
      agg.grave.samples++;
      agg.grave[sm.cat]++;
    }
    for (const k of Object.keys(agg.curse)) agg.curse[k] += game.curse[k];

    for (const sv of game.survival) {
      // 召喚の分布（在場記録＝トークンを除いた全召喚と1:1）
      agg.summonTotal++;
      bump(agg.summonByAtk, sv.atk, 'n');
      bump(agg.summonByHp, sv.hp, 'n');
      agg.summonByShape[shapeOfStats(sv)]++;
      if (!agg.survivalByHp.has(sv.hp)) agg.survivalByHp.set(sv.hp, { n: 0, turnsSum: 0, censored: 0 });
      const o = agg.survivalByHp.get(sv.hp);
      o.n++;
      o.turnsSum += sv.turns;
      if (sv.censored) o.censored++;
    }
    for (const tk of game.taken) {
      agg.takenTotal++;
      bump(agg.takenByAtk, tk.atk, 'n');
      bump(agg.takenByHp, tk.hp, 'n');
      agg.takenByShape[shapeOfStats(tk)]++;
    }

    // CG-014 追加分
    const early = { file: game.file, seed: game.seed, t1: 0, t2: 0 };
    for (const e of game.ev) {
      if (e.type !== 'pitch') continue;
      if (e.turn === 1) early.t1++;
      else if (e.turn === 2) early.t2++;
    }
    agg.earlyPitchByGame.push(early);

    for (const n of game.ownerChanges.values()) {
      agg.ownerChangeCards++;
      agg.transferTotal += n;
      bump(agg.ownerChangeDist, n, 'n');
    }

    for (const gp of game.pitchGaps) bump(agg.pitchGapDist, gp.delta, 'n');
    agg.pitchNever += game.pitchNever;
  }
  return agg;
}

function shapeOfStats(x) {
  if (x.atk > x.hp) return 'atk';
  if (x.hp > x.atk) return 'hp';
  return 'even';
}

// ---------------------------------------------------------------------------
// カード別の召喚回数（同コスト帯の比較用）
// ev には iid しか無く cardId が要るので、シードから初期 state を作り直して引く。
// iid の採番は決定的なので、初期 state だけで手札・デッキ由来の全カードが引ける。
// トークン（対局中に生成された iid）は初期 state に無い → 除外される。
// ---------------------------------------------------------------------------

function summonCountsByCard(games) {
  const out = new Map();
  for (const game of games) {
    const data = applySettings(JSON.parse(JSON.stringify(cardDataBase)), game.settings);
    const s0 = createInitialState(game.seed, data);
    for (const e of game.ev) {
      if (e.type !== 'play') continue;
      const inst = s0.cards[e.iid];
      if (!inst) continue;
      out.set(inst.cardId, (out.get(inst.cardId) || 0) + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Markdown 出力
// ---------------------------------------------------------------------------

function renderGroup(label, agg, byCard) {
  const L = [];
  const games = agg.games;
  const decided = games.filter((g) => g.decided);
  const p1 = decided.filter((g) => g.winner === 'p1').length;

  L.push(`## 設定: ${label}`);
  L.push('');
  L.push(`| 項目 | 値 |`);
  L.push(`|---|---|`);
  L.push(`| 試合数 | ${games.length}（決着 ${decided.length}） |`);
  L.push(`| 勝敗 | p1 ${p1} / p2 ${decided.length - p1} |`);
  L.push(`| 決着ターン | 平均 ${f1(mean(decided.map((g) => g.turns)))} |`);
  L.push('');
  L.push(`| ファイル | シード | 対戦 | 勝者 | ターン | 再生 |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const g of games) {
    L.push(
      `| ${g.file} | ${g.seed} | ${g.matchup} | ${g.winner ?? '未決着'} | ${g.turns} | ${
        g.replayOk ? '✅ 一致' : `⚠ ${g.replayNote}`
      } |`
    );
  }
  L.push('');

  // --- 1. ターン別: 手札がピッチ専用になっているか ---
  L.push(`### 1. ターン別: 手札を離れたカードの内訳（ピッチ専用率）`);
  L.push('');
  L.push(`「ピッチ専用」＝ピッチされた後、その試合中に一度も召喚され直さなかったカード。`);
  L.push(`1ターン＝片方の手番。`);
  L.push('');
  L.push(`| ターン | 手札から召喚 | ピッチ | うちピッチ専用 | ピッチ専用率（手札離脱に対して） |`);
  L.push(`|---|---|---|---|---|`);
  const turns = [...agg.byTurn.keys()].sort((a, b) => a - b);
  for (const t of turns) {
    const b = agg.byTurn.get(t);
    const playHand = b.playHand || 0;
    const pitch = b.pitch || 0;
    const dead = b.deadEnd || 0;
    const out = playHand + pitch;
    if (out === 0) continue;
    L.push(`| ${t} | ${playHand} | ${pitch} | ${dead} | ${f1(pct(dead, out))}% |`);
  }
  {
    const tot = { playHand: 0, pitch: 0, deadEnd: 0 };
    for (const t of turns) {
      const b = agg.byTurn.get(t);
      tot.playHand += b.playHand || 0;
      tot.pitch += b.pitch || 0;
      tot.deadEnd += b.deadEnd || 0;
    }
    L.push(
      `| **全体** | ${tot.playHand} | ${tot.pitch} | ${tot.deadEnd} | ${f1(
        pct(tot.deadEnd, tot.playHand + tot.pitch)
      )}% |`
    );
  }
  L.push('');

  // --- 2. コスト別: 出された / 捨てられた ---
  L.push(`### 2. コスト別: 出された回数 / 捨てられた回数`);
  L.push('');
  L.push(`| コスト | 召喚（手札） | 召喚（墓地） | ピッチ | 出/捨 比 |`);
  L.push(`|---|---|---|---|---|`);
  const costs = [...agg.byCost.keys()].sort((a, b) => a - b);
  for (const c of costs) {
    const b = agg.byCost.get(c);
    const played = (b.playHand || 0) + (b.playGrave || 0);
    const pitch = b.pitch || 0;
    L.push(
      `| ${c} | ${b.playHand || 0} | ${b.playGrave || 0} | ${pitch} | ${
        pitch ? f2(played / pitch) : played ? '∞' : '—'
      } |`
    );
  }
  L.push('');

  // --- 3. 墓地に欲しいカードが無い状況 ---
  L.push(`### 3. 手番開始時、召喚元の墓地に欲しいカードが無い頻度`);
  L.push('');
  L.push(
    `「欲しいカードが無い」＝空／全部準備中（墓地バッファで寝ている）／` +
      `準備済みの最大コストが ${LOW_COST_MAX} 以下、のいずれか。`
  );
  L.push('');
  const gr = agg.grave;
  const none = gr.empty + gr.napping + gr.lowOnly;
  L.push(`| 状態 | 手番数 | 頻度 |`);
  L.push(`|---|---|---|`);
  L.push(`| 空 | ${gr.empty} | ${f1(pct(gr.empty, gr.samples))}% |`);
  L.push(`| 全部準備中（バッファ） | ${gr.napping} | ${f1(pct(gr.napping, gr.samples))}% |`);
  L.push(`| 低コスト（≦${LOW_COST_MAX}）のみ | ${gr.lowOnly} | ${f1(pct(gr.lowOnly, gr.samples))}% |`);
  L.push(`| **欲しいカードが無い（計）** | **${none}** | **${f1(pct(none, gr.samples))}%** |`);
  L.push(`| コスト${LOW_COST_MAX + 1}以上が準備済み | ${gr.good} | ${f1(pct(gr.good, gr.samples))}% |`);
  L.push(`| 手番サンプル計 | ${gr.samples} | |`);
  L.push('');

  // --- 4. 呪いが召喚判断を変えた回数 ---
  L.push(`### 4. 呪い（c08）が召喚判断に関わった回数`);
  L.push('');
  L.push(`「判断を変えた」は直接観測できないため、観測できる3つで数える。`);
  L.push(`対象は「呪いが有効で、墓地に準備済みのカードがあり、空き枠もある」手番。`);
  L.push('');
  L.push(`| 観測 | 回数 |`);
  L.push(`|---|---|`);
  L.push(`| 呪いが効いている状況の手番 | ${agg.curse.faced} |`);
  L.push(`| うち、税を払って墓地から召喚した | ${agg.curse.paidTurns} |`);
  L.push(`| うち、全部ピッチすれば税込みで払えたのに墓地から出さなかった | ${agg.curse.avoided} |`);
  L.push(`| うち、税が無ければ届いたが税のせいで届かなかった | ${agg.curse.blocked} |`);
  L.push(`| 税を払った召喚（回・手番でなく召喚単位） | ${agg.curse.paidSummons}（計 +${agg.curse.taxTotal}pt） |`);
  L.push('');

  // --- 5. 攻撃力と体力の偏り（追加指示） ---
  L.push(`### 5. 攻撃力と体力の偏り`);
  L.push('');
  L.push(`召喚（トークンを除く。手札・墓地の両方を含む）${agg.summonTotal} 回。`);
  L.push(`デッキ構成比はデッキ ${agg.deck.total} 枚に占める同値の枚数比。`);
  L.push('');
  L.push(`攻撃力の値別:`);
  L.push('');
  L.push(`| 攻撃力 | 召喚回数 | 召喚に占める割合 | デッキ構成比 | 差 |`);
  L.push(`|---|---|---|---|---|`);
  L.push(...distRows(agg.summonByAtk, agg.summonTotal, agg.deck.byAtk, agg.deck.total));
  L.push('');
  L.push(`体力の値別:`);
  L.push('');
  L.push(`| 体力 | 召喚回数 | 召喚に占める割合 | デッキ構成比 | 差 |`);
  L.push(`|---|---|---|---|---|`);
  L.push(...distRows(agg.summonByHp, agg.summonTotal, agg.deck.byHp, agg.deck.total));
  L.push('');
  L.push(`型別（刷られた数値で 攻>体／体>攻／攻=体）:`);
  L.push('');
  L.push(`| 型 | 召喚回数 | 召喚に占める割合 | デッキ構成比 | 差 |`);
  L.push(`|---|---|---|---|---|`);
  for (const k of ['atk', 'hp', 'even']) {
    const n = agg.summonByShape[k];
    const share = pct(n, agg.summonTotal);
    const deckShare = pct(agg.deck.byShape[k], agg.deck.total);
    L.push(
      `| ${SHAPE_LABEL[k]} | ${n} | ${f1(share)}% | ${f1(deckShare)}% | ${sign(share - deckShare)} pt |`
    );
  }
  L.push('');

  // 5b. 同コスト帯の中での選ばれ方
  L.push(`同コスト帯の中での選ばれ方（カード別。コスト内シェアで比較）:`);
  L.push('');
  L.push(`| コスト | カード | 攻/体 | 型 | 召喚回数 | コスト内シェア | コスト内デッキ構成比 | 差 |`);
  L.push(`|---|---|---|---|---|---|---|---|`);
  {
    const cards = Object.values(agg.deck.byCard).sort(
      (a, b) => a.def.cost - b.def.cost || (a.def.id < b.def.id ? -1 : 1)
    );
    // コストごとの召喚総数とデッキ枚数
    const costSummon = {};
    const costDeck = {};
    for (const { def, copies } of cards) {
      costSummon[def.cost] = (costSummon[def.cost] || 0) + (byCard.get(def.id) || 0);
      costDeck[def.cost] = (costDeck[def.cost] || 0) + copies;
    }
    for (const { def, copies } of cards) {
      const n = byCard.get(def.id) || 0;
      const share = pct(n, costSummon[def.cost]);
      const deckShare = pct(copies, costDeck[def.cost]);
      const shape = { atk: '攻', hp: '体', even: '中' }[shapeOf(def)];
      L.push(
        `| ${def.cost} | ${def.name}（${def.id}） | ${def.attack}/${def.health} | ${shape} | ${n} | ${
          costSummon[def.cost] ? `${f1(share)}%` : '—'
        } | ${f1(deckShare)}% | ${costSummon[def.cost] ? `${sign(share - deckShare)} pt` : '—'} |`
      );
    }
  }
  L.push('');

  // 5c. 体力別の在場ターン数
  L.push(`体力の値別: 倒されずに場に残ったターン数（1ターン＝片方の手番）:`);
  L.push('');
  L.push(`「試合終了まで残った」は倒されていないので、在場ターンは打ち切り値（それ以上残った可能性がある）。`);
  L.push('');
  L.push(`| 体力 | 召喚回数 | 平均在場ターン | 試合終了まで残った数 | 残存率 |`);
  L.push(`|---|---|---|---|---|`);
  for (const hp of [...agg.survivalByHp.keys()].sort((a, b) => a - b)) {
    const o = agg.survivalByHp.get(hp);
    L.push(
      `| ${hp} | ${o.n} | ${f1(o.turnsSum / o.n)} | ${o.censored} | ${f1(pct(o.censored, o.n))}% |`
    );
  }
  L.push('');

  // 5d. 相手の墓地へ行った回数
  L.push(`倒れて相手の墓地へ行った回数（＝奪われた回数。ピッチ・消滅・退避成功は含まない）:`);
  L.push('');
  L.push(`| 攻撃力 | 奪われた回数 | | 体力 | 奪われた回数 |`);
  L.push(`|---|---|---|---|---|`);
  {
    const atks = [...agg.takenByAtk.keys()].sort((a, b) => a - b);
    const hps = [...agg.takenByHp.keys()].sort((a, b) => a - b);
    const rows = Math.max(atks.length, hps.length);
    for (let r = 0; r < rows; r++) {
      const a = atks[r] !== undefined ? `${atks[r]} | ${agg.takenByAtk.get(atks[r]).n}` : ' | ';
      const h = hps[r] !== undefined ? `${hps[r]} | ${agg.takenByHp.get(hps[r]).n}` : ' | ';
      L.push(`| ${a} | | ${h} |`);
    }
  }
  L.push('');
  L.push(`型別: 攻撃寄り ${agg.takenByShape.atk} 回 ／ 体力寄り ${agg.takenByShape.hp} 回 ／ 中立 ${agg.takenByShape.even} 回（計 ${agg.takenTotal} 回）`);
  L.push('');

  // --- 6. ターン1〜2のピッチ枚数（CG-014） ---
  L.push(`### 6. ターン1〜2でピッチされた枚数`);
  L.push('');
  L.push(`1ターン＝片方の手番。ターン1＝先攻の初手番、ターン2＝後攻の初手番。`);
  L.push('');
  L.push(`| ファイル | シード | ターン1 | ターン2 | 計 |`);
  L.push(`|---|---|---|---|---|`);
  {
    let t1 = 0, t2 = 0;
    for (const e of agg.earlyPitchByGame) {
      L.push(`| ${e.file} | ${e.seed} | ${e.t1} | ${e.t2} | ${e.t1 + e.t2} |`);
      t1 += e.t1;
      t2 += e.t2;
    }
    L.push(`| **計** | | ${t1} | ${t2} | ${t1 + t2} |`);
  }
  L.push('');

  // --- 7. 同じカードが手を替えた回数（CG-014） ---
  L.push(`### 7. 同じカードが手を替えた回数の分布（iid 単位）`);
  L.push('');
  L.push(`「手を替えた」＝カードの所在ゾーン（デッキ/手札/場/墓地）の持ち主が変わった。`);
  L.push(`ピッチ・倒されて相手の墓地へ、のどちらも1回と数える。対象はデッキ由来のカード`);
  L.push(`（トークンは墓地に入らず消滅するため対象外。ネクロマンサーも対象外）。`);
  L.push('');
  L.push(`| 手を替えた回数 | 枚数 | 対象に占める割合 |`);
  L.push(`|---|---|---|`);
  for (const k of [...agg.ownerChangeDist.keys()].sort((a, b) => a - b)) {
    const n = agg.ownerChangeDist.get(k).n;
    L.push(`| ${k} | ${n} | ${f1(pct(n, agg.ownerChangeCards))}% |`);
  }
  L.push(`| **対象カード計** | ${agg.ownerChangeCards} | （のべ変更 ${agg.transferTotal} 回） |`);
  L.push('');

  // --- 8. ピッチしたカードが召喚され直すまでの手番数（CG-014） ---
  L.push(`### 8. ピッチしたカードが相手に召喚されるまでの手番数`);
  L.push('');
  L.push(`ピッチされたカードは相手の墓地へ入るので、召喚し直すのは常に相手。`);
  L.push(`手番差＝召喚された手番 − ピッチされた手番（1ターン＝片方の手番。差1＝直後の相手手番）。`);
  L.push('');
  L.push(`| 手番差 | 件数 |`);
  L.push(`|---|---|`);
  {
    let resummoned = 0;
    for (const k of [...agg.pitchGapDist.keys()].sort((a, b) => a - b)) {
      const n = agg.pitchGapDist.get(k).n;
      L.push(`| ${k} | ${n} |`);
      resummoned += n;
    }
    L.push(`| 召喚され直さなかった | ${agg.pitchNever} |`);
    L.push(`| **ピッチ計** | ${resummoned + agg.pitchNever} |`);
  }
  L.push('');
  return L.join('\n');
}

function distRows(map, total, deckMap, deckTotal) {
  const keys = new Set([...map.keys(), ...Object.keys(deckMap).map(Number)]);
  return [...keys]
    .sort((a, b) => a - b)
    .map((k) => {
      const n = map.get(k)?.n || 0;
      const share = pct(n, total);
      const deckShare = pct(deckMap[k] || 0, deckTotal);
      return `| ${k} | ${n} | ${f1(share)}% | ${f1(deckShare)}% | ${sign(share - deckShare)} pt |`;
    });
}

function sign(x) {
  return `${x >= 0 ? '+' : ''}${f1(x)}`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('使い方: node tools/analyze_logs.js <ログ.json | ディレクトリ> [...]');
    console.error('        ANALYZE_OUT="解析.md" を指定すると docs/research/ へ書き出す');
    process.exit(1);
  }

  const warnings = [];
  const files = collectFiles(args);
  const logs = loadLogs(files, warnings);
  if (logs.length === 0) {
    console.error('読めた対戦ログが1つもない');
    for (const w of warnings) console.error(`★ ${w}`);
    process.exit(1);
  }

  const games = logs.map((log) => analyzeGame(log, warnings)).filter(Boolean);

  // 設定値でグループ化
  const groups = new Map();
  for (const g of games) {
    const key = settingsKey(g.settings);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }

  const stamp = process.env.ANALYZE_STAMP || `${new Date().toISOString()}（ツール実行時刻・UTC）`;
  const head = process.env.ANALYZE_HEAD || '（HEAD未指定）';

  const L = [];
  L.push(`# ${process.env.ANALYZE_TITLE || '対戦ログ解析（CG-013）'}`);
  L.push('');
  L.push(`| 項目 | 値 |`);
  L.push(`|---|---|`);
  L.push(`| 実施日時 | ${stamp} |`);
  L.push(`| HEAD | \`${head}\` |`);
  L.push(`| 読み込んだログ | ${games.length} 試合（ファイル ${files.length} 件） |`);
  L.push(`| 設定グループ | ${groups.size} |`);
  L.push('');
  L.push(`ログには統計が入っていない。engine（決定的）でシード + action 列を再生して数えた値。`);
  L.push(`**観測値のみを記載する。解釈・結論は書かない。**`);
  L.push('');
  L.push(`## 定義（このツールがどう数えたか）`);
  L.push('');
  L.push(`- **ピッチ専用**: ピッチされた後、その試合中に一度も召喚され直さなかったカード`);
  L.push(`- **欲しいカードが無い**: 手番開始時、召喚元の墓地が 空／全部準備中（バッファ）／準備済みの最大コストが ${LOW_COST_MAX} 以下`);
  L.push(`- **呪いが判断に関わった**: 呪いが有効・墓地に準備済みあり・空き枠あり、の手番で観測した3分類（表を参照）`);
  L.push(`- **攻撃寄り / 体力寄り**: 刷られた数値で 攻>体 ／ 体>攻（同値は中立）`);
  L.push(`- **在場ターン**: 召喚された手番から場を離れた手番までの手番数。試合終了まで残った分は打ち切り`);
  L.push(`- **奪われた**: 場で倒れて相手の墓地へ入った回数。ピッチによる墓地送り・消滅・c05 の退避成功は含まない`);
  L.push(`- **手を替えた（CG-014）**: 所在ゾーン（デッキ/手札/場/墓地）の持ち主が変わった回数。iid 単位。トークン・ネクロマンサーは除く`);
  L.push(`- **再召喚までの手番差（CG-014）**: ピッチされた手番から、墓地から召喚され直した手番までの差。1ターン＝片方の手番`);
  L.push('');
  if (warnings.length) {
    L.push(`## ⚠ 警告`);
    L.push('');
    for (const w of warnings) L.push(`- ${w}`);
    L.push('');
  }

  for (const gs of groups.values()) {
    const data = applySettings(JSON.parse(JSON.stringify(cardDataBase)), gs[0].settings);
    const agg = aggregateGroup(gs, data);
    L.push(renderGroup(settingsLabel(gs[0].settings), agg, summonCountsByCard(gs)));
    L.push('---');
    L.push('');
  }

  const md = L.join('\n');
  if (process.env.ANALYZE_OUT) {
    const out = path.join(here, '..', 'docs', 'research', process.env.ANALYZE_OUT);
    writeFileSync(out, md, 'utf8');
    console.log(`書き出し: ${out}`);
  } else {
    console.log(md);
  }
}

main();
