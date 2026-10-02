# @nodemy-official/circuit-module

このパッケージは headless な回路図・アナログ解析ライブラリです。回路データ、編集操作、格子幾何、直流・小信号交流・過渡解析を提供し、任意で使える React UI も含みます。ロジックは React、DOM、CSS に依存せず利用できます。

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

## React UI（任意）

React UI は headless です。各モジュールは標準 CSS を自動で読み込まず、モジュール同士の配置は利用側で決めます。React と React DOM（18 または 19）は UI を使う場合にインストールしてください。ロジックだけを利用する場合は不要です。

### 自由に組み立てる

`CircuitEditor` は画面を描画しない状態 provider です。`children` に JSX または render prop を渡し、controller から必要なモジュールを好きな順番・場所に配置します。次の例では、部品パレット、基板、プロパティ、解析を独自の CSS グリッドに置いています。標準 CSS を import せず、このアプリ用の CSS と `slotProps` だけで見た目を定義できます。

```tsx
import { CircuitEditor, CircuitBoard, CircuitPalette, CircuitInspector, CircuitAnalysisPanel } from "@nodemy-official/circuit-module/ui";
import { createExampleCircuit, type CircuitDocument, type CircuitEndpoint } from "@nodemy-official/circuit-module/model";
import "./workbench.css";

function saveDraft(document: CircuitDocument) {
  localStorage.setItem("circuit-draft", JSON.stringify(document));
}

export function Workbench() {
  return (
    <CircuitEditor initialDocument={createExampleCircuit()} onDocumentChange={saveDraft}>
      {(editor) => {
        const part = editor.document.parts.find((item) => item.id === editor.selection.parts[0]);
        const wire = editor.document.wires.find((item) => item.id === editor.selection.wires[0]);
        const endpointLabel = (endpoint: CircuitEndpoint) => {
          const item = editor.document.parts.find((candidate) => candidate.id === endpoint.partId);
          const partName = item?.label || item?.id || "部品";
          return `${partName}の${endpoint.terminal === "a" ? "端子A" : "端子B"}`;
        };
        const wireEndpoints = wire ? { from: endpointLabel(wire.from), to: endpointLabel(wire.to) } : undefined;

        return (
          <main className="workbench">
            <header className="workbench__header">
              <h1>{editor.document.title}</h1>
              <button type="button" onClick={editor.undo} disabled={!editor.canUndo}>元に戻す</button>
              <button type="button" onClick={editor.redo} disabled={!editor.canRedo}>やり直す</button>
            </header>
            <CircuitAnalysisPanel
              className="workbench__analysis"
              analysis={editor.analysis}
              partCount={editor.document.parts.length}
              wireCount={editor.document.wires.length}
            />
            <CircuitPalette className="workbench__palette" onAdd={editor.add} />
            <CircuitBoard
              className="workbench__board"
              document={editor.document}
              selection={editor.selection}
              pendingEndpoint={editor.pendingEndpoint}
              pendingWire={editor.pendingWire}
              analysis={editor.analysis}
              onSelectPart={editor.selectPart}
              onSelectWire={editor.selectWire}
              onTerminalClick={editor.chooseTerminal}
              onConnectionStart={editor.startConnection}
              onReconnectStart={editor.startReconnect}
              onConnectionCancel={editor.cancelConnection}
              onBoardClick={editor.choosePoint}
              onMovePart={editor.movePart}
              onMoveEnd={editor.endEdit}
              onMoveCancel={editor.cancelMove}
              onWireRouteChange={editor.updateWireRoute}
              onWireRouteCancel={editor.cancelWireRoute}
              onWireRouteEnd={editor.endEdit}
              slotProps={{
                viewport: { style: { minHeight: 420 } },
                partLabel: { className: "workbench__part-label" },
                wireLine: { style: { stroke: "#475569" } },
              }}
              renderControls={({ zoom, showGrid, setShowGrid, zoomIn, zoomOut, resetZoom, fit, canZoomIn, canZoomOut }) => (
                <nav className="workbench__board-controls" aria-label="基板の表示">
                  <button type="button" onClick={zoomOut} disabled={!canZoomOut}>−</button>
                  <output>{Math.round(zoom * 100)}%</output>
                  <button type="button" onClick={zoomIn} disabled={!canZoomIn}>＋</button>
                  <button type="button" onClick={resetZoom}>100%</button>
                  <button type="button" onClick={fit}>全体表示</button>
                  <button type="button" aria-pressed={showGrid} onClick={() => setShowGrid(!showGrid)}>格子</button>
                </nav>
              )}
            />
            <CircuitInspector
              className="workbench__inspector"
              part={part}
              wire={wire}
              wireEndpoints={wireEndpoints}
              reading={part ? editor.analysis.parts[part.id] : undefined}
              onChange={editor.updatePart}
              onRotate={editor.rotateSelected}
              onDelete={editor.removeSelected}
              onReconnect={wire ? (end) => editor.startReconnect(wire.id, end) : undefined}
              onResetWireRoute={wire ? () => editor.resetWireRoute(wire.id) : undefined}
              onBlur={editor.endEdit}
              slotProps={{ fields: { className: "workbench__fields" } }}
            />
            {editor.error && <p className="workbench__error" role="alert">{editor.error}</p>}
          </main>
        );
      }}
    </CircuitEditor>
  );
}
```

`saveDraft` は `CircuitDocument` を受け取る保存処理です。端子の丸からドラッグするか、端子を順にクリックすると導線をつなげられます。接続中に既存の導線をクリックすると、その途中に分岐を追加します。導線の端の丸をドラッグするか、Inspectorのボタンで端を選んでから端子をクリックすると接続先をつなぎ替えられ、端子の近くで接続先に吸着します。`Esc` で接続を中断でき、確定した配線変更はUndoで戻せます。`CircuitBoard` に `pendingWire` と接続イベントを渡すと、部品ドラッグや空きマスへの接続点追加も動作します。`onMoveEnd` はドラッグをUndoの一操作として確定し、`onMoveCancel` はタッチでピンチへ切り替わったときに部品移動を戻します。

選択した導線は線上、または四角い区間ハンドルをドラッグして経路を調整できます。水平区間は上下、垂直区間は左右へ動き、区間ハンドルを選ぶと矢印キーでも調整できます。Shift + 矢印キーは5マス移動し、Escで経路ドラッグを取り消せます。手動経路はJSON保存に含まれ、Inspectorの「自動配線に戻す」で自動ルートへ戻せます。導線を選ぶとInspectorにも操作方法が表示されます。

独自UIで導線経路を管理する場合、`CircuitBoard` の `onWireRouteChange(id, waypoints?)` で更新を保存し、`onWireRouteCancel(id)` で取消時に変更を戻し、`onWireRouteEnd()` でドラッグを確定します。`useCircuitEditor` controller の `updateWireRoute`、`cancelWireRoute`、`resetWireRoute` はこの流れを扱います。`CircuitInspector` の `onResetWireRoute` は選択中の手動経路を自動配線へ戻し、`onReconnect` と `wireEndpoints` は再接続操作とボタンの端子名を設定します。`onBlur={editor.endEdit}` は値の連続編集を一操作にまとめます。解析は `editor.analysis` から参照し、失敗理由は `editor.error` に表示できます。

`CircuitEditor` の `children` は通常の `ReactNode` でも、`(editor) => ReactNode` の render prop でも構いません。render prop を使わず子孫から状態を読む場合は `useCircuitEditorContext()` を使えます。`initialDocument` は初期値、`onDocumentChange` は変更通知です。controller が持つ `document`、`selection`、`pendingEndpoint`、`pendingWire`、`analysis`、`error` と、追加・選択・接続・つなぎ替え・移動・回転・削除・Undo/Redo などの操作を組み合わせてください。provider を使わず hook を直接使いたい場合は、従来どおり `useCircuitEditor(initialDocument?)` を利用できます。

### 標準の見た目を使う

標準レイアウトは preset として分離されています。利用するアプリだけが CSS と preset を明示的に import します。

```tsx
import { CircuitEditor } from "@nodemy-official/circuit-module/ui";
import { CircuitEditorLayout } from "@nodemy-official/circuit-module/ui/preset";
import "@nodemy-official/circuit-module/ui/styles.css";

export function App() {
  return <CircuitEditor><CircuitEditorLayout /></CircuitEditor>;
}
```

標準レイアウトの右サイドバーは「プロパティ」「解析」「波形」のタブに分かれています。部品や導線を選ぶと「プロパティ」で値や接続を編集でき、「解析」では定常解析と接続チェック、「波形」では過渡解析・エネルギー・交流応答・回路比較を確認できます。キャンバス下部の解析状態を選ぶと「解析」タブが開きます。幅の狭い画面では下部ナビゲーションの「詳細」からサイドバーを開きます。

### ブロックのレンダリング結果に埋め込む

`CircuitPreview` は preset の標準 CSS を使う、編集ナビゲーションのないインラインプレビューです。親の幅に合わせて表示し、`style` の `--circuit-preview-height` で基板の高さを任意に指定できます。埋め込みプレビュー自身が内側に20pxの余白を持つため、親に余白を追加する必要はありません。余白を親で管理する場合は、root の `style={{ padding: 0 }}` で内側余白をなくせます。以下ではブロックの版が変わったときに `key` を更新し、`initialDocument` から試行値を作り直します。プレビュー内での値の変更は親の文書へ反映されません。

```tsx
import { CircuitPreview } from "@nodemy-official/circuit-module/ui/preset";
import type { CircuitDocument } from "@nodemy-official/circuit-module/model";
import "@nodemy-official/circuit-module/ui/styles.css";

function CircuitBlockResult({
  blockId,
  revision,
  document,
}: {
  blockId: string;
  revision: number;
  document: CircuitDocument;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <CircuitPreview
        key={`${blockId}:${revision}`}
        initialDocument={document}
        data-theme="dark"
        style={{ "--circuit-preview-height": "320px" }}
      />
    </div>
  );
}
```

高さを指定しない場合は、親の幅に応じた高さ（280〜400px）が使われます。グリッドや flex の子に置く場合は、親の項目にも `min-width: 0` を設定すると内容が親の幅に収まります。`data-theme="dark"`、または祖先の `.dark` / `[data-theme="dark"]` でダークテーマを指定できます。テーマ指定がない場合の既定はライトです。試行値はマウント中に保持されるため、表示するブロックやその内容を差し替える際は、例のように変化する ID や版を `key` に含めてください。

プレビューに表示する要素は `previewFeatures` で選べます。`CircuitPreview` と `CircuitEditorLayout` の両方で使え、各項目は省略すると有効になります。`ac` だけは既定で自動判定され、交流電源を含む回路、または交流解析を選んだときに交流向けの機能を表示します。

| 項目 | 表示内容 |
| --- | --- |
| `title` | 回路名 |
| `summary` | 基板上とダイアログ内の解析概要 |
| `parts` | 部品一覧、部品の調整、基板上の部品確認・スイッチ操作 |
| `analysisSettings` | ダイアログ内の「解析設定」タブ |
| `learning` | 学習ビュー全体。`false` にすると以下の学習機能もすべて隠す |
| `transient` | 過渡波形 |
| `energy` | 電力・エネルギー |
| `comparison` | 元の回路との比較 |
| `ac` | 交流向け機能。`true` / `false` で固定、`"auto"` で回路と解析設定から判定 |

`learning` を有効にしても、`transient`、`energy`、`comparison`、`ac` がすべて無効なら空の学習ビューは表示されません。`parts: false` は部品一覧だけでなく、基板上の部品確認・スイッチ操作も隠します。`ac: false` は交流向けツールの表示だけを切り替え、解析モードや計測値は変更しません。型は `@nodemy-official/circuit-module/ui/preset` の `CircuitPreviewFeatures` から import できます。

回路図だけを表示する場合は、他の表示項目をすべて無効にします。基板の流れ・電位表示やコントロールも隠すには `boardProps` を使います。

```tsx
import { CircuitPreview, type CircuitPreviewFeatures } from "@nodemy-official/circuit-module/ui/preset";

const boardOnly = {
  title: false,
  summary: false,
  parts: false,
  analysisSettings: false,
  learning: false,
} satisfies CircuitPreviewFeatures;

<CircuitPreview
  initialDocument={document}
  previewFeatures={boardOnly}
  boardProps={{ showFlow: false, showPotentials: false, renderControls: null }}
/>
```

個別に選ぶ例では、タイトルと部品操作を隠し、解析概要と過渡波形を表示します。交流向けの機能は自動判定に任せます。

```tsx
const lessonFeatures = {
  title: false,
  summary: true,
  parts: false,
  analysisSettings: false,
  learning: true,
  transient: true,
  energy: false,
  comparison: false,
  ac: "auto",
} satisfies CircuitPreviewFeatures;

<CircuitPreview initialDocument={document} previewFeatures={lessonFeatures} />
```

標準スタイルは任意です。`/ui/styles.css` は全スタイル、`/ui/board.css` は基板、`/ui/editor.css` はエディターと各パネル用です。どれも必要なものだけを import できます。モジュールの root には `className`、`style`、HTML 属性を渡せます。内部要素は `slotProps` の `className` と `style` で調整します。root と slot の `style` では CSS カスタムプロパティも型キャストなしで指定できます（例: `style={{ "--circuit-accent": "#7c3aed" }}`）。全 slot 名は公開型 `CircuitBoardSlot`、`CircuitPaletteSlot`、`CircuitInspectorSlot`、`CircuitAnalysisPanelSlot` に定義されています。部品・導線・端子の `data-selected` / `data-pending` や、パネルの `data-state` / `data-status` を使い、状態に応じた CSS も書けます。`CircuitBoard` の `showFlow` を `true` にすると解析に基づく電流・電子の流れを表示できます（既定は `false`）。標準レイアウトではプレビュー中に自動で有効になります。

余白には `--circuit-space-1`〜`--circuit-space-6` と `--circuit-space-8`（順に 4/8/12/16/20/24/32px）、コントロールの高さには標準 `--circuit-control-height`（36px）、コンパクト `--circuit-control-height-compact`（32px）、タッチ `--circuit-control-height-touch`（44px）を使います。これらは各 CSS entry から自動で読み込まれるため追加の import は不要です。親要素に同名の CSS 変数を指定すると子 UI に継承され、アプリに合わせて調整できます。

`showPotentials` を `true` にすると、電位色を切り替えるチェックボックスと、2点間の電圧差・端子電流を確認する操作UIを表示します（既定は `false`）。電位色はチェックボックスで切り替え、初期状態ではOFFです。プレビューでも `boardProps` の `showFlow`、`showPotentials`、`renderControls` を尊重します。これらに `false`、`false`、`null` を渡すと、それぞれ流れ表示、電位表示、基板コントロールを隠せます。

流れ表示の凡例には、表示する向きを選ぶラジオボタンがあり、「電流のみ」（初期値）、「電子のみ」、「両方」を選べます。選択は粒子・凡例・導線の読み上げ説明に反映されます。`flow`、`flowParticle`、`flowLegend`、`flowKey`、`flowNote`、`flowPauseButton`、`flowDisplayControl`、`flowDisplayOption` slot と、`--circuit-board-current` / `--circuit-board-electron` CSS 変数で見た目を調整できます。

基本コントロールは `src/ui/primitives.tsx` の `@base-ui/react` ラッパーを使います。`Button`、`Input`、`NativeSelect`、`Switch`、`Tabs`、`Dialog` は `data-slot` と `circuit-ui-*` クラスを通じて標準 CSS の `--circuit-*` 変数に馴染みます。構成は [shadcn/ui の Base UI Button](https://ui.shadcn.com/docs/components/base/button) と [Dialog](https://ui.shadcn.com/docs/components/base/dialog) を参考にしています。shadcn/ui の参照実装は [MIT ライセンス](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md) です。

標準 CSS を読み込まないときは、各モジュールの DOM と SVG に必要なレイアウト・色・操作領域を利用側で定義します。基板では特に `viewport` の幅と高さ、`surface` の `touch-action: none`、部品・端子・導線の透明な hit 領域が必要です。独自 CSS の実用例は `stories/Headless.stories.tsx` と `stories/headless-story.css` にあります。標準 CSS は `@layer circuit` 内にあるため、利用側の通常の CSS で上書きでき、CSS 変数も親要素から継承できます。

従来のように `CircuitEditor` 一つで標準画面を出していた箇所は、provider の子に `<CircuitEditorLayout />` を置く形へ移行してください。画面の一部だけ使う場合は preset を使わず、必要な UI モジュールを配置します。`CircuitBoard` の `renderPart` では部品の SVG 表現を差し替えられ、`renderControls` ではズームや格子切り替え操作の見た目と並びを組み替えられます。標準コントロールは callback が `null` を返すか、`renderControls={null}` を渡して隠せます。

標準 preset は部品の追加・ドラッグ移動・回転・削除、端子接続、導線の経路調整とつなぎ替え、部品値の編集、解析結果の確認に対応します。キーボードでは `1`〜`7` で部品を追加し、`V` で選択ツール、`H` で移動ツールに切り替えます。選択中の部品は `R` で回転、`Delete` で削除できます。`⌘ / Ctrl + Z` で元に戻し、`⌘ / Ctrl + Shift + Z` でやり直します。`Esc` は選択や接続を解除します。UI を使わないアプリは `./model`、`./edit`、`./geometry`、`./solver` のみを利用できます。

標準エディターのヘッダーで「プレビュー」を押すと、回路の配置と配線を保ったまま試算できます。プレビューでは左右の編集サイドバーを隠し、回路図を全幅で表示します。通常部品はクリックまたは `Enter` / `Space` で選ぶと、調整値と計測値をダイアログで確認できます。スイッチはクリック、`Enter`、`Space` で切り替え、ダブルクリックまたは `Shift+Enter` で詳細を開きます。比較用の全部品一覧は初期状態で折りたたまれ、必要なときに展開できます。「元の値に戻す」は一覧を閉じたまま使えます。「解析・部品」ダイアログには部品一覧と「解析設定」タブがあり、狭い画面でも切り替えて確認できます。`previewFeatures` で「部品」や「解析設定」を個別に隠せます。部品ごと、または全体の試行値をリセットでき、ダイアログを閉じても値を保持します。編集に戻ると試行値は編集データへ反映されません。独自の画面で部品詳細を開く場合は `CircuitBoard` の `onInspectPart(partId)` callback を使えます。回路図の流れ表示は解析に基づき、オレンジの矢印が電流、青いマイナス粒と小さな矢印が電子の流れを表します。凡例の「表示する向き」では電流のみ、電子のみ、両方を選べ、選択に合わせてアニメーション・凡例・導線の読み上げ説明が切り替わります。ゼロ電流、開回路、短絡、解析不能時は粒が動きません。凡例で一時停止・再生を切り替えられ、`prefers-reduced-motion` が有効な環境では粒子を動かさず方向だけを表示します。速度と粒数は模式的な表現です。`Esc` または「編集に戻る」でプレビューを終了できます。

電位の色、時間カーソルに同期する複数波形、エネルギーや交流応答、プレビューでの変更前後比較の試し方は[回路の学習可視化](docs/learning-visualizations.md)を参照してください。

Storybook で操作とレンダリング結果を確認できます。

```sh
npm run storybook
```

### 回路ファイル、診断、複数選択

コア API から回路を版付き JSON に保存し、読み込めます。読み込みは JSON の形・部品種別・数値・端子参照を検証して新しい `CircuitDocument` を返します。以前の `CircuitDocument` をそのまま JSON 化した形式も読み込めます。外部データを使うときは `parseCircuitDocument` の結果を確認してから利用してください。

```ts
import {
  inspectCircuit,
  parseCircuitDocument,
  serializeCircuitDocument,
  type CircuitDocument,
} from "@nodemy-official/circuit-module";

function save(document: CircuitDocument) {
  return serializeCircuitDocument(document);
}

function load(json: string) {
  const result = parseCircuitDocument(json);
  if (!result.ok) { throw new Error(result.reason); }
  return result.document;
}

const diagnostics = inspectCircuit(load(save({ title: "例", parts: [], wires: [] })));
```

保存データは `{ "format": "circuit-module", "version": 1, "document": ... }` の envelope です。保存・読み込み上限は `MAX_CIRCUIT_DOCUMENT_JSON_LENGTH`（1,000,000 文字）、`MAX_CIRCUIT_DOCUMENT_PARTS`（10,000 個）、`MAX_CIRCUIT_DOCUMENT_WIRES`（20,000 本）、`MAX_CIRCUIT_DOCUMENT_COORDINATE`（座標の絶対値、格子セル単位）で公開しています。座標上限は `Number.MAX_SAFE_INTEGER / (GRID * 4)` で、基板のピクセル変換と座標差分が有限値に収まるよう設定しています。これらはファイル形式の上限で、solver が解析できる回路規模の保証ではありません。回路が未接続、未完成、または電源なしでもファイルとして保存できます。解析上の問題は `inspectCircuit(document)` で個別に確認します。利用可能な subpath は `@nodemy-official/circuit-module/serialization` と `/diagnostics` です。

headless の保存上限はエディターで読み込めるサイズとは別です。UI の `useCircuitEditor.importDocument()` は `MAX_CIRCUIT_EDITOR_PARTS`（256 個）と `MAX_CIRCUIT_EDITOR_WIRES`（1,024 本）を超えるファイルを拒否し、現在の document と履歴を保って controller の `error` に理由を設定します。同期描画と解析にかかる負荷を抑えるための制限です。headless `analyzeCircuit()` は `MAX_CIRCUIT_ANALYSIS_TERMINALS`（512 端子）を超えると `invalid` を返します。ファイル保存上限を解析可能サイズとみなさないでください。

標準の `<CircuitEditorLayout />` には「ファイル」メニューがあり、空の新規回路、JSON の読み込み、JSON のダウンロードに対応します。新規作成と成功した読み込みは Undo で戻せます。独自 UI では `useCircuitEditor` controller の `newDocument()`、`importDocument(json)`、`exportDocument()` を使えます。読み込みに失敗した場合は `importDocument` が `false` を返し、現在の document を保持します。

headless controller の `diagnostics` は `inspectCircuit` と同じ診断結果です。UI の `CircuitDiagnosticsPanel` は問題の部品・導線へ戻る選択ボタンを表示できます。標準 preset ではこのパネルを「接続チェック」として組み込んでいます。

対応機能の背景、公式資料との比較、実装済み機能の受け入れ条件は[回路エディター調査](docs/editor-research.md)にまとめています。

| 操作 | 標準 UI |
| --- | --- |
| 追加選択 | 部品または導線を Shift / Ctrl / Cmd を押しながらクリック |
| 範囲選択 | Shift を押しながら基板の空白をドラッグ。選択中へ追加 |
| 全選択 | Ctrl / Cmd + A |
| コピー / 切り取り / 貼り付け | Ctrl / Cmd + C / X / V |
| 複製 | Ctrl / Cmd + D |
| 保存 / 読み込み | Ctrl / Cmd + S / O |
| Undo / Redo | Ctrl / Cmd + Z、Ctrl / Cmd + Shift + Z または Y |
| 回転 / 削除 | R、Delete または Backspace |

複数部品を選んで移動・回転・削除できます。複数選択を回転すると、接続点を除く各部品がそれぞれの中心を基準に90度回り、選択全体の配置は回転しません。部品を削除すると、その部品に接続した導線も削除されます。コピーでは、両端が選択部品に含まれる導線も含めます。コピー、切り取り、貼り付け、複製は同じ `CircuitEditor` provider 内の内部クリップボードを使い、OS のクリップボードや別 provider とは共有しません。複製では部品・導線 ID と部品ラベルを再採番します。

`canCopy`、`canCut`、`canPaste` は別々の状態です。コピー可能かは選択部品があるか、貼り付け可能かは内部クリップボードに部品があるかを示します。明示選択した導線は両端の部品も選ばれている必要があり、満たさないと `canCut` は `false`、Ctrl / Cmd + X は理由を表示して何も削除しません。コピーされるのは選択部品と、両端がその選択に含まれる導線です。切り取りは部品削除と同様に接続導線を削除しますが、両端が選択されていない外部導線はコピーされず、貼り付け後も復元されません。Undo で元に戻せます。

`input` / `textarea` / `select` / `contenteditable` にフォーカス中は Ctrl / Cmd + S / O を回路ファイルの保存・読み込みとして処理します。Ctrl / Cmd + A / C / X / V / D / Z / Y や単独キーのエディター操作は入力欄では処理せず、各入力要素へ渡します。プレビュー中はファイル操作と編集用ショートカットが無効です。Esc で編集に戻れます。

独自基板では `CircuitBoard` の `onSelectPart(id, additive?)`、`onSelectWire(id, additive?)`、`onSelectRange(selection, additive?)` に controller の `selectPart`、`selectWire`、`selectRange` を渡します（例: `onSelectRange={editor.selectRange}`）。Shift / Ctrl / Cmd による追加選択は `additive` 引数で届きます。controller の `selectAll()`、`canCopy`、`canCut`、`canPaste`、`copySelected()`、`cutSelected()`、`paste()`、`duplicateSelected()`、`diagnostics` も独自 toolbar やパネルから使えます。

20種類の部品を配置でき、電池・交流電源・電流源、抵抗・電球・コンデンサ・コイル、可変抵抗、ダイオード・LED、BJT・MOSFET、オペアンプ、スイッチ・計器・接続点・GNDを扱います。定常の直流動作点と単一周波数の小信号交流解析に加え、時間波形を計算する過渡解析を利用できます。モデルの範囲と制約は[アナログ解析ガイド](docs/analog-simulation.md)を参照してください。診断メッセージと部品名は現時点では日本語です。

電流計は測定したい枝へ直列に、電圧計は測定対象の両端へ並列につなぐと、基板上に読み値が表示されます。直流では符号付きの値、交流では実効値と位相を表示します。未接続、値不定、未解析、解析不能、短絡のときは状態と理由を添えて「—」を表示します。独自 UI では `CircuitMeterReadout` に `kind`、`reading`、`analysisStatus` を渡して標準の計器表示を使えます。表示内容だけを取得する場合は `getMeterDisplay(...)` を利用できます。

## 開発と配布

```sh
npm install
npm run check
npm run build
npm run build-storybook
npm run build-storybook:test
npm pack --dry-run
```

コード品質チェックには Ultracite の Biome preset を使っています。`npm run lint` で lint、`npm run format` でフォーマットできます。`npm run check` は lint、型チェック、テストを実行します。

`npm run build-storybook` は Docs を含む Storybook の静的ビルドで、CI でも検証します。操作確認用のアセットを速く生成する場合は `npm run build-storybook:test` を使えます。この test build は Docs を省略して `storybook-static/test` に出力しますが、自動ブラウザテストは実行しません。詳しくは[Storybook の build 設定](https://storybook.js.org/docs/api/main-config/main-config-build)と[telemetry 設定](https://storybook.js.org/docs/configure/telemetry)を参照してください。

テストは `npm test` で全件、`npm test -- --project headless` でヘッドレス処理、`npm test -- --project ui` で React UI を実行できます。Vitest は単一ワーカーのスレッドプールで実行し、`src/**/__tests__/**/*.test.ts` はワーカー内でモジュールを再利用します。このため、ヘッドレスのテストでは共有モジュールやグローバル変数への変更を残さないでください。`src/**/__tests__/**/*.test.tsx` はファイルごとに分離し、操作テストの jsdom とサーバーレンダリングテストの Node 環境を使い分けます。

ヘッドレスのテストは `src/__tests__/` の下で検証対象ごとにまとめています。`analog-solver/`、`circuit-solver/`、`transient-solver/` に各ソルバー、`numerics/` に数値基盤、`circuit-analog-adapter/` に公開 API への変換、`circuit-visualization/` に表示用の解析、`simulation-input/` に入力検証、`integration/` に複数の API・解析モード間の整合性を置きます。モデル・編集・幾何・診断・シリアライズ・例題の基本テストは直下に残します。ファイル名は検証対象を表し、調査時の `audit`・`review`・`subagent` といった名前は使いません。

対象を絞る場合は、例えば `npm test -- --project headless src/__tests__/transient-solver` で過渡解析、`npm run check:numerics` で数値契約と数値ポリシーを検証できます。回路の生成処理は `src/__tests__/helpers/`、UI 操作テストの環境準備と後片付けは `src/ui/__tests__/helpers/` に置きます。期待値には独立した有理数オラクルや物理式・保存則を使い、共通化の際もソルバーの演算関数から期待値を求めたり許容誤差を広げたりしません。

配布先は `https://npm.pkg.github.com` に限定しています。GitHub Release を公開すると、Actions がテスト・ビルドを確認してから `GITHUB_TOKEN` で公開パッケージを発行します。Release の前に `package.json` の version と tag を一致させてください。ライセンス表記は抽出元に合わせて `UNLICENSED` です。
