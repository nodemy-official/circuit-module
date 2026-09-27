# 回路を読み解くための可視化

回路図は部品と接続を表しますが、電位、分岐電流、時間による変化、エネルギーの行き先は図だけでは読み取れません。このガイドでは、標準 UI と headless UI を使ってそれらを可視化する方法を説明します。

## 標準エディターで使う

標準レイアウトを使うと、基板上の電位表示、解析条件、波形やエネルギーの学習パネルをまとめて利用できます。

```tsx
import { CircuitEditor } from "@nodemy-official/circuit-module/ui";
import { CircuitEditorLayout } from "@nodemy-official/circuit-module/ui/preset";
import { createCircuitExample } from "@nodemy-official/circuit-module";
import "@nodemy-official/circuit-module/ui/styles.css";

export function CircuitLesson() {
  return (
    <CircuitEditor initialDocument={createCircuitExample("charging")}>
      <CircuitEditorLayout />
    </CircuitEditor>
  );
}
```

編集画面の基板上部にある「表示設定」から「電位を色で表示」を選ぶと、同じ導線でつながる端子を同じ電位の色で示します。「電位差・電流の分配」を開くと、基準点と測定点を選び、その差と測定点につながる部品端子の電流を確認できます。交流解析では電位と電流を実効値と位相で扱います。

右側の「解析」タブでは定常解析のモードと周波数、解析結果、接続チェックを確認できます。「波形」タブには時間波形・過渡解析、電力とエネルギー、交流の波形と周波数応答、変更前後の比較をまとめています。部品を選ぶと「プロパティ」タブから値を編集できます。プレビュー中は基板の下に「学習ビュー」が表示され、編集前の回路を基準に過渡波形と部品値変更の影響を見られます。プレビュー中に調整した値は編集データへ反映されません。

標準 UI の構成や CSS の読み込み方法は [README](../README.md) を、部品モデルと解析上の制約は[アナログ解析ガイド](analog-simulation.md)を参照してください。

## 表示から読み取れること

| 可視化 | 学べること |
| --- | --- |
| 電位の色と2点間の電位差 | 電圧が2点の差であること、基準点を変えると電位の値が変わること |
| 部品端子ごとの電流 | 分岐への流入と流出、電流の大きさ、節点で電流がつり合うこと |
| 時間波形と時間カーソル | 設定した初期状態からの過渡変化、同じ時刻に各部品の電圧・電流がどうなるか |
| 電力と蓄積エネルギー | 電源が供給する電力、部品が吸収・放出する電力、コンデンサやコイルに蓄えられるエネルギー |
| 交流波形と周波数応答 | 電圧と電流の位相差、周波数による回路応答の変化 |
| 部品値の変更前後 | 変更した値が各部品の電圧・電流・電力に与える影響 |

電位の色の上限は表示尺度です。上限を超えた値は同じ色になるため、具体的な値は端子ラベルと「電位差・電流の分配」の表示で確認してください。基準電位が決まらない部分は着色されません。

電流の分配表示は部品の端子で解析した電流を使います。理想導線だけでできたループでは導線ごとの電流が一意に決まらないことがあるため、導線内の電流を推測して表示しません。従来7種類だけの直流回路を除き、拡張解析の導線電流も未計算です。

電力の符号は表示ごとに次の規約です。

- 「電力とエネルギー」では電源の供給を正、吸収を負として表示します。その他の部品は吸収を正、放出を負として表示します。
- 「部品値変更の影響を比較」では独立電源の供給を正、その他の部品の吸収を正として表示します。表に符号の意味も表示します。
- `analyzeCircuit()` の定常解析結果は受動部品の吸収と独立電源の供給を正にそろえます。低レベルの `analyzeAnalogCircuit()` と過渡サンプルは、すべての部品で吸収を正にします。

交流の電圧・電流は実効値（RMS）で、位相は度で示します。「交流の波形と周波数応答」は実効値と位相から1周期の正弦波を描き、周波数応答の掃引では現在の解析周波数の周辺を対数間隔で計算します。掃引時は現在の解析周波数に一致する交流電源の周波数を同時に変え、振幅と位相を保ちます。異なる周波数の電源はその掃引で励振しません。交流の電力は平均有効電力です。コンデンサとコイルの蓄積エネルギーは交流成分の周期平均を表示します。

過渡解析では選択した時刻の値は瞬時値です。交流電源も時間領域では正弦波として評価します。回路図上部の「表示設定」から「電位を色で表示」を有効にし、「電力とエネルギー」を使うと、同じ時間カーソルで波形の一点と回路の状態を対応付けられます。

スイッチや部品値を変更した場合は、設定した初期電圧・初期電流から波形を再計算します。再生途中にスイッチイベントを挿入する機能ではありません。

比較では同じ ID かつ同じ種類の部品だけ差分を計算します。追加・削除・種類変更の行は基準値と現在値を示し、差分対象外とします。解析が無効、直流と交流のモードが異なる、交流周波数が異なる、または瞬時値と定常値を組み合わせたときは差分を出しません。欠けている値や有限でない値は `—` として表示します。

## 独自 UI で時間カーソルを基板へ同期する

独自レイアウトでは `CircuitTransientPanel` の `onFrameChange` を受け、`analysisAtTransientFrame(document, frame)` の結果を `CircuitBoard.analysis` に渡します。これにより基板の電位表示を時間波形のカーソルに同期できます。

```tsx
import { useState } from "react";
import {
  analysisAtTransientFrame,
  type CircuitAnalysis,
  type CircuitDocument,
  type CircuitTransientFrame,
} from "@nodemy-official/circuit-module";
import {
  CircuitBoard,
  CircuitEnergyPanel,
  CircuitTransientPanel,
} from "@nodemy-official/circuit-module/ui";

export function SynchronizedLesson({
  document,
  steadyAnalysis,
}: {
  document: CircuitDocument;
  steadyAnalysis: CircuitAnalysis;
}) {
  const [selection, setSelection] = useState<{
    document: CircuitDocument;
    frame: CircuitTransientFrame | null;
  } | null>(null);
  const frame = selection?.document === document ? selection.frame : null;
  const sampledAnalysis = frame ? analysisAtTransientFrame(document, frame) : null;
  const boardAnalysis = sampledAnalysis ?? steadyAnalysis;

  return (
    <>
      <CircuitBoard document={document} analysis={boardAnalysis} showPotentials />
      <CircuitTransientPanel
        document={document}
        onFrameChange={(frame) => setSelection({ document, frame })}
      />
      <CircuitEnergyPanel document={document} analysis={boardAnalysis} frame={frame} />
    </>
  );
}
```

`CircuitTransientPanel` は波形計算後、再生やカーソル移動のたびに `{ analysis, sampleIndex }` を `onFrameChange` へ渡します。回路が変わったとき、解析条件の変更で結果が無効になったとき、パネルがアンマウントされたときは `null` になります。`analysisAtTransientFrame` は過渡サンプルを通常の `CircuitAnalysis` 形式へ変換し、`timeSeconds` を付けます。この解析の電圧・電流・電力は瞬時値です。定常解析結果との部品値差分には使わず、同時刻の波形・電位・エネルギー表示に使ってください。

`CircuitBoard.showPotentials` は既定で `false` です。独自 UI で電位表示を使うときは `true` を渡します。標準レイアウトでは編集画面・プレビュー画面とも基板の電位操作を有効にし、時間カーソルの解析結果を基板へ反映します。

## パネルを個別に配置する

`@nodemy-official/circuit-module/ui` から `CircuitSimulationPanel`、`CircuitTransientPanel`、`CircuitEnergyPanel`、`CircuitAcPanel`、`CircuitComparisonPanel`、`CircuitBoard` を組み合わせられます。解析条件は回路データとは別に `CircuitAnalysisOptions` で管理します。

```tsx
import { CircuitSimulationPanel } from "@nodemy-official/circuit-module/ui";

<CircuitSimulationPanel
  document={editor.document}
  analysis={editor.analysis}
  options={editor.analysisOptions}
  onChange={editor.setAnalysisOptions}
  baselineDocument={initialDocument}
  onFrameChange={setFrame}
/>
```

`CircuitSimulationPanel` は解析条件の設定と各学習パネルをまとめます。`showLearningPanels={false}` を渡すと設定だけにでき、個々のパネルは好きな場所へ配置できます。比較パネルへ `baselineDocument` と `baselineAnalysis` の両方を渡すとその値を基準に使います。どちらも渡さない場合は「現在を比較の基準にする」から内部スナップショットを保存し、基準の更新や解除ができます。
