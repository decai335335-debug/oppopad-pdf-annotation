# OPPO Pad Document Annotation

A stylus-first Markdown and PDF annotation plugin for Obsidian on Android tablets and desktop.

This is an independent community project and is not affiliated with, endorsed by, or sponsored by OPPO.

## Features

- Annotates rendered Markdown and Obsidian's native PDF reader.
- Fountain pen and translucent highlighter with adjustable color, width, and opacity.
- Pressure and high-frequency coalesced pointer samples when Android WebView exposes them.
- OPPO Pencil body-button or double-tap switching when ColorOS reports it as a standard stylus event.
- Finger and stylus inputs are separated:
  - Stylus writes or erases.
  - One-finger movement scrolls.
  - One-finger long-press selects text and opens the system copy action.
  - Two fingers pan and zoom.
  - Desktop mouse drag continues to select and copy text.
- Markdown uses a fixed 1180-pixel logical page; camera zoom never rewrites annotation coordinates.
- PDF strokes are stored by file, page number, and normalized page coordinates, so they remain aligned at different display sizes.
- Annotations are stored in `OPPO Pad Annotations/annotations.json` inside the vault and follow Markdown or PDF file renames.
- The same annotations load on desktop when the vault is synchronized.
- No account, telemetry, advertising, or automatic network requests.

Hardware capabilities vary by tablet, stylus, ColorOS version, and Android WebView. The plugin cannot guarantee a specific sampling rate, native-app latency, or access to proprietary OPPO Pencil Bluetooth events.

## Usage

### Markdown

1. Open a Markdown file.
2. Select the pen ribbon icon, run **Open current Markdown in handwriting view**, or select **Open in handwriting view** from the file menu.
3. Write with the stylus, move with one finger, pinch with two fingers, or long-press text with one finger to copy.
4. Select the document icon to return to the normal Markdown view.

### PDF

1. Open a PDF in Obsidian's normal PDF reader.
2. The compact handwriting toolbar appears in the PDF view.
3. Use the stylus for pen, highlighter, or eraser.
4. Long-press PDF text with one finger on a tablet, or drag with the mouse on desktop, to select and copy it.

The plugin keeps the native PDF text layer intact. Its annotation canvases do not receive finger or mouse pointer events.

## Installation

### Community plugins

After review and publication:

1. Open **Settings → Community plugins**.
2. Search for **OPPO Pad Document Annotation**.
3. Install and enable it.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create `.obsidian/plugins/oppopad-pdf-annotation/` inside the vault.
3. Copy the three files into that folder.
4. Restart Obsidian and enable the plugin.

Obsidian 1.8.7 or later is required.

## Privacy and storage

Handwriting data is stored in `OPPO Pad Annotations/annotations.json` inside the vault, with a plugin-local backup. Markdown, PDF content, and annotations are not sent to an external service. Annotations are overlays and do not modify the source Markdown or PDF file.

## Development

```bash
npm install
npm run check
npm run build
```

## License and attribution

Licensed under the [MIT License](LICENSE).

The handwriting outline renderer uses [`perfect-freehand`](https://github.com/steveruizok/perfect-freehand). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Version 1.7.0 adds synchronized PDF handwriting on top of Obsidian's native selectable PDF text layer. It also changes Markdown touch handling so a finger long-press remains available for native text selection and copying, while movement becomes scrolling and two fingers remain pan/zoom.

---

## 中文说明

这是一个面向 OPPO Pad、Android 平板和电脑端 Obsidian 的 Markdown／PDF 手写标注插件。

- Markdown 与 PDF 都支持钢笔、荧光笔和橡皮。
- 手写笔只负责书写和擦除，不会触发文字长按选择。
- 平板上用一根手指静止长按文字，可继续使用系统选择和复制。
- 一根手指移动时滚动页面，两根手指缩放和平移。
- 电脑端鼠标仍可拖选 Markdown 或 PDF 文字并复制。
- PDF 使用 Obsidian 原生文字层，标注画布不接收手指或鼠标事件。
- PDF 笔迹按文件、页码和页内归一化坐标保存，不同设备显示尺寸不同也不会偏移。
- 所有笔迹保存在仓库内的 `OPPO Pad Annotations/annotations.json`，可随仓库同步到电脑和平板。
