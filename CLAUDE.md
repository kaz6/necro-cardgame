# CLAUDE.md

持ち駒カードゲーム（仮）— HTML/JS モック。

このファイルは AI エージェント向けの作業契約書。**変更する前に必ず読むこと。**

---

## 0. Notion ページID

★ **検索で当てにいくことを禁止。必ずこの表から引くこと。**
「DECISION_LOG」「SESSION_STATE」「CURRENT_SPEC」は**他企画にも同名ページが実在する**ため、
検索すると別企画のページを踏む。

| ページ | ID |
|---|---|
| 親（持ち駒カードゲーム（仮）） | `3b8a8a5d-fd45-81b7-a681-fe882d78be64` |
| DECISION_LOG | `3b8a8a5d-fd45-8118-9c7f-fe1776262d0d` |
| CURRENT_SPEC | `3b8a8a5d-fd45-81bd-b087-d9e61a87148d` |
| 却下案索引 | `3b8a8a5d-fd45-8153-86b2-ec2c8cae40c4` |
| SESSION_STATE | `3b8a8a5d-fd45-81de-aeb2-f19d5c5275d1` |
| _tasks（実装タスク） | `3b8a8a5d-fd45-8197-9f70-d0e222660c63` |
| 参照資料（調査・先行事例） | `3b8a8a5d-fd45-8132-90f6-d1df64f99c8c` |
| 更新履歴 | `3b8a8a5d-fd45-81b3-8cf6-ef46ee0cff78` |

タスク番号の接頭辞は **`CG-`**。新しいタスクを作る前に、必ず `_tasks` の進行中一覧を見ること。

---

## 1. このリポジトリの位置づけ

- **正本（Single Source of Truth）は Notion。** `docs/` はその AI 可読ミラーである。
- Notion と `docs/` が食い違った場合、**Notion が正しい**。docs 側を直す。
- `docs/` を勝手に「正史」として書き換えない。ミラーの更新は人間の指示に従う。
- **本企画は SESSION_STATE・CURRENT_SPEC とも Notion が正本**（天使様と同じ扱い）。
  遠征ギルドログとは向きが逆なので、あちらの記述をそのまま当てないこと。
- ★ 将来、engine が仕様の実体になった時点で CURRENT_SPEC を repo 正本へ反転させる。
  **反転の判定は人が行う。勝手に反転しないこと。**
- セッション終了の手順は `.claude/skills/session-end/SKILL.md` に従う。

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

### 4.1 報告フォーマット — 遠征ギルドログ（EX）と同じ構造で出す

**報告は遠征ギルドログの EX タスクと同じ構造にする。** この企画だけ別形式にしない。
出典は 02_operations の運用規約と、EX-052 をはじめとする実際の EX タスクページ。

#### 実装を終えたとき

```markdown
# 実装（対象・裁定X があれば併記）
**YYYY-MM-DD HH:MM〜HH:MM JST ／ HEAD `hash`（前は `hash`）／ 実行条件・件数**

## やったこと
- （何をどう変えたか。★ で要点を立てる）
- （裁定どおりか、どこを裁定外にしたか）

## 検証
| 完了条件 | 結果 |
|---|---|
| （条件） | ✅ / ⚠️ 未達（数字つきで） |

## 数字
| | 前 `hash` | 後 `hash` |
|---|---|---|
| （指標） | （値） | （値） |

## commit
- `hash` （メッセージ）

## 記録した一般則
- ★ （次に効く形で1行。なければ節ごと省く）
```

#### 判断が要って止まるとき

```markdown
## ★ 停止：（論点の名前）
**論点：**（何が決まっていないか。1行）

### A（推奨）：（案）
- 利点：
- 欠点：★

### B：（案）
- 利点：
- 欠点：

**トレードオフ**：A＝… ／ B＝…
**却下済み**：（該当する却下案と、その理由がこの場合に及ぶか。なければ「なし」）
```

#### 規則

- **測定値には日付・時刻・HEAD ハッシュを必ず併記する。** 3点そろわない数値は
  「いつのものか不明」として扱い、判断の根拠にする前に測り直す。
- **実施日時は推測しない。** `TZ=Asia/Tokyo date` で取り直す。
  チャット側は現在時刻を持たないため、報告の日時が時系列の基準になる。
- **未検証のものを「完了」と書かない。** 検証欄に未達を数字で書く。
- **指示からはみ出した点・未対応の欄を空にしない。** なければ「なし」と書く。
- **勝手に決めた判断は停止ブロックに出す。** 指示のツリーから外れた追加や、
  指示になかった項目の補完は、黙って進めない。
- **却下済みの案を機械的に適用しない。** 却下の理由がこの場合にも及ぶかを先に確かめる
  （EX-052 の攻撃行の例）。

### 4.2 共有欄 — 最後に必ず1つ出す

報告の末尾に、**どこに書いたかとサマリー**をまとめて出す。セッション中に何度報告しても、
共有欄は**最後の1つだけ**。

報告ブロックが「裁定のための要約」なのに対し、共有欄は**後から追うための手がかり**。
役割が違うので**両方出す**（置き換えではない）。

```markdown
■ 共有欄（対象／YYYY-MM-DD HH:MM JST）

Notion 反映先
・ページ名 ID
  → 書いた節 / 状態
・（以下、書いた先すべて）

サマリー
・何をしたか（数行）
・未反映・未対応（なければ「なし」）
・commit
```

- **Notion に書いていないものを反映先に書かない。** 未反映なら状態欄に明記する。
- **リンクは実 URL かページ ID で書く。** ページ名だけにしない。

---

## 5. ディレクトリ

```
/
├ CLAUDE.md          このファイル
├ index.html         モックのエントリポイント
├ .claude/skills/
│  └ session-end/SKILL.md   セッション終了手順（マスターは Notion 02_operations）
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
│  └ cards.json      カード定義 + ルールフラグ（数値・効果はすべてここ）
├ js/
│  ├ engine.js       純粋なゲームロジック（DOM 非依存）
│  └ view.js         描画のみ
├ tools/             計測用ハーネス（engine を使う。view には依存しない）
│  ├ simulate.js     ランダムAI同士の自動対戦と集計
│  └ report.js       集計を docs/research/ の Markdown に書き出す
└ package.json       `{"type":"module"}` のみ。engine.js を Node で直接実行するため
```

---

## 6. 検証のしかた

```
node js/engine.js          # engine のセルフテスト（非破壊性・決定性・視点フィルタ・ルール）
python3 -m http.server     # index.html を開いてホットシート対戦
```

`node js/engine.js` が通らない変更は入れないこと。

**未確定ルールはハードコードせず `data/cards.json` の `rules` に足してフラグ化する。**
仮ルール・正本の矛盾に対する解釈は、すべてここで切り替えられる状態を保つ。
