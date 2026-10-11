# 指示文の点検（necro-cardgame）

> 実施：2026-10-11 23:10 JST ／ HEAD `fce8530`（origin/main と一致、左右とも0）
> 道具：Claude Code 2.1.296 の同梱スキル `claude-api` の `prompt-audit`（`shared/prompt-audit.md` の手順）。手本は guild-log-mock の `docs/audit/2026-10-11-prompt-audit-diff.md`。
> 扱い：**事実の訂正だけ当てる**。書き方・強調・重複は、仕組みの棚卸しの①発火実績と②要否のあとに決める（作者の指示 2026-10-11）。session-end スキルに関わる指摘は写しを直さず、マスターの一覧にためる。

## 0. 前提

- 範囲：`CLAUDE.md`（292行）と `.claude/skills/session-end/SKILL.md`（450行）。ほかのスキル・サブエージェント・コマンド・AGENTS.md・規則ファイルは無い（`git ls-files` で確認）。`.claude/settings.json` は読んでいない。
- 対象モデル：Sonnet 5.5（`.claude/settings.json` の `model: sonnet` で、2026-10-11 からこのリポジトリのセッションが使う）。
- 既定ブランチは main（`git remote show origin`）。旧既定ブランチ `claude/card-game-repo-scaffold-fhye9a` は origin に無い。CLAUDE.md と SKILL.md に旧ブランチ名の記述は残っていない（`grep` で確認）。

## 1. 実際に試したこと（使い捨ての worktree で実行）

| コマンド・確認 | 結果 |
|---|---|
| `node js/engine.js` | 122件すべて成功、exit 0 |
| `node js/ai.js` | 10件すべて成功、exit 0 |
| `node tools/compare_v03.js` | 16秒で完了、「決定性 true」。`docs/research/` の CG-021 の表を上書きする（HEAD とタイムスタンプの行が変わる） |
| `node tools/compare_king.js` | 40秒で完了、「CG-021 との一致: true」「決定性 true」。`docs/research/` の CG-022 の表を上書きする |
| `node tools/simulate.js` | 500戦（シード 1000〜1499）の要約が出る。CLAUDE.md の「1回まわして要約を出す」と一致 |
| 構成の確認 | §5 の木と `git ls-files`：`js/`・`data/`・`tools/` の5本・`legacy/v0.2`・`docs/` の7本は一致。ルートの `README.md` は §5 に無い（欠けているだけで誤りではない） |
| 型の確認 | §2.2 の例の action 型（`move`・`place`・`placeDefector`・`draftPick`）は engine に実在。§2.8 の読み込み順（データ → engine → ai → view）は `index.html` と一致 |
| 「中身は素の JSON」（§2.7） | `data/cards.js`・`data/ai.js` とも、先頭の `var` 行と末尾の `module.exports` を除いた本体が `JSON.parse` で読める |
| タグ | `v0.2-final` は `7f78c8f` を指す。CLAUDE.md の記述と一致 |

## 2. 試して見つけた穴

### H1：ソース検査は、CLAUDE.md が禁じる範囲の一部しか見ていない（確度：中）

CLAUDE.md §2.8 の最後に「この規約は `node js/engine.js` のセルフテストがソース検査で見張っている」とある。実物（`js/engine.js:1287-1311`）が見るのは **`js/engine.js`・`js/view.js`・`js/ai.js`・`index.html`・`package.json` だけ**で、`data/*.js` と `tools/*.js` は対象外。実際に試した結果：

| 差し込み | 検査の結果 |
|---|---|
| `tools/harness.js` に `Math.random()` を足す | **通る**（122件すべて成功、exit 0） |
| `data/ai.js` に `Math.random()` を足す | **通る** |
| `data/cards.js` に `import x from "y"` を足す | 落ちる。ただしソース検査ではなく、Node が読み込めずに落ちている |
| `package.json` に `"type": "module"` を足す | 落ちる（検査が見ている） |

§2.4 は「`Math.random()` の使用は禁止」と書く。測定ツール（`tools/`）はシードで再現できることが前提なので、ここに入ると再現性が崩れる。検査を `data/` と `tools/` に広げるのは**コードの変更**なので、ここでは当てない。

## 3. 指摘

| # | 場所 | 指摘 | 種別 | 確度 | 扱い |
|---|---|---|---|---|---|
| C1 | `CLAUDE.md` §4.1 と `.claude/skills/session-end/SKILL.md`（停止時の形式・完了時の形式） | 停止するときの形式が2つある。CLAUDE.md は「A（推奨）／B／トレードオフ／却下済み」、SKILL は7項目で「→ A / B / C（前提が違う）」を末尾に付ける。完了時も、CLAUDE.md の「実装を終えたとき」の雛形と SKILL の5項目が別 | 指示文どうしの食い違い | 高 | **当てない**（規則どうしの食い違い。どちらを正とするかは作者の裁定。下の質問Q1） |

事実の訂正（古いパス、実物と合わない件数や引数、動かないコマンド）は **0件**。

## 4. 当てたもの

なし。**CLAUDE.md は変えていない**（点検の記録だけを置く）。SKILL.md の写しも直していない。

## 5. 作者に聞くこと

- Q1（C1）：停止・完了の報告の形は、CLAUDE.md §4.1（遠征の EX 形式に揃えた形）と SKILL（運用規約の7項目・5項目）のどちらを正とするか。現状の運用は、実装の報告は §4.1 の形（CG-021〜023 の報告）。SKILL の形は session-end のときだけ使う。
