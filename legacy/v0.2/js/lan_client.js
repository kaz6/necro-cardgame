/**
 * js/lan_client.js — LAN 対戦クライアント（CG-019・使い捨て）
 *
 * 【位置づけ】
 *   lan.html 専用。server.js（権威サーバ）とだけ話す。
 *   - 盤面・手札・墓地の描画は js/view.js をそのまま使う（NECRO_VIEW 経由）
 *   - このファイルはサーバとの通信と、参加・設定・開始のロビー UI だけを持つ
 *   - ゲームルールを一切判定しない。合法性の最終判定はサーバ
 *
 * 【なぜ view.js と分かれているか】
 *   view.js は file://（index.html）でも読まれるため、fetch を書けない
 *   （node js/engine.js のソース検査が見張っている）。通信はこのファイルに閉じる。
 *   このファイルは lan.html からしか読まれず、http 配信が前提なので fetch を使ってよい。
 *
 * 【進行】ターン制なのでポーリング（1秒間隔）。WebSocket は使わない。
 */

(function (root) {
'use strict';

const V = root.NECRO_VIEW;

let me = null;      // { you: 'p1'|'p2', key, host, name }
let rev = -1;       // 反映済みのサーバ rev
let phase = null;   // 'lobby' | 'playing' | 'done'
let lastLobby = null;
let pollTimer = null;

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

// ---------------------------------------------------------------------------
// 通信
// ---------------------------------------------------------------------------

async function api(url, body) {
  const res = await fetch(url, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function saveMe() {
  try { sessionStorage.setItem('necro_lan_me', JSON.stringify(me)); } catch { /* 保存できなくても遊べる */ }
}

function loadMe() {
  try { return JSON.parse(sessionStorage.getItem('necro_lan_me')); } catch { return null; }
}

function clearMe() {
  me = null;
  try { sessionStorage.removeItem('necro_lan_me'); } catch { /* noop */ }
}

// view.js の dispatch から呼ばれるドライバ。action をサーバへ送るだけ
const driver = {
  get isHost() { return !!(me && me.host); },
  send(action) {
    api('/api/action', { you: me.you, key: me.key, action })
      .then((r) => {
        if (r.ok) {
          applyServer(r);
        } else {
          // サーバが拒否した action。理由をそのまま画面に出す
          V.setMessage(`サーバが拒否: ${r.reason}`);
          V.render();
        }
      })
      .catch((e) => {
        V.setMessage(`通信エラー: ${e.message}`);
        V.render();
      });
  },
};

// ---------------------------------------------------------------------------
// サーバ応答の反映
// ---------------------------------------------------------------------------

function applyServer(r) {
  if (r.rev < rev) return;   // ポーリングと action 応答の追い越し対策
  rev = r.rev;
  phase = r.phase;
  lastLobby = r;

  if (r.phase === 'lobby' || !r.state) {
    renderSetup(r);
    return;
  }

  $('game').style.display = '';
  $('settings-bar').style.display = '';
  V.applyRemoteState(r.state, r.log, r.seed, r.settings);
  renderSetup(r);
}

async function poll() {
  if (me) {
    try {
      const r = await api(`/api/state?you=${me.you}&key=${encodeURIComponent(me.key)}`);
      if (r.ok) {
        if (r.rev !== rev || r.phase !== phase) applyServer(r);
      } else {
        // key が合わない（サーバ再起動など）→ 参加からやり直す
        clearMe();
        renderSetup(null);
      }
    } catch {
      setupMsg('サーバに接続できない（自動で再試行します）');
    }
  }
  pollTimer = setTimeout(poll, 1000);
  void pollTimer;
}

// ---------------------------------------------------------------------------
// ロビー UI（参加 → ホストが設定を決めて開始）
// ---------------------------------------------------------------------------

function setupMsg(text) {
  const n = $('lan-msg');
  if (n) n.textContent = text || '';
}

async function join(name) {
  try {
    const r = await api('/api/join', { name });
    if (!r.ok) { setupMsg(r.reason); return; }
    me = { you: r.you, key: r.key, host: r.host, name: r.name };
    saveMe();
    V.connectRemote(driver);
    renderSetup(null);
  } catch (e) {
    setupMsg(`参加できない: ${e.message}`);
  }
}

/** ホスト用: ルール設定のセレクト群（CG-013 のデバッグパネルと同じ項目・同じ表記） */
function settingsForm(current) {
  const row = el('div', 'lan-row');
  for (const r of V.DEBUG_RULES) {
    const lab = el('label', '', `${r.label} `);
    const sel = document.createElement('select');
    sel.id = `lan-set-${r.key}`;
    for (const c of r.choices) {
      const o = document.createElement('option');
      o.value = String(c);
      o.textContent = `${V.choiceName(r, c)}${V.DEBUG_DEFAULTS[r.key] === c ? '（既定）' : ''}`;
      sel.appendChild(o);
    }
    sel.value = String(current[r.key] !== undefined ? current[r.key] : V.DEBUG_DEFAULTS[r.key]);
    lab.appendChild(sel);
    row.appendChild(lab);
  }
  return row;
}

function readSettingsForm() {
  const out = {};
  for (const r of V.DEBUG_RULES) {
    const sel = $(`lan-set-${r.key}`);
    out[r.key] = r.choices.find((c) => String(c) === sel.value);
  }
  return out;
}

async function start() {
  const settings = readSettingsForm();
  try {
    const r = await api('/api/start', { you: me.you, key: me.key, settings });
    if (!r.ok) { setupMsg(r.reason); return; }
    setupMsg('');
    applyServer(r);
  } catch (e) {
    setupMsg(`開始できない: ${e.message}`);
  }
}

function renderSetup(r) {
  const box = $('lan-setup');
  box.innerHTML = '';

  // --- 未参加: 名前を入れて参加する ---
  if (!me) {
    const row = el('div', 'lan-row');
    row.appendChild(el('span', 'lan-title', 'LAN 対戦に参加する'));
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'lan-name';
    input.maxLength = 12;
    input.placeholder = '名前（省略可）';
    row.appendChild(input);
    const btn = el('button', 'primary', '参加');
    btn.addEventListener('click', () => join(input.value.trim()));
    row.appendChild(btn);
    box.appendChild(row);
    box.appendChild(el('div', 'lan-status', '最初に参加した人がホスト（プレイヤー1）になり、ルール設定と対戦開始を行います'));
    const msg = el('div', 'lan-msg');
    msg.id = 'lan-msg';
    box.appendChild(msg);
    return;
  }

  const row = el('div', 'lan-row');
  row.appendChild(el('span', 'lan-me', `あなた: ${me.name}（${me.you}${me.host ? '・ホスト' : ''}）`));

  const joined = r?.joined || lastLobby?.joined || {};
  row.appendChild(
    el('span', 'lan-status', `参加状況 — p1: ${joined.p1 || '待ち'} ／ p2: ${joined.p2 || '待ち'}`)
  );
  box.appendChild(row);

  // --- ロビー / 決着後: ホストは設定を決めて開始できる ---
  if (phase !== 'playing') {
    if (me.host) {
      box.appendChild(el('div', 'lan-status', 'ルール設定（サーバ側が正本。開始時に確定して両画面に表示されます）'));
      box.appendChild(settingsForm((phase === null ? {} : r?.settings) || {}));
      const row2 = el('div', 'lan-row');
      const btn = el('button', 'primary', phase === 'done' ? '新しい対戦を開始' : '対戦開始');
      btn.disabled = !joined.p2;
      btn.addEventListener('click', start);
      row2.appendChild(btn);
      if (!joined.p2) row2.appendChild(el('span', 'lan-status', '相手の参加を待っています…'));
      box.appendChild(row2);
    } else {
      box.appendChild(el('div', 'lan-status',
        phase === 'done' ? 'ホストが新しい対戦を始めるのを待っています…' : 'ホストが対戦を開始するのを待っています…'));
    }
  }

  const msg = el('div', 'lan-msg');
  msg.id = 'lan-msg';
  box.appendChild(msg);
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

function main() {
  const stored = loadMe();
  if (stored && stored.you && stored.key) {
    me = stored;
    V.connectRemote(driver);
  }
  renderSetup(null);
  poll();
}

// デバッグ用の最小の口（開発者コンソールから action を送って検証できる）。
// サーバは受け取った action を必ず検証するので、ここから何を送っても壊れない
root.NECRO_LAN = {
  version: 'CG-019',
  me: () => me,
  send: (action) => driver.send(action),
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}

})(typeof globalThis !== 'undefined' ? globalThis : window);
