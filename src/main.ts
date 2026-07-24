import {
  Component,
  ItemView,
  MarkdownRenderer,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import type { ViewStateResult } from "obsidian";

const VIEW_TYPE = "oppopad-markdown-annotation";
const DATA_VERSION = 1;
const SAVE_DELAY_MS = 350;

type InkTool = "pen" | "eraser";

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
  points: InkPoint[];
  width: number;
}

interface PluginData {
  annotations: Record<string, InkStroke[]>;
  version: number;
}

interface AnnotationViewState {
  file?: string;
}

const DEFAULT_DATA: PluginData = {
  annotations: {},
  version: DATA_VERSION
};

export default class OppoPadMarkdownAnnotationPlugin extends Plugin {
  private data: PluginData = { ...DEFAULT_DATA, annotations: {} };

  async onload(): Promise<void> {
    this.data = normalizePluginData(await this.loadData());

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
      void this.openMarkdownAnnotation(file, this.app.workspace.getLeaf("split"));
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
        void this.saveData(this.data);
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
    await this.saveData(this.data);
  }

  private async openMarkdownAnnotation(file: TFile, leaf: WorkspaceLeaf): Promise<void> {
    for (const existingLeaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const state = existingLeaf.view.getState() as AnnotationViewState;
      if (state.file === file.path) {
        await this.app.workspace.revealLeaf(existingLeaf);
        return;
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
  private canvas: HTMLCanvasElement | null = null;
  private clearConfirmUntil = 0;
  private currentStroke: InkStroke | null = null;
  private filePath = "";
  private markdownComponent: Component | null = null;
  private markdownEl: HTMLElement | null = null;
  private renderGeneration = 0;
  private resizeObserver: ResizeObserver | null = null;
  private saveTimer: number | null = null;
  private scrollEl: HTMLElement | null = null;
  private stageEl: HTMLElement | null = null;
  private strokes: InkStroke[] = [];
  private tool: InkTool = "pen";
  private toolbarEl: HTMLElement | null = null;
  private trackedTouches = new Map<number, { x: number; y: number }>();
  private zoom = 1;
  private pinchDistance = 0;
  private pinchStartZoom = 1;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: OppoPadMarkdownAnnotationPlugin
  ) {
    super(leaf);
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

  async setState(state: AnnotationViewState, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    this.filePath = typeof state.file === "string" ? state.file : "";
    this.strokes = this.filePath ? this.plugin.getAnnotations(this.filePath) : [];
    await this.renderMarkdown();
  }

  protected async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("oppopad-markdown-annotation-view");

    this.toolbarEl = this.contentEl.createDiv({ cls: "oppopad-annotation-toolbar" });
    this.createToolbarButton("pen-line", "Pen", () => this.setTool("pen"), "pen");
    this.createToolbarButton("eraser", "Eraser", () => this.setTool("eraser"), "eraser");
    this.createToolbarButton("undo-2", "Undo last stroke", () => this.undo());
    this.createToolbarButton("trash-2", "Clear handwriting", () => this.clearHandwriting());
    this.createToolbarButton("minus", "Zoom out", () => this.setZoom(this.zoom - 0.1));
    this.createToolbarButton("plus", "Zoom in", () => this.setZoom(this.zoom + 0.1));
    this.createToolbarButton("file-text", "Return to Markdown", () => void this.returnToMarkdown());

    this.scrollEl = this.contentEl.createDiv({ cls: "oppopad-annotation-scroll" });
    this.stageEl = this.scrollEl.createDiv({ cls: "oppopad-annotation-stage" });
    this.markdownEl = this.stageEl.createDiv({ cls: "markdown-preview-view markdown-rendered oppopad-markdown-content" });
    this.canvas = this.stageEl.createEl("canvas", {
      cls: "oppopad-ink-canvas",
      attr: { "aria-hidden": "true" }
    });

    this.registerDomEvent(this.stageEl, "pointerdown", (event) => this.onPointerDown(event), { capture: true });
    this.registerDomEvent(this.stageEl, "pointermove", (event) => this.onPointerMove(event), { capture: true });
    this.registerDomEvent(this.stageEl, "pointerup", (event) => this.onPointerUp(event), { capture: true });
    this.registerDomEvent(this.stageEl, "pointercancel", (event) => this.onPointerUp(event), { capture: true });

    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.resizeObserver.observe(this.stageEl);
    this.register(() => this.resizeObserver?.disconnect());

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.path === this.filePath) {
          void this.renderMarkdown();
        }
      })
    );

    this.updateToolbarState();
    await this.renderMarkdown();
  }

  protected async onClose(): Promise<void> {
    this.flushSave();
    this.unloadMarkdownComponent();
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
      this.resizeCanvas();
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
      window.requestAnimationFrame(() => this.resizeCanvas());
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

  private setTool(tool: InkTool): void {
    this.tool = tool;
    this.currentStroke = null;
    this.updateToolbarState();
  }

  private updateToolbarState(): void {
    if (!this.toolbarEl) {
      return;
    }
    for (const button of Array.from(this.toolbarEl.querySelectorAll<HTMLElement>("[data-tool]"))) {
      button.classList.toggle("is-active", button.dataset.tool === this.tool);
    }
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      this.trackedTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.trackedTouches.size === 2) {
        this.pinchDistance = touchMapDistance(this.trackedTouches);
        this.pinchStartZoom = this.zoom;
      }
      return;
    }

    if (event.pointerType !== "pen") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.button === 5 || (event.buttons & 32) !== 0 || event.detail >= 2) {
      this.setTool(this.tool === "eraser" ? "pen" : "eraser");
      new Notice(this.tool === "eraser" ? "Eraser" : "Pen", 700);
      return;
    }

    this.stageEl?.setPointerCapture(event.pointerId);
    const point = this.getInkPoint(event);
    if (this.tool === "eraser") {
      this.eraseAt(point);
      return;
    }

    this.currentStroke = {
      color: "#d9480f",
      id: makeStrokeId(),
      points: [point],
      width: 3
    };
    this.redraw();
  }

  private onPointerMove(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      if (!this.trackedTouches.has(event.pointerId)) {
        return;
      }
      this.trackedTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.trackedTouches.size >= 2 && this.pinchDistance > 0) {
        event.preventDefault();
        const distance = touchMapDistance(this.trackedTouches);
        this.setZoom(this.pinchStartZoom * (distance / this.pinchDistance));
      }
      return;
    }

    if (event.pointerType !== "pen") {
      return;
    }

    if (this.tool === "eraser") {
      if ((event.buttons & 1) !== 0 || event.pressure > 0) {
        event.preventDefault();
        this.eraseAt(this.getInkPoint(event));
      }
      return;
    }

    if (!this.currentStroke) {
      return;
    }

    event.preventDefault();
    const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
    for (const sample of samples) {
      this.appendInkPoint(this.getInkPoint(sample));
    }
    this.redraw();
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      this.trackedTouches.delete(event.pointerId);
      if (this.trackedTouches.size < 2) {
        this.pinchDistance = 0;
      }
      return;
    }

    if (event.pointerType !== "pen") {
      return;
    }

    if (this.stageEl?.hasPointerCapture(event.pointerId)) {
      this.stageEl.releasePointerCapture(event.pointerId);
    }

    const stroke = this.currentStroke;
    this.currentStroke = null;
    if (!stroke) {
      return;
    }
    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      stroke.points.push({ ...point, x: Math.min(1, point.x + 0.001) });
    }
    this.strokes.push(stroke);
    this.scheduleSave();
    this.redraw();
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
      y: Math.max(0, (event.clientY - rect.top) / this.zoom)
    };
  }

  private appendInkPoint(point: InkPoint): void {
    const stroke = this.currentStroke;
    if (!stroke) {
      return;
    }
    const previous = stroke.points[stroke.points.length - 1];
    const width = this.canvas?.clientWidth ?? 1;
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
      x: point.x,
      y: point.y
    });
  }

  private eraseAt(point: InkPoint): void {
    const width = this.canvas?.clientWidth ?? 1;
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
    this.zoom = clamp(value, 0.6, 3);
    if (this.stageEl) {
      this.stageEl.setCssProps({ "--oppopad-zoom": String(this.zoom) });
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

  private resizeCanvas(): void {
    const canvas = this.canvas;
    const stage = this.stageEl;
    const scroll = this.scrollEl;
    if (!canvas || !stage || !scroll) {
      return;
    }
    const width = Math.max(1, stage.clientWidth);
    const height = Math.max(scroll.clientHeight, this.markdownEl?.scrollHeight ?? 0, 1);
    stage.setCssProps({ "--oppopad-stage-height": `${height}px` });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.setCssProps({
        "--oppopad-canvas-width": `${width}px`,
        "--oppopad-canvas-height": `${height}px`,
      });
      this.redraw();
    }
  }

  private redraw(): void {
    const canvas = this.canvas;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    for (const stroke of this.strokes) {
      drawStroke(context, stroke, width);
    }
    if (this.currentStroke) {
      drawStroke(context, this.currentStroke, width);
    }
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
}

function drawStroke(context: CanvasRenderingContext2D, stroke: InkStroke, width: number): void {
  if (stroke.points.length < 2) {
    return;
  }
  context.save();
  context.strokeStyle = stroke.color;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (let index = 1; index < stroke.points.length; index += 1) {
    const previous = stroke.points[index - 1];
    const point = stroke.points[index];
    const pressure = ((previous.pressure ?? 0.5) + (point.pressure ?? 0.5)) / 2;
    const tilt = Math.min(1, Math.hypot(point.tiltX ?? 0, point.tiltY ?? 0) / 60);
    context.lineWidth = Math.max(0.5, stroke.width * (0.3 + pressure * 1.4) * (1 + tilt * 0.2));
    context.beginPath();
    context.moveTo(previous.x * width, previous.y);
    context.lineTo(point.x * width, point.y);
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

function cloneStroke(stroke: InkStroke): InkStroke {
  return {
    ...stroke,
    points: stroke.points.map((point) => ({ ...point }))
  };
}

function normalizePluginData(value: unknown): PluginData {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_DATA, annotations: {} };
  }
  const record = value as Partial<PluginData>;
  const annotations: Record<string, InkStroke[]> = {};
  if (record.annotations && typeof record.annotations === "object") {
    for (const [path, strokes] of Object.entries(record.annotations)) {
      if (!Array.isArray(strokes)) {
        continue;
      }
      annotations[path] = strokes.filter(isInkStroke).map(cloneStroke);
    }
  }
  return { annotations, version: DATA_VERSION };
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

function makeStrokeId(): string {
  return `stroke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
