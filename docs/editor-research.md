# 回路エディター調査と機能範囲

調査基準日: **2026-09-25**。各製品の公式ユーザーガイド、公式リファレンス、公式プロジェクト文書を確認した。現在の実装範囲は[アナログ解析ガイド](analog-simulation.md)にまとめている。20種類の部品を使った直流動作点・単一周波数の小信号交流・過渡解析を備える学習向けアナログ回路エディターとして、編集と解析の基本操作を採用し、ネット名、周波数 sweep、PCB、デジタル論理などは別の機能領域として扱う。

## 公式資料で確認した機能

| 製品 | 一次資料で確認した点 | 本モジュールへの示唆 |
| --- | --- | --- |
| KiCad Schematic Editor 10.0 | 選択、配線、ネットラベル、電源シンボル、未接続マーカー、階層シート、ネット強調表示、Electrical Rules Checker、PDF / SVG / netlist 出力まで扱う。[公式マニュアル](https://docs.kicad.org/10.0/en/eeschema/eeschema.pdf) | 編集・保存・検査・出力を一続きにするのが成熟した回路図ツールの基準。現行はJSONファイル往復、診断、選択対象への移動を備える。シートや電気ルール、ネット名は将来候補にする。 |
| EasyEDA Std | 端子クリックや W キーで配線を始め、配線上のノードや端点・頂点の編集、ネットラベル、GND / VCC、No Connect Flag を提供する。[配線ツール](https://docs.easyeda.com/en/Schematic/Wiring-Tools/) 回路図の PDF / PNG / SVG 出力ではシートの統合・分割も選べる。[回路図の出力](https://docs.easyeda.com/en/Export/Export-Schematic/) | 配線対象へ直接入れる操作、接続先の編集、未接続を意図的に表す方法、共有しやすい画像出力が参考になる。現行データモデルに「線の頂点」「ネット名」「意図的未接続」はないため、これらは未実装のまま将来候補にする。 |
| CircuitLab | Ctrl / Cmd + S、Z、A、C、X、V、部品回転などを揃え、ビルドとシミュレーションを切り替える。[公式ショートカット](https://www.circuitlab.com/docs/keyboard-shortcuts/) Smart Wires は既存接続を保った線の移動や L 字配線を扱う。[Smart Wires](https://www.circuitlab.com/docs/smart-wires/) 公式ドキュメントは DC、DC sweep、時間領域、周波数領域の解析を案内している。[公式ドキュメント目次](https://www.circuitlab.com/docs/) | キーボード編集と配線の接続維持は実装機能の参考。現行は直流動作点・単一周波数の小信号交流・時間領域の過渡解析を備え、sweep は将来候補にする。 |
| Falstad CircuitJS | 公式 JavaScript interface は同一オリジンの iframe にシミュレーターを置き、実行状態・時刻・刻み幅を読み書きするAPIと更新・解析コールバックを説明している。[CircuitJS JavaScript Interface](https://www.falstad.com/circuit/doc/js-interface.html) | シミュレーターを画面と分離したAPIとして公開する設計が headless solver の参考になる。現行は CircuitJS を組み込まず、独自の DC / AC / 過渡solverを利用する。 |
| Logisim-evolution | 公式ユーザーガイドは教育用デジタル論理設計と構築中のシミュレーション、サブ回路、複数配線を扱う。[User Guide](https://github.com/logisim-evolution/logisim-evolution/blob/main/src/main/resources/doc/en/html/guide/index.html) Edit menu には Undo / Redo、Cut / Copy / Paste、Duplicate、Select All がある。[Edit menu guide](https://github.com/logisim-evolution/logisim-evolution/blob/main/src/main/resources/doc/en/html/guide/menu/edit.html) | 学習用ツールに必要な復元・複製・選択の手触りが参考になる。論理ゲートや HDL を加えるのではなく、アナログ回路を編集する学習フローへ範囲を絞る。 |

これらは異なる利用者と回路領域を持つ。ここから導いた判断は、操作の一般的な期待（保存、選択、復元、検査）と、学習用のアナログ解析（直流・小信号交流・過渡）を現在の回路モデルへ合わせるものだ。電子設計自動化製品の機能数を、そのまま本モジュールの受け入れ条件にはしない。

## 機能の採否

| 区分 | 機能 | 判断・範囲 |
| --- | --- | --- |
| 実装済み | headless model / edit / geometry / solver、格子基板、部品追加・移動・回転・削除、端子接続、値編集、直流・交流・過渡解析 | 編集ロジックは React / DOM 不要で利用できる。20種類の部品と解析モードの詳細は[アナログ解析ガイド](analog-simulation.md)を参照。 |
| 実装済み | solver の解析端子・未知数上限 | `MAX_CIRCUIT_ANALYSIS_TERMINALS` とアナログsolverの未知数上限は各512。端子数を超えた解析は `invalid` を返す。保存形式の件数上限は、解析可能な規模を示さない。 |
| 実装済み | 配線端点のつなぎ替え・格子上への再接続 | 選択した導線の端点を別の端子へつなぎ直すか、格子上へ移して接続点を追加できる。 |
| 実装済み | 回路ファイルの新規作成・JSON 保存・読み込み | `serialization` が version 1 envelope を保存し、旧 raw `CircuitDocument` も読み込む。読み込み時に型・範囲・ID・端点を検証し、日本語の理由を返す。新規作成と正常な読み込みは Undo で戻せる。React UI では保存が JSON ダウンロード、読み込みが JSON ファイル選択になる。 |
| 実装済み | interactive file import limits | headless の保存形式は部品10,000個・導線20,000本を上限とする一方、`useCircuitEditor.importDocument()` は部品256個・導線1,024本までに制限する。UI上限超過は現在の document / history を保って error に理由を表示する。同期 SVG 描画と solver の負荷を避ける UI 専用の制限である。 |
| 実装済み | headless 診断と選択可能な診断パネル | `inspectCircuit(document)` は問題コード・深刻度・メッセージ・部品ID・導線IDを返す。`CircuitDiagnosticsPanel` は任意の `onSelect` に問題対象を渡し、preset は対象へ選択を移す。診断は保存形式の妥当性判定やsolver実行とは別の検査である。 |
| 実装済み | 複数選択、範囲選択、全選択 | 部品・導線の Shift / Ctrl / Cmd クリックは選択に追加・解除する。Shift + 空白ドラッグは範囲内の部品と完全に範囲内にある配線を現在の選択へ加える。Ctrl / Cmd + A は全ての部品・導線を選ぶ。 |
| 実装済み | 選択をまとめた移動・回転・削除、コピー・切り取り・貼り付け・複製 | 選択部品に接続する導線は移動に追従する。複数選択の回転は各部品をそれぞれの中心のまわりに90度回し、選択全体の位置関係は回転しない。接続点は回転しない。クリップボードは同じ provider 内のみ。部品と、両端が選択部品に含まれる導線を複写する。貼り付け・複製は空き位置を探し、ID と部品ラベルを一意に付け直す。 |
| 実装済み | `canCopy` / `canCut` / `canPaste` | `canCopy` は部品が選択されていること、`canPaste` は内部クリップボードに部品があることを示す。明示的に選択した導線は両端の部品も選ばれていないと `canCut` が false になり、Ctrl / Cmd + X は理由を表示して削除しない。部品の切り取りは削除と同じく接続導線も消すが、コピーに入るのは両端が選択部品である導線だけで、外部導線はclipboardに複写されず Undo でのみ戻せる。 |
| 実装済み | 20種類のアナログ部品とプロパティ | 交流電源、コンデンサ、コイル、GND、電流源、可変抵抗、ダイオード、LED、BJT、MOSFET、オペアンプを含む。共通の数値field metadataを部品プロパティとプレビューで使う。 |
| 実装済み | 直流動作点・小信号交流解析 | `auto` / `dc` / `ac` と解析周波数を設定できる。交流値はRMSと位相を表示する。アナログ解析は導線電流を計算しないため、導線上の方向表示はしない。 |
| 実装済み | 過渡解析と時間波形 | コンデンサ・コイルの状態と交流電源波形を後退Euler法で計算し、部品電圧・電流を時系列で確認できる。モデル範囲と上限は[アナログ解析ガイド](analog-simulation.md)に記載。 |
| 実装済み | 操作履歴とショートカット | 編集、新規作成、読み込みを controller の Undo / Redo に接続する。Ctrl / Cmd + A、C、X、V、D、S、O を用意する。input / textarea / select / contenteditable では S / O はファイル操作として処理し、A / C / X / V / D / Z / Y と単独キーは入力側へ渡す。プレビュー中はファイル操作と編集用ショートカットが無効で、Esc で編集に戻れる。 |
| 将来候補 P1 | ネット強調表示 | 回路全体の診断を使って対象の部品・導線を選べるようになった。次に接続ネットを視覚的に追える表示を加えると、分岐や電流経路を学習しやすい。 |
| 将来候補 P1 | 意図的な未接続マーカー | 「接続忘れ」と「使わない端子」を区別する。診断がマーカーを尊重し、保存・Undo・視覚表示で同じ意味を保つことを受け入れ条件とする。 |
| 将来候補 P1 | SVG / PNG / PDF 出力 | 教材やレポートに回路を貼り、印刷するために推奨する。表示倍率、出力範囲、文字の可読性を確認する。 |
| 将来候補 P2 | 手動配線頂点・ルート保持 | 回路の見た目を整え、部品移動後も選んだ配線形状を保つために推奨する。ルート点の保存・履歴・交差表現をデータモデルへ追加する必要がある。 |
| 将来候補 P2 | ネット名の結合、VCC / 電源ネット | GNDは共通の0 V基準として実装済み。ネット名やVCCなどの電源シンボルを別の線どうしでも同一ノードとして扱うには、現在の端点接続グラフとsolverの接続規則を拡張する必要がある。 |
| 将来候補 P2 | 周波数 sweep | 現行の交流解析は単一周波数を指定して計算する。周波数範囲を掃引する機能や応答グラフは別途必要。 |
| 対象外 | PCB・フットプリント・製造データ、ERC規則セット、複数シート/階層回路、HDL/VHDL | PCB / ERC と HDL は別の設計領域。複数シートも、単一 `CircuitDocument` の中で端点を接続する現在のsolverにはシート参照・階層ネットの仕組みがないため、現行範囲外とする。 |

## 実装済み機能の受け入れ条件

| 領域 | 完了条件 |
| --- | --- |
| JSON | 保存→読み込みで既知フィールドが保持される。読み込みは envelope version 1 と旧 raw JSON を受け入れる。壊れた JSON、未知の kind、重複 ID、非有限座標、座標上限超過、範囲外数値、存在しない部品・端子、不正な重複導線を無言で補正せず日本語で拒否する。未接続・無電源の document はファイルとして受け入れる。 |
| サイズ上限 | headless JSON は 1,000,000 JavaScript 文字、部品10,000個、導線20,000本、座標 `MAX_CIRCUIT_DOCUMENT_COORDINATE = Number.MAX_SAFE_INTEGER / (GRID * 4)`（格子セル単位、x/y の絶対値）が上限。UI の file import は部品256個・導線1,024本が上限。上限超過時は API が理由を返し、UIは document と履歴を保つ。solverは合計512端子を超える解析を `invalid` として返すので、headless保存上限をsolverの処理量保証として扱わない。 |
| ファイル操作 | UI の新規作成とサイズ・内容の条件を満たすファイル読み込みは Undo 可能。失敗した読み込みは編集中 document / history を置き換えない。JSON 保存は標準 browser download とする。 |
| 選択・クリップボード | modifier click、Shift 範囲、全選択は部品と導線を識別して controller に渡す。コピー結果には両端の部品を含む導線だけを含め、複製時は ID・ラベル衝突を避ける。 clipboard の寿命は provider 内とする。 |
| 切り取り | 明示選択wireの両端部品が未選択なら `canCut=false`、ボタン無効、Ctrl / Cmd + X は理由を出して何も削除しない。部品の切り取りで削除される外部導線はclipboardへ複写されず、Undoで復元できる。 |
| 診断 | `inspectCircuit` 単体を React/DOM なしで呼べる。パネルの項目を選ぶと、該当する部品と導線だけが editor selection に入る。診断自体は document を変更しない。 |
| キー操作 | Ctrl / Cmd + S / O は入力欄フォーカス中もファイル操作として動く。A / C / X / V / D / Z / Y と単独の編集キーは入力要素で横取りしない。プレビュー中はファイル操作と編集用ショートカットが無効で、Esc で編集に戻れる。 |

## API と操作の入口

- `@nodemy-official/circuit-module/serialization`: `serializeCircuitDocument(document)`、`parseCircuitDocument(json)`、`MAX_CIRCUIT_DOCUMENT_JSON_LENGTH`、`MAX_CIRCUIT_DOCUMENT_PARTS`、`MAX_CIRCUIT_DOCUMENT_WIRES`、`MAX_CIRCUIT_DOCUMENT_COORDINATE`。
- `@nodemy-official/circuit-module/diagnostics`: `inspectCircuit(document)`、診断型。
- `@nodemy-official/circuit-module/solver`: `analyzeCircuit(document)`、`MAX_CIRCUIT_ANALYSIS_TERMINALS`（512端子）。
- `@nodemy-official/circuit-module/ui`: `CircuitDiagnosticsPanel`、`CircuitBoard`、`useCircuitEditor`。
- `@nodemy-official/circuit-module/ui`: `MAX_CIRCUIT_EDITOR_PARTS`（256部品）、`MAX_CIRCUIT_EDITOR_WIRES`（1,024導線）、interactive import の上限。
- `@nodemy-official/circuit-module/ui/preset`: 標準 `CircuitEditorLayout`。
- editor controller: `diagnostics`、`selectRange(selection, additive?)`、`selectAll()`、`canCopy`、`canCut`、`canPaste`、`copySelected()`、`cutSelected()`、`paste()`、`duplicateSelected()`、`newDocument()`、`importDocument(json)`、`exportDocument()`、`undo()`、`redo()`。
- `CircuitBoard` の `onSelectPart(id, additive?)`、`onSelectWire(id, additive?)`、`onSelectRange(selection, additive?)` は controller の `selectPart`、`selectWire`、`selectRange` に接続できる（例: `onSelectRange={editor.selectRange}`）。

標準 UI の Ctrl / Cmd + A / C / X / V / D / S / O は、順に全選択、コピー、切り取り、貼り付け、複製、JSON 保存、JSON 読み込みを行う。Undo は Z、Redo は Shift + Z または Y。部品追加は `1`〜`7`、回転は R、削除は Delete / Backspace。入力欄では S / O だけをファイル操作に使い、文字編集のためのコマンドを横取りしません。プレビュー中はファイル操作と編集用ショートカットが無効で、Esc で編集に戻れます。

## 一次資料

- [KiCad 10.0 Schematic Editor manual](https://docs.kicad.org/10.0/en/eeschema/eeschema.pdf)
- [EasyEDA Std Wiring Tools](https://docs.easyeda.com/en/Schematic/Wiring-Tools/)
- [EasyEDA Std Export Schematics](https://docs.easyeda.com/en/Export/Export-Schematic/)
- [CircuitLab Keyboard Shortcuts](https://www.circuitlab.com/docs/keyboard-shortcuts/)
- [CircuitLab Smart Wires](https://www.circuitlab.com/docs/smart-wires/)
- [CircuitLab Documentation contents](https://www.circuitlab.com/docs/)
- [Falstad CircuitJS JavaScript interface](https://www.falstad.com/circuit/doc/js-interface.html)
- [Logisim-evolution User Guide](https://github.com/logisim-evolution/logisim-evolution/blob/main/src/main/resources/doc/en/html/guide/index.html)
- [Logisim-evolution Edit menu guide](https://github.com/logisim-evolution/logisim-evolution/blob/main/src/main/resources/doc/en/html/guide/menu/edit.html)
