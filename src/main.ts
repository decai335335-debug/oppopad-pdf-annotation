import {
  Component,
  FileView,
  ItemView,
  MarkdownRenderer,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  setIcon
} from "obsidian";
import { getStroke } from "perfect-freehand";
import type { ViewStateResult } from "obsidian";

const VIEW_TYPE = "oppopad-markdown-annotation";
const DATA_VERSION = 3;
const SYNC_FOLDER = "OPPO Pad Annotations";
const SYNC_FILE = `${SYNC_FOLDER}/annotations.json`;
const SAVE_DELAY_MS = 350;
const LOGICAL_PAGE_WIDTH = 1180;
const MIN_LOGICAL_PAGE_HEIGHT = 1600;
const CANVAS_TILE_HEIGHT = 2048;

type DrawingTool = "pen" | "highlighter";
type InkTool = DrawingTool | "eraser";

interface InkPoint {
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  x: number;
  y: number;
}

interface InkStroke {
  color: string;
  id: string;
  opacity: number;
  page?: number;
  pageWidth?: number;
  points: InkPoint[];
  tool: DrawingTool;
  width: number;
}

interface ToolStyle {
  color: string;
  opacity: number;
  width: number;
}

interface ToolPreferences {
  highlighter: ToolStyle;
  pen: ToolStyle;
}

interface PluginData {
  annotations: Record<string, InkStroke[]>;
  preferences: ToolPreferences;
  version: number;
}

interface AnnotationViewState {
  file?: string;
}

interface CanvasTile {
  canvas: HTMLCanvasElement;
  height: number;
  top: number;
}

const DEFAULT_PREFERENCES: ToolPreferences = {
  pen: { color: "#1f2937", opacity: 1, width: 2.4 },
  highlighter: { color: "#ffd43b", opacity: 0.32, width: 18 }
};

const DEFAULT_DATA: PluginData = {
  annotations: {},
  preferences: DEFAULT_PREFERENCES,
  version: DATA_VERSION
};

export default class OppoPadMarkdownAnnotationPlugin extends Plugin {
  private data: PluginData = {
    ...DEFAULT_DATA,
    annotations: {},
    preferences: clonePreferences(DEFAULT_PREFERENCES)
  };
  private saveQueue: Promise<void> = Promise.resolve();
  private pdfScanTimer: number | null = null;
  private pdfSessions = new Map<HTMLElement, PdfAnnotationSession>();

  async onload(): Promise<void> {
    const legacyData = normalizePluginData(await this.loadData());
    this.data = await this.loadSyncedData(legacyData);

    this.registerView(VIEW_TYPE, (leaf) => new MarkdownAnnotationView(leaf, this));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.queuePdfScan()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.queuePdfScan()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.queuePdfScan()));
    this.register(() => {
      if (this.pdfScanTimer !== null) {
        window.clearTimeout(this.pdfScanTimer);
      }
      for (const session of this.pdfSessions.values()) {
        session.destroy();
      }
      this.pdfSessions.clear();
    });

    this.addCommand({
      id: "open-current-markdown-in-handwriting-view",
      name: "Open current Markdown in handwriting view",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md") {
          return false;
        }
        if (!checking) {
          void this.openMarkdownAnnotation(file, this.app.workspace.getLeaf(false));
        }
        return true;
      }
    });

    this.addRibbonIcon("pen-line", "Open Markdown handwriting view", () => {
      const file = this.app.workspace.getActiveFile();
      if (!(file instanceof TFile) || !["md", "pdf"].includes(file.extension)) {
        new Notice("Open a Markdown or PDF file first.");
        return;
      }
      if (file.extension === "pdf") {
        this.queuePdfScan(0);
        new Notice("PDF handwriting tools are ready in the PDF view.");
      } else {
        void this.openMarkdownAnnotation(file, this.app.workspace.getLeaf(false));
      }
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
        if (!(file instanceof TFile) || !["md", "pdf"].includes(file.extension)) {
          return;
        }
        menu.addItem((item) => {
          item
            .setTitle("Open in handwriting view")
            .setIcon("pen-line")
            .onClick(() => {
              if (file.extension === "pdf") {
                const targetLeaf = leaf ?? this.app.workspace.getLeaf("tab");
                void targetLeaf.openFile(file).then(() => this.queuePdfScan(0));
              } else {
                void this.openMarkdownAnnotation(file, leaf ?? this.app.workspace.getLeaf("tab"));
              }
            });
        });
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile) || !["md", "pdf"].includes(file.extension)) {
          return;
        }
        const annotations = this.data.annotations[oldPath];
        if (!annotations) {
          return;
        }
        delete this.data.annotations[oldPath];
        this.data.annotations[file.path] = annotations;
        void this.persistData();
      })
    );
    this.queuePdfScan(0);
  }

  getAnnotations(filePath: string): InkStroke[] {
    return (this.data.annotations[filePath] ?? []).map(cloneStroke);
  }

  async saveAnnotations(filePath: string, strokes: InkStroke[]): Promise<void> {
    if (strokes.length === 0) {
      delete this.data.annotations[filePath];
    } else {
      this.data.annotations[filePath] = strokes.map(cloneStroke);
    }
    await this.persistData();
  }

  getPreferences(): ToolPreferences {
    return clonePreferences(this.data.preferences);
  }

  async savePreferences(preferences: ToolPreferences): Promise<void> {
    this.data.preferences = clonePreferences(preferences);
    await this.persistData();
  }

  queuePdfScan(delay = 180): void {
    if (this.pdfScanTimer !== null) {
      window.clearTimeout(this.pdfScanTimer);
    }
    this.pdfScanTimer = window.setTimeout(() => {
      this.pdfScanTimer = null;
      this.scanPdfViews();
    }, delay);
  }

  private scanPdfViews(): void {
    const activeRoots = new Set<HTMLElement>();
    for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
      const view = leaf.view;
      if (!(view instanceof FileView) || !(view.file instanceof TFile) || view.file.extension !== "pdf") {
        continue;
      }
      const root = view.containerEl;
      activeRoots.add(root);
      const existing = this.pdfSessions.get(root);
      if (existing?.filePath === view.file.path) {
        existing.scanPages();
        continue;
      }
      existing?.destroy();
      this.pdfSessions.set(root, new PdfAnnotationSession(this, view.file, root));
    }
    for (const [root, session] of this.pdfSessions.entries()) {
      if (!activeRoots.has(root) || !root.isConnected) {
        session.destroy();
        this.pdfSessions.delete(root);
      }
    }
  }

  private async loadSyncedData(fallback: PluginData): Promise<PluginData> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(SYNC_FILE));
    if (file instanceof TFile) {
      try {
        return normalizePluginData(JSON.parse(await this.app.vault.cachedRead(file)) as unknown);
      } catch (error) {
        console.error("Could not read synced handwriting data.", error);
        new Notice("Synced handwriting data could not be read; using the local backup.");
        return fallback;
      }
    }
    this.data = fallback;
    await this.persistData();
    return fallback;
  }

  private async refreshSyncedData(): Promise<void> {
    await this.saveQueue;
    const file = this.app.vault.getAbstractFileByPath(normalizePath(SYNC_FILE));
    if (!(file instanceof TFile)) {
      return;
    }
    try {
      this.data = normalizePluginData(JSON.parse(await this.app.vault.cachedRead(file)) as unknown);
    } catch (error) {
      console.error("Could not refresh synced handwriting data.", error);
    }
  }

  private persistData(): Promise<void> {
    this.saveQueue = this.saveQueue
      .then(async () => {
        const folderPath = normalizePath(SYNC_FOLDER);
        if (!this.app.vault.getAbstractFileByPath(folderPath)) {
          await this.app.vault.createFolder(folderPath);
        }
        const filePath = normalizePath(SYNC_FILE);
        const content = `${JSON.stringify(this.data, null, 2)}\n`;
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
          await this.app.vault.modify(file, content);
        } else {
          await this.app.vault.create(filePath, content);
        }
        await this.saveData(this.data);
      })
      .catch((error) => {
        console.error("Could not save synced handwriting data.", error);
        new Notice("Could not save handwriting data to the synced folder.");
      });
    return this.saveQueue;
  }

  private async openMarkdownAnnotation(file: TFile, leaf: WorkspaceLeaf): Promise<void> {
    await this.refreshSyncedData();
    for (const existingLeaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      await this.app.workspace.revealLeaf(existingLeaf);
      if (existingLeaf.view instanceof MarkdownAnnotationView) {
        const state = existingLeaf.view.getState();
        if (state.file === file.path) {
          existingLeaf.view.reloadAnnotations();
          return;
        }
      }
    }

    await leaf.setViewState({
      type: VIEW_TYPE,
      active: true,
      state: { file: file.path }
    });
    await this.app.workspace.revealLeaf(leaf);
  }
}

class TouchSidebarGestureGuard {
  private closeFrame: number | null = null;

  private readonly onTouchEvent = (event: TouchEvent): void => {
    this.hold();
    event.stopPropagation();
  };

  constructor(
    private readonly plugin: OppoPadMarkdownAnnotationPlugin,
    private readonly rootEl: HTMLElement
  ) {}

  start(): void {
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"] as const) {
      this.rootEl.addEventListener(type, this.onTouchEvent, { passive: true });
    }
    this.hold();
  }

  hold(): void {
    this.collapseIfOpen();
    if (this.closeFrame !== null) {
      return;
    }
    this.closeFrame = window.requestAnimationFrame(() => {
      this.closeFrame = null;
      this.collapseIfOpen();
    });
  }

  destroy(): void {
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"] as const) {
      this.rootEl.removeEventListener(type, this.onTouchEvent);
    }
    if (this.closeFrame !== null) {
      window.cancelAnimationFrame(this.closeFrame);
      this.closeFrame = null;
    }
  }

  private collapseIfOpen(): void {
    const { leftSplit, rightSplit } = this.plugin.app.workspace;
    if (!leftSplit.collapsed) {
      leftSplit.collapse();
    }
    if (!rightSplit.collapsed) {
      rightSplit.collapse();
    }
  }
}

class MarkdownAnnotationView extends ItemView {
  private canvasTiles: CanvasTile[] = [];
  private clearConfirmUntil = 0;
  private currentStroke: InkStroke | null = null;
  private liveStrokeFrame: number | null = null;
  private liveStrokePath: SVGPathElement | null = null;
  private liveStrokeSvg: SVGSVGElement | null = null;
  private colorInput: HTMLInputElement | null = null;
  private filePath = "";
  private markdownComponent: Component | null = null;
  private markdownEl: HTMLElement | null = null;
  private renderGeneration = 0;
  private redrawFrame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private saveTimer: number | null = null;
  private scrollEl: HTMLElement | null = null;
  private sidebarCloseFrame: number | null = null;
  private sidebarGuard: TouchSidebarGestureGuard | null = null;
  private stageHeight = 1;
  private stageEl: HTMLElement | null = null;
  private surfaceEl: HTMLElement | null = null;
  private lastPenActivityAt = 0;
  private lastStylusToggleAt = 0;
  private stylusButtonPressed = false;
  private strokes: InkStroke[] = [];
  private tool: InkTool = "pen";
  private toolbarEl: HTMLElement | null = null;
  private trackedTouches = new Map<number, { x: number; y: number }>();
  private touchGestureActive = false;
  private touchInertiaFrame: number | null = null;
  private touchLastAt = 0;
  private touchStartPositions = new Map<number, { x: number; y: number }>();
  private touchVelocity = { x: 0, y: 0 };
  private fitZoom = 1;
  private zoom = 1;
  private opacityInput: HTMLInputElement | null = null;
  private opacityValueEl: HTMLElement | null = null;
  private preferences: ToolPreferences;
  private widthInput: HTMLInputElement | null = null;
  private widthValueEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: OppoPadMarkdownAnnotationPlugin
  ) {
    super(leaf);
    this.preferences = plugin.getPreferences();
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    const file = this.getMarkdownFile();
    return file ? `${file.basename} — Handwriting` : "Markdown handwriting";
  }

  getIcon(): string {
    return "pen-line";
  }

  getState(): Record<string, unknown> {
    return { file: this.filePath };
  }

  reloadAnnotations(): void {
    if (!this.filePath) {
      return;
    }
    this.strokes = this.plugin.getAnnotations(this.filePath);
    this.redraw();
  }

  async setState(state: AnnotationViewState, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    this.filePath = typeof state.file === "string" ? state.file : "";
    this.strokes = this.filePath ? this.plugin.getAnnotations(this.filePath) : [];
    await this.renderMarkdown();
  }

  protected async onOpen(): Promise<void> {
    try {
      this.contentEl.empty();
      this.contentEl.addClass("oppopad-markdown-annotation-view");

    this.toolbarEl = this.contentEl.createDiv({ cls: "oppopad-annotation-toolbar" });
    this.createToolbarButton("pen-line", "Fountain pen", () => this.setTool("pen"), "pen");
    this.createToolbarButton("highlighter", "Highlighter", () => this.setTool("highlighter"), "highlighter");
    this.createToolbarButton("eraser", "Eraser", () => this.setTool("eraser"), "eraser");
    this.createToolControls();
    this.createToolbarButton("undo-2", "Undo last stroke", () => this.undo());
    this.createToolbarButton("trash-2", "Clear handwriting", () => this.clearHandwriting());
    this.createToolbarButton("minus", "Zoom out", () => this.setZoom(this.zoom - 0.1));
    this.createToolbarButton("plus", "Zoom in", () => this.setZoom(this.zoom + 0.1));
    this.createToolbarButton("file-text", "Return to Markdown", () => void this.returnToMarkdown());

    this.scrollEl = this.contentEl.createDiv({ cls: "oppopad-annotation-scroll" });
    this.surfaceEl = this.scrollEl.createDiv({ cls: "oppopad-annotation-surface" });
    this.stageEl = this.surfaceEl.createDiv({ cls: "oppopad-annotation-stage" });
    this.sidebarGuard = new TouchSidebarGestureGuard(this.plugin, this.contentEl);
    this.sidebarGuard.start();
    this.stageEl.style.setProperty("--oppopad-page-width", `${LOGICAL_PAGE_WIDTH}px`);
    this.markdownEl = this.stageEl.createDiv({ cls: "markdown-preview-view markdown-rendered oppopad-markdown-content" });
    this.liveStrokeSvg = this.stageEl.createSvg("svg", {
      cls: "oppopad-live-stroke",
      attr: {
        "aria-hidden": "true",
        preserveAspectRatio: "none",
        width: String(LOGICAL_PAGE_WIDTH)
      }
    });
    this.liveStrokePath = this.liveStrokeSvg.createSvg("path");

    this.registerDomEvent(this.stageEl, "pointerdown", (event) => this.onPointerDown(event), { capture: true });
    this.registerDomEvent(this.stageEl, "pointermove", (event) => this.onPointerMove(event), { capture: true });
    this.registerDomEvent(this.stageEl, "pointerup", (event) => this.onPointerUp(event), { capture: true });
    this.registerDomEvent(this.stageEl, "pointercancel", (event) => this.onPointerCancel(event), { capture: true });
    this.registerDomEvent(this.stageEl, "contextmenu", (event) => {
      if (performance.now() - this.lastPenActivityAt < 900) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.toggleFromStylusHardware();
      }
    }, { capture: true });
    this.registerDomEvent(window, "keydown", (event) => {
      if (
        performance.now() - this.lastPenActivityAt < 900 &&
        ["BrowserBack", "BrowserForward", "ContextMenu"].includes(event.key)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.toggleFromStylusHardware();
      }
    }, { capture: true });
      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(() => this.safeResizeCanvas());
        this.resizeObserver.observe(this.scrollEl);
        this.register(() => this.resizeObserver?.disconnect());
      }
      this.registerDomEvent(window, "resize", () => this.safeResizeCanvas());

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.path === this.filePath) {
          void this.renderMarkdown();
        }
      })
    );

      this.updateToolbarState();
      await this.renderMarkdown();
    } catch (error) {
      console.error("Could not initialize Markdown handwriting view.", error);
      this.showViewError(error);
    }
  }

  protected async onClose(): Promise<void> {
    this.flushSave();
    this.unloadMarkdownComponent();
    if (this.redrawFrame !== null) {
      window.cancelAnimationFrame(this.redrawFrame);
      this.redrawFrame = null;
    }
    if (this.liveStrokeFrame !== null) {
      window.cancelAnimationFrame(this.liveStrokeFrame);
      this.liveStrokeFrame = null;
    }
    this.sidebarGuard?.destroy();
    this.sidebarGuard = null;
    if (this.sidebarCloseFrame !== null) {
      window.cancelAnimationFrame(this.sidebarCloseFrame);
      this.sidebarCloseFrame = null;
    }
    this.stopTouchInertia();
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private async renderMarkdown(): Promise<void> {
    if (!this.markdownEl) {
      return;
    }

    const generation = ++this.renderGeneration;
    const file = this.getMarkdownFile();
    this.unloadMarkdownComponent();
    this.markdownEl.empty();

    if (!file) {
      this.markdownEl.createEl("p", { text: "Markdown file not found." });
      this.safeResizeCanvas();
      return;
    }

    const loading = this.markdownEl.createEl("p", {
      cls: "oppopad-loading",
      text: "Loading Markdown…"
    });

    try {
      const markdown = await this.app.vault.cachedRead(file);
      if (generation !== this.renderGeneration || !this.markdownEl) {
        return;
      }
      loading.remove();
      const component = new Component();
      this.addChild(component);
      this.markdownComponent = component;
      await MarkdownRenderer.render(this.app, markdown, this.markdownEl, file.path, component);
      if (generation !== this.renderGeneration) {
        return;
      }
      window.requestAnimationFrame(() => this.safeResizeCanvas());
    } catch (error) {
      console.error("Could not render Markdown handwriting view.", error);
      loading.remove();
      this.markdownEl.createEl("p", {
        cls: "oppopad-render-error",
        text: "Could not load this Markdown file. Return to the normal Markdown view and try again."
      });
    }
  }

  private unloadMarkdownComponent(): void {
    if (!this.markdownComponent) {
      return;
    }
    this.removeChild(this.markdownComponent);
    this.markdownComponent = null;
  }

  private getMarkdownFile(): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(this.filePath);
    return file instanceof TFile && file.extension === "md" ? file : null;
  }

  private createToolbarButton(
    icon: string,
    label: string,
    action: () => void,
    tool?: InkTool
  ): void {
    if (!this.toolbarEl) {
      return;
    }
    const button = this.toolbarEl.createEl("button", {
      cls: "clickable-icon oppopad-toolbar-button",
      attr: {
        "aria-label": label,
        title: label,
        type: "button"
      }
    });
    if (tool) {
      button.dataset.tool = tool;
    }
    setIcon(button, icon);
    button.addEventListener("click", action);
  }

  private createToolControls(): void {
    if (!this.toolbarEl) {
      return;
    }
    const controls = this.toolbarEl.createDiv({ cls: "oppopad-tool-controls" });
    const colors = ["#1f2937", "#e03131", "#1971c2", "#2f9e44", "#ffd43b", "#ae3ec9"];
    const palette = controls.createDiv({ cls: "oppopad-color-palette" });
    for (const color of colors) {
      const swatch = palette.createEl("button", {
        cls: "oppopad-color-swatch",
        attr: {
          "aria-label": `Select ${color}`,
          title: color,
          type: "button"
        }
      });
      swatch.style.setProperty("--oppopad-swatch-color", color);
      swatch.addEventListener("click", () => this.updateActiveStyle({ color }));
    }

    this.colorInput = controls.createEl("input", {
      cls: "oppopad-color-input",
      attr: {
        "aria-label": "Custom ink color",
        title: "Custom color",
        type: "color"
      }
    });
    this.colorInput.addEventListener("input", () => {
      if (this.colorInput) {
        this.updateActiveStyle({ color: this.colorInput.value }, false);
      }
    });
    this.colorInput.addEventListener("change", () => this.saveToolPreferences());

    const widthControl = controls.createDiv({ cls: "oppopad-slider-control" });
    widthControl.createSpan({ text: "粗细" });
    this.widthInput = widthControl.createEl("input", {
      attr: {
        "aria-label": "Stroke width",
        max: "40",
        min: "1",
        step: "0.5",
        type: "range"
      }
    });
    this.widthValueEl = widthControl.createSpan({ cls: "oppopad-slider-value" });
    this.widthInput.addEventListener("input", () => {
      if (this.widthInput) {
        this.updateActiveStyle({ width: Number(this.widthInput.value) }, false);
      }
    });
    this.widthInput.addEventListener("change", () => this.saveToolPreferences());

    const opacityControl = controls.createDiv({ cls: "oppopad-slider-control" });
    opacityControl.createSpan({ text: "透明" });
    this.opacityInput = opacityControl.createEl("input", {
      attr: {
        "aria-label": "Stroke opacity",
        max: "100",
        min: "5",
        step: "1",
        type: "range"
      }
    });
    this.opacityValueEl = opacityControl.createSpan({ cls: "oppopad-slider-value" });
    this.opacityInput.addEventListener("input", () => {
      if (this.opacityInput) {
        this.updateActiveStyle({ opacity: Number(this.opacityInput.value) / 100 }, false);
      }
    });
    this.opacityInput.addEventListener("change", () => this.saveToolPreferences());
  }

  private setTool(tool: InkTool): void {
    this.tool = tool;
    this.currentStroke = null;
    this.clearLiveStroke();
    this.updateToolbarState();
  }

  private getDrawingTool(): DrawingTool {
    return this.tool === "highlighter" ? "highlighter" : "pen";
  }

  private updateActiveStyle(update: Partial<ToolStyle>, save = true): void {
    const drawingTool = this.getDrawingTool();
    this.preferences[drawingTool] = {
      ...this.preferences[drawingTool],
      ...update
    };
    this.updateToolbarState();
    if (save) {
      this.saveToolPreferences();
    }
  }

  private saveToolPreferences(): void {
    void this.plugin.savePreferences(this.preferences);
  }

  private updateToolbarState(): void {
    if (!this.toolbarEl) {
      return;
    }
    for (const button of Array.from(this.toolbarEl.querySelectorAll<HTMLElement>("[data-tool]"))) {
      button.classList.toggle("is-active", button.dataset.tool === this.tool);
    }
    const style = this.preferences[this.getDrawingTool()];
    if (this.colorInput) {
      this.colorInput.value = style.color;
      this.colorInput.disabled = this.tool === "eraser";
    }
    if (this.widthInput) {
      this.widthInput.value = String(style.width);
      this.widthInput.disabled = this.tool === "eraser";
    }
    if (this.opacityInput) {
      this.opacityInput.value = String(Math.round(style.opacity * 100));
      this.opacityInput.disabled = this.tool === "eraser";
    }
    if (this.widthValueEl) {
      this.widthValueEl.setText(style.width.toFixed(1));
    }
    if (this.opacityValueEl) {
      this.opacityValueEl.setText(`${Math.round(style.opacity * 100)}%`);
    }
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      this.sidebarGuard?.hold();
      this.stopTouchInertia();
      this.trackedTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.touchStartPositions.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.touchLastAt = performance.now();
      this.touchVelocity = { x: 0, y: 0 };
      if (this.trackedTouches.size >= 2) {
        this.beginTouchGesture(event);
      }
      return;
    }

    if (event.pointerType !== "pen") {
      return;
    }

    this.lastPenActivityAt = performance.now();
    this.keepSidebarsClosed();
    event.preventDefault();
    event.stopImmediatePropagation();

    if (this.handleStylusButton(event)) {
      return;
    }

    this.stageEl?.setPointerCapture(event.pointerId);
    const point = this.getInkPoint(event);
    if (this.tool === "eraser") {
      this.eraseAt(point);
      return;
    }

    const drawingTool = this.getDrawingTool();
    const style = this.preferences[drawingTool];
    this.currentStroke = {
      color: style.color,
      id: makeStrokeId(),
      opacity: style.opacity,
      points: [point],
      tool: drawingTool,
      width: style.width
    };
    this.scheduleLiveStroke();
  }

  private onPointerMove(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      this.sidebarGuard?.hold();
      if (!this.trackedTouches.has(event.pointerId)) {
        return;
      }
      const before = new Map(this.trackedTouches);
      this.trackedTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!this.touchGestureActive) {
        const start = this.touchStartPositions.get(event.pointerId);
        const moved = start ? Math.hypot(event.clientX - start.x, event.clientY - start.y) : 0;
        const selection = this.contentEl.ownerDocument.getSelection();
        if (selection && !selection.isCollapsed) {
          return;
        }
        if (this.trackedTouches.size < 2 && moved < 8) {
          return;
        }
        this.beginTouchGesture(event);
      } else {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (this.trackedTouches.size === 1) {
        const previous = before.get(event.pointerId);
        if (previous && this.scrollEl) {
          const now = performance.now();
          const elapsed = Math.max(4, now - this.touchLastAt);
          const dx = event.clientX - previous.x;
          const dy = event.clientY - previous.y;
          this.scrollEl.scrollLeft -= dx;
          this.scrollEl.scrollTop -= dy;
          this.touchVelocity.x = this.touchVelocity.x * 0.68 + (dx / elapsed) * 0.32;
          this.touchVelocity.y = this.touchVelocity.y * 0.68 + (dy / elapsed) * 0.32;
          this.touchLastAt = now;
        }
      } else if (this.trackedTouches.size >= 2 && this.scrollEl) {
        this.touchVelocity = { x: 0, y: 0 };
        const beforeDistance = touchMapDistance(before);
        const afterDistance = touchMapDistance(this.trackedTouches);
        const beforeCenter = touchMapCenter(before);
        const afterCenter = touchMapCenter(this.trackedTouches);
        this.scrollEl.scrollLeft -= afterCenter.x - beforeCenter.x;
        this.scrollEl.scrollTop -= afterCenter.y - beforeCenter.y;
        if (beforeDistance > 0 && afterDistance > 0) {
          this.setZoomAround(this.zoom * (afterDistance / beforeDistance), afterCenter);
        }
      }
      return;
    }

    if (event.pointerType !== "pen") {
      return;
    }

    this.lastPenActivityAt = performance.now();
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.handleStylusButton(event)) {
      return;
    }
    if (this.tool === "eraser") {
      if ((event.buttons & 1) !== 0 || event.pressure > 0) {
        this.eraseAt(this.getInkPoint(event));
      }
      return;
    }

    if (!this.currentStroke) {
      return;
    }

    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const samples = coalesced.length > 0 ? [...coalesced, event] : [event];
    for (const sample of samples) {
      this.appendInkPoint(this.getInkPoint(sample));
    }
    this.scheduleLiveStroke();
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      this.sidebarGuard?.hold();
      const gestureWasActive = this.touchGestureActive;
      if (gestureWasActive) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      const wasSingleTouch = this.trackedTouches.size === 1;
      this.trackedTouches.delete(event.pointerId);
      this.touchStartPositions.delete(event.pointerId);
      if (this.stageEl?.hasPointerCapture(event.pointerId)) {
        this.stageEl.releasePointerCapture(event.pointerId);
      }
      if (gestureWasActive && wasSingleTouch && this.trackedTouches.size === 0) {
        this.startTouchInertia();
      } else if (this.trackedTouches.size === 1) {
        this.touchLastAt = performance.now();
        this.touchVelocity = { x: 0, y: 0 };
      }
      if (this.trackedTouches.size === 0) {
        this.touchGestureActive = false;
      }
      return;
    }

    if (event.pointerType !== "pen") {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.stageEl?.hasPointerCapture(event.pointerId)) {
      this.stageEl.releasePointerCapture(event.pointerId);
    }

    const stroke = this.currentStroke;
    this.stylusButtonPressed = false;
    if (!stroke) {
      return;
    }
    this.appendFinalPoint(stroke, this.getInkPoint(event));
    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      stroke.points.push({ ...point, x: Math.min(1, point.x + 0.001) });
    }
    this.currentStroke = null;
    this.clearLiveStroke();
    this.strokes.push(stroke);
    this.scheduleSave();
    this.redraw();
  }

  private onPointerCancel(event: PointerEvent): void {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.stageEl?.hasPointerCapture(event.pointerId)) {
      this.stageEl.releasePointerCapture(event.pointerId);
    }
    if (event.pointerType === "touch") {
      this.trackedTouches.delete(event.pointerId);
      this.touchStartPositions.delete(event.pointerId);
      this.touchVelocity = { x: 0, y: 0 };
      if (this.trackedTouches.size === 0) {
        this.touchGestureActive = false;
      }
      return;
    }
    if (event.pointerType === "pen") {
      this.currentStroke = null;
      this.stylusButtonPressed = false;
      this.clearLiveStroke();
    }
  }

  private togglePenEraser(): void {
    this.setTool(this.tool === "eraser" ? "pen" : "eraser");
    new Notice(this.tool === "eraser" ? "橡皮" : "钢笔", 700);
  }

  private handleStylusButton(event: PointerEvent): boolean {
    const isPressed =
      event.button === 2 ||
      event.button === 5 ||
      event.button === 6 ||
      (event.buttons & 2) !== 0 ||
      (event.buttons & 32) !== 0 ||
      (event.buttons & 64) !== 0;
    if (!isPressed) {
      this.stylusButtonPressed = false;
      return false;
    }
    if (!this.stylusButtonPressed) {
      this.stylusButtonPressed = true;
      this.toggleFromStylusHardware();
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }

  private toggleFromStylusHardware(): void {
    const now = performance.now();
    if (this.lastStylusToggleAt !== 0 && now - this.lastStylusToggleAt < 500) {
      return;
    }
    this.lastStylusToggleAt = now;
    this.togglePenEraser();
  }

  private keepSidebarsClosed(): void {
    this.app.workspace.leftSplit.collapse();
    this.app.workspace.rightSplit.collapse();
    if (this.sidebarCloseFrame !== null) {
      return;
    }
    this.sidebarCloseFrame = window.requestAnimationFrame(() => {
      this.sidebarCloseFrame = null;
      this.app.workspace.leftSplit.collapse();
      this.app.workspace.rightSplit.collapse();
    });
  }

  private stopTouchInertia(): void {
    if (this.touchInertiaFrame !== null) {
      window.cancelAnimationFrame(this.touchInertiaFrame);
      this.touchInertiaFrame = null;
    }
  }

  private startTouchInertia(): void {
    this.stopTouchInertia();
    let previousTime = performance.now();
    const step = (time: number): void => {
      const scroll = this.scrollEl;
      if (!scroll) {
        this.touchInertiaFrame = null;
        return;
      }
      const elapsed = Math.min(32, Math.max(1, time - previousTime));
      previousTime = time;
      scroll.scrollLeft -= this.touchVelocity.x * elapsed;
      scroll.scrollTop -= this.touchVelocity.y * elapsed;
      const decay = Math.pow(0.94, elapsed / 16.67);
      this.touchVelocity.x *= decay;
      this.touchVelocity.y *= decay;
      if (Math.hypot(this.touchVelocity.x, this.touchVelocity.y) < 0.015) {
        this.touchInertiaFrame = null;
        return;
      }
      this.touchInertiaFrame = window.requestAnimationFrame(step);
    };
    if (Math.hypot(this.touchVelocity.x, this.touchVelocity.y) >= 0.015) {
      this.touchInertiaFrame = window.requestAnimationFrame(step);
    }
  }

  private getInkPoint(event: PointerEvent): InkPoint {
    const stage = this.stageEl;
    if (!stage) {
      return { x: 0, y: 0 };
    }
    const rect = stage.getBoundingClientRect();
    const pressure =
      event.pressure > 0.01
        ? clamp(event.pressure * 1.15, 0.12, 1)
        : undefined;
    return {
      pressure,
      tiltX: clamp(event.tiltX, -90, 90),
      tiltY: clamp(event.tiltY, -90, 90),
      x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
      y: Math.max(0, (event.clientY - rect.top) / this.getEffectiveZoom())
    };
  }

  private appendInkPoint(point: InkPoint): void {
    const stroke = this.currentStroke;
    if (!stroke) {
      return;
    }
    const previous = stroke.points[stroke.points.length - 1];
    const width = LOGICAL_PAGE_WIDTH;
    const distance = Math.hypot((point.x - previous.x) * width, point.y - previous.y);
    const mergeDistance = 0.45 / Math.max(0.1, this.getEffectiveZoom());
    if (distance < mergeDistance) {
      if ((point.pressure ?? 0) > (previous.pressure ?? 0)) {
        previous.pressure = point.pressure;
      }
      return;
    }
    const rawPressure = point.pressure ?? previous.pressure ?? 0.5;
    const smoothedPressure =
      (previous.pressure ?? rawPressure) + (rawPressure - (previous.pressure ?? rawPressure)) * 0.38;
    const maximumPressureChange = Math.max(0.025, (distance / Math.max(stroke.width, 0.5)) * 0.28);
    stroke.points.push({
      pressure: clamp(
        smoothedPressure,
        (previous.pressure ?? smoothedPressure) - maximumPressureChange,
        (previous.pressure ?? smoothedPressure) + maximumPressureChange
      ),
      tiltX: previous.tiltX === undefined
        ? point.tiltX
        : previous.tiltX + ((point.tiltX ?? previous.tiltX) - previous.tiltX) * 0.34,
      tiltY: previous.tiltY === undefined
        ? point.tiltY
        : previous.tiltY + ((point.tiltY ?? previous.tiltY) - previous.tiltY) * 0.34,
      x: point.x,
      y: point.y
    });
  }

  private scheduleLiveStroke(): void {
    if (this.liveStrokeFrame !== null) {
      return;
    }
    this.liveStrokeFrame = window.requestAnimationFrame(() => {
      this.liveStrokeFrame = null;
      const stroke = this.currentStroke;
      const path = this.liveStrokePath;
      if (!stroke || !path) {
        return;
      }
      path.setAttribute("d", strokeOutlineToSvgPath(getStrokeOutline(stroke, LOGICAL_PAGE_WIDTH)));
      path.setAttribute("fill", stroke.color);
      path.setAttribute("fill-opacity", String(stroke.opacity));
    });
  }

  private clearLiveStroke(): void {
    if (this.liveStrokeFrame !== null) {
      window.cancelAnimationFrame(this.liveStrokeFrame);
      this.liveStrokeFrame = null;
    }
    this.liveStrokePath?.removeAttribute("d");
  }

  private appendFinalPoint(stroke: InkStroke, point: InkPoint): void {
    const previous = stroke.points.at(-1);
    if (!previous) {
      stroke.points.push(point);
      return;
    }
    const width = LOGICAL_PAGE_WIDTH;
    if (Math.hypot((point.x - previous.x) * width, point.y - previous.y) >= 0.2) {
      stroke.points.push({
        ...point,
        pressure: point.pressure ?? previous.pressure
      });
    }
  }

  private eraseAt(point: InkPoint): void {
    const width = LOGICAL_PAGE_WIDTH;
    const x = point.x * width;
    const before = this.strokes.length;
    this.strokes = this.strokes.filter((stroke) => !strokeHitTest(stroke, x, point.y, width, 14));
    if (this.strokes.length !== before) {
      this.scheduleSave();
      this.redraw();
    }
  }

  private undo(): void {
    if (this.strokes.pop()) {
      this.scheduleSave();
      this.redraw();
    }
  }

  private clearHandwriting(): void {
    if (this.strokes.length === 0) {
      return;
    }
    const now = Date.now();
    if (now > this.clearConfirmUntil) {
      this.clearConfirmUntil = now + 2200;
      new Notice("Tap clear again to remove all handwriting.", 2000);
      return;
    }
    this.clearConfirmUntil = 0;
    this.strokes = [];
    this.currentStroke = null;
    this.scheduleSave();
    this.redraw();
  }

  private setZoom(value: number): void {
    this.zoom = clamp(value, 0.5, 3);
    this.applyZoom();
  }

  private beginTouchGesture(event: PointerEvent): void {
    this.touchGestureActive = true;
    this.sidebarGuard?.hold();
    event.preventDefault();
    event.stopImmediatePropagation();
    for (const pointerId of this.trackedTouches.keys()) {
      this.stageEl?.setPointerCapture(pointerId);
    }
    this.contentEl.ownerDocument.getSelection()?.removeAllRanges();
  }

  private setZoomAround(value: number, focalPoint: { x: number; y: number }): void {
    const stage = this.stageEl;
    const scroll = this.scrollEl;
    if (!stage || !scroll) {
      this.setZoom(value);
      return;
    }
    const oldScale = this.getEffectiveZoom();
    const oldRect = stage.getBoundingClientRect();
    const logicalX = (focalPoint.x - oldRect.left) / Math.max(0.1, oldScale);
    const logicalY = (focalPoint.y - oldRect.top) / Math.max(0.1, oldScale);
    this.setZoom(value);
    const newScale = this.getEffectiveZoom();
    const newRect = stage.getBoundingClientRect();
    scroll.scrollLeft += newRect.left + logicalX * newScale - focalPoint.x;
    scroll.scrollTop += newRect.top + logicalY * newScale - focalPoint.y;
  }

  private getEffectiveZoom(): number {
    return this.fitZoom * this.zoom;
  }

  private applyZoom(): void {
    const scale = this.getEffectiveZoom();
    if (this.stageEl) {
      this.stageEl.style.setProperty("--oppopad-scale", String(scale));
    }
    if (this.surfaceEl) {
      this.surfaceEl.style.setProperty("--oppopad-surface-width", `${LOGICAL_PAGE_WIDTH * scale}px`);
      this.surfaceEl.style.setProperty("--oppopad-surface-height", `${this.stageHeight * scale}px`);
    }
  }

  private async returnToMarkdown(): Promise<void> {
    const file = this.getMarkdownFile();
    if (!file) {
      return;
    }
    this.flushSave();
    await this.leaf.openFile(file);
  }

  private safeResizeCanvas(): void {
    try {
      this.resizeCanvas();
    } catch (error) {
      console.error("Could not resize Markdown handwriting canvas.", error);
    }
  }

  private resizeCanvas(): void {
    const stage = this.stageEl;
    const scroll = this.scrollEl;
    if (!stage || !scroll) {
      return;
    }
    this.fitZoom = Math.min(1, Math.max(0.1, scroll.clientWidth / LOGICAL_PAGE_WIDTH));
    this.applyZoom();
    const annotationHeight = this.strokes.reduce(
      (maximum, stroke) =>
        stroke.points.reduce(
          (strokeMaximum, point) => Math.max(strokeMaximum, point.y + stroke.width + 96),
          maximum
        ),
      0
    );
    const height = Math.max(MIN_LOGICAL_PAGE_HEIGHT, this.markdownEl?.scrollHeight ?? 0, annotationHeight);
    this.stageHeight = height;
    stage.style.setProperty("--oppopad-stage-height", `${height}px`);
    this.applyZoom();
    if (this.liveStrokeSvg) {
      this.liveStrokeSvg.setAttribute("height", String(height));
      this.liveStrokeSvg.setAttribute("viewBox", `0 0 ${LOGICAL_PAGE_WIDTH} ${height}`);
    }
    const tileCount = Math.max(1, Math.ceil(height / CANVAS_TILE_HEIGHT));
    const lastTileHeight = height - (tileCount - 1) * CANVAS_TILE_HEIGHT;
    const requiresRebuild =
      this.canvasTiles.length !== tileCount ||
      Math.abs((this.canvasTiles.at(-1)?.height ?? 0) - lastTileHeight) > 1;
    if (requiresRebuild) {
      for (const tile of this.canvasTiles) {
        tile.canvas.remove();
      }
      this.canvasTiles = [];
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      for (let index = 0; index < tileCount; index += 1) {
        const top = index * CANVAS_TILE_HEIGHT;
        const tileHeight = index === tileCount - 1 ? lastTileHeight : CANVAS_TILE_HEIGHT;
        const canvas = stage.createEl("canvas", {
          cls: "oppopad-ink-canvas",
          attr: { "aria-hidden": "true" }
        });
        canvas.style.setProperty("--oppopad-canvas-width", `${LOGICAL_PAGE_WIDTH}px`);
        canvas.style.setProperty("--oppopad-canvas-height", `${tileHeight}px`);
        canvas.style.setProperty("--oppopad-canvas-top", `${top}px`);
        canvas.width = Math.max(1, Math.round(LOGICAL_PAGE_WIDTH * scale));
        canvas.height = Math.max(1, Math.round(tileHeight * scale));
        this.canvasTiles.push({ canvas, height: tileHeight, top });
      }
    }
    this.redraw();
  }

  private redraw(): void {
    if (this.redrawFrame !== null) {
      return;
    }
    this.redrawFrame = window.requestAnimationFrame(() => {
      this.redrawFrame = null;
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      for (const tile of this.canvasTiles) {
        const context = tile.canvas.getContext("2d");
        if (!context) {
          continue;
        }
        context.setTransform(scale, 0, 0, scale, 0, -tile.top * scale);
        context.clearRect(0, tile.top, LOGICAL_PAGE_WIDTH, tile.height);
        context.save();
        context.beginPath();
        context.rect(0, tile.top, LOGICAL_PAGE_WIDTH, tile.height);
        context.clip();
        for (const stroke of this.strokes) {
          if (strokeIntersectsRange(stroke, tile.top, tile.top + tile.height)) {
            drawStroke(context, stroke, LOGICAL_PAGE_WIDTH);
          }
        }
        context.restore();
      }
    });
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.plugin.saveAnnotations(this.filePath, this.strokes);
    }, SAVE_DELAY_MS);
  }

  private flushSave(): void {
    if (!this.filePath) {
      return;
    }
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    void this.plugin.saveAnnotations(this.filePath, this.strokes);
  }

  private showViewError(error: unknown): void {
    this.contentEl.empty();
    this.contentEl.addClass("oppopad-markdown-annotation-view");
    const panel = this.contentEl.createDiv({ cls: "oppopad-view-error" });
    panel.createEl("h3", { text: "Handwriting view could not start" });
    panel.createEl("p", {
      text: "Disable and enable the plugin once. If this message remains, report the diagnostic text below."
    });
    panel.createEl("pre", {
      text: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    });
  }
}

interface PdfPageOverlay {
  canvas: HTMLCanvasElement;
  cleanup?: () => void;
  liveCanvas: HTMLCanvasElement;
  pageEl: HTMLElement;
  pageIndex: number;
  redrawFrame: number | null;
  resizeObserver: ResizeObserver | null;
}

class PdfAnnotationSession {
  readonly filePath: string;
  private currentOverlay: PdfPageOverlay | null = null;
  private currentPointerId: number | null = null;
  private currentStroke: InkStroke | null = null;
  private destroyed = false;
  private mutationObserver: MutationObserver;
  private overlays = new Map<HTMLElement, PdfPageOverlay>();
  private preferences: ToolPreferences;
  private saveTimer: number | null = null;
  private sidebarGuard: TouchSidebarGestureGuard;
  private stylusButtonPressed = false;
  private strokes: InkStroke[];
  private tool: InkTool = "pen";
  private toolbarEl: HTMLElement;

  constructor(
    private readonly plugin: OppoPadMarkdownAnnotationPlugin,
    private readonly file: TFile,
    private readonly rootEl: HTMLElement
  ) {
    this.filePath = file.path;
    this.preferences = plugin.getPreferences();
    this.strokes = plugin.getAnnotations(file.path);
    this.rootEl.addClass("oppopad-pdf-root");
    this.sidebarGuard = new TouchSidebarGestureGuard(plugin, rootEl);
    this.sidebarGuard.start();
    this.toolbarEl = this.createToolbar();
    this.updateToolbar();
    this.mutationObserver = new MutationObserver(() => this.scanPages());
    this.mutationObserver.observe(rootEl, { childList: true, subtree: true });
    this.scanPages();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.mutationObserver.disconnect();
    this.sidebarGuard.destroy();
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.plugin.saveAnnotations(this.file.path, this.strokes);
    }
    for (const overlay of this.overlays.values()) {
      this.destroyOverlay(overlay);
    }
    this.overlays.clear();
    this.toolbarEl.remove();
    this.rootEl.removeClass("oppopad-pdf-root");
  }

  scanPages(): void {
    if (this.destroyed) {
      return;
    }
    const pages = Array.from(
      this.rootEl.querySelectorAll<HTMLElement>(
        ".pdfViewer .page[data-page-number], .pdf-viewer .page[data-page-number], .pdf-container .page[data-page-number], .page[data-page-number]"
      )
    );
    for (const [fallbackIndex, pageEl] of pages.entries()) {
      if (this.overlays.has(pageEl)) {
        continue;
      }
      const pageNumber = Number(pageEl.dataset.pageNumber);
      const pageIndex = Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber - 1 : fallbackIndex;
      this.overlays.set(pageEl, this.createOverlay(pageEl, pageIndex));
    }
    for (const [pageEl, overlay] of this.overlays.entries()) {
      if (!pageEl.isConnected || !this.rootEl.contains(pageEl)) {
        this.destroyOverlay(overlay);
        this.overlays.delete(pageEl);
      }
    }
  }

  private createToolbar(): HTMLElement {
    const toolbar = this.rootEl.createDiv({
      cls: "oppopad-pdf-toolbar",
      attr: { "aria-label": "PDF handwriting tools" }
    });
    const addToolButton = (icon: string, label: string, tool: InkTool): void => {
      const button = toolbar.createEl("button", {
        cls: "clickable-icon oppopad-pdf-tool-button",
        attr: { "aria-label": label, "data-tool": tool, type: "button" },
        title: label
      });
      setIcon(button, icon);
      button.addEventListener("click", () => {
        this.tool = tool;
        this.currentStroke = null;
        this.clearLiveCanvas();
        this.updateToolbar();
      });
    };
    addToolButton("pen-line", "Pen", "pen");
    addToolButton("highlighter", "Highlighter", "highlighter");
    addToolButton("eraser", "Eraser", "eraser");

    const color = toolbar.createEl("input", {
      cls: "oppopad-pdf-color",
      attr: { "aria-label": "Ink color" },
      type: "color"
    });
    color.addEventListener("input", () => {
      const drawingTool = this.getDrawingTool();
      this.preferences[drawingTool].color = color.value;
      this.updateToolbar();
    });
    color.addEventListener("change", () => void this.plugin.savePreferences(this.preferences));

    const width = toolbar.createEl("input", {
      cls: "oppopad-pdf-width",
      attr: { "aria-label": "Ink width", max: "40", min: "1", step: "0.5" },
      type: "range"
    });
    width.addEventListener("input", () => {
      this.preferences[this.getDrawingTool()].width = Number(width.value);
    });
    width.addEventListener("change", () => void this.plugin.savePreferences(this.preferences));

    const opacity = toolbar.createEl("input", {
      cls: "oppopad-pdf-opacity",
      attr: { "aria-label": "Ink opacity", max: "100", min: "5", step: "1" },
      type: "range"
    });
    opacity.addEventListener("input", () => {
      this.preferences[this.getDrawingTool()].opacity = Number(opacity.value) / 100;
    });
    opacity.addEventListener("change", () => void this.plugin.savePreferences(this.preferences));

    const undo = toolbar.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "Undo PDF stroke", type: "button" },
      title: "Undo PDF stroke"
    });
    setIcon(undo, "undo-2");
    undo.addEventListener("click", () => {
      if (this.strokes.pop()) {
        this.scheduleSave();
        this.redrawAll();
      }
    });
    toolbar.createSpan({
      cls: "oppopad-pdf-selection-hint",
      text: "Long-press or drag text to copy"
    });
    return toolbar;
  }

  private updateToolbar(): void {
    for (const button of Array.from(this.toolbarEl.querySelectorAll<HTMLElement>("[data-tool]"))) {
      button.classList.toggle("is-active", button.dataset.tool === this.tool);
    }
    const style = this.preferences[this.getDrawingTool()];
    const color = this.toolbarEl.querySelector<HTMLInputElement>(".oppopad-pdf-color");
    const width = this.toolbarEl.querySelector<HTMLInputElement>(".oppopad-pdf-width");
    const opacity = this.toolbarEl.querySelector<HTMLInputElement>(".oppopad-pdf-opacity");
    if (color) {
      color.value = style.color;
      color.disabled = this.tool === "eraser";
    }
    if (width) {
      width.value = String(style.width);
      width.disabled = this.tool === "eraser";
    }
    if (opacity) {
      opacity.value = String(Math.round(style.opacity * 100));
      opacity.disabled = this.tool === "eraser";
    }
  }

  private createOverlay(pageEl: HTMLElement, pageIndex: number): PdfPageOverlay {
    pageEl.addClass("oppopad-pdf-page");
    const canvas = pageEl.createEl("canvas", {
      cls: "oppopad-pdf-ink-canvas",
      attr: { "aria-hidden": "true" }
    });
    const liveCanvas = pageEl.createEl("canvas", {
      cls: "oppopad-pdf-live-canvas",
      attr: { "aria-hidden": "true" }
    });
    const overlay: PdfPageOverlay = {
      canvas,
      liveCanvas,
      pageEl,
      pageIndex,
      redrawFrame: null,
      resizeObserver: null
    };
    const pointerDown = (event: PointerEvent): void => this.onPointerDown(event, overlay);
    const pointerMove = (event: PointerEvent): void => this.onPointerMove(event, overlay);
    const pointerUp = (event: PointerEvent): void => this.onPointerUp(event, overlay);
    const pointerCancel = (event: PointerEvent): void => this.onPointerCancel(event, overlay);
    pageEl.addEventListener("pointerdown", pointerDown, { capture: true });
    pageEl.addEventListener("pointermove", pointerMove, { capture: true });
    pageEl.addEventListener("pointerup", pointerUp, { capture: true });
    pageEl.addEventListener("pointercancel", pointerCancel, { capture: true });
    const cleanup = (): void => {
      pageEl.removeEventListener("pointerdown", pointerDown, { capture: true });
      pageEl.removeEventListener("pointermove", pointerMove, { capture: true });
      pageEl.removeEventListener("pointerup", pointerUp, { capture: true });
      pageEl.removeEventListener("pointercancel", pointerCancel, { capture: true });
    };
    overlay.cleanup = cleanup;
    if (typeof ResizeObserver !== "undefined") {
      overlay.resizeObserver = new ResizeObserver(() => this.resizeOverlay(overlay));
      overlay.resizeObserver.observe(pageEl);
    }
    this.resizeOverlay(overlay);
    return overlay;
  }

  private destroyOverlay(overlay: PdfPageOverlay): void {
    if (overlay.redrawFrame !== null) {
      window.cancelAnimationFrame(overlay.redrawFrame);
    }
    overlay.resizeObserver?.disconnect();
    overlay.cleanup?.();
    overlay.canvas.remove();
    overlay.liveCanvas.remove();
    overlay.pageEl.removeClass("oppopad-pdf-page");
  }

  private resizeOverlay(overlay: PdfPageOverlay): void {
    const width = Math.max(1, overlay.pageEl.clientWidth);
    const height = Math.max(1, overlay.pageEl.clientHeight);
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    for (const canvas of [overlay.canvas, overlay.liveCanvas]) {
      const pixelWidth = Math.max(1, Math.round(width * scale));
      const pixelHeight = Math.max(1, Math.round(height * scale));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
    }
    this.redrawOverlay(overlay);
  }

  private onPointerDown(event: PointerEvent, overlay: PdfPageOverlay): void {
    if (event.pointerType !== "pen") {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.handleStylusButton(event)) {
      return;
    }
    overlay.pageEl.setPointerCapture(event.pointerId);
    this.currentPointerId = event.pointerId;
    this.currentOverlay = overlay;
    const point = this.getPoint(event, overlay);
    if (this.tool === "eraser") {
      this.eraseAt(point, overlay);
      return;
    }
    const drawingTool = this.getDrawingTool();
    const style = this.preferences[drawingTool];
    this.currentStroke = {
      color: style.color,
      id: makeStrokeId(),
      opacity: style.opacity,
      page: overlay.pageIndex,
      pageWidth: Math.max(1, overlay.pageEl.clientWidth),
      points: [point],
      tool: drawingTool,
      width: style.width
    };
    this.redrawLive(overlay);
  }

  private onPointerMove(event: PointerEvent, overlay: PdfPageOverlay): void {
    if (event.pointerType !== "pen" || event.pointerId !== this.currentPointerId) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.handleStylusButton(event)) {
      return;
    }
    if (this.tool === "eraser") {
      this.eraseAt(this.getPoint(event, overlay), overlay);
      return;
    }
    if (!this.currentStroke || this.currentOverlay !== overlay) {
      return;
    }
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const samples = coalesced.length > 0 ? [...coalesced, event] : [event];
    for (const sample of samples) {
      this.appendPoint(this.getPoint(sample, overlay), overlay);
    }
    this.redrawLive(overlay);
  }

  private onPointerUp(event: PointerEvent, overlay: PdfPageOverlay): void {
    if (event.pointerType !== "pen" || event.pointerId !== this.currentPointerId) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (overlay.pageEl.hasPointerCapture(event.pointerId)) {
      overlay.pageEl.releasePointerCapture(event.pointerId);
    }
    const stroke = this.currentStroke;
    this.stylusButtonPressed = false;
    if (stroke && this.currentOverlay === overlay) {
      const point = this.getPoint(event, overlay);
      const previous = stroke.points.at(-1);
      if (previous) {
        point.pressure = point.pressure ?? previous.pressure;
      }
      stroke.points.push(point);
      if (stroke.points.length === 1) {
        stroke.points.push({ ...stroke.points[0] });
      }
      this.strokes.push(stroke);
      this.scheduleSave();
      this.redrawOverlay(overlay);
    }
    this.clearPointerState();
  }

  private onPointerCancel(event: PointerEvent, overlay: PdfPageOverlay): void {
    if (event.pointerType !== "pen" || event.pointerId !== this.currentPointerId) {
      return;
    }
    event.preventDefault();
    if (overlay.pageEl.hasPointerCapture(event.pointerId)) {
      overlay.pageEl.releasePointerCapture(event.pointerId);
    }
    this.clearPointerState();
  }

  private handleStylusButton(event: PointerEvent): boolean {
    const pressed = isStylusButtonEvent(event);
    if (!pressed) {
      this.stylusButtonPressed = false;
      return false;
    }
    if (!this.stylusButtonPressed) {
      this.stylusButtonPressed = true;
      this.togglePenEraser();
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }

  private getPoint(event: PointerEvent, overlay: PdfPageOverlay): InkPoint {
    const rect = overlay.pageEl.getBoundingClientRect();
    return {
      pressure: event.pressure > 0.01 ? clamp(event.pressure * 1.15, 0.12, 1) : undefined,
      tiltX: clamp(event.tiltX, -90, 90),
      tiltY: clamp(event.tiltY, -90, 90),
      x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
      y: clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1)
    };
  }

  private appendPoint(point: InkPoint, overlay: PdfPageOverlay): void {
    const stroke = this.currentStroke;
    if (!stroke) {
      return;
    }
    const previous = stroke.points.at(-1);
    if (!previous) {
      stroke.points.push(point);
      return;
    }
    const width = Math.max(1, overlay.pageEl.clientWidth);
    const height = Math.max(1, overlay.pageEl.clientHeight);
    const distance = Math.hypot((point.x - previous.x) * width, (point.y - previous.y) * height);
    if (distance < 0.45) {
      previous.pressure = Math.max(previous.pressure ?? 0, point.pressure ?? 0);
      return;
    }
    const rawPressure = point.pressure ?? previous.pressure ?? 0.5;
    const previousPressure = previous.pressure ?? rawPressure;
    const smoothedPressure = previousPressure + (rawPressure - previousPressure) * 0.38;
    const maximumChange = Math.max(0.025, (distance / Math.max(stroke.width, 0.5)) * 0.28);
    stroke.points.push({
      ...point,
      pressure: clamp(smoothedPressure, previousPressure - maximumChange, previousPressure + maximumChange)
    });
  }

  private eraseAt(point: InkPoint, overlay: PdfPageOverlay): void {
    const width = Math.max(1, overlay.pageEl.clientWidth);
    const height = Math.max(1, overlay.pageEl.clientHeight);
    const before = this.strokes.length;
    this.strokes = this.strokes.filter(
      (stroke) =>
        stroke.page !== overlay.pageIndex ||
        !pdfStrokeHitTest(stroke, point.x * width, point.y * height, width, height, 16)
    );
    if (this.strokes.length !== before) {
      this.scheduleSave();
      this.redrawOverlay(overlay);
    }
  }

  private redrawAll(): void {
    for (const overlay of this.overlays.values()) {
      this.redrawOverlay(overlay);
    }
  }

  private redrawOverlay(overlay: PdfPageOverlay): void {
    if (overlay.redrawFrame !== null) {
      return;
    }
    overlay.redrawFrame = window.requestAnimationFrame(() => {
      overlay.redrawFrame = null;
      const width = Math.max(1, overlay.pageEl.clientWidth);
      const height = Math.max(1, overlay.pageEl.clientHeight);
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      const context = overlay.canvas.getContext("2d");
      if (!context) {
        return;
      }
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, width, height);
      for (const stroke of this.strokes) {
        if (stroke.page === overlay.pageIndex) {
          drawPdfStroke(context, stroke, width, height);
        }
      }
    });
  }

  private redrawLive(overlay: PdfPageOverlay): void {
    const width = Math.max(1, overlay.pageEl.clientWidth);
    const height = Math.max(1, overlay.pageEl.clientHeight);
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const context = overlay.liveCanvas.getContext("2d");
    if (!context) {
      return;
    }
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    if (this.currentStroke && this.currentOverlay === overlay) {
      drawPdfStroke(context, this.currentStroke, width, height);
    }
  }

  private clearLiveCanvas(): void {
    for (const overlay of this.overlays.values()) {
      const context = overlay.liveCanvas.getContext("2d");
      context?.clearRect(0, 0, overlay.liveCanvas.width, overlay.liveCanvas.height);
    }
  }

  private clearPointerState(): void {
    this.currentStroke = null;
    this.currentPointerId = null;
    this.currentOverlay = null;
    this.clearLiveCanvas();
  }

  private getDrawingTool(): DrawingTool {
    return this.tool === "highlighter" ? "highlighter" : "pen";
  }

  private togglePenEraser(): void {
    this.tool = this.tool === "eraser" ? "pen" : "eraser";
    this.clearPointerState();
    this.updateToolbar();
    new Notice(this.tool === "eraser" ? "橡皮" : "钢笔", 700);
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.plugin.saveAnnotations(this.file.path, this.strokes);
    }, SAVE_DELAY_MS);
  }
}

function drawStroke(context: CanvasRenderingContext2D, stroke: InkStroke, width: number): void {
  const outline = getStrokeOutline(stroke, width);
  if (outline.length < 3) {
    return;
  }
  context.save();
  context.fillStyle = stroke.color;
  context.globalAlpha = stroke.opacity;
  context.beginPath();
  context.moveTo(outline[0][0], outline[0][1]);
  for (let index = 1; index < outline.length - 1; index += 1) {
    const point = outline[index];
    const next = outline[index + 1];
    context.quadraticCurveTo(
      point[0],
      point[1],
      (point[0] + next[0]) / 2,
      (point[1] + next[1]) / 2
    );
  }
  context.closePath();
  context.fill();
  context.restore();
}

function drawPdfStroke(
  context: CanvasRenderingContext2D,
  stroke: InkStroke,
  width: number,
  height: number
): void {
  if (stroke.points.length === 0) {
    return;
  }
  const size = stroke.width * (width / Math.max(1, stroke.pageWidth ?? width));
  const outline = getStroke(
    stroke.points.map((point) => ({
      pressure: point.pressure ?? 0.5,
      x: point.x * width,
      y: point.y * height
    })),
    {
      end: { cap: true, taper: 0 },
      last: true,
      simulatePressure: false,
      size,
      smoothing: stroke.tool === "highlighter" ? 0.62 : 0.58,
      start: { cap: true, taper: 0 },
      streamline: stroke.tool === "highlighter" ? 0.28 : 0.18,
      thinning: stroke.tool === "highlighter" ? 0 : 0.58
    }
  );
  if (outline.length < 3) {
    return;
  }
  context.save();
  context.fillStyle = stroke.color;
  context.globalAlpha = stroke.opacity;
  context.beginPath();
  context.moveTo(outline[0][0], outline[0][1]);
  for (let index = 1; index < outline.length - 1; index += 1) {
    const point = outline[index];
    const next = outline[index + 1];
    context.quadraticCurveTo(
      point[0],
      point[1],
      (point[0] + next[0]) / 2,
      (point[1] + next[1]) / 2
    );
  }
  context.closePath();
  context.fill();
  context.restore();
}

function pdfStrokeHitTest(
  stroke: InkStroke,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): boolean {
  for (let index = 1; index < stroke.points.length; index += 1) {
    const start = stroke.points[index - 1];
    const end = stroke.points[index];
    if (
      pointToSegmentDistance(
        x,
        y,
        start.x * width,
        start.y * height,
        end.x * width,
        end.y * height
      ) <= radius
    ) {
      return true;
    }
  }
  return false;
}

function isStylusButtonEvent(event: PointerEvent): boolean {
  return (
    event.button === 2 ||
    event.button === 5 ||
    event.button === 6 ||
    (event.buttons & 2) !== 0 ||
    (event.buttons & 32) !== 0 ||
    (event.buttons & 64) !== 0
  );
}

function getStrokeOutline(stroke: InkStroke, width: number): number[][] {
  if (stroke.points.length === 0) {
    return [];
  }
  return getStroke(
    stroke.points.map((point) => ({
      pressure: point.pressure ?? 0.5,
      x: point.x * width,
      y: point.y
    })),
    {
      end: { cap: true, taper: 0 },
      last: true,
      simulatePressure: false,
      size: stroke.width,
      smoothing: stroke.tool === "highlighter" ? 0.62 : 0.58,
      start: { cap: true, taper: 0 },
      streamline: stroke.tool === "highlighter" ? 0.28 : 0.18,
      thinning: stroke.tool === "highlighter" ? 0 : 0.58
    }
  );
}

function strokeOutlineToSvgPath(outline: number[][]): string {
  if (outline.length < 3) {
    return "";
  }
  let path = `M ${outline[0][0].toFixed(2)} ${outline[0][1].toFixed(2)}`;
  for (let index = 1; index < outline.length - 1; index += 1) {
    const point = outline[index];
    const next = outline[index + 1];
    path += ` Q ${point[0].toFixed(2)} ${point[1].toFixed(2)} ${((point[0] + next[0]) / 2).toFixed(2)} ${((point[1] + next[1]) / 2).toFixed(2)}`;
  }
  return `${path} Z`;
}

function strokeHitTest(
  stroke: InkStroke,
  x: number,
  y: number,
  width: number,
  radius: number
): boolean {
  for (let index = 1; index < stroke.points.length; index += 1) {
    const start = stroke.points[index - 1];
    const end = stroke.points[index];
    if (pointToSegmentDistance(x, y, start.x * width, start.y, end.x * width, end.y) <= radius) {
      return true;
    }
  }
  return false;
}

function strokeIntersectsRange(stroke: InkStroke, top: number, bottom: number): boolean {
  for (const point of stroke.points) {
    if (point.y >= top - stroke.width && point.y <= bottom + stroke.width) {
      return true;
    }
  }
  return false;
}

function pointToSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) {
    return Math.hypot(px - ax, py - ay);
  }
  const ratio = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy));
}

function touchMapDistance(touches: Map<number, { x: number; y: number }>): number {
  const points = Array.from(touches.values());
  if (points.length < 2) {
    return 0;
  }
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

function touchMapCenter(touches: Map<number, { x: number; y: number }>): { x: number; y: number } {
  const points = Array.from(touches.values()).slice(0, 2);
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  const total = points.reduce(
    (result, point) => ({ x: result.x + point.x, y: result.y + point.y }),
    { x: 0, y: 0 }
  );
  return { x: total.x / points.length, y: total.y / points.length };
}

function cloneStroke(stroke: InkStroke): InkStroke {
  return {
    ...stroke,
    points: stroke.points.map((point) => ({ ...point }))
  };
}

function normalizePluginData(value: unknown): PluginData {
  if (!value || typeof value !== "object") {
    return {
      ...DEFAULT_DATA,
      annotations: {},
      preferences: clonePreferences(DEFAULT_PREFERENCES)
    };
  }
  const record = value as Partial<PluginData>;
  const annotations: Record<string, InkStroke[]> = {};
  if (record.annotations && typeof record.annotations === "object") {
    for (const [path, strokes] of Object.entries(record.annotations)) {
      if (!Array.isArray(strokes)) {
        continue;
      }
      annotations[path] = strokes.filter(isInkStroke).map(normalizeStroke);
    }
  }
  return {
    annotations,
    preferences: normalizePreferences(record.preferences),
    version: DATA_VERSION
  };
}

function isInkStroke(value: unknown): value is InkStroke {
  if (!value || typeof value !== "object") {
    return false;
  }
  const stroke = value as Partial<InkStroke>;
  return (
    typeof stroke.id === "string" &&
    typeof stroke.color === "string" &&
    typeof stroke.width === "number" &&
    Array.isArray(stroke.points) &&
    stroke.points.every(
      (point) =>
        point &&
        typeof point === "object" &&
        typeof (point as Partial<InkPoint>).x === "number" &&
        typeof (point as Partial<InkPoint>).y === "number"
    )
  );
}

function normalizeStroke(stroke: InkStroke): InkStroke {
  return {
    ...cloneStroke(stroke),
    opacity: typeof stroke.opacity === "number" ? clamp(stroke.opacity, 0.05, 1) : 1,
    tool: stroke.tool === "highlighter" ? "highlighter" : "pen"
  };
}

function clonePreferences(preferences: ToolPreferences): ToolPreferences {
  return {
    pen: { ...preferences.pen },
    highlighter: { ...preferences.highlighter }
  };
}

function normalizePreferences(value: unknown): ToolPreferences {
  if (!value || typeof value !== "object") {
    return clonePreferences(DEFAULT_PREFERENCES);
  }
  const record = value as Partial<ToolPreferences>;
  return {
    pen: normalizeToolStyle(record.pen, DEFAULT_PREFERENCES.pen),
    highlighter: normalizeToolStyle(record.highlighter, DEFAULT_PREFERENCES.highlighter)
  };
}

function normalizeToolStyle(value: unknown, fallback: ToolStyle): ToolStyle {
  if (!value || typeof value !== "object") {
    return { ...fallback };
  }
  const style = value as Partial<ToolStyle>;
  return {
    color: typeof style.color === "string" ? style.color : fallback.color,
    opacity: typeof style.opacity === "number" ? clamp(style.opacity, 0.05, 1) : fallback.opacity,
    width: typeof style.width === "number" ? clamp(style.width, 1, 40) : fallback.width
  };
}

function makeStrokeId(): string {
  return `stroke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
