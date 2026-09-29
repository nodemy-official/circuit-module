# Repository Guidelines

## プロジェクト構成

`src/` に headless の回路モデル、編集・解析ロジック、任意利用の React UI（`src/ui/`）があります。テストは `src/__tests__/` または `src/ui/__tests__/` に置き、`*.test.ts` をロジック用、`*.test.tsx` を React UI 用として使います。Storybook の例は `stories/`、設定は `.storybook/`、設計・解析資料は `docs/` にあります。`dist/` は生成物なので直接編集しません。

## ビルド・テスト・開発コマンド

Node.js 22 以降を使います。Bun の lockfile があり、CI は `bun ci` で依存関係を復元します。`bun run check` は lint・型チェック・テスト、`bun run build` はパッケージ、`bun run build-storybook` は Storybook の静的サイトを生成します。`bun run storybook` でポート 6006 に開発用 UI を起動できます。CI では `npm pack --dry-run --ignore-scripts` で梱包内容も確認します。

## コードスタイルと命名

既存の TypeScript / React コードに合わせ、インデントは 2 スペース、文字列はダブルクォート、値は `camelCase`、コンポーネントと型は `PascalCase` にします。Ultracite preset を使う Biome が lint を担当します。`bun run lint` で確認し、`bun run format` で整形してください。ファイル名は隣接する実装・テストの規則に合わせます。

## テスト

Vitest を使います。ロジックのテストは `src/__tests__/` または `src/ui/__tests__/` に `*.test.ts`、React UI のテストは `src/ui/__tests__/` に `*.test.tsx` として配置します。`npm test` で全件を実行し、`npm test -- --project headless` と `npm test -- --project ui` で各プロジェクトを個別に実行できます。`bun run check` にも全テストが含まれます。

## コミットとプルリクエスト

最近のコミット見出しは “Add …” や “Improve …” のような簡潔な英語の命令形です。それ以外の形式規約は確認できません。CONTRIBUTING ガイドや PR テンプレートはありません。PR には変更内容と実行した確認を記し、UI の変更はレビューに役立つ場合に画面例を添えてください。

## 数値計算の変更

積和・比・複素演算には `analog-math.ts` と `exact-linear-algebra.ts` の共通関数を使い、途中で表示用の `number` へ丸めて計算に戻さないでください。指数・三角関数など近似が必要な境界は、その理由と誤差の扱いを明記してください。

`Float64Array` の内部状態には厳密値が別途保持されています。更新には `setRealStateValue` / `addRealStateValue`、複製には `cloneRealState` を使います。直接代入や通常の配列コピーによる厳密値の欠落は `scripts/numeric-policy.mjs` が検出します。生配列を扱えるのは数値基盤の2ファイルだけです。検査を回避する型キャストや例外の追加で解決しないでください。

数値基盤を変更したら `bun run check:numerics` と `bun run check` を実行します。期待値に検証対象と同じ演算関数を使わず、独立した有理数オラクルや回路の保存則で確かめます。微小値を0と誤認する絶対許容差の拡大でテストを通さないでください。

## エージェント向け指示

作業とやり取りは日本語で行います。簡単な作業はサブエージェントに委譲し、ユーザーから依頼されない限りブランチを切り替えません。シェルコマンドは必ず `rtk` で始め、コマンド実行時は `@/Users/suzumiyaaoba/.codex/RTK.md` の指示に従ってください。
