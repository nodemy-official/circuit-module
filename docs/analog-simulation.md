# アナログ回路と解析

本パッケージは回路図を編集するための20種類の部品と、直流動作点・単一周波数の小信号交流・時間領域の過渡解析を提供します。解析は学習や回路の概算向けです。SPICE系シミュレーターの詳細なデバイスモデルや製品設計用の精度を提供するものではありません。

## 部品と数値プロパティ

部品カタログは次の20種類です。部品の追加時の初期値と端子名は `circuitPartCatalog`、編集可能な数値フィールドと範囲は `circuitPartNumericFields(kind)` から参照できます。UIの部品プロパティとプレビューはこのメタデータを使います。

| 種類 | 数値プロパティと既定値 |
| --- | --- |
| 電池 | `voltageVolts` 9 V、`internalResistanceOhms` 0 Ω |
| 抵抗 | `resistanceOhms` 10 Ω |
| 電球 | `resistanceOhms` 20 Ω、`ratedPowerWatts` 2 W |
| スイッチ | 初期状態は閉。操作時に状態を切替 |
| 電流計・電圧計・接続点 | 追加の数値プロパティなし |
| 交流電源 | `voltageVolts` 5 V RMS、`frequencyHz` 1000 Hz、`phaseDegrees` 0°、`offsetVolts` 0 V |
| コンデンサ | `capacitanceFarads` 1 µF、`initialVoltageVolts` 0 V |
| コイル | `inductanceHenries` 0.01 H、`initialCurrentAmps` 0 A |
| GND | 追加の数値プロパティなし。すべてのGND端子は同じ0 V基準 |
| 電流源 | `currentAmps` 0.01 A。正の値はA端子からB端子へ流れる向き |
| 可変抵抗 | `resistanceOhms` 1000 Ω、`wiperPosition` 0.5。A–C間の抵抗は全抵抗×位置 |
| ダイオード | `saturationCurrentAmps` 1 pA、`emissionCoefficient` 1 |
| LED | `saturationCurrentAmps` 1e-20 A、`emissionCoefficient` 2、`ratedCurrentAmps` 20 mA |
| NPN・PNPトランジスタ | `currentGain` β 100、`saturationCurrentAmps` 10 fA |
| N・PチャネルMOSFET | `thresholdVolts` 2 V、`transconductanceAmpsPerVoltSquared` 0.02 A/V²、`channelLengthModulation` 0.01 1/V |
| オペアンプ | `openLoopGain` 100000、`positiveRailVolts` +15 V、`negativeRailVolts` −15 V |

電池、抵抗、電球、スイッチ、電流計、電圧計、接続点の従来7種類は既存の直流解析経路で処理します。この7種類だけを使う既存回路では、導線・閉スイッチ・電流計の1e−6 Ω近似を維持し、電池の内部抵抗には1e−6 Ωの下限を適用します。高抵抗回路でも電位差や微小電流を桁落ちで失わないよう計算します。短絡判定は外部負荷の合成抵抗が1e−3 Ω未満かで行い、直列・並列接続した電池では電源群に接続された負荷網の合成抵抗を考慮します。その他の部品や交流モードはアナログ解析経路を使います。

## 定常解析

`analyzeCircuit(document, switchStates?, options?)` の `options.mode` は `"auto"`、`"dc"`、`"ac"` です。`auto` は交流電源を含む回路を交流解析、それ以外を直流解析にします。`frequencyHz` は小信号交流解析の周波数です。未指定なら回路内の最初の交流電源の周波数を使い、電源がなければ1 kHzを使います。

```ts
import { analyzeCircuit, createCircuitExample } from "@nodemy-official/circuit-module";

const circuit = createCircuitExample("ac");
const analysis = analyzeCircuit(circuit, {}, { mode: "ac", frequencyHz: 1000 });
const capacitor = analysis.parts.load;
console.log(analysis.mode, analysis.frequencyHz);
console.log(capacitor.voltageVolts, capacitor.voltagePhaseDegrees);
```

交流結果の `voltageVolts` と `currentAmps` は実効値の大きさで、符号を持ちません。`voltagePhaseDegrees` と `currentPhaseDegrees` が基準に対する位相、`reactivePowerVars` が無効電力です。`analyzeCircuit()` の `powerWatts` は受動部品で吸収を正、解析中に励振する電源で供給を正にします。交流解析で電池は励振せず、内部抵抗による吸収を正にします。損失のない理想コンデンサ・コイルの定常解析では有効電力を0 Wとして扱います。直流結果は電圧・電流が符号付きです。部品の主計測値は、BJTでコレクタ−エミッタ、MOSFETでドレイン−ソース、オペアンプで出力−GND、可変抵抗でA−B間を表します。個々の端子値は `terminalVoltages` と `terminalCurrents` で参照できます。

アナログ解析では抵抗・電球・可変抵抗、および交流のコンデンサ・コイルの枝電流を原則として未知数に取り、部品の電圧降下をインピーダンスと電流から求めます。リアクタンスが数値の表現範囲を超えてもアドミタンスが表現可能な場合は、アドミタンスを回路方程式へ直接組み込みます。抵抗比が大きい回路でも、ほぼ等しい端子電位の引き算で微小な電圧降下を失いにくくするためです。部品の測定値には主計測値を使ってください。`terminalVoltages` を利用側で引き算すると、浮動小数点数の丸めにより小さな差が失われる場合があります。未接続部分の仮の基準電位は独立して固定し、別の正常な回路の計算を妨げないようにしています。

スイッチ部品の `CircuitPartReading` と `TransientPartReading` には `switchClosed` が付き、解析で使った閉・開状態を示します。`analyzeCircuit()` の `switchStates` 引数、または `simulateTransient()` の `options.switchStates` に指定した上書きを優先し、上書きがない場合は部品の `initiallyClosed` を使います。過渡解析では各サンプルのスイッチ状態を参照できます。

低レベルAPIでは電力の符号規約が異なります。`analyzeAnalogCircuit()` / `solveAnalogStep()` の `power.real` と、`simulateTransient()` が返す各サンプルの `powerWatts` はすべての部品で吸収を正とし、電源などが供給すると負になります。直流・過渡結果の電圧と電流は符号付きで、通常はA−B電圧とA端子へ流入する電流を表します。BJTはC−E・C端子へ流入、MOSFETはD−S・D端子へ流入、オペアンプは出力−GND電圧・出力端子へ流入する電流です。

回路全体の `analysis.currentAmps` は、単一の独立電源について電流を定義できる場合に限り値を持ち、複数電源やオペアンプを含む回路では `null` です。オペアンプの簡易モデルでは正負電源レールを内部で参照し、回路図上の独立電源として扱わないため、電源電流を1つの値にまとめられません。解析パネルでは値がない場合「—」を表示します。

定常解析の `status` は計算の成否だけでなく、回路の戻り経路も表します。独立電源からその電源自身を通らずに戻る経路がなければ、有効な電圧を計算できても `open` になります。直流定常解析ではコンデンサを開放として扱うため、RC充電例は定常解析で `open`・0 Aとなりますが、同じ回路の `simulateTransient()` は充電中の有効な時間波形を返します。交流解析ではコンデンサとコイルが周波数に応じた経路になり、オペアンプ回路は出力端子からGND（GNDがない場合は解析基準点）への外部負荷経路があると `closed` になります。

交流解析は1周波数ずつ計算します。選んだ解析周波数と一致しない交流電源は、その計算では励振されず診断に表示されます。周波数値の浮動小数点の丸め程度の差は、同じ周波数として扱います。電流源は直流専用で、小信号交流解析時に励振電流を与えません。コンデンサとコイルは周波数に応じた複素インピーダンスとして計算します。半導体の交流結果は直流動作点まわりの小信号線形化です。

## 電流計・電圧計の読み値

基板上の電流計はA端子からB端子へ流れる電流を、電圧計はA端子とB端子の電位差を表示します。直流では符号付きで、端子の向きを逆にすると負の値になります。交流では単一周波数解析の実効値を表示します。モデル上、電流計は抵抗0 Ω、電圧計は回路に負荷を加えない理想計器です。ただし、従来7種類だけを使う直流解析では数値安定性のため、電流計を1e−6 Ωで近似します。読み値は数値解析の結果であり、末尾の桁が実測精度を表すものではありません。

各計器の解析値には `meterStatus` が付き、`connected` は両端子が接続され測定できる状態、`unconnected` は少なくとも片方の端子に導線がない状態、`floating` は導線があっても電圧の基準が定まらない、または電流計が迂回され電流を特定できない状態を表します。`unconnected` と `floating` の数値は有効な測定値として扱わず、回路全体の `status` も確認してください。回路全体の解析が短絡や入力不正で止まった場合も、基板の計器表示に数値は出ず、状態と理由を示します。

電流計を電源へ直接並列につなぐと短絡として解析され、読み値は理由とともに「—」になります。計器端子が未接続の場合も、値の代わりに状態を表示します。

アナログ解析は分岐ごとの理想導線電流を計算しません。`wireCurrents` は空で、導線上の電流・電子の方向表示もありません。これは交流解析だけの仕様ではなく、拡張アナログ解析を使う直流回路でも同じです。導線分岐の電流は理想回路では一意に決まらない場合があるため、未計算値から方向を推測しません。従来7種類だけの直流回路は既存ソルバーの推定値を使います。

## 時間波形

`simulateTransient(document, options)` は `durationSeconds` と `timeStepSeconds` で指定した時間範囲の電圧・電流を返します。コンデンサ初期電圧とコイル初期電流、または直流動作点から開始できます。数値積分には後退Euler法を使い、交流電源は

```text
offsetVolts + √2 × voltageVolts(RMS) × cos(2π × frequencyHz × t + phaseDegrees × π / 180)
```

として時間波形を作ります。例では、部品を選び「時間波形・過渡解析」を開いて条件を指定します。

開始時刻 `t = 0` でも指定されたコンデンサ電圧とコイル電流を保ち、接続点の電流のつり合いから初期電圧・電流を求めます。直列コイルには同じ電流変化率が流れるため、初期電圧はインダクタンスに応じて分かれます。例えば9 Vを1 Hと2 Hの直列コイルへ印加した場合は3 V・6 Vです。直列コイルの初期電流が一致しないなど、接続と矛盾する初期条件は `invalid` になります。

```ts
import { createCircuitExample, simulateTransient } from "@nodemy-official/circuit-module";

const chargingCircuit = createCircuitExample("charging");
const waveform = simulateTransient(chargingCircuit, {
  durationSeconds: 0.01,
  timeStepSeconds: 0.000025,
  startFromOperatingPoint: false,
});
if (waveform.status === "valid") {
  console.log(waveform.samples.at(-1)?.parts.load?.voltageVolts);
}
```

React UIでは `CircuitSimulationPanel` が解析モード・周波数の設定と `CircuitTransientPanel` をまとめて表示します。`CircuitTransientPanel` は単独でも配置できます。

```tsx
import { CircuitEditor, CircuitSimulationPanel } from "@nodemy-official/circuit-module/ui";

export function SimulationSettings() {
  return <CircuitEditor>{(editor) => (
    <CircuitSimulationPanel
      document={editor.document}
      analysis={editor.analysis}
      options={editor.analysisOptions}
      onChange={editor.setAnalysisOptions}
    />
  )}</CircuitEditor>;
}
```

`useCircuitEditor` の `analysisOptions` と `setAnalysisOptions(options)` は回路データから独立したセッション状態です。標準の `CircuitEditorLayout` はこの設定を解析パネルへ接続しています。過渡解析パネルは計算結果をその場で表示し、UI上限は2000時間ステップです。コアAPIにも `MAX_TRANSIENT_STEPS`、`MAX_TRANSIENT_SOLVER_WORK`、解析端子数512の上限があります。回路の端子数・時間刻み・期間により、演算量上限を超える解析は拒否されます。

## モデルの範囲と限界

- 抵抗・電球は定数抵抗です。温度による抵抗変化や熱連成はありません。
- ダイオードとLEDは温度一定のShockley式、BJTは簡易Ebers–Moll型、MOSFETはチャネル長変調を含む二乗則近似です。MOSFETのボディダイオード、接合・拡散容量などの寄生容量、温度依存、降伏には対応しません。
- 過渡解析ではコンデンサとコイルの蓄積状態を扱いますが、半導体は各時間ステップで準静的に解きます。半導体の電荷蓄積や逆回復はありません。
- オペアンプはGND基準で、利得と指定した正負電源レールを使う簡易3端子モデルです。出力抵抗は20 Ω固定で、電源レールの消費電流は算出しません。帯域幅、スルーレート、有限の供給電流、入力電流・オフセットは扱いません。
- 交流解析は単一周波数の定常小信号解析で、過渡波形や高調波歪みを返しません。過渡波形は別途 `simulateTransient` で計算します。
- 理想電源・導線のループや特異な接続、非線形方程式の未収束は解析不能になることがあります。診断と `status` を確認してください。

この分け方はSPICE系ツールで一般的な直流動作点、小信号交流、過渡解析の区別を参考にしています。モデル粒度は本パッケージの実装範囲に限られます。部品記号・端子の参考には[CircuitLab Circuit Elements](https://www.circuitlab.com/docs/circuit-elements/)、解析種別とSPICEの説明には[ngspice Tutorial](https://ngspice.sourceforge.io/ngspice-tutorial.html)と[ngspice User Manual](https://ngspice.sourceforge.io/docs/ngspice-manual.pdf)を参照してください。

## サンプル回路

`circuit-examples.ts` は保存・読み込みと解析に使える9種類の回路を提供します。`createCircuitExample(kind)` に次のいずれかを渡してください。

| kind | サンプル |
| --- | --- |
| `dc` | 直流の基本回路 |
| `ac` | 交流のRCフィルタ |
| `rlc` | 交流のRLC直列回路 |
| `charging` | コンデンサの充電 |
| `led` | LEDと電流制限抵抗 |
| `rectifier` | ダイオードの半波整流 |
| `transistor` | NPNトランジスタ |
| `mosfet` | MOSFETのスイッチ |
| `opamp` | オペアンプの電圧フォロワ |
