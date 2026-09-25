# @nodemy-official/circuit-module

Nodemy の直流回路エディタ向け headless モジュールです。React、DOM、CSS に依存せず、回路のデータ型、編集操作、格子幾何、直流回路解析を提供します。

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

`CircuitDocument` は JSON として保存でき、編集関数は新しい document を返します。`analyzeCircuit(document, switchStates?)` はスイッチ状態を文書を書き換えずに試算できます。`./model`、`./edit`、`./geometry`、`./solver` からも個別に import できます。

解析対象は定常直流の電池、抵抗、電球、スイッチ、電流計、電圧計、接続点です。導線・閉スイッチ・電流計は微小抵抗、電圧計は開放として近似します。過渡現象、交流、熱による抵抗変化は扱いません。診断メッセージと部品名は現時点では日本語です。

## 開発と配布

```sh
npm install
npm run check
npm run build
npm pack --dry-run
```

配布先は `https://npm.pkg.github.com` に限定しています。GitHub Release を公開すると、Actions がテスト・ビルドを確認してから `GITHUB_TOKEN` で公開パッケージを発行します。Release の前に `package.json` の version と tag を一致させてください。ライセンス表記は抽出元に合わせて `UNLICENSED` です。
