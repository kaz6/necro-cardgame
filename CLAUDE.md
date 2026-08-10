# CLAUDE.md

持ち駒カードゲーム（仮）— HTML/JS モック。

このファイルは AI エージェント向けの作業契約書。**変更する前に必ず読むこと。**

---

## 1. このリポジトリの位置づけ

- **正本（Single Source of Truth）は Notion。** `docs/` はその AI 可読ミラーである。
- Notion と `docs/` が食い違った場合、**Notion が正しい**。docs 側を直す。
- `docs/` を勝手に「正史」として書き換えない。ミラーの更新は人間の指示に従う。

---

## 2. アーキテクチャの絶対制約

### 2.1 engine.js — 純粋なゲームロジック

- **DOM / window / document / localStorage に一切触らない。**
- **Node 単体で実行できること。** `node js/engine.js` が通らない変更は入れない。
- **`(state, action) => newState` の純粋関数として書く。**
  - 戻り値は**新しい state**。既存 state を破壊的に変更しない（no mutation）。
  - `push` / `splice` / 直接代入による既存オブジェクトの書き換えは禁止。
    新しい配列・オブジェクトを作って返す。
  - 同じ `(state, action)` からは常に同じ `newState` が出ること。

### 2.2 action はシリアライズ可能なオブジェクト

- **すべてのプレイヤー行動は、JSON 化できる action オブジェクトで表現する。**
- 関数・クラスインスタンス・DOM 参照を action に入れない。
- 例:
  ```js
  { type: 'play',  cardId: 'c03', slot: 2 }
  { type: 'draft', pick: 0 }
  { type: 'attack', attackerSlot: 1, targetSlot: 3 }
  { type: 'revive', cardId: 'c07' }
  { type: 'endTurn' }
  ```

### 2.3 視点フィルタ filterStateFor

- **`filterStateFor(state, playerId)` を最初から用意する。**
- state から「そのプレイヤーが見てよい情報だけ」を残した新しい state を返す。
- **相手の手札の中身とデッキの中身は必ず落とす**（枚数だけ残す）。
- 後付けで足すのではなく、engine の初期設計に含める。

### 2.4 乱数はシード管理

- **`Math.random()` の使用は禁止。**
- 乱数は engine 内部の seeded RNG のみを使う。RNG の状態は state の一部として持つ。
- **同一シード + 同一 action 列 → 同一結果**が常に成立すること。
- シャッフル・ドラフト・その他ランダム要素すべてがこの規約に従う。

### 2.5 view.js — 描画のみ

- **engine の state を読んで描画するだけ。**
- view からゲームルールを判定しない。勝敗・合法手・ダメージ計算を view に書かない。
- view が engine に働きかける唯一の手段は **action オブジェクトを engine に渡すこと**。

### 2.6 データ外部化

- **カードの数値・効果は `data/cards.json` に置く。JS にベタ書きしない。**
- バランス調整が JSON の編集だけで完結する状態を保つ。
- ハードコードされた数値を見つけたら JSON に追い出す。

---

## 3. 上記制約の理由

将来 **オンライン対戦を権威サーバ型（authoritative server）で実装する**ため。

- クライアントは action だけをサーバへ送る。サーバが唯一の state を持ち、
  `filterStateFor` で各プレイヤーに見せてよい state だけを返す。
- そのためには engine が「DOM 非依存・決定的・シリアライズ可能」でなければならない。
- **ロックステップ／ロールバック方式は採用しない。**
  本作は隠し情報（手札・デッキ）を持つため、全クライアントが完全な state を
  保持する前提の方式はチート耐性を満たさない。
  → 詳細は `docs/DECISION_LOG.md` を参照。

---

## 4. 作業時のルール

- 実装前に `docs/SESSION_STATE.md` と `docs/NEXT_TASKS.md` を読む。
- 設計判断をしたら `docs/DECISION_LOG.md` に追記する（形式: `# YYYY-MM-DD｜タイトル`）。
- **却下した案は `docs/REJECTED.md` に理由込みで書く。** 蒸し返し防止が目的。
  REJECTED にある案を再提案しない。再提案する場合は「なぜ却下理由が変わったか」を先に述べる。
- 調査・先行事例は `docs/research/` に置く。規約は `docs/research/README.md` を参照。
- 未確定事項を勝手に確定させない。`docs/SESSION_STATE.md` の「未確定項目」を尊重する。

---

## 5. ディレクトリ

```
/
├ CLAUDE.md          このファイル
├ index.html         モックのエントリポイント
├ docs/              AI 可読ミラー（正本は Notion）
│  ├ CONCEPT.md
│  ├ CURRENT_SPEC.md
│  ├ DECISION_LOG.md
│  ├ REJECTED.md
│  ├ SESSION_STATE.md
│  ├ NEXT_TASKS.md
│  ├ ARCHITECTURE_PRINCIPLES.md
│  └ research/       調査・市場リサーチ・先行事例
├ data/
│  └ cards.json      カード定義（数値・効果はすべてここ）
└ js/
   ├ engine.js       純粋なゲームロジック（DOM 非依存）
   └ view.js         描画のみ
```
