# @nodemy-official/circuit-module

直流回路のデータ型、編集操作、格子幾何、解析と、任意で使える React 製エディター UI を提供します。ロジックは React、DOM、CSS に依存せず利用できます。

## 導入

GitHub Packages の認証を設定した環境でインストールします。

```ini
@nodemy-official:registry=https://npm.pkg.github.com
```

```sh
npm install @nodemy-official/circuit-module
```

## 使用例

```ts
import {
  addPart,
  analyzeCircuit,
  connect,
  createExampleCircuit,
} from "@nodemy-official/circuit-module";

const initial = createExampleCircuit();
const analysis = analyzeCircuit(initial);
console.log(analysis.status, analysis.currentAmps);

const added = addPart(initial, "resistor", { x: 30, y: 8 });
if (added.ok) {
  const next = connect(added.document, { partId: "part-1", terminal: "a" }, {
    partId: added.id,
    terminal: "a",
  });
  if (next.ok) console.log(analyzeCircuit(next.document));
}
```

編集関数は新しい document を返します。`analyzeCircuit(document, switchStates?)` はスイッチ状態を文書を書き換えずに試算できます。`./model`、`./edit`、`./geometry`、`./solver` からも個別に import できます。

## エディター UI

React を使うアプリでは、`./ui` から組み立て済みのエディターを表示できます。React と React DOM（18 または 19）は UI を利用する場合にインストールしてください。ロジックのみを利用する場合は不要です。

```tsx
import { CircuitEditor } from "@nodemy-official/circuit-module/ui";

export function App() {
  return <CircuitEditor />;
}
```

`CircuitEditor` では部品の追加・ドラッグ移動・回転・削除、端子同士や空きマスへの接続、部品値の変更、解析結果の確認ができます。部品はパレットの検索から選べ、追加すると表示中の回路図の中央付近に配置されます。初期文書を渡すには `initialDocument`、編集結果の受け取りには `onDocumentChange` を使います。ドラッグとフィールド編集はそれぞれ一操作として記録され、元に戻す・やり直すで取り消せます。

キーボードでは `1`〜`7` で部品を追加し、`V` で選択ツール、`H` で移動ツールに切り替えます。選択中の部品は `R` で回転、`Delete` で削除できます。`⌘ / Ctrl + Z` で元に戻し、`⌘ / Ctrl + Shift + Z` でやり直します。`Esc` は選択や接続を解除します。

キャンバスは移動ツール、Space＋ドラッグ、またはマウスの中ボタンで移動できます。ホイールやトラックパッドでは表示位置を移動し、Ctrl／⌘＋ホイールやピンチではポインター位置を中心にズームできます。「回路全体を表示」ボタンで表示位置を戻せます。編集キャンバスの格子表示は、ツールバーから切り替えられます。スマートフォンでは画面下部のナビゲーションから「部品」「回路図」「プロパティ」を切り替えられます。

配置や組み合わせを変える場合は、`CircuitBoard`、`CircuitPalette`、`CircuitInspector`、`CircuitAnalysisPanel` を個別に import し、`useCircuitEditor(initialDocument?)` の状態と操作を渡してください。`CircuitBoard` の `renderPart` で部品の SVG 表現も差し替えられます。CSS カスタムプロパティで色を調整できます。UI を使わないアプリは従来どおり `./model`、`./edit`、`./geometry`、`./solver` のみを利用できます。

Storybook で操作とレンダリング結果を確認できます。

```sh
npm run storybook
```

解析対象は定常直流の電池、抵抗、電球、スイッチ、電流計、電圧計、接続点です。導線・閉スイッチ・電流計は微小抵抗、電圧計は開放として近似します。過渡現象、交流、熱による抵抗変化は扱いません。診断メッセージと部品名は現時点では日本語です。

## 開発と配布

```sh
npm install
npm run check
npm run build
npm run build-storybook
npm pack --dry-run
```

配布先は `https://npm.pkg.github.com` に限定しています。GitHub Release を公開すると、Actions がテスト・ビルドを確認してから `GITHUB_TOKEN` で公開パッケージを発行します。Release の前に `package.json` の version と tag を一致させてください。ライセンス表記は抽出元に合わせて `UNLICENSED` です。
