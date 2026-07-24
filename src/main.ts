import {
  Component,
  ItemView,
  MarkdownRenderer,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  setIcon
} from "obsidian";
import type { ViewStateResult } from "obsidian";

const VIEW_TYPE = "oppopad-markdown-annotation";
const DATA_VERSION = 2;
const SYNC_FOLDER = "OPPO Pad Annotations";
const SYNC_FILE = `${SYNC_FOLDER}/annotations.json`;
const SAVE_DELAY_MS = 350;
const LOGICAL_PAGE_WIDTH = 1180;
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

  async onload(): Promise<void> {
    const legacyData = normalizePluginData(await this.loadData());
    this.data = await this.loadSyncedData(legacyData);

    this.registerView(VIEW_TYPE, (leaf) => new MarkdownAnnotationView(leaf, this));

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
      if (!(file instanceof TFile) || file.extension !== "md") {
        new Notice("Open a Markdown file first.");
        return;
      }
      void this.openMarkdownAnnotation(file, this.app.workspace.getLeaf(false));
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
        if (!(file instanceof TFile) || file.extension !== "md") {
          return;
        }
        menu.addItem((item) => {
          item
            .setTitle("Open in handwriting view")
            .setIcon("pen-line")
            .onClick(() => void this.openMarkdownAnnotation(file, leaf ?? this.app.workspace.getLeaf("tab")));
        });
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile) || file.extension !== "md") {
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

class MarkdownAnnotationView extends ItemView {
  private canvasTiles: CanvasTile[] = [];
  private clearConfirmUntil = 0;
  private currentStroke: InkStroke | null = null;
  private colorInput: HTMLInputElement | null = null;
  private filePath = "";
  private lastPenTapAt = 0;
  private lastPenTapPosition = { x: 0, y: 0 };
  private lastStrokeWasTap = false;
  private markdownComponent: Component | null = null;
  private markdownEl: HTMLElement | null = null;
  private renderGeneration = 0;
  private redrawFrame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private saveTimer: number | null = null;
  private scrollEl: HTMLElement | null = null;
  private sidebarCloseFrame: number | null = null;
  private stageEl: HTMLElement | null = null;
  private strokes: InkStroke[] = [];
  private tool: InkTool = "pen";
  private toolbarEl: HTMLElement | null = null;
  private trackedTouches = new Map<number, { x: number; y: number }>();
  private touchMode: "pending" | "horizontal" | "vertical" | null = null;
  private fitZoom = 1;
  private zoom = 1;
  private opacityInput: HTMLInputElement | null = null;
  private opacityValueEl: HTMLElement | null = null;
  private penDownPosition = { x: 0, y: 0 };
  private penMoved = false;
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
    this.stageEl = this.scrollEl.createDiv({ cls: "oppopad-annotation-stage" });
    this.stageEl.style.setProperty("--oppopad-page-width", `${LOGICAL_PAGE_WIDTH}px`);
    this.markdownEl = this.stageEl.createDiv({ cls: "markdown-preview-view markdown-rendered oppopad-markdown-content" });

    this.registerDomEvent(this.stageEl, "pointerdown", (event) => this.onPointerDown(event), { capture: true });
    this.registerDomEvent(this.stageEl, "pointermove", (event) => this.onPointerMove(event), { capture: true });
    this.registerDomEvent(this.stageEl, "pointerup", (event) => this.onPointerUp(event), { capture: true });
    this.registerDomEvent(this.stageEl, "pointercancel", (event) => this.onPointerUp(event), { capture: true });
    const suppressSidebarTouchGesture = (event: TouchEvent): void => {
      if (event.touches.length >= 2 || this.touchMode === "horizontal") {
        event.preventDefault();
      }
      event.stopImmediatePropagation();
    };
    this.registerDomEvent(this.stageEl, "touchstart", suppressSidebarTouchGesture, {
      capture: true,
      passive: false
    });
    this.registerDomEvent(this.stageEl, "touchmove", suppressSidebarTouchGesture, {
      capture: true,
      passive: false
    });
    this.registerDomEvent(this.stageEl, "touchend", suppressSidebarTouchGesture, {
      capture: true,
      passive: false
    });

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
    if (this.sidebarCloseFrame !== null) {
      window.cancelAnimationFrame(this.sidebarCloseFrame);
      this.sidebarCloseFrame = null;
    }
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
      this.keepSidebarsClosed();
      event.stopImmediatePropagation();
      this.trackedTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.trackedTouches.size === 1) {
        this.touchMode = "pending";
      } else {
        this.touchMode = null;
        event.preventDefault();
        for (const pointerId of this.trackedTouches.keys()) {
          this.stageEl?.setPointerCapture(pointerId);
        }
      }
      return;
    }

    if (event.pointerType !== "pen") {
      return;
    }

    this.keepSidebarsClosed();
    event.preventDefault();
    event.stopImmediatePropagation();

    const now = performance.now();
    const isSideButton =
      event.button === 2 ||
      event.button === 5 ||
      event.button === 6 ||
      (event.buttons & 2) !== 0 ||
      (event.buttons & 32) !== 0 ||
      (event.buttons & 64) !== 0;
    const isDoubleTap =
      event.detail >= 2 ||
      (now - this.lastPenTapAt < 380 &&
        Math.hypot(
          event.clientX - this.lastPenTapPosition.x,
          event.clientY - this.lastPenTapPosition.y
        ) < 36);
    if (isSideButton || isDoubleTap) {
      if (isDoubleTap && this.lastStrokeWasTap && this.strokes.at(-1)?.points.length === 2) {
        this.strokes.pop();
        this.scheduleSave();
        this.redraw();
      }
      this.lastPenTapAt = 0;
      this.togglePenEraser();
      return;
    }

    this.penDownPosition = { x: event.clientX, y: event.clientY };
    this.penMoved = false;
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
    this.redraw();
  }

  private onPointerMove(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      if (!this.trackedTouches.has(event.pointerId)) {
        return;
      }
      this.keepSidebarsClosed();
      event.stopImmediatePropagation();
      const before = new Map(this.trackedTouches);
      this.trackedTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.trackedTouches.size === 1) {
        const previous = before.get(event.pointerId);
        if (previous && this.touchMode === "pending") {
          const dx = event.clientX - previous.x;
          const dy = event.clientY - previous.y;
          if (Math.hypot(dx, dy) >= 4) {
            this.touchMode = Math.abs(dx) > Math.abs(dy) * 1.15 ? "horizontal" : "vertical";
          }
        }
        if (previous && this.scrollEl && this.touchMode === "horizontal") {
          event.preventDefault();
          const effectiveZoom = this.getEffectiveZoom();
          this.scrollEl.scrollLeft -= (event.clientX - previous.x) / effectiveZoom;
        }
      } else if (this.trackedTouches.size >= 2 && this.scrollEl) {
        event.preventDefault();
        const beforeDistance = touchMapDistance(before);
        const afterDistance = touchMapDistance(this.trackedTouches);
        const beforeCenter = touchMapCenter(before);
        const afterCenter = touchMapCenter(this.trackedTouches);
        const effectiveZoom = this.getEffectiveZoom();
        this.scrollEl.scrollLeft -= (afterCenter.x - beforeCenter.x) / effectiveZoom;
        this.scrollEl.scrollTop -= (afterCenter.y - beforeCenter.y) / effectiveZoom;
        if (beforeDistance > 0 && afterDistance > 0) {
          this.setZoom(this.zoom * (afterDistance / beforeDistance));
        }
      }
      return;
    }

    if (event.pointerType !== "pen") {
      return;
    }

    this.keepSidebarsClosed();
    event.preventDefault();
    event.stopImmediatePropagation();
    if (Math.hypot(event.clientX - this.penDownPosition.x, event.clientY - this.penDownPosition.y) > 7) {
      this.penMoved = true;
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
    this.redraw();
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      event.stopImmediatePropagation();
      if (this.touchMode === "horizontal" || this.trackedTouches.size >= 2) {
        event.preventDefault();
      }
      this.trackedTouches.delete(event.pointerId);
      if (this.stageEl?.hasPointerCapture(event.pointerId)) {
        this.stageEl.releasePointerCapture(event.pointerId);
      }
      this.touchMode = this.trackedTouches.size === 1 ? "pending" : null;
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
    this.currentStroke = null;
    this.lastPenTapAt = this.penMoved ? 0 : performance.now();
    this.lastPenTapPosition = { x: event.clientX, y: event.clientY };
    this.lastStrokeWasTap = !this.penMoved && stroke !== null;
    if (!stroke) {
      return;
    }
    this.appendFinalPoint(stroke, this.getInkPoint(event));
    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      stroke.points.push({ ...point, x: Math.min(1, point.x + 0.001) });
    }
    this.strokes.push(stroke);
    this.scheduleSave();
    this.redraw();
  }

  private togglePenEraser(): void {
    this.setTool(this.tool === "eraser" ? "pen" : "eraser");
    new Notice(this.tool === "eraser" ? "橡皮" : "钢笔", 700);
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

  private getInkPoint(event: PointerEvent): InkPoint {
    const stage = this.stageEl;
    if (!stage) {
      return { x: 0, y: 0 };
    }
    const rect = stage.getBoundingClientRect();
    return {
      pressure: clamp(event.pressure > 0 ? event.pressure : 0.5, 0, 1),
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
    if (distance < 0.35) {
      return;
    }
    stroke.points.push({
      pressure: previous.pressure === undefined
        ? point.pressure
        : previous.pressure + ((point.pressure ?? previous.pressure) - previous.pressure) * 0.42,
      tiltX: previous.tiltX === undefined
        ? point.tiltX
        : previous.tiltX + ((point.tiltX ?? previous.tiltX) - previous.tiltX) * 0.34,
      tiltY: previous.tiltY === undefined
        ? point.tiltY
        : previous.tiltY + ((point.tiltY ?? previous.tiltY) - previous.tiltY) * 0.34,
      x: previous.x + (point.x - previous.x) * 0.72,
      y: previous.y + (point.y - previous.y) * 0.72
    });
  }

  private appendFinalPoint(stroke: InkStroke, point: InkPoint): void {
    const previous = stroke.points.at(-1);
    if (!previous) {
      stroke.points.push(point);
      return;
    }
    const width = LOGICAL_PAGE_WIDTH;
    if (Math.hypot((point.x - previous.x) * width, point.y - previous.y) >= 0.2) {
      stroke.points.push(point);
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

  private getEffectiveZoom(): number {
    return this.fitZoom * this.zoom;
  }

  private applyZoom(): void {
    if (this.stageEl) {
      this.stageEl.style.setProperty("--oppopad-zoom", String(this.getEffectiveZoom()));
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
    const height = Math.max(
      scroll.clientHeight / this.getEffectiveZoom(),
      this.markdownEl?.scrollHeight ?? 0,
      1
    );
    stage.style.setProperty("--oppopad-stage-height", `${height}px`);
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
        if (
          this.currentStroke &&
          strokeIntersectsRange(this.currentStroke, tile.top, tile.top + tile.height)
        ) {
          drawStroke(context, this.currentStroke, LOGICAL_PAGE_WIDTH);
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

function drawStroke(context: CanvasRenderingContext2D, stroke: InkStroke, width: number): void {
  if (stroke.points.length < 2) {
    return;
  }
  context.save();
  context.strokeStyle = stroke.color;
  context.globalAlpha = stroke.opacity;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (let index = 1; index < stroke.points.length; index += 1) {
    const beforePrevious = stroke.points[Math.max(0, index - 2)];
    const previous = stroke.points[index - 1];
    const point = stroke.points[index];
    const pressure = ((previous.pressure ?? 0.5) + (point.pressure ?? 0.5)) / 2;
    const tilt = Math.min(1, Math.hypot(point.tiltX ?? 0, point.tiltY ?? 0) / 60);
    const pressureFactor = stroke.tool === "highlighter" ? 1 : 0.58 + pressure * 0.72;
    context.lineWidth = Math.max(0.5, stroke.width * pressureFactor * (1 + tilt * 0.08));
    const startX = index === 1
      ? beforePrevious.x * width
      : ((beforePrevious.x + previous.x) / 2) * width;
    const startY = index === 1
      ? beforePrevious.y
      : (beforePrevious.y + previous.y) / 2;
    const endX = index === stroke.points.length - 1
      ? point.x * width
      : ((previous.x + point.x) / 2) * width;
    const endY = index === stroke.points.length - 1
      ? point.y
      : (previous.y + point.y) / 2;
    context.beginPath();
    context.moveTo(startX, startY);
    context.quadraticCurveTo(previous.x * width, previous.y, endX, endY);
    context.stroke();
  }
  context.restore();
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
