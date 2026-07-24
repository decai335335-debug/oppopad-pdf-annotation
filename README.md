# OPPO Pad Markdown Annotation

A stylus-first Markdown annotation view for Obsidian on Android tablets. It renders the real Markdown document first, then places a persistent handwriting layer over the rendered content.

This is an independent community project and is not affiliated with, endorsed by, or sponsored by OPPO.

## Features

- Opens `.md` files in a dedicated handwriting view.
- Uses Obsidian's native `MarkdownRenderer`, including links, embeds, images, callouts, and themes.
- Smooth fountain pen and translucent highlighter tools.
- Adjustable color, stroke width, and opacity.
- Fixed landscape-width document layout, so rotation does not reflow Markdown underneath existing ink.
- Stylus input writes or erases on the annotation layer.
- One-finger touch pans the document without creating ink.
- One-finger reading uses velocity-sampled kinetic scrolling while the drawing surface keeps full control of pen events.
- Two-finger touch pans and zooms the rendered Markdown and handwriting together.
- Uses pressure, tilt, and high-frequency coalesced pointer samples when Android WebView exposes them.
- OPPO Pencil body double-tap switches between pen and eraser only when ColorOS exposes it as a stylus button event to Obsidian WebView.
- Undo, clear, zoom, and return-to-Markdown toolbar actions.
- Handwriting is saved per Markdown file in `OPPO Pad Annotations/annotations.json` inside the vault and follows file renames.
- The same annotations load on desktop when that vault folder is synchronized.
- No account, telemetry, advertising, or automatic network requests.

Hardware capabilities vary by tablet, stylus, ColorOS version, and Android WebView. The plugin cannot guarantee a specific sampling rate or native-app latency.

## Usage

1. Open a Markdown file.
2. Use one of these entry points:
   - Select the pen icon in the left ribbon.
   - Run **Open current Markdown in handwriting view** from the command palette.
   - Open the file menu and select **Open in handwriting view**.
3. Write with the stylus.
4. Scroll with one finger and pinch with two fingers.
5. Select the document icon in the handwriting toolbar to return to the normal Markdown view.

## Installation

### Community plugins

After review and publication:

1. Open **Settings → Community plugins**.
2. Search for **OPPO Pad Markdown Annotation**.
3. Install and enable it.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create `.obsidian/plugins/oppopad-pdf-annotation/` inside the vault.
3. Copy the three files into that folder.
4. Restart Obsidian and enable the plugin.

Obsidian 1.8.7 or later is required.

## Privacy and storage

Handwriting data is stored in `OPPO Pad Annotations/annotations.json` inside the vault, with a plugin-local backup. This makes the data available to the same plugin on other synchronized devices. Markdown content and annotations are not sent to an external service by the plugin. Removing a handwritten stroke does not modify the Markdown source text.

## Development

```bash
npm install
npm run check
npm run build
```

## License and attribution

Licensed under the [MIT License](LICENSE).

Version 1.0.0 was derived from Pdftion by Murat. Version 1.1.0 replaces the PDF implementation with a focused Markdown handwriting view maintained by [decai335335-debug](https://github.com/decai335335-debug).

The handwriting outline renderer uses [`perfect-freehand`](https://github.com/steveruizok/perfect-freehand). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Version 1.1.1 hardens the Android view lifecycle, reuses the current Markdown tab on mobile, and caps canvas memory usage to prevent WebView crashes.

Version 1.2.0 adds the pen/highlighter controls, smoother curves, manual touch pan/pinch handling, and stronger suppression of Obsidian's edge-pane gestures while writing.

Version 1.3.0 adds a fixed landscape-width layout, vault-synced annotation storage, tiled high-resolution canvases, frame-batched drawing, and automatic sidebar closing during pen/touch gestures.

Version 1.4.0 replaces the custom line renderer with the MIT-licensed `perfect-freehand` outline engine used by established Obsidian drawing plugins, removes pen-tip double-tap switching, and adds kinetic touch scrolling without allowing the browser to cancel pen strokes.

---

## 中文说明

这个插件用于给 Markdown 文件做手写标注，不是 PDF 批注工具。

- 先使用 Obsidian 原生渲染器加载真正的 Markdown 内容，再叠加手写层。
- 横竖屏使用相同的横屏逻辑页面宽度，避免旋转后正文重排和笔迹错位。
- 手写笔负责书写，单指负责平移，双指负责缩放和平移。
- 支持压感、倾斜、高频采样，以及系统能够上报时的笔身双击切换橡皮。
- 每个 Markdown 文件的笔迹保存在仓库内的 `OPPO Pad Annotations/annotations.json`，同步到电脑后可由同一插件读取，不会修改 Markdown 源文字。
