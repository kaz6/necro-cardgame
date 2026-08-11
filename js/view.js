/**
 * view.js — 描画のみ（ルール v0.2）
 *
 * 【不可逆制約】詳細は CLAUDE.md
 *   - engine の state を読んで描画するだけ
 *   - ゲームルールを判定しない。合法性は必ず engine のヘルパに訊く
 *   - engine に働きかける唯一の手段は action オブジェクトを渡すこと
 *   - 数値は data/cards.js 由来のものを state から読む。ここに書かない
 *
 * ローカル2人ホットシート。手番外のプレイヤーに手札を見せないため、
 * ターン交代時にカーテンを挟む。描画は必ず filterStateFor を通した state を使う。
 *
 * CPU（CG-006）は js/ai.js。view は「手番の担当が CPU なら ai.js に action を訊いて
 * engine へ渡す」だけで、思考の中身には関与しない。
 *
 * 【読み込み形式】CG-008
 *   index.html から素の <script> で読む。engine / ai / データは
 *   先に読み込まれたグローバルから受け取る（ES モジュールは file:// で読めない）。
 */

(function (root) {
'use strict';

const {
  createInitialState,
  reduce,
  filterStateFor,
  canSummon,
  canReposition,
  legalAttackTargets,
  isAttackable,
  isNecromancerAttackable,
  opponentOf,
  summonSourceOwner,
  slotIndex,
  boardSize,
  attackOf,
  healthOf,
  graveyardSummonTax,
} = root.NECRO_ENGINE;

const { chooseCpuAction } = root.NECRO_AI_CPU;

// ---------------------------------------------------------------------------
// 画面の状態（ゲームの状態ではない。ここにルールを持たせない）
// ---------------------------------------------------------------------------

let cardData = null;
let aiData = null;
let state = null;

const ui = {
  mode: 'normal',        // 'normal' | 'summon'
  summonStep: 'pitch',   // 'pitch' | 'place'
  pitch: [],             // ピッチするインスタンス id
  plan: [],              // [{iid, from, slot}]
  pickup: null,          // 召喚待ちで手に持っているカード {iid, from}
  selectedSlot: null,    // 盤面で選択中の自分のスロット
  curtain: false,        // ホットシートの目隠し
  useCurtain: true,
  message: '',
  seed: 12345,
  matchup: 'hh',                            // 'hh' | 'hc' | 'cc'
  controller: { p1: 'human', p2: 'human' }, // 誰が指すか
  auto: false,                              // CPU 同士の自動進行中か
};

/** 対戦相手の設定を controller に落とす */
function applyMatchup(matchup) {
  ui.matchup = matchup;
  ui.controller = {
    p1: matchup === 'cc' ? 'cpu' : 'human',
    p2: matchup === 'hh' ? 'human' : 'cpu',
  };
}

const isCpu = (pid) => ui.controller[pid] === 'cpu';
const bothHuman = () => !isCpu('p1') && !isCpu('p2');

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function setMessage(text) {
  ui.message = text;
}

/** action を engine に渡す。合法性の判断は engine 側。 */
function dispatch(action) {
  try {
    state = reduce(state, action);
    setMessage('');
    return true;
  } catch (e) {
    setMessage(e.message);
    return false;
  }
}

/**
 * その候補を今の plan に足しても召喚が成立するか。
 * 判定は engine の canSummon に委ねる（view でコスト計算をしない）。
 */
function isAffordable(v, cand) {
  const taken = new Set(ui.plan.map((p) => p.slot));
  let slot = -1;
  for (let s = 0; s < boardSize(v.rules); s++) {
    if (!v.players[v.you].board[s] && !taken.has(s)) { slot = s; break; }
  }
  if (slot < 0) return false;
  return canSummon(state, v.you, ui.pitch, [...ui.plan, { ...cand, slot }]).ok;
}

function resetSummonUi() {
  ui.mode = 'normal';
  ui.summonStep = 'pitch';
  ui.pitch = [];
  ui.plan = [];
  ui.pickup = null;
}

// ---------------------------------------------------------------------------
// CPU の進行
//
// view は「手番の担当が CPU なら ai.js に action を訊いて engine に渡す」だけ。
// 思考は同期。ここでゲームルールを判定しない。
// ---------------------------------------------------------------------------

/** CPU に1手だけ指させる。指した action（指せなければ null） */
function cpuStep() {
  if (state.winner || !isCpu(state.active)) return null;
  const action = chooseCpuAction(state, state.active, aiData);
  return dispatch(action) ? action : null;
}

/** CPU の手番を1ターン分（ターン終了まで）進める */
function cpuTurn(maxSteps = 400) {
  let n = 0;
  while (n++ < maxSteps) {
    const a = cpuStep();
    if (!a || a.type === 'endTurn') break;
  }
}

/** 手番が CPU の間だけ進める。人間の手番か決着で止まる */
function cpuRunUntilHuman(maxTurns = 600) {
  let n = 0;
  while (!state.winner && isCpu(state.active) && n++ < maxTurns) cpuTurn();
}

/** CPU 同士を1ターンずつ自動で進める（画面が追えるよう少し間を置く） */
function autoTick() {
  if (!ui.auto) return;
  if (state.winner || !isCpu(state.active)) {
    ui.auto = false;
    render();
    return;
  }
  cpuTurn();
  render();
  setTimeout(autoTick, 200);
}

// ---------------------------------------------------------------------------
// カードの描画
// ---------------------------------------------------------------------------

/** そのカードの元の持ち主を表すラベル（奪取の実感が検証対象なので常に出す） */
function ownerTag(v, iid) {
  const owner = v.cards[iid].owner;
  return v.players[owner].name;
}

/**
 * カード1枚を描画する。
 * @param {object} v filterStateFor 済み state
 * @param {string} iid
 * @param {object} opts {compact, showHp, onClick, badges:[], selected, dim}
 */
function cardNode(v, iid, opts = {}) {
  const inst = v.cards[iid];
  const def = v.defs[inst.cardId];
  const owner = inst.owner;

  const n = el('div', `card owner-${owner}`);
  if (opts.compact) n.classList.add('compact');
  if (opts.selected) n.classList.add('selected');
  if (opts.dim) n.classList.add('dim');
  // 自分のものではないカード = 奪ったもの / 相手から渡ったもの
  if (owner !== v.you) n.classList.add('foreign');

  const head = el('div', 'card-head');
  head.appendChild(el('span', 'cost', String(def.cost)));
  head.appendChild(el('span', 'cname', def.name));
  n.appendChild(head);

  // 数値は engine に訊く。能力で書き換わっている場合（c05 の 1/1 化）はその値が返る
  const atk = attackOf(v, iid);
  const maxHp = healthOf(v, iid);

  const stats = el('div', 'stats');
  stats.appendChild(el('span', 'atk', String(atk)));
  const hpLeft = maxHp - inst.damage;
  const hp = el('span', 'hp', opts.showHp === false ? String(maxHp) : String(hpLeft));
  if (opts.showHp !== false && hpLeft < maxHp) hp.classList.add('hurt');
  stats.appendChild(hp);
  n.appendChild(stats);

  const foot = el('div', 'card-foot');
  foot.appendChild(el('span', 'owner-tag', `元: ${ownerTag(v, iid)}`));
  n.appendChild(foot);

  // 効果が未設計のカードはひと目で分かるようにする（現状は数値だけのバニラとして動く）
  if (def.implemented === false) n.appendChild(el('span', 'badge todo', '未'));
  // 能力の説明は常に読めるようにする（プレイテストで効果を思い出せないと検証にならない）
  if (def.ability?.text) n.title = `${def.name}: ${def.ability.text}`;
  if (inst.stats) n.appendChild(el('span', 'badge morph', '変'));
  // 呪いが墓地で待機している間だけ印を出す
  if (def.ability?.effect === 'graveyardSummonTax' && inst.curseArmed) {
    n.appendChild(el('span', 'badge curse', '呪'));
  }

  for (const b of opts.badges || []) n.appendChild(el('span', `badge ${b.cls || ''}`, b.text));

  if (opts.onClick) {
    n.classList.add('clickable');
    n.addEventListener('click', opts.onClick);
  }
  return n;
}

function backNode() {
  const n = el('div', 'card back');
  n.appendChild(el('div', 'back-mark', '?'));
  return n;
}

// ---------------------------------------------------------------------------
// 盤面
// ---------------------------------------------------------------------------

/**
 * 盤面を描画する。
 * @param {object} v
 * @param {string} pid 描画対象プレイヤー
 * @param {boolean} isSelf 自分の盤面か
 */
function boardNode(v, pid, isSelf) {
  const rules = v.rules;
  const wrap = el('div', 'board');
  // 攻撃可能な対象は engine に列挙させる。
  // isAttackable は「守り手側の条件」しか見ないので、選択中の攻撃者が
  // 実際に攻撃できるか（攻撃済みか等）はこちらで判定させる必要がある。
  const targets =
    !isSelf && ui.mode === 'normal' && ui.selectedSlot !== null
      ? legalAttackTargets(state, v.you, ui.selectedSlot)
      : [];
  // 自分は前列を上（相手側）に、相手は前列を下（自分側）に置いて向かい合わせる
  const rows = isSelf ? [0, 1] : [1, 0];

  for (const row of rows) {
    const rowNode = el('div', `board-row ${row === 0 ? 'front' : 'back'}`);
    rowNode.appendChild(el('span', 'row-label', row === 0 ? '前' : '後'));

    for (let col = 0; col < rules.board.cols; col++) {
      const slot = slotIndex(row, col, rules);
      const iid = v.players[pid].board[slot];
      const cell = el('div', 'slot');

      if (iid) {
        const inst = v.cards[iid];
        const badges = [];
        if (inst.attacksUsed >= rules.attacksPerUnitPerTurn) badges.push({ text: '攻撃済', cls: 'used' });

        const selected = isSelf && ui.selectedSlot === slot;
        let onClick = null;

        // 手番が CPU のときは盤面を操作させない（観戦のみ）
        if (isSelf && ui.mode === 'normal' && !isCpu(v.you)) {
          onClick = () => {
            ui.selectedSlot = ui.selectedSlot === slot ? null : slot;
            setMessage('');
            render();
          };
        } else if (!isSelf && ui.mode === 'normal' && ui.selectedSlot !== null) {
          if (targets.some((t) => t.kind === 'unit' && t.slot === slot)) {
            cell.classList.add('target');
            onClick = () => {
              dispatch({
                type: 'attack',
                attackerSlot: ui.selectedSlot,
                target: { kind: 'unit', slot },
              });
              ui.selectedSlot = null;
              render();
            };
          } else {
            cell.classList.add('protected');
          }
        }

        cell.appendChild(cardNode(v, iid, { compact: true, badges, selected, onClick }));
      } else {
        cell.classList.add('empty');
        cell.appendChild(el('span', 'slot-mark', '空'));

        if (isSelf && ui.mode === 'summon' && ui.summonStep === 'place' && ui.pickup) {
          cell.classList.add('placeable');
          cell.addEventListener('click', () => {
            ui.plan = [...ui.plan, { ...ui.pickup, slot }];
            ui.pickup = null;
            render();
          });
        } else if (isSelf && ui.mode === 'normal' && ui.selectedSlot !== null) {
          if (canReposition(state, v.you, ui.selectedSlot, slot).ok) {
            cell.classList.add('movable');
            cell.addEventListener('click', () => {
              dispatch({ type: 'reposition', fromSlot: ui.selectedSlot, toSlot: slot });
              ui.selectedSlot = null;
              render();
            });
          }
        }
      }

      // 召喚予定のカードを枠に仮表示
      const planned = ui.plan.find((p) => p.slot === slot);
      if (isSelf && planned) {
        cell.classList.add('planned');
        cell.innerHTML = '';
        cell.appendChild(cardNode(v, planned.iid, { compact: true, showHp: false }));
        const tag = el('span', 'plan-tag', '召喚予定');
        tag.addEventListener('click', () => {
          ui.plan = ui.plan.filter((p) => p.slot !== slot);
          render();
        });
        cell.appendChild(tag);
      }

      rowNode.appendChild(cell);
    }
    wrap.appendChild(rowNode);
  }
  return wrap;
}

function necroNode(v, pid, isSelf) {
  const iid = v.players[pid].necromancer;
  const inst = v.cards[iid];
  const def = v.defs[inst.cardId];
  const hpLeft = def.health - inst.damage;

  const n = el('div', `necro owner-${pid}`);
  n.appendChild(el('div', 'necro-name', `${v.players[pid].name} のネクロマンサー`));
  const bar = el('div', 'necro-hp');
  const fill = el('div', 'necro-hp-fill');
  fill.style.width = `${Math.max(0, (hpLeft / def.health) * 100)}%`;
  bar.appendChild(fill);
  n.appendChild(bar);
  n.appendChild(el('div', 'necro-num', `${hpLeft} / ${def.health}`));

  if (!isSelf && ui.mode === 'normal' && ui.selectedSlot !== null) {
    // 守り手側の条件だけでなく、選択中の攻撃者が実際に攻撃できるかも含めて engine に訊く
    const canHit = legalAttackTargets(state, v.you, ui.selectedSlot).some(
      (t) => t.kind === 'necromancer'
    );
    if (canHit) {
      n.classList.add('target', 'clickable');
      n.addEventListener('click', () => {
        dispatch({ type: 'attack', attackerSlot: ui.selectedSlot, target: { kind: 'necromancer' } });
        ui.selectedSlot = null;
        render();
      });
    } else {
      n.classList.add('protected');
      if (!isNecromancerAttackable(state, pid)) {
        n.appendChild(el('div', 'necro-note', '相手の場に守り手が居る間は攻撃できない'));
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// 手札・墓地
// ---------------------------------------------------------------------------

function handNode(v) {
  const me = v.players[v.you];
  const wrap = el('div', 'hand');
  for (const iid of me.hand) {
    const isPitched = ui.pitch.includes(iid);
    const isPlanned = ui.plan.some((p) => p.iid === iid);
    const badges = [];
    if (isPitched) badges.push({ text: 'ピッチ', cls: 'pitched' });
    if (isPlanned) badges.push({ text: '召喚予定', cls: 'planned' });

    let onClick = null;
    if (ui.mode === 'summon' && ui.summonStep === 'pitch' && !isPlanned) {
      onClick = () => {
        ui.pitch = isPitched ? ui.pitch.filter((x) => x !== iid) : [...ui.pitch, iid];
        render();
      };
    }

    let unaffordable = false;
    if (ui.mode === 'summon' && ui.summonStep === 'place' && !isPitched && !isPlanned) {
      if (isAffordable(v, { iid, from: 'hand' })) {
        onClick = () => {
          ui.pickup = { iid, from: 'hand' };
          setMessage('出す枠を選んでください');
          render();
        };
      } else {
        unaffordable = true;
        badges.push({ text: 'pt不足', cls: 'used' });
      }
    }

    const node = cardNode(v, iid, {
      badges,
      onClick,
      selected: ui.pickup?.iid === iid,
      dim: isPitched || isPlanned || unaffordable,
      showHp: false,
    });
    wrap.appendChild(node);
  }
  if (me.hand.length === 0) wrap.appendChild(el('div', 'empty-note', '手札なし'));
  return wrap;
}

function graveNode(v, pid) {
  const p = v.players[pid];
  // どちらの墓地から召喚できるかは engine に訊く（正本の矛盾によりフラグ化されている）
  const isSource = pid === summonSourceOwner(state, v.you);
  const wrap = el('div', 'grave');

  const head = el('div', 'grave-head');
  head.appendChild(el('span', 'grave-title', `${p.name} の墓地`));
  head.appendChild(el('span', 'grave-cost', `総コスト ${p.graveyardCost}`));
  head.appendChild(el('span', 'grave-count', `${p.graveyard.length}枚`));
  if (isSource) head.appendChild(el('span', 'grave-src', 'ここから召喚できる'));
  wrap.appendChild(head);

  const list = el('div', 'grave-list');
  for (const iid of p.graveyard) {
    const isPlanned = ui.plan.some((x) => x.iid === iid);
    let onClick = null;
    let unaffordable = false;
    if (isSource && ui.mode === 'summon' && ui.summonStep === 'place' && !isPlanned) {
      if (isAffordable(v, { iid, from: 'graveyard' })) {
        onClick = () => {
          ui.pickup = { iid, from: 'graveyard' };
          setMessage('出す枠を選んでください');
          render();
        };
      } else {
        unaffordable = true;
      }
    }
    list.appendChild(
      cardNode(v, iid, {
        compact: true,
        showHp: false,
        onClick,
        dim: isPlanned || unaffordable,
        selected: ui.pickup?.iid === iid,
      })
    );
  }
  if (p.graveyard.length === 0) list.appendChild(el('div', 'empty-note', '空'));
  wrap.appendChild(list);
  return wrap;
}

// ---------------------------------------------------------------------------
// 操作パネル
// ---------------------------------------------------------------------------

function controlsNode(v) {
  const wrap = el('div', 'controls');
  const me = v.players[v.you];

  if (v.winner) {
    wrap.appendChild(el('div', 'winner', `${v.players[v.winner].name} の勝利`));
    const again = el('button', 'primary', 'もう一度');
    again.addEventListener('click', () => newGame(ui.seed + 1));
    wrap.appendChild(again);
    return wrap;
  }

  // --- 手番が CPU のとき ---
  if (isCpu(v.you)) {
    wrap.appendChild(el('span', 'hint', `${v.players[v.you].name} は CPU です`));

    const one = el('button', '', 'CPU: 1手進める');
    one.addEventListener('click', () => {
      cpuStep();
      render();
    });
    wrap.appendChild(one);

    const turn = el('button', 'primary', 'CPU: ターンを進める');
    turn.addEventListener('click', () => {
      cpuTurn();
      // 相手が人間なら、その手番で止まる
      if (!isCpu(state.active)) ui.curtain = false;
      render();
    });
    wrap.appendChild(turn);

    if (isCpu('p1') && isCpu('p2')) {
      const auto = el('button', 'end', ui.auto ? '自動を止める' : '決着まで自動');
      auto.addEventListener('click', () => {
        ui.auto = !ui.auto;
        render();
        if (ui.auto) autoTick();
      });
      wrap.appendChild(auto);
    }
    return wrap;
  }

  if (ui.mode === 'normal') {
    const draw = el('button', '', `ドロー（${v.rules.drawPerTurn}枚）`);
    draw.disabled = me.drawUsed;
    draw.addEventListener('click', () => {
      dispatch({ type: 'draw' });
      render();
    });
    wrap.appendChild(draw);

    const summon = el('button', '', '召喚');
    summon.addEventListener('click', () => {
      ui.mode = 'summon';
      ui.summonStep = 'pitch';
      ui.selectedSlot = null;
      setMessage('手札から捨てるカード（ピッチ）を選んでください');
      render();
    });
    wrap.appendChild(summon);

    const end = el('button', 'end', 'ターン終了');
    end.addEventListener('click', () => {
      if (dispatch({ type: 'endTurn' })) {
        ui.selectedSlot = null;
        resetSummonUi();
        // 相手が CPU なら、その手番をここで消化して人間の番まで戻す
        cpuRunUntilHuman();
        // 目隠しは人間同士のときだけ意味がある
        ui.curtain = ui.useCurtain && bothHuman();
      }
      render();
    });
    wrap.appendChild(end);

    if (ui.selectedSlot !== null) {
      const targets = legalAttackTargets(state, v.you, ui.selectedSlot);
      wrap.appendChild(
        el('span', 'hint', targets.length ? '赤枠 = 攻撃可 ／ 青枠 = 移動可' : '攻撃できる相手がいません')
      );
      const cancel = el('button', 'ghost', '選択解除');
      cancel.addEventListener('click', () => {
        ui.selectedSlot = null;
        render();
      });
      wrap.appendChild(cancel);
    }
    return wrap;
  }

  // --- 召喚モード ---
  const points = ui.pitch.reduce((s, iid) => s + v.defs[v.cards[iid].cardId].cost, 0);
  const need = ui.plan.reduce((s, p) => s + v.defs[v.cards[p.iid].cardId].cost, 0);
  // 呪い（c08）の追加支払い。いくら乗るかは engine に訊く
  const tax = ui.plan.some((p) => p.from === 'graveyard') ? graveyardSummonTax(state, v.you) : 0;

  wrap.appendChild(
    el('span', 'pt', `支払い ${points} pt ／ 使用 ${need + tax} pt ／ 残り ${points - need - tax} pt`)
  );
  if (tax > 0) wrap.appendChild(el('span', 'warn', `呪い +${tax} pt`));
  else if (graveyardSummonTax(state, v.you) > 0) {
    wrap.appendChild(el('span', 'hint', `墓地から出すと呪いで +${graveyardSummonTax(state, v.you)} pt`));
  }

  if (ui.summonStep === 'pitch') {
    wrap.appendChild(el('span', 'hint', '捨てたカードは相手の墓地へ行きます'));
    const next = el('button', 'primary', '次へ（出すカードを選ぶ）');
    next.disabled = ui.pitch.length === 0;
    next.addEventListener('click', () => {
      ui.summonStep = 'place';
      // 召喚元の墓地は engine に訊く（rules.summonSource で決まる）
      const srcName = v.players[summonSourceOwner(state, v.you)].name;
      setMessage(`手札または ${srcName} の墓地からカードを選び、空き枠に置いてください`);
      render();
    });
    wrap.appendChild(next);
  } else {
    const back = el('button', 'ghost', 'ピッチ選択に戻る');
    back.addEventListener('click', () => {
      ui.summonStep = 'pitch';
      ui.plan = [];
      ui.pickup = null;
      render();
    });
    wrap.appendChild(back);

    const check = canSummon(state, v.you, ui.pitch, ui.plan);
    const confirm = el('button', 'primary', '召喚を確定');
    confirm.disabled = !check.ok;
    if (!check.ok && ui.plan.length > 0) wrap.appendChild(el('span', 'warn', check.reason));
    confirm.addEventListener('click', () => {
      if (dispatch({ type: 'summon', pitch: ui.pitch, plays: ui.plan })) resetSummonUi();
      render();
    });
    wrap.appendChild(confirm);
  }

  const cancel = el('button', 'ghost', 'やめる');
  cancel.addEventListener('click', () => {
    resetSummonUi();
    setMessage('');
    render();
  });
  wrap.appendChild(cancel);
  return wrap;
}

// ---------------------------------------------------------------------------
// 全体描画
// ---------------------------------------------------------------------------

function render() {
  const viewer = state.winner || state.active;
  const v = filterStateFor(state, state.active);
  const foe = opponentOf(v.you);
  void viewer;

  // ヘッダ
  const head = $('status');
  head.innerHTML = '';
  head.appendChild(el('span', 'turn', `ターン ${v.turn}`));
  head.appendChild(el('span', 'active', `手番: ${v.players[v.you].name}`));
  if (isCpu(v.you)) head.appendChild(el('span', 'cpu-tag', 'CPU'));
  const gc = el('span', 'gcosts');
  gc.appendChild(el('span', 'gc', `${v.players.p1.name} 墓地 ${v.players.p1.graveyardCost} pt`));
  gc.appendChild(el('span', 'gc', `${v.players.p2.name} 墓地 ${v.players.p2.graveyardCost} pt`));
  head.appendChild(gc);
  head.appendChild(el('span', 'decks', `デッキ 自${v.players[v.you].deckCount} / 相${v.players[foe].deckCount}`));

  // 相手側
  const foeArea = $('foe-area');
  foeArea.innerHTML = '';
  const foeHead = el('div', 'side-head');
  foeHead.appendChild(el('span', 'pname', v.players[foe].name));
  foeHead.appendChild(el('span', 'hcount', `手札 ${v.players[foe].handCount} 枚`));
  foeArea.appendChild(foeHead);
  const foeHand = el('div', 'hand backs');
  for (let i = 0; i < v.players[foe].handCount; i++) foeHand.appendChild(backNode());
  foeArea.appendChild(foeHand);
  foeArea.appendChild(necroNode(v, foe, false));
  foeArea.appendChild(boardNode(v, foe, false));

  // 自分側
  const selfArea = $('self-area');
  selfArea.innerHTML = '';
  selfArea.appendChild(boardNode(v, v.you, true));
  selfArea.appendChild(necroNode(v, v.you, true));
  const selfHead = el('div', 'side-head');
  selfHead.appendChild(el('span', 'pname', `${v.players[v.you].name}（あなた）`));
  selfHead.appendChild(el('span', 'hcount', `手札 ${v.players[v.you].handCount} 枚`));
  selfArea.appendChild(selfHead);
  selfArea.appendChild(handNode(v));

  // 墓地
  const graves = $('graves');
  graves.innerHTML = '';
  graves.appendChild(graveNode(v, foe));
  graves.appendChild(graveNode(v, v.you));

  // 操作
  const controls = $('controls');
  controls.innerHTML = '';
  controls.appendChild(controlsNode(v));

  // メッセージ
  $('message').textContent = ui.message;
  $('message').className = ui.message ? 'msg show' : 'msg';

  // ログ
  const log = $('log');
  log.innerHTML = '';
  for (const line of v.log.slice(-40)) log.appendChild(el('div', 'log-line', line));
  log.scrollTop = log.scrollHeight;

  // カーテン
  const curtain = $('curtain');
  if (ui.curtain && !v.winner) {
    curtain.className = 'curtain show';
    curtain.innerHTML = '';
    curtain.appendChild(el('div', 'curtain-name', `${v.players[v.you].name} の番です`));
    curtain.appendChild(el('div', 'curtain-note', '相手に画面を見せないよう交代してください'));
    const go = el('button', 'primary', '開始');
    go.addEventListener('click', () => {
      ui.curtain = false;
      render();
    });
    curtain.appendChild(go);
  } else {
    curtain.className = 'curtain';
    curtain.innerHTML = '';
  }
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

function newGame(seed) {
  ui.seed = seed;
  state = createInitialState(seed, cardData);
  resetSummonUi();
  ui.selectedSlot = null;
  ui.curtain = false;
  ui.auto = false;
  setMessage('');
  render();
}

function main() {
  // fetch は file:// で使えないので、データは先に読んだ <script> のグローバルから受ける
  cardData = root.NECRO_CARDS;
  aiData = root.NECRO_AI;

  $('new-game').addEventListener('click', () => {
    const raw = $('seed').value.trim();
    const parsed = Number.parseInt(raw, 10);
    applyMatchup($('matchup').value);
    newGame(Number.isFinite(parsed) ? parsed : ui.seed);
  });
  $('curtain-toggle').addEventListener('change', (e) => {
    ui.useCurtain = e.target.checked;
  });
  $('matchup').addEventListener('change', (e) => {
    applyMatchup(e.target.value);
    ui.auto = false;
    ui.curtain = false;
    render();
  });

  $('seed').value = String(ui.seed);
  $('matchup').value = ui.matchup;
  applyMatchup(ui.matchup);
  newGame(ui.seed);
  void boardSize;
}

// index.html は body の末尾で読み込むので DOM は組み上がっているが、
// 読み込み位置を変えても壊れないようにしておく。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}

})(typeof globalThis !== 'undefined' ? globalThis : window);
