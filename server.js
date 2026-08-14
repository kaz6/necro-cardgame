/**
 * server.js — 同一 Wi-Fi 内 2台対戦用の権威サーバ（CG-019・使い捨て）
 *
 * 【位置づけ】
 *   手札を隠した人間同士のプレイテストのための最小構成。
 *   ★ Unity 本実装へは持ち越さない。持ち越すのは「権威サーバ型で成立するか」の
 *     検証結果だけ。将来の拡張を見越した抽象化はしない（部屋1つ・2人固定）。
 *
 * 【制約】
 *   - Node 標準の http のみ。npm 依存ゼロ。WebSocket なし（ターン制なのでポーリング）
 *   - サーバだけが完全な state を持つ。クライアントへ返すのは必ず
 *     filterStateFor(state, playerId) を通した state（相手の手札・両デッキの中身は
 *     通信の JSON に一切含まれない）
 *   - 届いた action は必ず engine の legalActions / canSummon で検証してから適用する。
 *     手番でない側からの action も拒否する
 *   - js/engine.js は変更しない（require して使うだけ）
 *
 * 【ログ】
 *   - 行動ログは view.js（CG-010）の組み立て処理をここへ移植し、サーバが自分の
 *     完全 state の差分から組み立てる。書く内容は公開ゾーンの情報だけ
 *     （手札・デッキは枚数のみ）なので、そのまま両クライアントへ流せる
 *     ＝ filterStateFor と同じ基準
 *   - 決着時に CG-013 と同一形式（necro-match-log）の完全ログをファイルへ書き出す。
 *     tools/analyze_logs.js を無改造で通すこと
 *
 * 【使い方】
 *   node server.js [--port 8765] [--seed 12345]
 *   → 起動時に相手へ伝える URL（LAN 内 IP とポート）を印字する
 */

'use strict';

const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const path = require('node:path');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');

// engine とデータの読み方は tools/harness.js と同じ（新しい読み込み方式を発明しない）
const {
  createInitialState,
  reduce,
  filterStateFor,
  legalActions,
  canSummon,
  opponentOf,
  attackOf,
  healthOf,
  PLAYERS,
} = require('./js/engine.js');
const cardDataBase = require('./data/cards.js');

// ---------------------------------------------------------------------------
// 起動オプション
// ---------------------------------------------------------------------------

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  const n = Number.parseInt(process.argv[i + 1], 10);
  return Number.isFinite(n) ? n : fallback;
}

const PORT = argValue('--port', 8765);
// シードはサーバが持つ。--seed 指定がなければ起動時刻から決める（値は必ずログに残す）
const INITIAL_SEED = argValue('--seed', Date.now() % 1000000);

// ---------------------------------------------------------------------------
// ルール設定（サーバ側が正本。CG-013 のデバッグパネルと同じ項目・同じ表記）
// ---------------------------------------------------------------------------

const SETTING_DEFS = [
  {
    key: 'graveyardSummonBuffer',
    label: '墓地バッファ',
    choices: [0, 1, 2],
    read: (data) => data.rules.graveyardSummonBuffer,
    write: (data, v) => { data.rules.graveyardSummonBuffer = v; },
  },
  {
    key: 'drawPerTurn',
    label: 'ドロー',
    choices: [2, 3],
    read: (data) => data.rules.drawPerTurn,
    write: (data, v) => { data.rules.drawPerTurn = v; },
  },
  {
    key: 'openingHandSecond',
    label: '後攻の初手',
    choices: [6, 7],
    read: (data) => data.rules.openingHand.second,
    write: (data, v) => { data.rules.openingHand = { ...data.rules.openingHand, second: v }; },
  },
  {
    key: 'pitchCarryover',
    label: 'ピッチ持ち越し',
    choices: [false, true],
    names: { false: 'なし', true: 'ターン内' },
    read: (data) => data.rules.pitchCarryover === true,
    write: (data, v) => { data.rules.pitchCarryover = v; },
  },
  {
    key: 'firstPlayerAttacksOnTurn1',
    label: '先攻1ターン目の攻撃',
    choices: [true, false],
    names: { true: '可', false: '不可' },
    read: (data) => data.rules.firstPlayerAttacksOnTurn1 !== false,
    write: (data, v) => { data.rules.firstPlayerAttacksOnTurn1 = v; },
  },
  {
    key: 'tokenOnDeath',
    label: 'トークンの倒れ先',
    choices: ['vanish', 'toGraveyard'],
    names: { vanish: '消滅', toGraveyard: '墓地へ' },
    read: (data) => data.tokens.list[0]?.onDeath || 'toGraveyard',
    write: (data, v) => { data.tokens.list = data.tokens.list.map((t) => ({ ...t, onDeath: v })); },
  },
];

const SETTING_DEFAULTS = {};
for (const s of SETTING_DEFS) SETTING_DEFAULTS[s.key] = s.read(cardDataBase);

const choiceName = (def, v) => def.names?.[v] ?? String(v);

/** クライアントから来た settings を検証する。不正なら理由の文字列を返す */
function validateSettings(input) {
  if (!input || typeof input !== 'object') return 'settings がオブジェクトではない';
  for (const def of SETTING_DEFS) {
    const v = input[def.key];
    if (v === undefined) return `settings.${def.key} が無い`;
    if (!def.choices.includes(v)) return `settings.${def.key} の値が不正: ${JSON.stringify(v)}`;
  }
  return null;
}

/** settings を NECRO_CARDS の深いコピーへ上書きする（view.js の effectiveCardData と同じ意味） */
function effectiveCardData(settings) {
  const data = JSON.parse(JSON.stringify(cardDataBase));   // 中身は素の JSON なので安全
  for (const def of SETTING_DEFS) def.write(data, settings[def.key]);
  return data;
}

function settingsSummary(settings) {
  return SETTING_DEFS
    .map((d) => `${d.label} ${choiceName(d, settings[d.key])}${settings[d.key] === SETTING_DEFAULTS[d.key] ? '' : '★'}`)
    .join('・');
}

// ---------------------------------------------------------------------------
// 部屋（1つだけ。複雑な状態管理を作らない）
// ---------------------------------------------------------------------------

const room = {
  phase: 'lobby',                    // 'lobby' | 'playing' | 'done'
  players: { p1: null, p2: null },   // { key, name }
  settings: { ...SETTING_DEFAULTS },
  nextSeed: INITIAL_SEED,
  seed: null,
  state: null,                       // 完全 state（サーバだけが持つ）
  matchRecord: null,                 // CG-013 形式の記録
  actionLog: [],                     // [{pid, kind, text}] サーバが完全 state の差分から組み立てる
  rev: 0,                            // 変化の通し番号（クライアントの再描画判定用）
};

// ---------------------------------------------------------------------------
// 行動ログの組み立て（view.js の recordAction（CG-010）をサーバへ移植したもの）
//
// LAN では view はフィルタ済み state しか見ないため完全ログを作れない。
// サーバが完全 state の差分から組み立てる。★ 書いてよいのは公開ゾーンの情報だけ:
//   - 手札 … 枚数のみ（何を引いたかは書かない）
//   - デッキ … 枚数のみ（何が落ちたかは書かない）
//   - 墓地・盤面 … 中身を書いてよい（どちらのプレイヤーからも見えるため）
// この基準は filterStateFor が落とす情報と同じなので、組み立てた行は
// そのまま両クライアントへ流せる。
// ---------------------------------------------------------------------------

function logLine(pid, kind, text) {
  room.actionLog.push({ pid, kind, text });
}

/** カード名。消滅したインスタンスも引けるよう、state を選べるようにしておく */
function nameOf(s, iid) {
  const inst = s.cards[iid];
  return (inst && s.defs[inst.cardId]?.name) || '？';
}

/** その盤面に居るインスタンスの集合 */
function boardSet(s, pid) {
  return new Set(s.players[pid].board.filter(Boolean));
}

/**
 * 1手ぶんの行動ログを組み立てる。判定はしない（合法性は engine が済ませている）。
 * 差分を日本語にするだけ。view.js の recordAction と同じ文面（fx の組み立てだけ省く）。
 */
function recordAction(before, after, action) {
  const pid = before.active;
  const foe = opponentOf(pid);
  const nm = { p1: before.players.p1.name, p2: before.players.p2.name };

  if (action.type === 'draw') {
    const n = after.players[pid].hand.length - before.players[pid].hand.length;
    logLine(pid, 'draw', `${nm[pid]} が ${n} 枚ドロー（手札 ${after.players[pid].hand.length} 枚）`);
    return;
  }

  if (action.type === 'endTurn') {
    if (after.winner) return;
    // 持ち越していた pt はターン終了で消える（CG-015）。消えた事実を残す
    const expired = before.rules.pitchCarryover ? before.players[pid].pitchCredit || 0 : 0;
    if (expired > 0) logLine(pid, 'pitch', `${nm[pid]} の持ち越し ${expired} pt が消えた（ターン終了）`);
    logLine(null, 'turn', `— ターン ${after.turn}：${nm[after.active]} —`);
    return;
  }

  if (action.type === 'reposition') {
    const iid = before.players[pid].board[action.fromSlot];
    logLine(pid, 'move', `${nm[pid]} が ${nameOf(before, iid)} を配置換え`);
    return;
  }

  if (action.type === 'summon') {
    // 支払いの内訳は engine に訊く（サーバでもコスト計算を書き写さない）
    const check = canSummon(before, pid, action.pitch, action.plays);
    const pitch = action.pitch || [];
    if (pitch.length) {
      const names = pitch.map((iid) => nameOf(before, iid)).join('・');
      logLine(pid, 'pitch', `${nm[pid]} が ${names} を捨てた（${check.points}pt → ${nm[foe]} の墓地へ）`);
    } else {
      logLine(pid, 'pitch', `${nm[pid]} はピッチなし（0pt）`);
    }
    const plays = (action.plays || [])
      .map((p) => `${nameOf(before, p.iid)}（${p.from === 'graveyard' ? '墓地' : '手札'}）`)
      .join('・');
    const tax = check.tax > 0 ? `／呪い +${check.tax}pt` : '';
    logLine(pid, 'summon', `${nm[pid]} が ${plays} を召喚${tax}`);
    // 余った pt の行方（CG-015）。持ち越しが有効なときだけ意味を持つ
    if (before.rules.pitchCarryover) {
      const leftover = check.points + check.credit - check.need - check.tax;
      logLine(pid, 'pitch', `　残り ${leftover} pt をこのターン内に持ち越し`);
    }
    // 場に出たときの効果で生まれたもの（c06 のトークン）
    for (const iid of Object.keys(after.cards)) {
      if (!before.cards[iid]) logLine(pid, 'summon', `　効果で ${nameOf(after, iid)} が場に出た`);
    }
    return;
  }

  if (action.type !== 'attack') return;

  const attackerIid = before.players[pid].board[action.attackerSlot];
  const attackerName = nameOf(before, attackerIid);

  if (action.target.kind === 'necromancer') {
    const necroIid = before.players[foe].necromancer;
    const dmg = after.cards[necroIid].damage - before.cards[necroIid].damage;
    const left = healthOf(after, necroIid) - after.cards[necroIid].damage;
    logLine(
      pid,
      'attack',
      `${nm[pid]} の ${attackerName} が ${nm[foe]} のネクロマンサーを攻撃（${dmg} ダメージ・残り ${Math.max(0, left)}）`
    );
  } else {
    const defenderIid = before.players[foe].board[action.target.slot];
    logLine(pid, 'attack', `${nm[pid]} の ${attackerName} が ${nameOf(before, defenderIid)} を攻撃`);
  }

  // 倒れたカードの行き先。盤面から居なくなったものを、その後どこに居るかで振り分ける
  for (const owner of PLAYERS) {
    const gone = boardSet(before, owner);
    for (const iid of boardSet(after, owner)) gone.delete(iid);
    for (const iid of gone) {
      const name = nameOf(before, iid);
      if (!after.cards[iid]) {
        logLine(owner, 'death', `　${name} が倒れて消滅した（墓地へは行かない）`);
      } else if (after.players[opponentOf(owner)].graveyard.includes(iid)) {
        logLine(owner, 'death', `　${name} が倒れて ${nm[opponentOf(owner)]} の墓地へ`);
      } else {
        logLine(owner, 'death', `　${name} が倒れて場から離れた`);
      }
    }
  }

  // c05: 倒されたが後列へ退いた（盤面には残るので上のループでは拾えない）
  for (const iid of Object.keys(after.cards)) {
    const b = before.cards[iid];
    if (!b || b.transformed || !after.cards[iid].transformed) continue;
    logLine(
      after.cards[iid].controller,
      'death',
      `　${nameOf(after, iid)} が倒れたが後列へ退いた（${attackOf(after, iid)}/${healthOf(after, iid)}）`
    );
  }

  // c07: デッキ上が墓地へ。何が落ちたかは書かない（枚数のみ）
  for (const owner of PLAYERS) {
    const d = before.players[owner].deck.length - after.players[owner].deck.length;
    if (d > 0) logLine(owner, 'mill', `　${nm[owner]} のデッキ上 ${d} 枚が ${nm[opponentOf(owner)]} の墓地へ`);
  }

  if (after.winner) logLine(after.winner, 'win', `${nm[after.winner]} の勝利`);
}

// ---------------------------------------------------------------------------
// 対戦ログの書き出し（CG-013 の necro-match-log と同一形式。
// tools/analyze_logs.js を無改造で通すことが必須条件）
// ---------------------------------------------------------------------------

const LOG_DIR = path.join(__dirname, 'docs', 'research', 'playtest_logs', 'lan');

function matchLogJson() {
  const r = room.matchRecord;
  const out = {
    format: 'necro-match-log',
    version: r.version,
    savedAt: new Date().toISOString(),
    settings: r.settings,   // ★ 冒頭に設定値
    seed: r.seed,
    matchup: r.matchup,
    result: r.result || { winner: null, turns: room.state ? room.state.turn : null, decided: false },
    actions: r.actions,
  };
  return JSON.stringify(out, null, 1);
}

function writeMatchLog() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `necrolog_${ts}_seed${room.seed}.json`);
  writeFileSync(file, matchLogJson());
  console.log(`[log] 完全ログを書き出した: ${file}`);
  console.log(`[log] 解析: node tools/analyze_logs.js "${file}"`);
}

// ---------------------------------------------------------------------------
// 対戦の開始と action の適用
// ---------------------------------------------------------------------------

function startMatch(settings) {
  room.settings = settings;
  room.seed = room.nextSeed;
  room.nextSeed = room.seed + 1;   // 再戦時は +1（毎回ログに残る）

  const data = effectiveCardData(settings);
  room.state = createInitialState(room.seed, data, {
    names: { p1: room.players.p1.name, p2: room.players.p2.name },
  });
  room.matchRecord = {
    version: cardDataBase.version,
    settings: { ...settings },
    seed: room.seed,
    matchup: 'lan',
    actions: [],
    result: null,
  };
  room.actionLog = [];
  logLine(null, 'turn', `設定: ${SETTING_DEFS.map((d) => `${d.label} ${choiceName(d, settings[d.key])}`).join('・')}／シード ${room.seed}`);
  logLine(null, 'turn', `— ターン 1：${room.state.players[room.state.active].name} —`);
  room.phase = 'playing';
  room.rev++;

  console.log(`[match] 対戦開始 シード=${room.seed} 設定: ${settingsSummary(settings)}`);
}

/**
 * action の検証。合法なら null、不正なら拒否理由を返す。
 * ★ 検証はすべて engine のヘルパ（legalActions / canSummon）に訊く。
 *   サーバ側でルールを書き写さない。
 */
function rejectReason(state, pid, action) {
  if (!action || typeof action.type !== 'string') return 'action が不正';
  if (state.winner) return '決着済み';
  if (state.active !== pid) return '手番ではない';

  // 召喚は組み合わせ爆発するため legalActions に含まれない。canSummon で検証する
  if (action.type === 'summon') {
    if (!Array.isArray(action.pitch || []) || !Array.isArray(action.plays || [])) return 'summon の形が不正';
    const check = canSummon(state, pid, action.pitch, action.plays);
    return check.ok ? null : `召喚できない: ${check.reason}`;
  }

  const legal = legalActions(state, pid);
  const listed = legal.some((a) => {
    if (a.type !== action.type) return false;
    switch (a.type) {
      case 'draw':
      case 'endTurn':
        return true;
      case 'attack':
        return (
          a.attackerSlot === action.attackerSlot &&
          a.target.kind === action.target?.kind &&
          (a.target.kind === 'necromancer' || a.target.slot === action.target?.slot)
        );
      case 'reposition':
        return a.fromSlot === action.fromSlot && a.toSlot === action.toSlot;
      default:
        return false;
    }
  });
  return listed ? null : '合法手ではない（legalActions に無い）';
}

function applyAction(pid, action) {
  const reason = rejectReason(room.state, pid, action);
  if (reason) {
    console.log(`[reject] ${pid}: ${reason} ${JSON.stringify(action)}`);
    return { ok: false, reason };
  }

  const before = room.state;
  let after;
  try {
    after = reduce(before, action);   // 最終防壁。ここで落ちたら適用しない
  } catch (e) {
    console.log(`[reject] ${pid}: reduce が拒否（${e.message}） ${JSON.stringify(action)}`);
    return { ok: false, reason: e.message };
  }

  room.state = after;
  room.matchRecord.actions.push({ turn: before.turn, pid: before.active, action });
  try {
    recordAction(before, after, action);
  } catch (e) {
    // ログは記録でしかないので、失敗しても対局は止めない
    logLine(null, 'turn', `（ログの記録に失敗: ${e.message}）`);
  }
  room.rev++;

  if (after.winner) {
    room.matchRecord.result = { winner: after.winner, turns: after.turn, decided: true };
    room.phase = 'done';
    console.log(`[match] 決着 勝者=${after.winner}（${after.players[after.winner].name}） ターン=${after.turn}`);
    writeMatchLog();
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HTTP まわり
// ---------------------------------------------------------------------------

/** クライアントへ返す「そのプレイヤーが見てよいものだけ」。state は必ず filterStateFor を通す */
function stateResponse(pid) {
  const base = {
    ok: true,
    phase: room.phase,
    rev: room.rev,
    you: pid,
    host: pid === 'p1',
    joined: { p1: room.players.p1?.name || null, p2: room.players.p2?.name || null },
    settings: room.settings,
    defaults: SETTING_DEFAULTS,
  };
  if (room.phase === 'lobby' || !room.state) return base;
  return {
    ...base,
    seed: room.seed,
    state: filterStateFor(room.state, pid),
    log: room.actionLog.slice(-60),
  };
}

function auth(query) {
  const pid = query.you;
  if (pid !== 'p1' && pid !== 'p2') return null;
  const p = room.players[pid];
  if (!p || p.key !== query.key) return null;
  return pid;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 配信するファイルは固定の一覧のみ（ディレクトリを歩かせない）
const STATIC_FILES = {
  '/': ['lan.html', 'text/html; charset=utf-8'],
  '/lan.html': ['lan.html', 'text/html; charset=utf-8'],
  '/js/engine.js': ['js/engine.js', 'text/javascript; charset=utf-8'],
  '/js/ai.js': ['js/ai.js', 'text/javascript; charset=utf-8'],
  '/js/view.js': ['js/view.js', 'text/javascript; charset=utf-8'],
  '/js/lan_client.js': ['js/lan_client.js', 'text/javascript; charset=utf-8'],
  '/data/cards.js': ['data/cards.js', 'text/javascript; charset=utf-8'],
  '/data/ai.js': ['data/ai.js', 'text/javascript; charset=utf-8'],
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error('body が大きすぎる'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // --- 静的ファイル ---
  if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
    const [rel, type] = STATIC_FILES[url.pathname];
    try {
      const body = readFileSync(path.join(__dirname, rel));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`読めない: ${rel}\n${e.message}`);
    }
    return;
  }

  // --- API ---
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const pid = auth({ you: url.searchParams.get('you'), key: url.searchParams.get('key') });
      if (!pid) return sendJson(res, 403, { ok: false, reason: '認証できない（参加し直してください）' });
      return sendJson(res, 200, stateResponse(pid));
    }

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const pid = !room.players.p1 ? 'p1' : !room.players.p2 ? 'p2' : null;
      if (!pid) return sendJson(res, 409, { ok: false, reason: '満員です（2人固定）' });
      const name =
        typeof body.name === 'string' && body.name.trim()
          ? body.name.trim().slice(0, 12)
          : pid === 'p1' ? 'プレイヤー1' : 'プレイヤー2';
      room.players[pid] = { key: crypto.randomBytes(8).toString('hex'), name };
      room.rev++;
      console.log(`[join] ${pid} が参加: ${name}`);
      return sendJson(res, 200, { ok: true, you: pid, key: room.players[pid].key, host: pid === 'p1', name });
    }

    if (req.method === 'POST' && url.pathname === '/api/start') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const pid = auth(body);
      if (!pid) return sendJson(res, 403, { ok: false, reason: '認証できない' });
      if (pid !== 'p1') return sendJson(res, 403, { ok: false, reason: '対戦を開始できるのはホストだけ' });
      if (room.phase === 'playing') return sendJson(res, 409, { ok: false, reason: '対戦中です' });
      if (!room.players.p2) return sendJson(res, 409, { ok: false, reason: '相手の参加待ちです' });
      const bad = validateSettings(body.settings);
      if (bad) return sendJson(res, 400, { ok: false, reason: bad });
      startMatch(body.settings);
      return sendJson(res, 200, stateResponse(pid));
    }

    if (req.method === 'POST' && url.pathname === '/api/action') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const pid = auth(body);
      if (!pid) return sendJson(res, 403, { ok: false, reason: '認証できない' });
      if (room.phase !== 'playing') return sendJson(res, 409, { ok: false, reason: '対戦中ではない' });
      const r = applyAction(pid, body.action);
      if (!r.ok) return sendJson(res, 400, { ok: false, reason: r.reason });
      return sendJson(res, 200, stateResponse(pid));
    }

    sendJson(res, 404, { ok: false, reason: 'not found' });
  } catch (e) {
    sendJson(res, 400, { ok: false, reason: `リクエストを処理できない: ${e.message}` });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
    }
  }
  console.log('持ち駒カードゲーム（仮）— LAN 対戦サーバ（CG-019・権威サーバ型）');
  console.log(`このPCで開く:        http://localhost:${PORT}/`);
  for (const ip of addrs) {
    console.log(`相手に伝える URL:    http://${ip}:${PORT}/   （同じ Wi-Fi から開く）`);
  }
  if (addrs.length === 0) console.log('（LAN 内 IPv4 アドレスが見つからない。ipconfig / ifconfig で確認してください）');
  console.log(`次の対戦のシード:    ${INITIAL_SEED}（--seed で指定可。対戦開始時にもログに出す）`);
  console.log('終了は Ctrl+C');
});
