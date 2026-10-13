/**
 * view.js — 描画と入力だけ（v0.3 モック1・CG-021 ＋ モック2・CG-023 ＋ モック3・CG-024 ＋ モック4・CG-025）
 *
 * 【制約】CLAUDE.md §2.5
 *   - engine の state を読んで描画するだけ。勝敗・合法手・戦闘の判定はここに書かない
 *     （光らせるマスは engine.legalActions、実際の強さと内訳は engine.strengthBreakdown、
 *       攻撃の結果（勝敗と押し出しの連鎖）は engine.previewMove＝実際の解決と同じ関数に訊く。
 *       モック3：投げる・運ぶの結果は engine.previewAction、前線基地の置き場所は engine.frontBaseSquares・
 *       basicPlacementSquares に訊く（CG-024）。
 *       モック4：入れ替え・運ぶ（改）の選択・連鎖の段も engine.previewAction の結果（イベントの depth）をそのまま並べる。
 *       運ぶ（改）の選択肢は engine.legalActions の carry 違いの手、入れ替え・投げるの能力の駒は engine.actionSource に訊く（CG-025））
 *   - engine に働きかける唯一の手段は action オブジェクトを reduce に渡すこと
 *   - 描画に使うのは filterStateFor を通した state（観戦の「両者の手札を見る」だけ例外）
 *   - data/cards.js（正本）は書き換えない。デバッグパネルの値は createInitialState の上書きとして渡す
 *
 * 【読み込み形式】CG-008 を踏襲。素の script で読み、グローバル NECRO_ENGINE / NECRO_AI_CPU を使う
 */

(function () {
'use strict';

const E = window.NECRO_ENGINE;
const AI = window.NECRO_AI_CPU;
const DATA = window.NECRO_CARDS;
const AIDATA = window.NECRO_AI;

if (!E || !AI || !DATA || !AIDATA) {
  window.NECRO_FATAL('読み込みに失敗しました', 'data/cards.js・data/ai.js・js/engine.js・js/ai.js のどれかが読めていません');
  return;
}

const FLAGS = DATA.flags.list;
const DEFAULTS = {};
const BASE = E.defaultSettings(DATA);   // キングの強さの既定は data の king.strength（CG-022）
for (const f of FLAGS) DEFAULTS[f.key] = BASE[f.key];

const MODES = [
  { value: 'hh', label: '人間 対 人間（ホットシート）', humans: ['p1', 'p2'] },
  { value: 'hc', label: '人間（先手） 対 CPU（後手）', humans: ['p1'] },
  { value: 'ch', label: 'CPU（先手） 対 人間（後手）', humans: ['p2'] },
  { value: 'cc', label: 'CPU 対 CPU', humans: [] },
];
const SIDE_NAME = { p1: '先手', p2: '後手' };
const SOURCE_LABEL = { spec: '仕様のフラグ', ambiguity: '曖昧な点の仮決め', tuning: '数値の調整' };
const SHORT_SIDE = { p1: '先', p2: '後' };

const ui = {
  state: null,
  mode: 'hh',
  cpuKinds: { p1: AIDATA.kinds[0].value, p2: AIDATA.kinds[0].value },
  debug: { ...DEFAULTS },
  selected: null,           // { type: 'square', sq, target?, mode?, carry? } | { type: 'hand', id }。target は確定前に結果を見せている先、
                            // mode は 'throw'（投げる）| 'swap'（入れ替え）、carry は運ぶ（改）で選んでいる駒のマス（null＝運ばない）
  inspect: null,            // 内訳を見せている盤上のマス（相手の駒も選べる）
  running: false,
  revealedFor: null,        // ホットシートで手札を見せている側
  log: [],
  record: null,
  timer: null,
  lastSquares: [],
};

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// ===========================================================================
// 対戦の開始と action の適用
// ===========================================================================

function humans() {
  return MODES.find((m) => m.value === ui.mode).humans;
}
function isHuman(pid) {
  return humans().includes(pid);
}

function newGame(seed) {
  clearTimeout(ui.timer);
  const s = Math.max(0, Math.floor(Number(seed) || 0));
  $('seed').value = String(s);
  ui.state = E.createInitialState(s, DATA, { ...ui.debug });
  ui.selected = null;
  ui.inspect = null;
  ui.revealedFor = null;
  ui.lastSquares = [];
  ui.running = ui.mode === 'cc' ? ui.running : false;
  const settings = { ...ui.state.rules };
  ui.record = {
    // ★ 冒頭に設定値（どの設定で遊んだかが分からないログは解析に使えない）
    settings,
    changedFromDefault: FLAGS.filter((f) => settings[f.key] !== DEFAULTS[f.key]).map((f) => f.key),
    seed: s,
    format: 'necro-cardgame-matchlog',
    version: DATA.version,
    players: {
      p1: isHuman('p1') ? 'human' : `cpu:${ui.cpuKinds.p1}`,
      p2: isHuman('p2') ? 'human' : `cpu:${ui.cpuKinds.p2}`,
    },
    startedAt: new Date().toISOString(),
    actions: [],
    result: null,
    plies: null,
    finishedAt: null,
  };
  ui.log = [];
  addLog(`新規対戦　シード ${s}　${settingsText(settings)}`, '');
  render();
}

function apply(action) {
  let next;
  try {
    next = E.reduce(ui.state, action);
  } catch (e) {
    addLog(`（受け付けられない操作: ${e.message}）`, '');
    render();
    return;
  }
  ui.state = next;
  ui.record.actions.push(action);
  ui.selected = null;
  ui.inspect = null;
  logEvents(next);
  if (next.result) {
    ui.record.result = { ...next.result };
    ui.record.plies = next.ply;
    ui.record.finishedAt = new Date().toISOString();
    ui.running = false;
  }
  render();
}

// ===========================================================================
// 視点
// ===========================================================================

/** いま画面に出す視点。'full' は観戦の「両者の手札を見る」 */
function perspective() {
  const s = ui.state;
  if (s.result) return 'full';   // 決着後は両者の手札を開ける
  if (ui.mode === 'cc') return $('peek').checked ? 'full' : null;
  if (ui.mode === 'hc') return 'p1';
  if (ui.mode === 'ch') return 'p2';
  const d = E.decider(s);
  // 交代の幕が出ている間は、どちらの手札も見せない
  if (d && $('curtain').checked && ui.revealedFor !== d) return null;
  return d || ui.revealedFor || 'p1';
}

function viewState() {
  const p = perspective();
  if (p === 'full') return ui.state;
  return E.filterStateFor(ui.state, p);
}

function handOf(view, pid) {
  const h = view.players[pid].hand;
  return Array.isArray(h) ? h : null;
}

/** 人間が今この画面で決定できるか（その人の視点が出ているか） */
function humanToAct() {
  const s = ui.state;
  if (s.result) return null;
  const d = E.decider(s);
  if (!isHuman(d)) return null;
  if (ui.mode === 'hh' && $('curtain').checked && ui.revealedFor !== d) return null;
  return d;
}

// ===========================================================================
// CPU
// ===========================================================================

function cpuShouldMove() {
  const s = ui.state;
  if (!s || s.result) return false;
  const d = E.decider(s);
  if (isHuman(d)) return false;
  return ui.mode !== 'cc' || ui.running;
}

function cpuStep() {
  const s = ui.state;
  if (!s || s.result) return;
  const d = E.decider(s);
  if (isHuman(d)) return;
  const a = AI.decide(s, d, AIDATA, { kind: ui.cpuKinds[d], salt: s.seed });
  if (a) apply(a);
}

function scheduleCpu() {
  clearTimeout(ui.timer);
  if (!cpuShouldMove()) return;
  const speed = Number($('cpu-speed').value);
  if (speed === 0) {
    ui.timer = setTimeout(() => {
      // 一気に：描画を挟まずに進め、最後にまとめて描く
      let guard = 0;
      while (cpuShouldMove() && guard++ < 400) {
        const s = ui.state;
        const d = E.decider(s);
        const a = AI.decide(s, d, AIDATA, { kind: ui.cpuKinds[d], salt: s.seed });
        const next = E.reduce(s, a);
        ui.state = next;
        ui.record.actions.push(a);
        logEvents(next);
        if (next.result) {
          ui.record.result = { ...next.result };
          ui.record.plies = next.ply;
          ui.record.finishedAt = new Date().toISOString();
          ui.running = false;
        }
      }
      render();
    }, 0);
    return;
  }
  ui.timer = setTimeout(cpuStep, speed);
}

// ===========================================================================
// 行動ログ（観戦者の視点＝公開情報だけで組み立てる）
// ===========================================================================

function addLog(text, cls) {
  ui.log.push({ text, cls });
}

/** 駒の名前（移動型＋能力）。駒の定義は今の対戦の state から引く（駒構成を切り替えられるため） */
function kindName(kind) {
  const s = ui.state;
  const def = s.defs[kind];
  const ab = def.ability ? s.abilities[def.ability] : null;
  return s.moveTypes[def.move].name + (ab ? `（${ab.name}）` : '');
}
function abilityName(id) {
  return ui.state.abilities[id] ? ui.state.abilities[id].name : id;
}

/** 発火点の名前（ログと確定前の表示） */
const TRIGGER_NAME = {
  onWin: '勝利時', onDefect: '寝返り時', onReturn: '山へ還るとき', onAttackWin: '攻めて勝ったとき', onMove: '攻撃でない移動',
  onSelfMove: '動いたとき', onPushed: '押されたとき', onLanded: '投げられて着地したとき', onMoved: '動かされたとき',
};
const DRAG_STOP = { king: 'キングは引きずらない', blocked: '不動は引きずらない', alreadyMoved: 'この連鎖で動いた駒なので止まる（打ち切り）', occupied: '行き先に駒がいるので引きずらない', edge: '行き先が盤の外' };

function logEvents(state) {
  // ★ 隠し情報を書かない。観戦者向けにフィルタした state のイベントだけを使う
  const pub = E.filterStateFor(state, null);
  const nameOf = (e, key) => {
    const id = e[key + 'Id'];
    if (id && pub.pieces[id]) return kindName(pub.pieces[id].kind);
    if (e[key + 'Kind']) return kindName(e[key + 'Kind']);
    return '駒';
  };
  const ply = state.ply;
  ui.lastSquares = [];
  for (const e of pub.lastEvents) {
    const who = e.player ? SIDE_NAME[e.player] : '';
    const cls = e.player || '';
    switch (e.type) {
      case 'move':
        addLog(`${ply}手目　${who}：${nameOf(e, 'piece')} ${e.from}→${e.to}`, cls);
        ui.lastSquares = [e.from, e.to];
        break;
      case 'place':
        addLog(`${ply}手目　${who}：${nameOf(e, 'piece')}を ${e.to} に置く${e.frontBase ? '（前線基地）' : ''}`, cls);
        ui.lastSquares = [e.to];
        break;
      case 'throw':
        addLog(`${ply}手目　${who}：${e.via}の${nameOf(e, 'thrower')}が ${e.from}の${nameOf(e, 'piece')}を ${e.to} へ投げる${e.landing === 'battle' ? '（敵に着地して戦闘）' : ''}`, cls);
        ui.lastSquares = [e.from, e.via, e.to];
        break;
      case 'carried': addLog(`　運ぶ：${e.from}の${nameOf(e, 'piece')}も一緒に ${e.to} へ`, ''); break;
      case 'swap':
        addLog(`${ply}手目　${who}：${e.from}の${nameOf(e, 'swapper')}と ${e.to}の${nameOf(e, 'piece')}を入れ替える`, cls);
        ui.lastSquares = [e.from, e.to];
        break;
      case 'passed': addLog(`　すり抜け：${e.at}の${nameOf(e, 'over')}を飛び越える`, ''); break;
      case 'dragged': addLog(`　道連れ：${e.from}の${nameOf(e, 'piece')}を ${e.to} へ引きずる${e.result === 'battle' ? '（そこにいる駒と戦闘）' : ''}`, ''); break;
      case 'dragBlocked': addLog(`　道連れ：${e.from}の${nameOf(e, 'piece')}は${DRAG_STOP[e.why] || e.why}`, ''); break;
      case 'carryBlocked': addLog(`　運ぶ：${e.from}の${nameOf(e, 'piece')}は行き先${e.to ? `（${e.to}）が空いていない` : 'が盤の外'}ので動かない`, ''); break;
      case 'draw': addLog(`${ply}手目　${who}：山から1枚引く（1行動）`, cls); break;
      case 'pass': addLog(`${ply}手目　${who}：動ける手がないのでパス`, cls); break;
      case 'battle': {
        const res = { win: '攻撃側の勝ち', lose: '防御側の勝ち', tie: '同値（両方とも山へ）' }[e.outcome];
        if (e.chain) addLog(`　押されて（動かされて）の戦闘：${nameOf(e, 'attacker')}(${e.attackerStrength}) ${e.from}→${e.to} ${nameOf(e, 'defender')}(${e.defenderStrength})　${res}`, cls);
        else {
          addLog(`${ply}手目　${who}：${nameOf(e, 'attacker')}(${e.attackerStrength}) ${e.from}→${e.to} ${nameOf(e, 'defender')}(${e.defenderStrength})　${res}`, cls);
          ui.lastSquares = [e.from, e.to];
        }
        break;
      }
      case 'kingFell': addLog(`　キングが倒れた${e.tie ? '（同値）' : e.pushedOff ? '（盤外へ押された）' : ''}`, ''); break;
      case 'ability': {
        const tr = TRIGGER_NAME[e.trigger] || e.trigger;
        addLog(`　【${tr}】${nameOf(e, 'piece')}の${abilityName(e.abilityId)}`, '');
        break;
      }
      case 'baseChange':
        addLog(`　　基礎の強さ ${e.changes.length === 0 ? '（範囲に対象なし）' : e.changes.map((c) => `${c.sq ? c.sq + 'の' : ''}${nameOf(c, 'piece')} ${c.from}→${c.to}`).join('・')}`, '');
        break;
      case 'abilityDraw': addLog(`　　${SIDE_NAME[e.player]}が山から${e.count}枚引く`, e.player); break;
      case 'pushed': {
        const where = e.result === 'offBoard' ? '盤の外へ（山へ還る）' : e.result === 'battle' ? `${e.to}の駒とぶつかる` : `${e.to}へ`;
        addLog(`　${e.abilityId ? abilityName(e.abilityId) : '押し出し'}：${e.from}の${nameOf(e, 'piece')}を${where}`, '');
        break;
      }
      case 'pushStop': {
        const why = { blocked: '不動の駒で止まる', king: 'キングは押されない', alreadyMoved: 'すでに動いた駒で止まる（打ち切り）', noDirection: '向きが定まらない', empty: '押す先に駒がない', edge: '押す先が盤の外' }[e.why];
        if (why) addLog(`　押し出し：${e.at ? e.at + ' ' : ''}${why}`, '');
        break;
      }
      case 'defect': addLog(`　${nameOf(e, 'piece')}が${SIDE_NAME[e.to]}に寝返る`, e.to); break;
      case 'return': {
        const why = { nth: `${e.defeats}回目に倒された`, tie: '同値', noSpace: '置く空きがない', friendly: '味方どうしの押し出しで負けた', pushedOff: '盤の外へ押された' }[e.why];
        addLog(`　${nameOf(e, 'piece')}は${SIDE_NAME[e.owner]}の山の底へ還る（${why}）`, e.owner);
        break;
      }
      case 'placeDefector': addLog(`　${who}：寝返った${nameOf(e, 'piece')}を ${e.to} に置く`, cls); ui.lastSquares = [e.to]; break;
      case 'draftOpen': addLog(`　${who}：取られた側ドラフト（山の上から2枚を見る）`, cls); break;
      case 'draftPick': addLog(`　${who}：1枚を自分の手札に、1枚を相手の手札に入れた`, cls); break;
      case 'draftSingle': addLog(`　${who}：取られた側ドラフト（山が1枚なので自分の手札へ）`, cls); break;
      case 'draftSkipped': addLog(`　${who}：取られた側ドラフト（山が空なので何もしない）`, cls); break;
      case 'turnDraw': break;
      default: break;
    }
  }
  if (state.result) addLog(resultText(state.result), '');
}

function resultText(r) {
  if (r.reason === 'maxPlies') return `引き分け（${r.ply}手に達した）`;
  if (r.reason === 'bothKings') return `引き分け（両方のキングが同値で倒れた）${r.ply}手`;
  return `${SIDE_NAME[r.winner]}の勝ち（キングを倒した）${r.ply}手`;
}

// ===========================================================================
// 設定（デバッグパネル）
// ===========================================================================

function choiceLabel(flag, value) {
  const c = flag.choices.find((x) => x.value === value);
  return c ? c.label : String(value);
}

function settingsText(rules) {
  return FLAGS.map((f) => `${f.label} ${choiceLabel(f, rules[f.key])}${rules[f.key] === DEFAULTS[f.key] ? '' : '★'}`).join('・');
}

function renderDebugSummary() {
  const box = $('debug-summary');
  box.textContent = '';
  box.appendChild(el('span', '', 'ルール設定（今の対戦）: '));
  const rules = ui.state.rules;
  FLAGS.forEach((f, i) => {
    const changed = rules[f.key] !== DEFAULTS[f.key];
    if (i > 0) box.appendChild(el('span', '', '・'));
    box.appendChild(el('span', changed ? 'changed' : '', `${f.label} ${choiceLabel(f, rules[f.key])}${changed ? '★' : ''}`));
  });
  box.appendChild(el('span', '', `　シード ${ui.state.seed}`));
  const pending = FLAGS.filter((f) => ui.debug[f.key] !== rules[f.key]);
  if (pending.length > 0) {
    box.appendChild(el('span', 'pending-note', `｜次の対戦から: ${pending.map((f) => `${f.label} ${choiceLabel(f, ui.debug[f.key])}`).join('・')}`));
  }
}

function buildDebugBody() {
  const body = $('debug-body');
  body.textContent = '';
  for (const f of FLAGS) {
    const row = el('div', 'debug-row');
    row.appendChild(el('span', 'lbl', f.label));
    const sel = el('select');
    sel.dataset.flag = f.key;
    f.choices.forEach((c, i) => {
      const o = el('option', '', `${c.label}${c.value === DEFAULTS[f.key] ? '（既定）' : ''}`);
      o.value = String(i);
      sel.appendChild(o);
    });
    sel.value = String(f.choices.findIndex((c) => c.value === ui.debug[f.key]));
    sel.addEventListener('change', () => {
      ui.debug[f.key] = f.choices[Number(sel.value)].value;
      if (f.key === 'pieceSet' || f.key === 'kingStrength') buildDebugBody();   // 駒構成の説明を差し替える
      render();
    });
    row.appendChild(sel);
    row.appendChild(el('span', 'src', SOURCE_LABEL[f.source] || f.source));
    body.appendChild(row);
  }
  body.appendChild(el('div', 'debug-note', '変更は次の「新規対戦」から反映されます（進行中の対局は変わりません）。既定と違う値には★が付きます。'));
  const row = el('div', 'debug-row');
  const reset = el('button', '', '既定に戻す');
  reset.addEventListener('click', () => {
    ui.debug = { ...DEFAULTS };
    buildDebugBody();
    render();
  });
  // 推奨設定（CG-025）：既定に data の recommended.settings だけを上書きする（既定値そのものは変えない）
  const rec = el('button', 'primary', DATA.recommended.label);
  rec.id = 'recommended';
  rec.addEventListener('click', () => {
    ui.debug = { ...DEFAULTS, ...DATA.recommended.settings };
    buildDebugBody();
    setDebugMessage('推奨設定にしました。「この設定で新規対戦」で始まります');
    render();
  });
  const apply2 = el('button', '', 'この設定で新規対戦');
  apply2.addEventListener('click', () => newGame($('seed').value));
  const save = el('button', '', '対戦ログを保存（JSON）');
  save.id = 'save-log';
  save.addEventListener('click', downloadLog);
  const copy = el('button', '', '対戦ログをコピー');
  copy.addEventListener('click', copyLog);
  row.appendChild(rec);
  row.appendChild(reset);
  row.appendChild(apply2);
  row.appendChild(save);
  row.appendChild(copy);
  body.appendChild(row);
  const msg = el('div', 'debug-msg');
  msg.id = 'debug-msg';
  body.appendChild(msg);
  const set = DATA.pieceSets[ui.debug.pieceSet];
  const comp = el('div', 'debug-note',
    `駒構成「${set.label}」（data/cards.js・両者同じ・次の対戦）: ${set.list.map((d) => `${DATA.moveTypes[d.move].name} 強さ${d.strength}・範囲${d.range}${d.ability ? `・${DATA.abilities[d.ability].name}` : ''}×${d.count}`).join('／')}／キング 強さ${ui.debug.kingStrength}`);
  body.appendChild(comp);
  const abl = el('div', 'debug-note', `能力: ${Object.keys(DATA.abilities).filter((k) => k[0] !== '_').map((k) => `${DATA.abilities[k].short}＝${DATA.abilities[k].name}：${DATA.abilities[k].text}`).join('／')}`);
  body.appendChild(abl);
}

// ===========================================================================
// 対戦ログ（JSON）
// ===========================================================================

function logText() {
  return JSON.stringify(ui.record, null, 2);
}
function logFileName() {
  const t = ui.record.startedAt.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '_');
  return `necro_v03_seed${ui.record.seed}_${t}.json`;
}
function setDebugMessage(t) {
  const n = $('debug-msg');
  if (n) n.textContent = t;
}
/** file:// でも Blob + download 属性で保存できる */
function downloadLog() {
  try {
    const blob = new Blob([logText()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = logFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDebugMessage(`保存しました（${a.download}）。保存できない環境では「コピー」を使ってください`);
  } catch (e) {
    setDebugMessage(`保存に失敗しました: ${e.message}`);
  }
}
/** file:// では navigator.clipboard が使えない場合があるので textarea で代替する */
function copyLog() {
  const text = logText();
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    setDebugMessage(ok ? 'コピーしました' : 'コピーできませんでした。「保存」を使ってください');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => setDebugMessage('コピーしました'), fallback);
  } else {
    fallback();
  }
}

// ===========================================================================
// 描画
// ===========================================================================

/** 実際の強さの内訳を文章にする */
function breakdownText(view, bd) {
  const parts = bd.parts.map((p) => ` ${p.amount > 0 ? '＋' : '−'} ${abilityName(p.abilityId)}（${p.from}）${Math.abs(p.amount)}`).join('');
  const base = `基礎 ${bd.base}${bd.base !== bd.initial ? `（初期 ${bd.initial}）` : ''}`;
  const raw = bd.base + bd.parts.reduce((n, p) => n + p.amount, 0);
  return `${base}${parts} ＝ ${bd.total}${raw < 0 ? '（0未満にはならない）' : ''}`;
}

function pieceNode(view, piece, sq) {
  const def = view.defs[piece.kind];
  const isKing = piece.kind === view.kingKind;
  const bd = E.strengthBreakdown(view, sq);
  const ab = def.ability ? view.abilities[def.ability] : null;
  const n = el('div', `piece ${piece.controller}${isKing ? ' king' : ''}`);
  n.appendChild(el('span', 'sym', def.symbol));
  // ★ 頭上の数字は実際の強さ（基礎＋常時の効果）。初期値より上なら緑、下なら黄色
  const cls = bd.total > bd.initial ? ' up' : bd.total < bd.initial ? ' down' : '';
  n.appendChild(el('span', `str${cls}`, String(bd.total)));
  if (piece.owner !== piece.controller) n.appendChild(el('span', `own ${piece.owner}`, `元${SHORT_SIDE[piece.owner]}`));
  if (ab) n.appendChild(el('span', 'abl', ab.short));
  if (!isKing) {
    const dots = el('div', 'def');
    for (let i = 0; i < view.rules.defeatsToReturn; i++) dots.appendChild(el('i', i < piece.defeats ? 'on' : ''));
    n.appendChild(dots);
  }
  n.title = `${kindName(piece.kind)}　実際の強さ ${breakdownText(view, bd)}${ab ? `\n${ab.name}：${ab.text}` : ''}\n倒された回数 ${isKing ? '-' : `${piece.defeats} / ${view.rules.defeatsToReturn}`}　元の持ち主 ${SIDE_NAME[piece.owner]}　今の持ち主 ${SIDE_NAME[piece.controller]}`;
  return n;
}

function cardNode(view, id, holder) {
  const piece = view.pieces[id];
  const def = view.defs[piece.kind];
  const ab = def.ability ? view.abilities[def.ability] : null;
  const n = el('div', `card ${holder}`);
  n.dataset.id = id;
  n.appendChild(el('span', 'str', String(def.strength)));
  n.appendChild(el('span', '', def.symbol));
  n.appendChild(el('span', 'meta', `範囲${def.range}`));
  if (ab) n.appendChild(el('span', 'abl', ab.short));
  if (piece.owner !== holder) n.appendChild(el('span', `own ${piece.owner}`, `元${SHORT_SIDE[piece.owner]}`));
  n.title = `${kindName(piece.kind)}　強さ ${def.strength}　配置範囲 ${def.range}（奥の${def.range + 1}列）${ab ? `\n${ab.name}：${ab.text}` : ''}\n元の持ち主 ${SIDE_NAME[piece.owner]}`;
  return n;
}

/** 丸数字（確定前の表示の順番） */
function circled(n) {
  return n >= 1 && n <= 20 ? String.fromCharCode(0x245f + n) : `(${n})`;
}

/**
 * 打つ前の結果予測（engine.previewAction）を、盤に出す印と文章に直す。
 * ★ 能力で駒が動くたびに順番の番号（①②…）を振り、盤の動く前のマスに「①押」、動いた先に「→①」を出す。
 *   文章には同じ番号と「何段目か」（engine がイベントに付けた depth）を出し、段が深いほど字下げする（CG-025）
 */
function previewMarks(view, pv) {
  const marks = {};
  const add = (sq, text, cls) => { if (sq) (marks[sq] = marks[sq] || []).push({ text, cls }); };
  const lines = [];
  const name = (e, key) => {
    const id = e[key + 'Id'];
    const pc = id && (pv.pieces[id] || view.pieces[id]);
    return pc ? kindName(pc.kind) : e[key + 'Kind'] ? kindName(e[key + 'Kind']) : '駒';
  };
  let seq = 0;
  const next = () => circled(++seq);
  const head = (e) => `${'　'.repeat(Math.max(0, e.depth || 0))}${e.depth ? `［${e.depth}段目］` : ''}`;
  for (const e of pv.events) {
    switch (e.type) {
      case 'battle': {
        const o = { win: '勝', lose: '負', tie: '同' }[e.outcome];
        add(e.to, `${o} ${e.attackerStrength}:${e.defenderStrength}`, `pv-${e.outcome}`);
        const res = { win: '攻め側の勝ち', lose: '守り側の勝ち', tie: '同値（両方とも山へ）' }[e.outcome];
        lines.push(`${e.chain ? `${'　'.repeat(Math.max(1, e.depth || 0))}→ 戦闘 ` : ''}${name(e, 'attacker')}(${e.attackerStrength}) ${e.from}→${e.to} ${name(e, 'defender')}(${e.defenderStrength})：${res}`);
        break;
      }
      case 'throw': {
        const n = next();
        add(e.from, `${n}投`, 'pv-throw');
        add(e.to, `→${n}`, 'pv-throw');
        lines.push(`${n}${head(e)} ${e.via}の${name(e, 'thrower')}が ${e.from}の${name(e, 'piece')}を ${e.to} へ投げる（途中の駒は飛び越える）${e.landing === 'empty' ? '：空きマスに着地' : '：敵の駒に着地して戦闘'}`);
        break;
      }
      case 'swap': {
        const n = next();
        add(e.from, `${n}替`, 'pv-swap');
        add(e.to, `${n}替`, 'pv-swap');
        lines.push(`${n}${head(e)} ${e.from}の${name(e, 'swapper')}と ${e.to}の${name(e, 'piece')}を入れ替える（${name(e, 'piece')}は動かされた）`);
        break;
      }
      case 'passed':
        add(e.at, '抜', 'pv-carry');
        lines.push(`すり抜け：${e.at}の${name(e, 'over')}を飛び越える`);
        break;
      case 'carried': {
        const n = next();
        add(e.from, `${n}運`, 'pv-carry');
        add(e.to, `→${n}`, 'pv-carry');
        lines.push(`${n}${head(e)} 運ぶ：${e.from}の${name(e, 'piece')}も一緒に ${e.to} へ動く`);
        break;
      }
      case 'carryBlocked':
        add(e.from, '運×', 'pv-stop');
        lines.push(`${head(e)}運ぶ：${e.from}の${name(e, 'piece')}は行き先${e.to ? `（${e.to}）が空いていない` : 'が盤の外'}ので動かない`);
        break;
      case 'pushed': {
        const n = next();
        const by = e.abilityId ? abilityName(e.abilityId) : '押し出し';
        if (e.result === 'offBoard') { add(e.from, `${n}押 盤外`, 'pv-off'); lines.push(`${n}${head(e)} ${by}：${e.from}の${name(e, 'piece')}を盤の外へ（元の持ち主の山へ）`); }
        else { add(e.from, `${n}押`, 'pv-push'); add(e.to, `→${n}`, 'pv-push'); lines.push(`${n}${head(e)} ${by}：${e.from}の${name(e, 'piece')}を${e.to}へ${e.result === 'battle' ? '（そこにいる駒と戦闘）' : ''}`); }
        break;
      }
      case 'dragged': {
        const n = next();
        add(e.from, `${n}引`, 'pv-drag');
        add(e.to, `→${n}`, 'pv-drag');
        lines.push(`${n}${head(e)} 道連れ：${e.from}の${name(e, 'piece')}を ${e.to} へ引きずる${e.result === 'battle' ? '（そこにいる駒と戦闘）' : ''}`);
        break;
      }
      case 'dragBlocked':
        add(e.from, '引×', 'pv-stop');
        lines.push(`${head(e)}道連れ：${e.from}の${name(e, 'piece')}は${DRAG_STOP[e.why] || e.why}`);
        break;
      case 'ability':
        // 動かされた駒の能力が発動した（連鎖の起点）。発動しただけで何も動かないものもここで分かる
        if (['onSelfMove', 'onPushed', 'onLanded', 'onMoved'].includes(e.trigger)) {
          lines.push(`${'　'.repeat(Math.max(0, e.depth || 0))}【${TRIGGER_NAME[e.trigger]}】${name(e, 'piece')}の${abilityName(e.abilityId)}`);
        }
        break;
      case 'pushStop':
        if (e.why === 'blocked') { add(e.at, '不動', 'pv-stop'); lines.push(`　→ ${e.at}は不動で止まる`); }
        else if (e.why === 'king') { add(e.at, '止', 'pv-stop'); lines.push(`　→ ${e.at}のキングは押されない`); }
        else if (e.why === 'alreadyMoved') { add(e.at, '止', 'pv-stop'); lines.push(`　→ ${e.at}の駒はこの連鎖で動いたので止まる（打ち切り）`); }
        else if (e.why === 'empty' || e.why === 'edge') lines.push('　→ 押す先に駒がない');
        else if (e.why === 'noDirection') lines.push('　→ 向きが定まらないので押さない');
        break;
      case 'defect': lines.push(`　→ ${name(e, 'piece')}が${SIDE_NAME[e.to]}に寝返る`); break;
      case 'return': lines.push(`　→ ${name(e, 'piece')}は${SIDE_NAME[e.owner]}の山へ還る`); break;
      case 'kingFell':
        lines.push(`　→ ★ ${e.losers.map((p) => SIDE_NAME[p]).join('と')}のキングが倒れる（決着）`);
        break;
      case 'baseChange':
        if (e.changes.length > 0) lines.push(`　→ ${abilityName(e.abilityId)}：${e.changes.map((c) => `${c.sq ? c.sq + 'の' : ''}${name(c, 'piece')} 基礎 ${c.from}→${c.to}`).join('・')}`);
        break;
      case 'abilityDraw': lines.push(`　→ ${abilityName(e.abilityId)}：${SIDE_NAME[e.player]}が山から${e.count}枚引く`); break;
      default: break;
    }
  }
  if (pv.maxDepth >= 2) lines.push(`（連鎖は ${pv.maxDepth} 段まで）`);
  return { marks, lines };
}

/** 能力を使う手番の行動（type＝throw・swap）のうち、能力の駒が sq のもの */
function abilityActionsBy(view, actions, sq, type) {
  return actions.filter((a) => a.type === type && E.actionSource(view, a) === sq);
}

/** sq の駒を target へ動かす手（運ぶ（改）の carry 違いをすべて。engine の合法手の並び＝候補の決め打ちの順番 → 運ばない） */
function moveVariants(actions, sq, target) {
  return actions.filter((a) => a.type === 'move' && a.from === sq && a.to === target);
}

/** いま盤に結果を出している手（動かす・投げる・入れ替え）。なければ null */
function selectedAction(view, actions) {
  const sel = ui.selected;
  if (!sel || sel.type !== 'square' || !sel.target) return null;
  if (sel.mode) return abilityActionsBy(view, actions, sel.sq, sel.mode).find((a) => a.to === sel.target) || null;
  const vs = moveVariants(actions, sel.sq, sel.target);
  if (vs.length <= 1 || !('carry' in sel)) return vs[0] || null;
  return vs.find((a) => a.carry === sel.carry) || vs[0];
}

const SHOWN_EVENTS = ['carried', 'carryBlocked', 'pushed', 'dragged', 'dragBlocked', 'passed'];

/** 確定の前に結果を見せる手か：攻撃・投げる・入れ替え・運ぶ（改）の選択がある移動・能力で駒が動く移動（engine の予測に訊く） */
function needsPreview(view, a, actions) {
  if (a.type === 'throw' || a.type === 'swap' || E.pieceAt(view, a.to)) return true;
  if (actions && moveVariants(actions, a.from, a.to).length > 1) return true;
  return E.previewAction(view, a).events.some((e) => SHOWN_EVENTS.includes(e.type));
}

function renderSide(box, view, pid, actor, actions) {
  box.textContent = '';
  const who = isHuman(pid) ? '人間' : `CPU（${AIDATA.kinds.find((k) => k.value === ui.cpuKinds[pid]).label}）`;
  const h = el('h3', '', `${SIDE_NAME[pid]}（${pid === 'p1' ? '行7の側' : '行1の側'}）・${who} `);
  h.appendChild(el('span', 'count', `山 ${E.deckCount(view, pid)}枚・手札 ${E.handCount(view, pid)}枚`));
  if (ui.state.active === pid && !ui.state.result) h.appendChild(el('span', 'prompt', '　◀ 手番'));
  box.appendChild(h);
  const hand = el('div', 'hand');
  const ids = handOf(view, pid);
  if (ids) {
    for (const id of ids) {
      const c = cardNode(view, id, pid);
      const canPlace = actor === pid && actions.some((a) => a.type === 'place' && a.pieceId === id);
      if (ui.selected && ui.selected.type === 'hand' && ui.selected.id === id) c.classList.add('sel');
      if (actor === pid && !canPlace) c.classList.add('disabled');
      c.addEventListener('click', () => onHandClick(id, pid));
      hand.appendChild(c);
    }
  } else {
    for (let i = 0; i < E.handCount(view, pid); i++) hand.appendChild(el('div', 'hidden-card'));
  }
  box.appendChild(hand);
}

function renderBoard(view, actor, actions) {
  const board = $('board');
  board.textContent = '';
  board.appendChild(el('div', 'coord colname', ''));
  for (const c of view.board.colNames) board.appendChild(el('div', 'coord colname', c));
  const hl = {};
  if (actor) {
    const pend = view.pending[0];
    if (pend && pend.type === 'placeDefector') {
      for (const a of actions) if (a.type === 'placeDefector') hl[a.to] = { cls: 'hl-defect' };
    } else if (ui.selected && ui.selected.type === 'square' && ui.selected.mode === 'throw') {
      // 投げる：着地点（勝敗は投げられる前のマスの実際の強さで比べる。空きマスは「投」）
      for (const a of abilityActionsBy(view, actions, ui.selected.sq, 'throw')) {
        const o = E.battleOutcome(view, a.from, a.to);
        hl[a.to] = o ? { cls: `hl-${o}`, label: { win: '勝', lose: '負', tie: '同' }[o] } : { cls: 'hl-throw', label: '投' };
      }
    } else if (ui.selected && ui.selected.type === 'square' && ui.selected.mode === 'swap') {
      // 入れ替え：交換できる隣の味方（CG-025）
      for (const a of abilityActionsBy(view, actions, ui.selected.sq, 'swap')) hl[a.to] = { cls: 'hl-swap', label: '替' };
    } else if (ui.selected && ui.selected.type === 'square') {
      for (const a of actions) {
        if (a.type !== 'move' || a.from !== ui.selected.sq || hl[a.to]) continue;
        const o = E.battleOutcome(view, a.from, a.to);   // 実際の強さで比べた勝敗
        // 能力で駒が一緒に動く移動（運ぶ・運ぶ（改）・道連れ…）には「運」を出す（engine の予測に訊く）
        hl[a.to] = o ? { cls: `hl-${o}`, label: { win: '勝', lose: '負', tie: '同' }[o] } : needsPreview(view, a, actions) ? { cls: 'hl-move', label: '運' } : { cls: 'hl-move' };
      }
      // 運ぶ（改）：確定前に結果を見せている移動で、一緒に動かす駒を選べる（候補のマスを押すと選び直す。CG-025）
      const sel = ui.selected;
      if (sel.target && !sel.mode) {
        const pa = selectedAction(view, actions);
        for (const v of moveVariants(actions, sel.sq, sel.target)) {
          if (v.carry) hl[v.carry] = { cls: pa && pa.carry === v.carry ? 'hl-carry-on' : 'hl-carry', label: pa && pa.carry === v.carry ? '' : '運?' };
        }
      }
    } else if (ui.selected && ui.selected.type === 'hand') {
      // 普段の置き場所は丸、前線基地で加わった置き場所は紫のひし形（CG-024）
      const basic = E.basicPlacementSquares(view, actor, ui.selected.id);
      for (const a of actions) if (a.type === 'place' && a.pieceId === ui.selected.id) hl[a.to] = { cls: basic.includes(a.to) ? 'hl-place' : 'hl-front' };
    }
  }
  // 前線基地の範囲は常に点線で示す（どちらの側の置き場所に加わっているか）
  const fb = { p1: new Set(E.frontBaseSquares(view, 'p1')), p2: new Set(E.frontBaseSquares(view, 'p2')) };
  // 確定前の攻撃・投げる・運ぶ：押し出しの連鎖まで含めた結果を盤に出す（実際の解決と同じ関数）
  const pa = selectedAction(view, actions);
  const pvMarks = pa ? previewMarks(view, E.previewAction(view, pa)).marks : {};
  for (let y = 1; y <= view.board.rows; y++) {
    board.appendChild(el('div', 'coord', String(y)));
    for (let x = 0; x < view.board.cols; x++) {
      const sq = E.squareName(view, x, y);
      const d = el('div', `sq ${(x + y) % 2 ? 'dark' : 'light'}`);
      if (y === view.board.homeRow.p1) d.classList.add('home1');
      if (y === view.board.homeRow.p2) d.classList.add('home2');
      if (ui.lastSquares.includes(sq)) d.classList.add('last');
      if (ui.selected && ui.selected.type === 'square' && ui.selected.sq === sq) d.classList.add('sel');
      if (ui.inspect === sq) d.classList.add('inspect');
      if (ui.selected && ui.selected.target === sq) d.classList.add('target');
      if (fb.p1.has(sq)) { d.classList.add('fb-p1'); d.title = '前線基地（先手の置き場所に加わっている）'; }
      if (fb.p2.has(sq)) { d.classList.add('fb-p2'); d.title = '前線基地（後手の置き場所に加わっている）'; }
      const h = hl[sq];
      if (h) {
        d.classList.add(h.cls);
        if (h.label && !pvMarks[sq]) d.appendChild(el('span', 'outcome', h.label));
      }
      if (pvMarks[sq]) {
        const box = el('div', 'pv');
        for (const m of pvMarks[sq]) box.appendChild(el('span', m.cls, m.text));
        d.appendChild(box);
      }
      const p = E.pieceAt(view, sq);
      if (p) d.appendChild(pieceNode(view, p, sq));
      d.dataset.sq = sq;
      d.addEventListener('click', () => onSquareClick(sq));
      board.appendChild(d);
    }
  }
}

function renderStatus(view, actor, actions) {
  const box = $('status');
  box.textContent = '';
  const s = ui.state;
  if (s.result) {
    box.appendChild(el('span', 'result', resultText(s.result)));
    box.appendChild(el('span', '', '　（対戦ログはルール設定パネルから保存できます）'));
    return;
  }
  const plyText = s.pending.length > 0 ? `${s.ply}手目の続き` : `${s.ply + 1}手目`;
  box.appendChild(el('span', '', `${plyText}（上限 ${s.rules.maxPlies}手）　手番 `));
  box.appendChild(el('b', s.active, SIDE_NAME[s.active]));
  box.appendChild(el('span', '', '　'));
  const d = E.decider(s);
  const pend = s.pending[0];
  let msg = '';
  if (!actor) {
    if (!isHuman(d)) msg = `${SIDE_NAME[d]}（CPU）が考えています`;
    else msg = `${SIDE_NAME[d]}の番です`;
  } else if (pend && pend.type === 'placeDefector') {
    msg = `寝返った${kindName(s.pieces[pend.pieceId].kind)}を置くマスを選んでください（光っているマス・手番は使いません）`;
  } else if (pend && pend.type === 'draft') {
    msg = '取られた側ドラフト：自分の手札に残す1枚を選んでください';
  } else if (ui.selected && ui.selected.type === 'square' && ui.selected.mode === 'throw' && ui.selected.target) {
    msg = `${ui.selected.sq}の駒が投げた結果（着地点 ${ui.selected.target}）を盤に出しています（①②…の順に起きる）。もう一度同じマスを押すか「確定」で投げる（ほかの着地点で選び直し）`;
  } else if (ui.selected && ui.selected.type === 'square' && ui.selected.mode === 'throw') {
    msg = `投げる：${ui.selected.sq}の周りの味方を、${ui.selected.sq}を挟んだ反対側の2マス先へ。着地点を選んでください（投＝空きマスに着地／勝・負・同＝敵に着地して戦闘）`;
  } else if (ui.selected && ui.selected.type === 'square' && ui.selected.mode === 'swap' && ui.selected.target) {
    msg = `${ui.selected.sq}と${ui.selected.target}を入れ替えた結果を盤に出しています（①②…の順に起きる）。もう一度同じマスを押すか「確定」で入れ替える`;
  } else if (ui.selected && ui.selected.type === 'square' && ui.selected.mode === 'swap') {
    msg = `入れ替え：${ui.selected.sq}の駒と位置を交換する隣の味方を選んでください（替）。交換された駒は「動かされた」になります`;
  } else if (ui.selected && ui.selected.type === 'square' && ui.selected.target) {
    const vs = moveVariants(actions, ui.selected.sq, ui.selected.target);
    msg = `${ui.selected.sq}→${ui.selected.target} の結果を盤に出しています（①②…の順に起きる）。${vs.length > 1 ? '運ぶ（改）で一緒に動かす駒は、下のボタンか盤の「運?」のマスで選び直せます。' : ''}もう一度同じマスを押すか「確定」で指す（ほかのマスで選び直し）`;
  } else if (ui.selected && ui.selected.type === 'square') {
    msg = '動かす先を選んでください（勝＝取れる／負＝倒される／同＝両方とも山へ／運＝能力でほかの駒も動く。攻撃と能力で駒が動く手は確定の前に結果を見せます）';
  } else if (ui.selected && ui.selected.type === 'hand') {
    msg = '置くマスを選んでください（丸＝普段の置き場所／紫のひし形＝前線基地で加わった置き場所）';
  } else {
    msg = '盤上の自分の駒を動かすか、手札から1枚置いてください（1手番に1行動）';
  }
  box.appendChild(el('span', 'prompt', msg));
}

function renderButtons(view, actor, actions) {
  const box = $('action-buttons');
  box.textContent = '';
  if (!actor || ui.state.pending.length > 0) return;
  const sel = ui.selected;
  const pa = selectedAction(view, actions);
  if (pa) {
    // 運ぶ（改）：一緒に動かす駒を選ぶ（候補が2体以上のとき。候補の順番 → 運ばない。CG-025）
    const vs = pa.type === 'move' ? moveVariants(actions, pa.from, pa.to) : [];
    if (vs.length > 1) {
      const wrap = el('div', 'carry-choice');
      wrap.appendChild(el('span', 'lbl', '運ぶ（改）：'));
      for (const v of vs) {
        const label = v.carry ? `${v.carry}の${kindName(E.pieceAt(view, v.carry).kind)}を運ぶ` : '運ばない';
        const b = el('button', v.carry === pa.carry ? 'primary' : '', label);
        b.dataset.carry = v.carry === null ? '-' : v.carry;
        b.addEventListener('click', () => { ui.selected = { ...sel, carry: v.carry }; render(); });
        wrap.appendChild(b);
      }
      box.appendChild(wrap);
    }
    const what = pa.type === 'throw' ? `${pa.from}の駒を${pa.to}へ投げる` : pa.type === 'swap' ? `${pa.from}と${pa.to}を入れ替える`
      : `${pa.from}→${pa.to}${pa.carry ? `・${pa.carry}を運ぶ` : pa.carry === null ? '・運ばない' : ''}`;
    const b = el('button', 'primary', `確定（${what}）`);
    b.id = 'confirm-move';
    b.addEventListener('click', () => apply(pa));
    box.appendChild(b);
    const c = el('button', '', 'やめる');
    c.addEventListener('click', () => { ui.selected = { type: 'square', sq: sel.sq, mode: sel.mode }; render(); });
    box.appendChild(c);
  } else if (sel && sel.type === 'square' && sel.mode) {
    const c = el('button', '', `${sel.mode === 'throw' ? '投げる' : '入れ替え'}のをやめる（動かすに戻る）`);
    c.id = 'mode-cancel';
    c.addEventListener('click', () => { ui.selected = { type: 'square', sq: sel.sq }; render(); });
    box.appendChild(c);
  } else if (sel && sel.type === 'square') {
    // 手番の行動として使う能力（投げる・CG-024／入れ替え・CG-025）
    if (abilityActionsBy(view, actions, sel.sq, 'throw').length > 0) {
      const b = el('button', '', `投げる（${sel.sq}の周りの味方を投げる）`);
      b.id = 'throw-mode';
      b.addEventListener('click', () => { ui.selected = { type: 'square', sq: sel.sq, mode: 'throw' }; render(); });
      box.appendChild(b);
    }
    if (abilityActionsBy(view, actions, sel.sq, 'swap').length > 0) {
      const b = el('button', '', `入れ替え（${sel.sq}と隣の味方を交換する）`);
      b.id = 'swap-mode';
      b.addEventListener('click', () => { ui.selected = { type: 'square', sq: sel.sq, mode: 'swap' }; render(); });
      box.appendChild(b);
    }
  }
  if (actions.some((a) => a.type === 'draw')) {
    const b = el('button', '', '山から1枚引く（1行動）');
    b.addEventListener('click', () => apply({ type: 'draw' }));
    box.appendChild(b);
  }
  if (actions.some((a) => a.type === 'pass')) {
    const b = el('button', '', 'パス（動ける手がない）');
    b.addEventListener('click', () => apply({ type: 'pass' }));
    box.appendChild(b);
  }
}

function renderOverlay(view, actor) {
  const root = $('overlay-root');
  root.textContent = '';
  const curtainRoot = $('curtain-root');
  curtainRoot.textContent = '';
  const s = ui.state;
  const d = E.decider(s);
  // ホットシートの交代：手札を隠す
  if (ui.mode === 'hh' && $('curtain').checked && d && ui.revealedFor !== d) {
    const ov = el('div', 'overlay curtain');
    const dlg = el('div', 'dialog');
    dlg.appendChild(el('h2', '', `${SIDE_NAME[d]}の番です`));
    const pend = s.pending[0];
    dlg.appendChild(el('p', '', pend && pend.type === 'draft' ? '（取られた側ドラフトを行います）' : pend && pend.type === 'placeDefector' ? '（寝返った駒を置きます）' : '端末を渡してから「表示する」を押してください。'));
    const b = el('button', 'primary', `${SIDE_NAME[d]}の手札を表示する`);
    b.id = 'reveal';
    b.addEventListener('click', () => { ui.revealedFor = d; render(); });
    dlg.appendChild(b);
    ov.appendChild(dlg);
    curtainRoot.appendChild(ov);   // ★ 盤と手札だけを覆う（設定パネルは触れるように）
    return;
  }
  // 取られた側ドラフト
  const pend = view.pending[0];
  if (actor && pend && pend.type === 'draft' && pend.options) {
    const ov = el('div', 'overlay');
    const dlg = el('div', 'dialog');
    dlg.appendChild(el('h2', '', `取られた側ドラフト（${SIDE_NAME[actor]}）`));
    dlg.appendChild(el('p', '', '自分の山の上から2枚。選んだ1枚が自分の手札に、もう1枚は相手の手札に入ります（手番は使いません）。'));
    const opts = el('div', 'opts');
    pend.options.forEach((id, i) => {
      const o = el('div', 'opt');
      o.appendChild(cardNode(view, id, actor));
      o.appendChild(el('div', '', kindName(view.pieces[id].kind)));
      const b = el('button', 'primary', 'これを自分に');
      b.dataset.keep = String(i);
      b.addEventListener('click', () => apply({ type: 'draftPick', keep: i }));
      o.appendChild(b);
      opts.appendChild(o);
    });
    dlg.appendChild(opts);
    ov.appendChild(dlg);
    root.appendChild(ov);
  }
}

/** 選んだ駒の実際の強さの内訳と、確定前の攻撃・投げる・運ぶの結果の文章 */
function renderDetail(view, actions) {
  const box = $('detail');
  box.textContent = '';
  const sq = ui.selected && ui.selected.type === 'square' ? ui.selected.sq : ui.inspect;
  const p = sq ? E.pieceAt(view, sq) : null;
  if (p) {
    const def = view.defs[p.kind];
    const ab = def.ability ? view.abilities[def.ability] : null;
    box.appendChild(el('div', 'detail-title', `${sq}：${SIDE_NAME[p.controller]}の${kindName(p.kind)}`));
    box.appendChild(el('div', '', `実際の強さ ${breakdownText(view, E.strengthBreakdown(view, sq))}`));
    if (ab) box.appendChild(el('div', 'muted', `${ab.name}：${ab.text}`));
  }
  const pa = selectedAction(view, actions);
  if (pa) {
    const pv = previewMarks(view, E.previewAction(view, pa));
    box.appendChild(el('div', 'detail-title', '打つ前の結果（確定するとこのとおりに解決する）'));
    for (const line of pv.lines) box.appendChild(el('div', '', line));
  }
  box.style.display = box.childNodes.length > 0 ? '' : 'none';
}

function renderLegend() {
  const box = $('legend');
  box.textContent = '';
  const add = (color, text) => {
    const s = el('span', 'sw');
    s.style.background = color;
    box.appendChild(s);
    box.appendChild(el('span', '', text));
  };
  const abl = Object.keys(DATA.abilities).filter((k) => k[0] !== '_').map((k) => `${DATA.abilities[k].short}＝${DATA.abilities[k].name}`).join('・');
  box.appendChild(el('div', '', `駒の見方：左上の数字＝実際の強さ（基礎＋常時の効果。緑は初期値より上・黄色は下。駒を選ぶと内訳）／右下の1文字＝能力（${abl}）／下の点＝倒された回数（全部埋まる回に倒されると寝返らず山へ）／右上の「元先・元後」＝元の持ち主／枠の色＝今の持ち主（青＝先手・赤＝後手）`));
  box.appendChild(el('div', '', '攻撃先・投げる先・入れ替える相手を選ぶと、確定の前に結果を盤に出します。能力で駒が動くたびに①②③…と番号を振り（「①押」が動く前のマス、「→①」が動いた先）、右の文章に何段目に何が起きたかを順に出します。もう一度同じマスか「確定」で指します。相手の駒も押すと内訳が見られます。'));
  box.appendChild(el('div', '', '運ぶ（改）：動いたとき（攻撃で勝ったときも）隣の味方を1体選んで一緒に動かす。候補が2体以上なら「運?」のマスかボタンで選ぶ（運ばない、も選べる）。投げる（投）・入れ替え（替）：駒を選んでボタン→着地点・相手を選ぶ。すり抜け：直線に動くとき味方1体を飛び越えられる。反動・爆風・道連れは押された・投げられて着地した・動かされたときに自動で起きる。前線基地：自分のポーンが相手の最奥列にいる間、その周りの空きマスにも置ける（点線で囲んだマス）。'));
  const line = el('div');
  box.appendChild(line);
  add('var(--move)', '動ける');
  add('var(--place)', '置ける');
  add('var(--front)', '前線基地で置ける');
  add('var(--throw)', '投げて着地できる');
  add('var(--swap)', '入れ替えられる');
  add('var(--carry)', '運ぶ（改）で選べる');
  add('var(--changed)', '寝返りを置ける');
  add('var(--win)', '取れる');
  add('var(--lose)', '倒される');
  add('var(--tie)', '同値');
}

function renderLog() {
  const box = $('log');
  box.textContent = '';
  for (const l of ui.log.slice(-200)) box.appendChild(el('div', l.cls, l.text));
  box.scrollTop = box.scrollHeight;
}

function render() {
  const view = viewState();
  const actor = humanToAct();
  const actions = actor ? E.legalActions(view, actor) : [];
  renderDebugSummary();
  renderStatus(view, actor, actions);
  renderSide($('side-top'), view, 'p2', actor, actions);
  renderBoard(view, actor, actions);
  renderSide($('side-bottom'), view, 'p1', actor, actions);
  renderButtons(view, actor, actions);
  renderDetail(view, actions);
  renderOverlay(view, actor);
  renderLog();
  $('cpu-run').textContent = ui.running ? 'CPU 自動進行: 実行中（押すと停止）' : 'CPU 自動進行: 停止中（押すと開始）';
  $('cpu-controls').style.display = ui.mode === 'hh' ? 'none' : '';
  $('cpu-run').disabled = ui.mode !== 'cc';
  $('cpu-step').disabled = ui.mode !== 'cc' || !!ui.state.result;
  scheduleCpu();
}

// ===========================================================================
// 入力
// ===========================================================================

function onSquareClick(sq) {
  const actor = humanToAct();
  const view = viewState();
  if (!actor) {
    // 手番でなくても、駒を押せば内訳を見られる
    ui.inspect = E.pieceAt(view, sq) && ui.inspect !== sq ? sq : null;
    render();
    return;
  }
  const actions = E.legalActions(view, actor);
  const pend = view.pending[0];
  if (pend) {
    if (pend.type === 'placeDefector') {
      const a = actions.find((x) => x.type === 'placeDefector' && x.to === sq);
      if (a) { apply(a); return; }
    }
    ui.inspect = E.pieceAt(view, sq) && ui.inspect !== sq ? sq : null;
    render();
    return;
  }
  if (ui.selected && ui.selected.type === 'square' && ui.selected.mode) {
    // 投げる・入れ替え：着地点・相手を選ぶと確定の前に結果を見せる。同じマスをもう一度押すと確定
    const mode = ui.selected.mode;
    const a = abilityActionsBy(view, actions, ui.selected.sq, mode).find((x) => x.to === sq);
    if (a) {
      if (ui.selected.target !== sq) {
        ui.selected = { type: 'square', sq: ui.selected.sq, mode, target: sq };
        render();
        return;
      }
      apply(a);
      return;
    }
    ui.selected = { type: 'square', sq: ui.selected.sq };   // 着地点・相手以外を押したらやめる（下で選び直し）
  }
  if (ui.selected && ui.selected.type === 'square') {
    const sel = ui.selected;
    // 運ぶ（改）：結果を見せている移動の候補のマス（運?）を押すと、一緒に動かす駒を選び直す（CG-025）
    if (sel.target && moveVariants(actions, sel.sq, sel.target).some((v) => v.carry === sq)) {
      ui.selected = { ...sel, carry: sq };
      render();
      return;
    }
    const vs = moveVariants(actions, sel.sq, sq);
    if (vs.length > 0) {
      // 攻撃と、能力でほかの駒も動く移動は、確定の前に結果（勝敗・連鎖・一緒に動く駒）を見せる。同じマスをもう一度押すと確定
      if (needsPreview(view, vs[0], actions) && sel.target !== sq) {
        ui.selected = { type: 'square', sq: sel.sq, target: sq };
        render();
        return;
      }
      apply(sel.target === sq ? selectedAction(view, actions) || vs[0] : vs[0]);
      return;
    }
  }
  if (ui.selected && ui.selected.type === 'hand') {
    const a = actions.find((x) => x.type === 'place' && x.pieceId === ui.selected.id && x.to === sq);
    if (a) { apply(a); return; }
  }
  const p = E.pieceAt(view, sq);
  ui.inspect = null;
  if (p && p.controller === actor && !(ui.selected && ui.selected.type === 'square' && ui.selected.sq === sq)) {
    ui.selected = { type: 'square', sq };
  } else if (p && p.controller !== actor) {
    ui.selected = null;
    ui.inspect = sq;   // 相手の駒は内訳だけ見せる
  } else {
    ui.selected = null;
  }
  render();
}

function onHandClick(id, holder) {
  const actor = humanToAct();
  if (!actor || actor !== holder || ui.state.pending.length > 0) return;
  ui.selected = ui.selected && ui.selected.type === 'hand' && ui.selected.id === id ? null : { type: 'hand', id };
  render();
}

// ===========================================================================
// 起動
// ===========================================================================

function init() {
  const mode = $('mode');
  for (const m of MODES) {
    const o = el('option', '', m.label);
    o.value = m.value;
    mode.appendChild(o);
  }
  mode.value = ui.mode;
  mode.addEventListener('change', () => {
    ui.mode = mode.value;
    ui.running = false;
    newGame($('seed').value);
  });
  for (const pid of ['p1', 'p2']) {
    const sel = $(pid === 'p1' ? 'cpu1' : 'cpu2');
    for (const k of AIDATA.kinds) {
      const o = el('option', '', k.label);
      o.value = k.value;
      sel.appendChild(o);
    }
    sel.value = ui.cpuKinds[pid];
    sel.addEventListener('change', () => {
      ui.cpuKinds[pid] = sel.value;
      if (ui.record) ui.record.players[pid] = isHuman(pid) ? 'human' : `cpu:${sel.value}`;
      render();
    });
  }
  $('new-game').addEventListener('click', () => newGame($('seed').value));
  // 別のシード：時刻から作る（engine の乱数ではない。view で Math.random を使わないため）
  $('new-seed').addEventListener('click', () => newGame(Date.now() % 1000000));
  $('curtain').addEventListener('change', render);
  $('peek').addEventListener('change', render);
  $('cpu-speed').addEventListener('change', render);
  $('cpu-run').addEventListener('click', () => { ui.running = !ui.running; render(); });
  $('cpu-step').addEventListener('click', () => { ui.running = false; cpuStep(); });
  buildDebugBody();
  renderLegend();
  newGame($('seed').value);
}

// テスト用の窓口（ブラウザでの自動確認に使う。ゲームの進行には使わない）
window.NECRO_VIEW = {
  get state() { return ui.state; },
  get record() { return ui.record; },
  newGame,
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
