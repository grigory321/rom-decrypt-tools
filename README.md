# ROM Studio

Version: 1.0.3

[English](#english) | [日本語](#日本語)

---

## English

### Overview

**ROM Studio** is a browser-based utility suite for inspecting, decrypting, converting, extracting, and playing audio from console ROM images, optical discs, archives, and game sound files.

Everything runs locally inside your web browser using Web Workers, the Web Audio API, and modern browser storage APIs. Your files never leave your device and are never uploaded to any external server.

#### Key Highlights

- **100% Local & Private**: All decryption, filesystem parsing, CPU/DSP emulation, and audio encoding happen entirely client-side inside a background Web Worker.
- **Pure TypeScript / JavaScript Architecture**: Shipped with zero WebAssembly (Wasm) blobs, zero Emscripten glue, and zero native binaries. Every decrypter, archive parser, stream decoder, and hardware sound emulator (including SPC700/S-DSP, Game Boy SM83/APU, PlayStation MIPS R3000A/IOP/SPU/SPU2, and console sequence engines) is written in clean, readable TypeScript/JavaScript.
- **Bounded-Memory Streaming**: Disc images and large containers are read on demand using bounded buffers. Audio is generated in blocks without retaining the full decoded song. Cartridge emulation can keep its mapped ROM in memory; Game Boy cartridges are limited to 8 MiB.
- **Multilingual UI**: Fully localized in Japanese, English, and Russian.

---

### Core Workspaces & Features

ROM Studio is organized into three dedicated workspaces accessible from the navigation bar:

#### 1. Decrypt & Convert

Decrypt encrypted handheld ROMs and convert between container formats while verifying cryptographic integrity.

- **Nintendo 3DS Decryption & Conversion**:
  - Supported inputs: `.3ds`, `.cci`, `.cxi`, `.cfa`, `.ncch`, `.cia`.
  - Automatically decrypts standard retail encryption using built-in common keys, KeyX slots, and an embedded seed database (`seeddb.bin`).
  - **Format Conversion**: Convert cartridge dumps (`.3ds` / `.cci`) into installable `.cia` archives, or convert standard application `.cia` files back into `.3ds` cartridge images.
  - **Strict Verification**: Validates TMD content records, ExHeader hashes, mixed-key ExeFS file hashes, and every level of the RomFS IVFC SHA-256 hash tree.
- **Nintendo DSi Decryption**:
  - Supported inputs: DSi-enhanced or DSi-exclusive `.nds` and `.srl` files.
  - Automatically derives header keys to decrypt `modcrypt` areas, clears the encryption flag, and repairs the header CRC.

#### 2. Extract Files (Contents Browser)

Browse the internal directory structure of ROMs, optical discs, and archives, inspect binary headers, and extract files.

- **Search & Category Filtering**: Filter contained entries by path/filename or by type (Executable code, RomFS, NitroFS, Metadata, Container, ROM bank, Audio, etc.).
- **Hex Preview**: Click any file entry to inspect a hexadecimal and ASCII dump of its first 512 bytes.
- **Automatic Code Decompression**: Compressed 3DS ExeFS `.code` sections are automatically exposed alongside a decompressed `code-decompressed.bin` virtual entry.
- **Single-File & Streamed ZIP64 Export**: Download individual files or pack selected files (or the entire archive) into a deterministic, streamed ZIP64 archive on the fly.
- **Direct Audio Handoff**: Click "Find audio in this ROM" to immediately send the opened file set to the Audio Workspace.

#### 3. Listen to Audio (Audio Workspace)

Discover, play, visualize, and export music, sound effects, and instrument samples directly from ROMs, discs, sound archives, or standalone audio files.

- **Automatic Discovery & Classification**:
  - Traverses known console file systems (NitroFS, RomFS, ISO9660/Joliet, Wii/Wii U FST, U8, AWB, VAB) and performs bounded 64 KiB sliding-window signature scans on unknown binary containers to find embedded audio.
  - Automatically categorizes tracks into **Music (BGM)**, **Effects (SFX)**, **Audio**, and **Instruments (Samples)**, ordering long/looping BGM tracks first.
- **Full-Featured Studio Player**:
  - Unlimited real-time playback, interactive seek bar, 10-second skip buttons, playback speed control (`0.5x` to `2.0x`), volume/mute, repeat-one, shuffle, and continuous autoplay.
  - Real-time canvas visualizer (switchable between **Spectrum** and **Waveform** views) and stereo L/R peak/RMS level meters.
  - Integrates with the operating system via the **Media Session API** and provides a floating mini-player when scrolling through large libraries.
  - **Interactive Game Boy Controls**: When playing raw `.gb` or `.gbc` cartridge ROMs, an interactive joypad (D-Pad, A, B, SELECT, START) appears in the player. Pressing buttons sends real controller inputs to the running cartridge code, allowing you to navigate in-game menus or sound tests. Input events are recorded and replayed deterministically when seeking or exporting to WAV/MP3.
- **Flexible Audio Export**:
  - **MP3**: Encoded at 44.1 kHz in 128, 192, or 320 kbps.
  - **WAV**: Uncompressed 16-bit signed PCM (automatically upgrades to `RF64` when the output exceeds 4 GiB).
  - **Original**: Saves the exact native sequence or stream bytes (encrypted ADX and HCA streams are saved in their decrypted native form with repaired CRCs).
  - **Whole-Song Export**: For supported sequence formats (`GBA` M4A, `3DS` CSEQ, and `PlayStation` SEQ/SEP), ROM Studio can automatically measure the track until its natural ending or play through the intro plus two full cycles of a detected infinite loop, preserving release tails. You can also specify a custom duration (1 to 86,400 seconds) and fade-out time (0 to 15 seconds).
  - **Re-importable ZIP Bundles**: Exporting selected tracks as a ZIP automatically includes required companion banks and libraries (such as `SDAT`, `BCSAR` / `CBNK` + `CWAR`, `VAB` / `VH` + `VB`, or `psflib` / `psf2lib`) so the archive remains self-contained and playable when re-imported.

---

### Supported Systems & Formats

Compatibility depends on the game’s data layout, sound driver and companion files. A listed extension does not guarantee every game or variant.

| System / Category     | ROM & Container Extensions                                                                     | Supported Audio Formats, Drivers & Capabilities                                                                                                                                                                                                                        |
| :-------------------- | :--------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Game Boy / Color**  | `.gb`, `.gbc`                                                                                  | `GBS` (`.gbs`, including ugetab interrupt extension) and direct `.gb`/`.gbc` cartridge execution (ROM-only, MBC1, non-RTC MBC3, MBC5 up to 8 MiB) via SM83 CPU & APU emulation with live button input                                                                  |
| **Game Boy Advance**  | `.gba`                                                                                         | Cartridge header & 64 KiB bank browsing; automatic M4A / Sappy sound driver detection, sequence playback (PCM8, DPCM, and 4-channel PSG), and deduplicated standalone WAV sample extraction                                                                            |
| **Nintendo DS / DSi** | `.nds`, `.srl`                                                                                 | NitroFS, ARM9/ARM7, and overlay browsing; automatic DSi `modcrypt` decryption; `SDAT` sound archives (`SSEQ` / `SSAR` sequences, `SBNK` banks, `SWAR` / `SWAV` waveforms, `STRM` streams)                                                                              |
| **Nintendo 3DS**      | `.3ds`, `.cci`, `.cia`, `.cxi`, `.cfa`, `.ncch`                                                | Decryption and `.3ds` <-> `.cia` conversion; ExeFS / RomFS browsing; `BCSAR` (`CSAR`), `BCGRP` (`CGRP`), `BCBNK` (`CBNK`), `BCWAR` (`CWAR`), `BCSEQ` (`CSEQ` sequence synthesis with original waves), `BCWAV` (`CWAV`), `BCSTM` (`CSTM`)                               |
| **Super Nintendo**    | `.sfc`, `.smc`, `.swc`, `.fig`                                                                 | LoROM / HiROM / ExHiROM bank browsing; automatic `.spc` extraction and playback from native ROM drivers (Nintendo N-SPC, Cube family, HeartBeat family, SNESMOD, SNESGSS); standalone `SPC` (`.spc`) playback via SPC700 / S-DSP emulation                             |
| **Wii / Wii U**       | `.iso`, `.wbfs`, `.wad`, `.arc`, `.u8`, `.wud`, `.wux`, `.rpx`, `.rpl`, `.tmd`, `.tik`, `.app` | Partition decryption & FST extraction (supports split `.wbf1` parts; WUD/WUX requires a matching `.key` file); `BRSTM` (`RSTM`), `RWAV` (`BRWAV`), `DSP`, `BFWAV` (`FWAV`), `BFSTM` (`FSTM`), `IDSP`                                                                   |
| **Nintendo Switch**   | (Standalone audio files)                                                                       | `BWAV` (`.bwav`, PCM16LE and Nintendo DSP ADPCM), `IDSP` (`.idsp`)                                                                                                                                                                                                     |
| **PlayStation**       | `.iso`, `.bin` + `.cue`, `.vab`, `.vh` + `.vb`                                                 | ISO9660 / Mode 1 / Mode 2 (2352 & 2336) browsing; CD-DA tracks; CD-ROM `XA` (`.xa`, `.str`, etc.); `VAG`; `SEQ` / `SEP` scores (with matching `.vab` or `.vh` + `.vb`); `PSF` / `miniPSF` (`.psf`, `.minipsf` + `.psflib`); native HeartBeat PS-X EXE driver execution |
| **PlayStation 2**     | `.iso`, `.bin` + `.cue`, `.pss`, `.xws`, `.xwh` + `.xwb`                                       | `PSF2` / `miniPSF2` (`.psf2`, `.minipsf2` + `.psf2lib` via MIPS IOP ELF/IRX loader & SPU2); `SS2` / `ADS`; `RXWS` (`.xws` or `.xwh` + `.xwb` with PSX ADPCM / PCM16LE); `PSS` movie private-stream SS2 audio extraction                                                |
| **CRI Middleware**    | `.awb`, `.afs2`, `.awx`                                                                        | `AWB` (`AFS2`) wave archive extraction; `ADX` (`.adx`, v3/v4/v5, Type 8/9 known-key auto-detection and `.adxkey` support); `HCA` (`.hca`, v1.01 to v3.00, Cipher 56 known-key auto-detection and `.hcakey` support)                                                    |
| **General / Shared**  | `.zip`                                                                                         | `ZIP` / `ZIP64` (Stored & Deflate); `WAV` / `RF64` / `BW64` (PCM 8/16/24/32-bit, Float 32/64, IMA & MS ADPCM); `AIFF` / `AIFC` (PCM, Float, Apple `ima4`, a-law, u-law); `AU` / `SND`                                                                                  |

---

### Getting Started

#### Prerequisites

- **Node.js**: Version 20 or newer.
- **Web Browser**: Any modern browser (Chrome, Edge, Safari, Firefox).
  - For saving output files larger than 32 MiB (such as decrypted 3DS/CIA images or large ZIP/WAV exports), a browser supporting the **File System Access API** (**Google Chrome** or **Microsoft Edge**) is required so outputs can be streamed directly to disk.

#### Running Locally

1. Install development dependencies (only required once when running from the TypeScript source repository; not needed for the prebuilt JS release archive):

   ```sh
   npm ci
   ```

2. Build and start the local server:

   ```sh
   npm start
   ```

   On Windows, you can also double-click `Start-ROM-Studio.cmd`.

3. Open the application in your browser:
   ```text
   http://localhost:4188
   ```
   To use a custom port, set the `PORT` environment variable (e.g., `PORT=8080 npm start`).

---

### npm package

Install the supplied tarball, then start the app:

```sh
npm install -g ./rom-studio-1.0.3.tgz
rom-studio
```

After publication to npm, `npx rom-studio` starts the same app.

### Usage Tips for Multi-File Formats (Companion Files)

Many console formats split headers, tables, bodies, or encryption keys across multiple files. To load them properly, **select all related files together in the file picker** or use the **Open folder** button:

- **BIN / CUE Discs**: Select the `.cue` sheet and all referenced `.bin` track files together.
- **PlayStation SEQ / SEP**: Select the `.seq` or `.sep` score along with its matching same-name `.vab` bank (or `.vh` and `.vb` pair).
- **Standalone 3DS CSEQ**: Select the `.bcseq` / `.cseq` file together with its matching `.bcbnk` (`.cbnk`) and `.bcwar` (`.cwar`), or include the parent `.bcsar` (`.csar`) and `.bcgrp` (`.cgrp`) files.
- **PSF / PSF2**: When loading `.minipsf` or `.minipsf2` files, include all required `.psflib` / `.psf2lib` companion libraries in the selection.
- **Split PS2 RXWS**: Select the `.xwh` header file together with its matching `.xwb` body file.
- **Split Wii WBFS**: Select `.wbfs` along with `.wbf1`, `.wbf2`, etc.
- **Wii U WUD / WUX**: Include the matching 16-byte binary (or 32-hex-digit text) disc key file (`.key`, `disc.key`, or `game.key`).
- **Wii U NUS Packages**: Select `title.tmd`, `title.tik`, and all `.app` and `.h3` files together, or open the containing folder.
- **Encrypted ADX / HCA**: If a file uses a custom key not covered by built-in heuristic detection, include a matching `.adxkey` or `.hcakey` file.

---

### Storage, Memory & Browser Behavior

- **Saving Outputs Over 32 MiB**:
  In-memory Blob downloads are capped at 32 MiB to prevent browser tab crashes. When an output exceeds 32 MiB, ROM Studio prompts for a save location via `showSaveFilePicker` (available in Chrome and Edge) and streams chunks directly to disk.
- **ZIP Decompression & OPFS**:
  Deflate-compressed ZIP entries are inflated into temporary files inside the browser's Origin Private File System (OPFS) and verified against their CRC32 before use. Web Locks prevent cross-tab collisions and clean up orphaned temporary files on startup. If OPFS is unavailable, the worker falls back to a shared 8 MiB in-memory budget.
- **Mobile & Cloud File Providers**:
  To avoid stalled reads on mobile browsers (such as iPhone Safari reading from iCloud Drive), file access uses bounded 1 MiB slices with a native `FileReader` fallback and a 30-second deadline. Make sure cloud files are downloaded to local device storage before selecting them.

---

### Development

Use Node.js 20 or newer. CI uses Node.js 24.

| Command                                | Purpose                                              |
| -------------------------------------- | ---------------------------------------------------- |
| `npm ci`                               | Install the locked development dependencies.         |
| `npm start`                            | Build the source edition and start the local server. |
| `npm run format`                       | Format source files and README.                      |
| `npm run check`                        | Check types and source formatting.                   |
| `npm test`                             | Build and run the regression tests.                  |
| `npm test -- tests/conversion.test.js` | Run one test file.                                   |
| `npm run build`                        | Generate the static application in `dist/`.          |
| `npm run release`                      | Create the source and prebuilt ZIPs in `releases/`.  |
| `npm pack`                             | Build and create the npm tarball.                    |

The npm package contains the built application, launcher and required license/source files. Development sources and tests remain in the source ZIP.

### License

ROM Studio is released under the **MIT License** (`LICENSE.txt`).

Third-party libraries and reference attributions retain their respective licenses in `public/vendor/NOTICES.txt` (and `dist/vendor/NOTICES.txt` in built distributions) as well as `public/fonts/OFL.txt`. No proprietary console BIOS, firmware, commercial ROMs, or copyrighted game recordings are included in this repository.

---

## 日本語

### 概要

**ROM Studio** は、コンソールゲームのROMイメージ、ディスクイメージ、アーカイブ、およびゲーム音声ファイルをブラウザ上で直接解析・操作するためのWebアプリケーションです。

ファイルの復号、フォーマット変換、内部ファイルシステムの展開・プレビュー、そして多様なゲーム音源のリアルタイム再生とWAV/MP3書き出しまでを1つのツールで完結できます。すべての処理はお使いのブラウザ内（ローカル環境）で実行され、選択したファイルが外部サーバーへ送信されることはありません。

#### 主な特徴

- **完全ローカル処理と高いプライバシー**: ファイルの読み込み、暗号解読、音声合成、ファイル書き出しのすべてがブラウザ内のWeb WorkerとWeb Audio API上で完結します。
- **純粋なTypeScript / JavaScript実装**: WebAssembly (Wasm) やネイティブバイナリに依存せず、すべて可読性の高いTypeScriptコードからビルドされた標準的なJavaScriptモジュールのみで動作します。そのため、ネイティブのエミュレータコアやサウンドドライバ（SPC700、SM83、MIPS R3000A / IOP、各種シーケンサーなど）もすべてJavaScriptで実装されています。
- **省メモリ・ストリーミング設計**: ディスクや大きなコンテナは必要な範囲を読み取り、音声は全体のPCMを保持せずに順次生成します。カートリッジの命令実行ではROMをメモリに保持する場合があり、Game Boyは最大8MiBです。
- **多言語インターフェース**: UIおよびエラー診断メッセージは、日本語・英語・ロシア語の3言語に対応しており、画面右上のメニューからいつでも切り替え可能です。

---

### 3つの主要機能（ワークスペース）

画面上部（または左サイドバー）のタブから、用途に合わせて3つのワークスペースを切り替えられます。

#### 1. ROMの復号・変換

暗号化されたROMイメージやパッケージを復号し、必要に応じて別フォーマットへ相互変換します。

- **Nintendo 3DS 復号・変換**:
  - 対応形式: `.3ds`, `.cci`, `.cxi`, `.cfa`, `.ncch`, `.cia`
  - 標準的な共通鍵、KeyX、および内蔵のシードデータベース（`seeddb.bin`）を用いて、暗号化されたパーティションやコンテンツを自動的に復号します。
  - **フォーマット相互変換**: カートリッジイメージ（`.3ds` / `.cci`）からインストール可能なアーカイブ（`.cia`）への変換、および通常のアプリケーション `.cia` から `.3ds` への変換に対応しています。
  - **整合性チェック**: 処理中にTMD、コンテンツハッシュ、ExeFS、RomFS（IVFCハッシュツリー全階層）のSHA-256検証を厳密に行います。
- **Nintendo DSi 復号**:
  - 対応形式: `.nds`, `.srl` (DSi拡張対応ROM)
  - DSi特有の `modcrypt` 暗号化領域をヘッダ情報から自動的に復号し、ヘッダ内の暗号化フラグのクリアとCRCの再計算を行った復号済みROMを出力します。

#### 2. ファイルの展開

ROMイメージ、光ディスク、圧縮アーカイブの内部構造を解析し、含まれるファイルを一覧表示・抽出します。

- **ファイルツリーとフィルタリング**: パス名でのリアルタイム検索や、ファイル種別（実行コード、RomFS、NitroFS、メタデータ、コンテナ、ROMバンク、音声など）での絞り込みが可能です。
- **バイナリプレビュー**: ファイル名をクリックすると、先頭512バイトの16進数ダンプ（Hex + ASCII）をその場で確認できます。
- **コード展開**: 3DSのExeFS内に含まれる圧縮された `.code` バイナリを検出すると、オリジナルに加えて展開済みの `code-decompressed.bin` も自動的にリストへ追加します。
- **個別保存と一括ZIP保存**: 必要なファイルだけを単体で保存できるほか、チェックを入れた複数ファイルやアーカイブ全体を無圧縮のZIP64形式でストリーミング保存できます。
- **オーディオ機能への連携**: 展開中のROMに音声が含まれている場合、「このROMの音声を聴く」ボタンから直接オーディオワークスペースへ引き継ぐことができます。

#### 3. 音声を聴く

ROMイメージやサウンドアーカイブ、単体の音声ファイルを読み込み、ブラウザ上で直接再生・整理・変換保存します。

- **自動探索とカテゴリ分類**:
  - ファイルシステムを持つROMやディスクからは既知のサウンドファイルを探索し、ファイルシステムを持たないバイナリやパックファイルからも、最大64KiBのスライディングウィンドウによるヘッダ検証スキャンで埋め込み音声を自動検出します。
  - 検出したトラックは「BGM」「効果音 (SFX)」「音声 (Audio)」「波形・サンプル (Instruments)」に自動分類され、BGMが優先して上部に並ぶよう整理されます。
- **高機能オーディオプレイヤー**:
  - 時間制限のない連続再生、シークバーによる任意位置への移動、10秒スキップ、再生速度の変更（0.5倍〜2.0倍）、音量調整・ミュート、1曲リピート、シャッフル再生、連続再生に対応しています。
  - リアルタイムのビジュアライザー（周波数スペクトラム表示／オシロスコープ波形表示の切り替え）と、L/Rステレオレベルメーターを搭載しています。
  - **Game Boy 仮想コントローラー**: `.gb` / `.gbc` の実ROMファイルを再生している間は、プレイヤー下部に十字キー、A、B、SELECT、STARTボタンが表示されます。再生中にボタンを押すことで、ゲーム内のタイトル画面やサウンドテストメニューを実際に操作してBGMを切り替えることができます。操作履歴は記録され、シークやWAV/MP3書き出し時にも同じボタン操作が再現されます。
- **多彩な書き出し (Export)**:
  - **MP3**: 44.1kHz ステレオ/モノラル（ビットレートは 128 / 192 / 320 kbps から選択可能）。
  - **WAV**: 非圧縮 16-bit PCM（出力が4GiBを超える場合は自動的にRF64形式へ切り替わります）。
  - **オリジナル形式**: 抽出された生データのまま保存します（暗号化されたADXやHCAを保存する場合は、復号済みのストリームとして出力されます）。
  - **曲全体の自動書き出し**: GBA (M4A)、3DS (CSEQ)、PlayStation (SEQ/SEP) などの一部のシーケンス形式では、曲の自然な終了位置、または無限ループの検知（イントロ＋ループ2周分）によって1曲丸ごと自動採寸して書き出すオプションを利用できます。もちろん、任意の秒数（1〜86,400秒）とフェードアウト時間（0〜15秒）を手動で指定することも可能です。
  - **依存関係を含むZIP保存**: シーケンスデータ単体では再生できない形式（音色バンクや波形アーカイブ、ライブラリファイルを必要とする形式）を選択して「選択した音声をZIP保存」すると、必要な関連ファイルを同梱した再インポート可能なZIPアーカイブを作成します。

---

### 対応システム・フォーマット一覧

対応範囲はゲームの内部構造・音源ドライバー・付属ファイルに依存します。同じ拡張子でも、すべての作品や派生形式で動作するとは限りません。

| システム / カテゴリ   | 対応コンテナ・ROM拡張子                                                                        | 対応オーディオ・サウンドドライバ・備考                                                                                                                                                                                                           |
| :-------------------- | :--------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Game Boy / Color**  | `.gb`, `.gbc`                                                                                  | `GBS` (`.gbs`, ugetab割り込み拡張対応)、および実ROM（ROMのみ / MBC1 / MBC3 / MBC5、最大8MiB）のSM83 CPU実コード実行による音声再生とボタン入力操作                                                                                                |
| **Game Boy Advance**  | `.gba`                                                                                         | ROMヘッダ・64KiBバンク展開、M4A / Sappy サウンドドライバの自動検出・シーケンス再生（PCM8 / DPCM / PSG 4ch）、単体PCM波形のWAV抽出                                                                                                                |
| **Nintendo DS / DSi** | `.nds`, `.srl`                                                                                 | NitroFS / ARM9 / ARM7 / オーバーレイ展開、DSi `modcrypt` 自動復号、`SDAT` サウンドアーカイブ（`SSEQ` / `SSAR` シーケンス、`SBNK` バンク、`SWAR` / `SWAV` 波形、`STRM` ストリーム）                                                               |
| **Nintendo 3DS**      | `.3ds`, `.cci`, `.cia`, `.cxi`, `.cfa`, `.ncch`                                                | 復号および `.3ds` / `.cia` 相互変換、ExeFS / RomFS 展開、`BCSAR` (`CSAR`), `BCGRP` (`CGRP`), `BCBNK` (`CBNK`), `BCWAR` (`CWAR`), `BCSEQ` (`CSEQ` オリジナル波形合成), `BCWAV` (`CWAV`), `BCSTM` (`CSTM`)                                         |
| **Super Nintendo**    | `.sfc`, `.smc`, `.swc`, `.fig`                                                                 | LoROM / HiROM / ExHiROM バンク展開、ROM内ネイティブドライバ（Nintendo N-SPC、Cube系、HeartBeat系、SNESMOD、SNESGSS）からの `.spc` 自動生成・再生、単体 `SPC` (`.spc`) のSPC700 / S-DSPエミュレーション再生                                       |
| **Wii / Wii U**       | `.iso`, `.wbfs`, `.wad`, `.arc`, `.u8`, `.wud`, `.wux`, `.rpx`, `.rpl`, `.tmd`, `.tik`, `.app` | パーティション復号・ファイル展開（分割 `.wbf1` 等対応、WUD/WUXは要 `.key`）、`BRSTM` (`RSTM`), `RWAV` (`BRWAV`), `DSP`, `BFWAV` (`FWAV`), `BFSTM` (`FSTM`), `IDSP`                                                                               |
| **Nintendo Switch**   | (単体音声ファイル)                                                                             | `BWAV` (`.bwav`, PCM16LE / DSP ADPCM)、`IDSP` (`.idsp`)                                                                                                                                                                                          |
| **PlayStation**       | `.iso`, `.bin` + `.cue`, `.vab`, `.vh` + `.vb`                                                 | ISO9660 / Mode1 / Mode2 (2352 / 2336) 展開、CD-DA音声、CD-ROM `XA` (`.xa`, `.str` 等)、`VAG`, `SEQ` / `SEP`（要同名 `.vab` または `.vh` + `.vb`）、`PSF` / `miniPSF` (`.psf`, `.minipsf` + `.psflib`)、ネイティブ HeartBeat サウンドドライバ実行 |
| **PlayStation 2**     | `.iso`, `.bin` + `.cue`, `.pss`, `.xws`, `.xwh` + `.xwb`                                       | `PSF2` / `miniPSF2` (`.psf2`, `.minipsf2` + `.psf2lib`、IOP ELF/IRX実行 + SPU2)、`SS2` / `ADS`, `RXWS`（PSX ADPCM / PCM16LE）、`PSS` ムービーからのSS2音声抽出                                                                                   |
| **CRI Middleware**    | `.awb`, `.afs2`, `.awx`                                                                        | `AWB` (`AFS2`) アーカイブ展開、`ADX`（`.adx`, Type 8/9 既知鍵自動復号および `.adxkey` 対応）、`HCA`（`.hca`, v1〜v3、Cipher 56 既知鍵自動復号および `.hcakey` 対応）                                                                             |
| **汎用フォーマット**  | `.zip`                                                                                         | `ZIP` / `ZIP64`（Stored / Deflate）、`WAV` / `RF64` / `BW64`（PCM / Float / IMA / MS ADPCM）、`AIFF` / `AIFC`（PCM / Float / `ima4` / a-law / u-law）、`AU` / `SND`                                                                              |

---

### セットアップと起動方法

#### 必要環境

- **Node.js**: バージョン 20 以上（ローカルWebサーバーの起動およびTypeScriptのビルドに使用します）
- **Webブラウザ**: 最新版の Google Chrome、Microsoft Edge、Safari、Firefox 等
  - 32MiBを超える大容量ファイル（復号済み3DS ROMや大型ZIPなど）を出力・保存する場合は、File System Access API に対応した **Google Chrome** または **Microsoft Edge** を推奨します。

#### 起動手順

1. リポジトリのルートディレクトリでターミナルを開き、初回のみ依存パッケージをインストールします（配布用のビルド済みJS版アーカイブを使用する場合は、`npm ci` は不要です）。

   ```sh
   npm ci
   ```

2. アプリケーションを起動します（ソースファイルが存在する場合は自動的に `dist/` へビルドされた後、ローカルサーバーが起動します）。

   ```sh
   npm start
   ```

   Windows環境では、同梱の `Start-ROM-Studio.cmd` をダブルクリックするだけでも起動できます。

3. ブラウザで以下のURLを開きます。
   ```text
   http://localhost:4188
   ```
   ポート番号を変更したい場合は、環境変数 `PORT` を指定して起動してください（例: `PORT=8080 npm start`）。

---

### npmパッケージ

配布されたtarballをインストールして起動できます。

```sh
npm install -g ./rom-studio-1.0.3.tgz
rom-studio
```

npmへの公開後は `npx rom-studio` でも同じアプリを起動できます。

### 使い方のヒント（ペアリングが必要なファイルについて）

複数のファイルがセットになっているフォーマットを読み込む場合は、**ファイル選択ダイアログで複数ファイルを同時に選択する**か、**「フォルダを開く」ボタンからフォルダごと読み込む**ことで自動的に関連付けられます。

- **BIN + CUE**: `.cue` シートと、そこから参照されているすべての `.bin` ファイルを一緒に選択してください。
- **PlayStation SEQ / SEP**: `.seq` または `.sep` ファイルと、同じファイル名（拡張子違い）の `.vab`、または `.vh` と `.vb` のペアを一緒に選択してください。
- **3DS 単体 CSEQ**: `.bcseq` / `.cseq` 単体を読み込む場合は、同じ場所にある同名の `.bcbnk` (`.cbnk`) と `.bcwar` (`.cwar`)、あるいは元の `.bcsar` (`.csar`) や `.bcgrp` (`.cgrp`) を一緒に選択してください。
- **PSF / PSF2**: `.minipsf` や `.minipsf2` を再生する場合は、参照先の `.psflib` / `.psf2lib` ファイルを一緒に選択してください。
- **PS2 RXWS (XWH + XWB)**: ヘッダのみの `.xwh` を開く場合は、同名の `.xwb` ストリーム本体を一緒に選択してください。
- **Wii WBFS (分割ファイル)**: `.wbfs` と `.wbf1`, `.wbf2` などに分割されている場合は、すべての分割ファイルを同時に選択してください。
- **Wii U WUD / WUX**: 暗号化されたディスクイメージを開く場合は、対応する16バイト（または32桁の16進数テキスト）のディスクキー（同名 `.key`、`disc.key`、または `game.key`）を一緒に選択してください。
- **Wii U NUS パッケージ**: `title.tmd`、`title.tik`、およびすべての `.app` / `.h3` ファイルをまとめて選択するか、フォルダごと開いてください。
- **暗号化された ADX / HCA**: 既知の鍵リストで自動復号できない独自鍵のファイルは、同名の `.adxkey` または `.hcakey` ファイルを一緒に選択することで復号できます。

---

### ストレージとメモリ管理に関する仕様

- **大容量ファイルの保存 (32MiB超)**:
  ブラウザのメモリ制限を回避するため、32MiBを超える出力ファイルはメモリ上でBlob化せず、File System Access API (`showSaveFilePicker`) を通じてディスクへ直接チャンク書き込みを行います。事前に保存先ダイアログが表示された場合は、保存先を指定して処理を開始してください。
- **ZIPの展開と一時ストレージ**:
  Deflate圧縮されたZIPエントリを展開する際、ブラウザの OPFS (Origin Private File System) が利用可能な場合は一時ファイルとしてディスク上に展開し、Web Locks API によって複数タブ間の競合防止と不要ファイルの自動クリーンアップを行います。OPFSが利用できない環境（一部のプライベートブラウジング環境など）では、ワーカー全体で共有される最大8MiBのメモリフォールバック領域を使用します。
- **モバイル・クラウドストレージへの配慮**:
  iPhoneやiPadの「ファイル」アプリ（iCloud Drive等）から読み込む際のブラウザの不具合を回避するため、ファイル読み込みは1MiB単位のスライスと `FileReader` フォールバック、および30秒のタイムアウト制御を備えています。クラウド上のファイルは、あらかじめ端末本体へダウンロードしてから選択してください。

---

### 開発

Node.js 20以降を使用します。CIではNode.js 24を使用しています。

| コマンド                               | 用途                                               |
| -------------------------------------- | -------------------------------------------------- |
| `npm ci`                               | 固定された開発用依存関係をインストールします。     |
| `npm start`                            | ソース版をビルドしてローカルサーバーを起動します。 |
| `npm run format`                       | ソースとREADMEを整形します。                       |
| `npm run check`                        | 型とソースの書式を確認します。                     |
| `npm test`                             | ビルドして回帰テストを実行します。                 |
| `npm test -- tests/conversion.test.js` | 指定したテストファイルを実行します。               |
| `npm run build`                        | `dist/` に静的アプリを生成します。                 |
| `npm run release`                      | `releases/` にソース版とJS版のZIPを作成します。    |
| `npm pack`                             | ビルドしてnpm用のtarballを作成します。             |

npmパッケージにはビルド済みアプリ、起動用ファイル、必要なライセンス・元ソースを含めます。開発ソースとテストはソースZIPに含まれます。

#### ディレクトリ構成

- `src/`: TypeScriptソースコード
  - `src/ui/`: メインスレッドで動作するUIコンポーネント、オーディオビジュアライザー、Web Audio ストリーミングプレイヤー
  - `src/worker.ts`, `src/worker/`: バックグラウンドで動作するWeb Worker、RPCディスパッチャ、ライブ再生セッション管理
  - `src/locales/`: 多言語翻訳辞書（`ja.ts`, `en.ts`, `ru.ts`）
  - その他: 各ゲーム機・ファイルシステム・暗号化・音声コーデック・シーケンサー・CPU/APU/DSPエミュレータの実装モジュール
- `public/`: HTML、CSS、フォント、SVGアート、内蔵シードデータ、およびベンダーライブラリ
- `scripts/`: ビルド、型検証、テスト、リリース作成用のNode.jsスクリプト
- `tests/`: 自動回帰テストおよび検証用合成フィクスチャ
- `.github/workflows/`: コード検査とGitHub Pagesの手動公開ワークフロー
- `dist/`: ビルド成果物（GitHub Pages等の静的ホスティングにそのまま配置可能）

---

### ライセンス

本プロジェクトのソースコードは **MIT License** の下で公開されています。全文は `LICENSE.txt` を参照してください。

同梱されているサードパーティ製ライブラリ（`aes-js`, `fflate`, `lamejs`, `@noble/hashes`, `spc700-js`, `Golos Text` フォントなど）および参考にしているオープンソース実装のライセンス・著作権表示については、`public/vendor/NOTICES.txt`（ビルド後は `dist/vendor/NOTICES.txt`）および `public/fonts/OFL.txt` に記載されています。なお、本リポジトリには商用のゲームROM、BIOS、ファームウェア、および著作物であるゲーム楽曲データは一切含まれていません。
