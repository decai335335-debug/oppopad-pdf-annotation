# OPPO Pad PDF Annotation

A stylus-first PDF annotation plugin for Obsidian on Android tablets. It separates pen input from finger gestures so you can write with a stylus, scroll with one finger, and pinch to zoom with two fingers.

This is an independent community project and is not affiliated with, endorsed by, or sponsored by OPPO.

## Features

- Stylus-only ink input with finger palm-rejection behavior.
- One-finger PDF scrolling and two-finger pan/zoom.
- Pressure-sensitive line width when Android WebView exposes `PointerEvent.pressure`.
- Tilt-aware pen width when `tiltX` and `tiltY` are available.
- High-frequency coalesced pointer samples and low-latency incremental canvas rendering.
- Stylus barrel-button or reported double-click switching between pen and eraser.
- Pen, highlighter, text, cover, image, selection, eraser, undo, and redo tools.
- Editable annotation state with automatic saving.
- Burned-in PDF export plus Markdown and DOCX helper exports.
- Support for normal PDF views and embedded PDF previews.

Hardware capabilities vary by tablet, stylus, ColorOS version, and Android WebView. The plugin uses pressure, tilt, high-rate samples, and stylus-button events when the operating system exposes them. It cannot guarantee a specific sampling rate or native-app latency.

## Installation

### Community plugins

After the plugin is accepted into the Obsidian community directory:

1. Open **Settings → Community plugins**.
2. Select **Browse**.
3. Search for **OPPO Pad PDF Annotation**.
4. Install and enable it.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from a release.
2. Create `.obsidian/plugins/oppopad-pdf-annotation/` inside your vault.
3. Copy the three files into that folder.
4. Restart Obsidian and enable the plugin under **Community plugins**.

Obsidian 1.8.7 or later is required.

## Usage

1. Open a PDF or an embedded PDF preview.
2. Select the pen icon in the PDF toolbar to enable annotation.
3. Write with the stylus.
4. Drag with one finger to scroll.
5. Pinch with two fingers to zoom.
6. Double-click the stylus barrel or use its reported side-button event to switch between pen and eraser, when supported by the device.
7. Use the share menu to export a burned-in PDF copy.

## Privacy and data

- No account is required.
- The plugin does not include telemetry, analytics, advertising, or automatic network requests.
- Editable annotation data is stored in the user's Obsidian vault.
- PDF export and conversion run locally.
- The plugin reads and writes only files selected through the active vault workflow.
- The optional local automation API (`PdftionAI`) is exposed only inside the running Obsidian app and does not contact an external AI service.

## Development

```bash
npm install
npm run check
npm run build
```

The production build is written to `main.js`.

## Release

The version in `manifest.json`, `package.json`, and `package-lock.json` must match the Git tag. Pushing a semantic-version tag such as `1.0.0` runs the release workflow and publishes `main.js`, `manifest.json`, and `styles.css`.

## License and attribution

Licensed under the [MIT License](LICENSE).

This project is derived from Pdftion by Murat and retains the original MIT copyright notice. Tablet stylus adaptations and subsequent modifications are maintained by [decai335335-debug](https://github.com/decai335335-debug).

---

## 中文说明

OPPO Pad PDF Annotation 是一个面向 Android 平板手写笔的 PDF 批注插件：

- 手写笔负责书写，手指不会产生墨迹。
- 单指滚动 PDF，双指移动和缩放页面。
- 系统支持时使用压感、倾斜、高频合并采样和笔侧键事件。
- 支持笔、荧光笔、文字、图片、橡皮、选择、撤销、重做和 PDF 导出。

实际压感级别、采样率、延迟和笔身双击能力由设备、ColorOS 与 Android WebView 是否向 Obsidian 提供相应事件决定。本项目不是 OPPO 官方产品，也不保证达到原生笔记应用的硬件延迟指标。
