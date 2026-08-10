# CLAUDE.md

持ち駒カードゲーム（仮）— HTML/JS モック。

このファイルは AI エージェント向けの作業契約書。**変更する前に必ず読むこと。**

最終更新: 2026-08-11

---

## 0. 30秒サマリ

- **何:** ネクロマンサー同士が、倒した相手のカードを「持ち駒」として奪い合うカードゲームの検証用モック。
- **今:** ルールの骨格は確定済み。**実装はほぼゼロ**（seeded RNG のみ動く）。
- **技術:** 素の HTML + ES Modules。ビルドなし・依存パッケージなし・テストフレームワークなし。
- **最優先の制約:** `js/engine.js` は DOM に触らない純粋関数。`Math.random()` 禁止。カードの数値は `data/cards.json`。
- **着手前に読む:** `docs/SESSION_STATE.md` → `docs/NEXT_TASKS.md` → `docs/DECISION_LOG.md` → `docs/REJECTED.md`。

---

## 1. このリポジトリの位置づけ

- **正本（Single Source of Truth）は Notion。** `docs/` はその AI 可読ミラーである。
- Notion と `docs/` が食い違った場合、**Notion が正しい**。docs 側を直す。
- `docs/` を勝手に「正史」として書き換えない。ミラーの更新は人間の指示に従う。
- 特に `docs/research/` は**読み取り専用ミラー**。ここのファイルを編集して調査内容を
  更新しない（`docs/research/README.md` 参照）。

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
- `Date.now()` / `new Date()` も使わない（決定性が壊れる）。時刻が必要なら state に持たせる。

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
- 落とすもの / 落とさないものの詳細は `js/engine.js` の `filterStateFor` の
  JSDoc に記載済み。**自分のデッキの中身と rng の内部状態も落とす**（先読み防止）。

### 2.4 乱数はシード管理

- **`Math.random()` の使用は禁止。**
- 乱数は engine 内部の seeded RNG のみを使う。RNG の状態は state の一部として持つ。
- **同一シード + 同一 action 列 → 同一結果**が常に成立すること。
- シャッフル・ドラフト・その他ランダム要素すべてがこの規約に従う。
- 実装は mulberry32（`createRng` / `nextRandom` / `shuffle`）。**これらは実装済み**。
  RNG 関数自体は状態を持たず、`{rng, value}` の形で新しい rng を返す。使う側が持ち回る。

### 2.5 view.js — 描画のみ

- **engine の state を読んで描画するだけ。**
- view からゲームルールを判定しない。勝敗・合法手・ダメージ計算を view に書かない。
  合法手が必要なら `engine.legalActions(state, playerId)` を呼ぶ。
- view が engine に働きかける唯一の手段は **action オブジェクトを engine に渡すこと**。
- 描画は必ず `filterStateFor` を通した state に対して行う。**生の state を直接描画しない。**

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

原則ごとの現時点の達成度判定は `docs/ARCHITECTURE_PRINCIPLES.md`。
ただし**あれは実装ゼロ時点の「見込み」**であり、実証ではない。実装後に再判定する。

---

## 4. 現在の実装状況

**実装はほぼゼロ。** 雛形の関数シグネチャと JSDoc だけが置いてある状態。

| 場所 | 状況 |
|---|---|
| `js/engine.js` `createRng` / `nextRandom` / `shuffle` | **実装済み**（mulberry32） |
| `js/engine.js` `createInitialState` | 未実装。呼ぶと `throw` |
| `js/engine.js` `reduce` | 未実装。呼ぶと `throw` |
| `js/engine.js` `filterStateFor` | 未実装。呼ぶと `throw` |
| `js/engine.js` `legalActions` | 未実装。呼ぶと `throw` |
| `js/view.js` | 雛形。`render()` の中身は TODO |
| `data/cards.json` | `_schema` / `_constraints` のみ。`cards: []` は空、`necromancer: {}` も空 |
| `docs/CONCEPT.md` / `docs/CURRENT_SPEC.md` | 見出しのみの空雛形。中身は Notion 側 |

**注意:** 現状ブラウザで開くと `createInitialState: 未実装` が投げられて画面は空のまま。
これは既知の状態であってバグではない。原因調査に時間を使わないこと。

state の形はまだ決まっていない。`createInitialState` の JSDoc にある想定
（players / turn / rng / winner）は**確定仕様ではなく叩き台**。

---

## 5. 開発ワークフロー

### 5.1 前提

- **ビルドなし・依存パッケージなし。** `npm install` は不要（`package.json` に依存も
  scripts もない）。`node_modules` は存在しない。
- **ES Modules。** `package.json` の `"type": "module"` により `.js` は ESM 扱い。
  `require()` は使えない。`import` / `export` を使う。
- Node は v22 系で動作確認済み。

### 5.2 engine の検証（主な検証手段）

```bash
node js/engine.js        # 例外を出さずに終了すること
```

これが engine の唯一の CI 相当。**DOM 非依存が壊れた瞬間にここで落ちる**ので、
engine を触ったら必ず流す。現状は副作用がないので出力は何も出ない（それが正常）。

個別の関数を叩く場合:

```bash
node -e "import('./js/engine.js').then(m => { \
  const a = m.shuffle([1,2,3,4,5], m.createRng(42)); \
  const b = m.shuffle([1,2,3,4,5], m.createRng(42)); \
  console.log(a.items, b.items); \
})"
```

**決定性の確認は「同一シードで2回流して一致するか」**を必ず見る。
engine にロジックを足したら、同一シード + 同一 action 列で同じ最終 state に
なることをこの形で確認する。

### 5.3 モックをブラウザで動かす

`index.html` は ES Modules と `fetch('./data/cards.json')` を使うため、
**`file://` で開くと動かない**（CORS で弾かれる）。必ず HTTP で配信する。

```bash
python3 -m http.server 8000     # リポジトリのルートで実行
# → http://localhost:8000/ を開く
```

### 5.4 テスト / lint

**現時点でテストフレームワークも linter も入っていない。** 導入する場合は
`docs/DECISION_LOG.md` に判断を残すこと。導入するまでは 5.2 の手動検証が代替。

---

## 6. 作業時のルール

- 実装前に `docs/SESSION_STATE.md` と `docs/NEXT_TASKS.md` を読む。
- 設計判断をしたら `docs/DECISION_LOG.md` に追記する（形式: `# YYYY-MM-DD｜タイトル`）。
- **却下した案は `docs/REJECTED.md` に理由込みで書く。** 蒸し返し防止が目的。
  REJECTED にある案を再提案しない。再提案する場合は「なぜ却下理由が変わったか」を先に述べる。
  「保留（死んでいない）」と明記された案のみ、保留理由を解消する材料があれば再検討可。
- 調査・先行事例は `docs/research/` に置く。規約は `docs/research/README.md` を参照
  （ファイル名 `調査内容_YYYYMMDD.md`、冒頭に TL;DR と調査日）。
- 未確定事項を勝手に確定させない。`docs/SESSION_STATE.md` の「未確定項目」を尊重する。
- 作業が一段落したら `docs/SESSION_STATE.md` の進捗と `docs/NEXT_TASKS.md` の
  チェックボックスを更新する。
- **コメント・ドキュメント・コミットメッセージは日本語。** 既存のスタイルに合わせる。

### 6.1 変更を入れる前のセルフチェック

- [ ] `js/engine.js` に `document` / `window` / `localStorage` / `fetch` が入っていないか
- [ ] `Math.random()` / `Date.now()` / `new Date()` を使っていないか
- [ ] 既存の state / 配列 / オブジェクトを破壊的に書き換えていないか
- [ ] action に関数・DOM 参照など JSON 化できないものが入っていないか
- [ ] カードの数値・効果を JS にベタ書きしていないか（`data/cards.json` へ）
- [ ] view にルール判定（勝敗・合法手・ダメージ計算）を書いていないか
- [ ] `node js/engine.js` が通るか
- [ ] 未確定項目（§8）を勝手に確定させていないか

---

## 7. 確定済みルール骨格（クイックリファレンス）

正本は Notion、記録は `docs/DECISION_LOG.md`。以下は実装時の参照用の要約であり、
**食い違ったら DECISION_LOG が優先**。

- **勝利条件:** ネクロマンサー撃破。ネクロマンサーは各プレイヤー1枚・常時場・公開・出し入れ不可。
- **デッキ:** 30枚。初期手札は先攻6枚 / 後攻7枚。
- **ドロー:** 自分のデッキから2枚めくり1枚を手札へ。**選ばなかった1枚は自分の墓地へ。**
- **盤面:** あり（Hearthstone ライク）。カードはスロットに出す。
- **ステータス:** 2値のみ（攻撃 / 体力）。**体力は回復しない。**
- **マナ:** あり。増加は固定（毎ターン一定量）。※増加量とコスト分布は未確定。
- **墓地:** 各プレイヤーで分離。
- **蘇生:** **相手の墓地からのみ。** ノーコスト、1ターン1枚まで。
  代償として自分のデッキ上から1枚を自分の墓地へ落とす。
- **持ち駒ゾーン:** 倒したカードはデッキに混ぜず、**公開**の持ち駒ゾーンへ置く。
- **カード:** 8種。うち4種が能力持ち（呪い1種 + 有効効果3種）。呪いはデッキに2枚。
- **呪い:** 墓地常在型。自分の墓地にある間、**相手の蘇生に追加コスト1枚**を課す。
- **オンライン対戦:** 権威サーバ型。ロックステップ／ロールバックは不採用。

---

## 8. 未確定項目（勝手に確定させない）

`docs/SESSION_STATE.md` が正。以下は人間の判断待ちであり、**実装の都合で仮決めして
先に進まない**。必要なら人間に確認する。

- **能力持ち3種の具体的効果テキスト** — 何をするか未決定。
- **マナカーブ** — 「あり・固定増加」までは確定。増加量とコスト分布は未定。
- **呪いのノイズ判定** — デッキ30枚中2枚が事故要因になりすぎないか未検証。実際に回して確認が必要。

---

## 9. ファイル構成

```
/
├ CLAUDE.md          このファイル（AI 向け作業契約書）
├ package.json       ESM 宣言のみ。依存・scripts なし
├ index.html         モックのエントリポイント
├ docs/              AI 可読ミラー（正本は Notion）
│  ├ CONCEPT.md              企画の芯（現状: 空雛形）
│  ├ CURRENT_SPEC.md         現行ルール仕様（現状: 空雛形）
│  ├ DECISION_LOG.md         確定した設計判断（`# YYYY-MM-DD｜タイトル`）
│  ├ REJECTED.md             却下案と理由（蒸し返し防止）
│  ├ SESSION_STATE.md        現在地スナップショット / 未確定項目
│  ├ NEXT_TASKS.md           次の作業単位（チェックリスト）
│  ├ ARCHITECTURE_PRINCIPLES.md  5原則の判定（実装前の「見込み」）
│  └ research/       調査・市場リサーチ・先行事例（読み取り専用ミラー）
├ data/
│  └ cards.json      カード定義（数値・効果はすべてここ）
└ js/
   ├ engine.js       純粋なゲームロジック（DOM 非依存）
   └ view.js         描画のみ
```

### 9.1 data/cards.json の構造

自己記述的な JSON。`_` 始まりのキーはドキュメントであり、ゲームデータではない。

- `_schema` — カード1件の各フィールドの意味（id / name / cost / attack / health /
  copies / ability）。
- `_constraints` — デッキ枚数・初手枚数・カード種数などの制約。
- `necromancer` — ネクロマンサーの定義（現状は空）。
- `cards` — カード8種の配列（現状は空）。

カードを定義するときは `_schema` に合わせ、`_constraints` を満たすこと
（合計30枚 / 8種 / 能力持ち4種 / 呪いは2枚）。

### 9.2 index.html のゾーン

view.js が描画する先の DOM は index.html に id で用意されている。
**index.html にゲームロジックを書かない。**

| id | 内容 |
|---|---|
| `opponent-hand` | 相手の手札（**枚数のみ**） |
| `opponent-board` | 相手の盤面 |
| `player-board` | 自分の盤面 |
| `player-hand` | 自分の手札 |
| `graveyards` | 墓地（自分 / 相手） |
| `captured` | 持ち駒ゾーン（公開） |
