import {
  Component,
  EventEmitter,
  Input,
  OnDestroy,
  Output,
  ChangeDetectionStrategy,
  ChangeDetectorRef
} from '@angular/core';
import {
  applyEasing,
  EasingName,
  EASING_LABELS,
  Keyframe,
  morphPathData,
  MorphPair,
  prepareMorph
} from '../../lib/path-morph';
import { downloadText, exportHtmlPlayer, exportSvgAnimation } from '../../lib/morph-export';

export interface MorphKeyframe {
  id: number;
  /** Raw SVG path data captured when the keyframe was added. */
  path: string;
  /** Easing applied to the transition that *ends* at this keyframe. */
  easing: EasingName;
  /** Duration in ms of the transition that *ends* at this keyframe. */
  duration: number;
  /** Optional label shown in the timeline. */
  label: string;
}

interface PreparedSegment {
  from: string;
  to: string;
  easing: EasingName;
  duration: number;
  pair: MorphPair;
}

/**
 * Timeline + playback engine for SVG path morphing.
 *
 * Added for this fork. Upstream has no animation capability at all: every
 * edit is a static snapshot. This component keeps a list of keyframes, builds
 * morph pairs lazily (only when the keyframe list changes), and drives a
 * requestAnimationFrame loop that writes interpolated path data to the canvas.
 */
@Component({
  selector: 'app-morph-timeline',
  templateUrl: './morph-timeline.component.html',
  styleUrls: ['./morph-timeline.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MorphTimelineComponent implements OnDestroy {
  /** Current path in the editor, used when capturing a new keyframe. */
  @Input() set currentPath(value: string) {
    this._currentPath = value || '';
  }
  get currentPath(): string {
    return this._currentPath;
  }

  /** Emitted on every animation frame with the interpolated path data. */
  @Output() previewPath = new EventEmitter<string | null>();
  /** Emitted when playback starts / stops so the editor can lock edits. */
  @Output() playingChange = new EventEmitter<boolean>();

  readonly easings = Object.keys(EASING_LABELS) as EasingName[];
  readonly easingLabels = EASING_LABELS;

  keyframes: MorphKeyframe[] = [];
  selectedId: number | null = null;

  isPlaying = false;
  isLooping = true;
  /** When true only the header row is shown. Lets the panel fit on phones. */
  isCollapsed = false;
  /** Global timeline progress in ms. */
  playhead = 0;

  /** Total duration of the whole timeline, excluding the first keyframe. */
  totalDuration = 0;
  currentPathData: string | null = null;

  private _currentPath = '';
  private nextId = 1;
  private segments: PreparedSegment[] = [];
  private rafId: number | null = null;
  private lastFrameTime = 0;
  private dirty = true;
  private emittedPerSecond = 0;
  private fpsWindowStart = 0;
  private fpsFrames = 0;

  /** Measured rendering throughput, exposed for the diagnostics panel. */
  measuredFps = 0;
  lastFrameCostMs = 0;

  constructor(private cdr: ChangeDetectorRef) {}

  ngOnDestroy(): void {
    this.stop();
  }

  /* ---------------- keyframe management ---------------- */

  addKeyframe(path?: string): void {
    const source = (path ?? this._currentPath).trim();
    if (!source) {
      return;
    }
    const index = this.keyframes.length;
    const kf: MorphKeyframe = {
      id: this.nextId++,
      path: source,
      easing: index === 0 ? 'linear' : 'easeInOutCubic',
      duration: index === 0 ? 0 : 600,
      label: `K${index + 1}`
    };
    this.keyframes = [...this.keyframes, kf];
    this.selectedId = kf.id;
    this.markDirty();
    this.renumber();
  }

  removeKeyframe(id: number): void {
    const index = this.keyframes.findIndex((k) => k.id === id);
    if (index < 0) {
      return;
    }
    this.keyframes = this.keyframes.filter((k) => k.id !== id);
    if (this.selectedId === id) {
      this.selectedId = this.keyframes.length ? this.keyframes[0].id : null;
    }
    this.markDirty();
    this.renumber();
  }

  moveKeyframe(id: number, delta: number): void {
    const index = this.keyframes.findIndex((k) => k.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= this.keyframes.length) {
      return;
    }
    const next = [...this.keyframes];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    this.keyframes = next;
    this.markDirty();
    this.renumber();
  }

  clearKeyframes(): void {
    this.stop();
    this.keyframes = [];
    this.selectedId = null;
    this.currentPathData = null;
    this.playhead = 0;
    this.totalDuration = 0;
    this.markDirty();
    this.previewPath.emit(null);
  }

  updateKeyframe(id: number, patch: Partial<MorphKeyframe>): void {
    this.keyframes = this.keyframes.map((k) => (k.id === id ? { ...k, ...patch } : k));
    this.markDirty();
  }

  /** Replace a keyframe's stored geometry with the current editor path. */
  recapture(id: number): void {
    const source = this._currentPath.trim();
    if (!source) {
      return;
    }
    this.updateKeyframe(id, { path: source });
  }

  select(id: number): void {
    this.selectedId = id;
    const index = this.keyframes.findIndex((k) => k.id === id);
    if (index > 0) {
      this.seek(this.keyframeStart(index));
    } else if (index === 0) {
      this.seek(0);
    }
  }

  get selected(): MorphKeyframe | null {
    return this.keyframes.find((k) => k.id === this.selectedId) || null;
  }

  private renumber(): void {
    this.keyframes = this.keyframes.map((k, i) => ({ ...k, label: `K${i + 1}` }));
    this.cdr.markForCheck();
  }

  private keyframeStart(index: number): number {
    let acc = 0;
    for (let i = 1; i <= index; i++) {
      acc += this.keyframes[i].duration;
    }
    return acc;
  }

  /* ---------------- preparation ---------------- */

  private markDirty(): void {
    this.dirty = true;
    this.totalDuration = this.keyframes
      .slice(1)
      .reduce((acc, k) => acc + Math.max(0, k.duration), 0);
    if (!this.isPlaying) {
      this.renderAt(this.playhead);
    }
    this.cdr.markForCheck();
  }

  private ensurePrepared(): void {
    if (!this.dirty) {
      return;
    }
    const segs: PreparedSegment[] = [];
    for (let i = 1; i < this.keyframes.length; i++) {
      const from = this.keyframes[i - 1];
      const to = this.keyframes[i];
      segs.push({
        from: from.path,
        to: to.path,
        easing: to.easing,
        duration: Math.max(0, to.duration),
        pair: prepareMorph(from.path, to.path)
      });
    }
    this.segments = segs;
    this.dirty = false;
  }

  toggleCollapsed(): void {
    this.isCollapsed = !this.isCollapsed;
    this.cdr.markForCheck();
  }

  /* ---------------- playback ---------------- */

  play(): void {
    if (this.keyframes.length < 2 || this.totalDuration <= 0) {
      return;
    }
    if (this.isPlaying) {
      return;
    }
    this.ensurePrepared();
    this.isPlaying = true;
    this.playingChange.emit(true);
    this.lastFrameTime = 0;
    this.fpsWindowStart = 0;
    this.fpsFrames = 0;
    this.rafId = requestAnimationFrame(this.tick);
    this.cdr.markForCheck();
  }

  pause(): void {
    this.stop();
  }

  togglePlay(): void {
    if (this.isPlaying) {
      this.stop();
    } else {
      this.play();
    }
  }

  private stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.isPlaying) {
      this.isPlaying = false;
      this.playingChange.emit(false);
      this.cdr.markForCheck();
    }
  }

  private tick = (timestamp: number): void => {
    if (!this.isPlaying) {
      return;
    }

    if (!this.lastFrameTime) {
      this.lastFrameTime = timestamp;
      this.fpsWindowStart = timestamp;
    }

    const frameStart = performance.now();
    const delta = Math.min(timestamp - this.lastFrameTime, 100);
    this.lastFrameTime = timestamp;

    this.playhead += delta;
    if (this.playhead >= this.totalDuration) {
      if (this.isLooping) {
        this.playhead = this.playhead % this.totalDuration;
      } else {
        this.playhead = this.totalDuration;
        this.renderAt(this.playhead);
        this.stop();
        return;
      }
    }

    this.renderAt(this.playhead);

    this.lastFrameCostMs = performance.now() - frameStart;
    this.fpsFrames++;
    if (timestamp - this.fpsWindowStart >= 500) {
      this.measuredFps = Math.round(
        (this.fpsFrames * 1000) / (timestamp - this.fpsWindowStart)
      );
      this.fpsFrames = 0;
      this.fpsWindowStart = timestamp;
      this.cdr.markForCheck();
    }

    this.rafId = requestAnimationFrame(this.tick);
  };

  /** Jump to an absolute time in ms and render that frame. */
  seek(time: number): void {
    this.playhead = Math.max(0, Math.min(time, this.totalDuration));
    this.ensurePrepared();
    this.renderAt(this.playhead);
    this.cdr.markForCheck();
  }

  onScrub(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.seek(value);
  }

  /** Render the frame at `time` without touching playback state. */
  private renderAt(time: number): void {
    if (this.keyframes.length < 2) {
      this.currentPathData = this.keyframes.length ? this.keyframes[0].path : null;
      this.previewPath.emit(this.currentPathData);
      return;
    }

    this.ensurePrepared();

    let remaining = time;
    let index = 0;
    for (let i = 0; i < this.segments.length; i++) {
      if (remaining < this.segments[i].duration || i === this.segments.length - 1) {
        index = i;
        break;
      }
      remaining -= this.segments[i].duration;
    }

    const seg = this.segments[index];
    if (!seg) {
      return;
    }

    const local = seg.duration > 0 ? Math.min(1, remaining / seg.duration) : 1;
    const eased = applyEasing(seg.easing, local);
    this.currentPathData = morphPathData(seg.pair, eased);
    this.previewPath.emit(this.currentPathData);
  }

  /* ---------------- export helpers ---------------- */

  exportSvg(): void {
    if (!this.canPlay) {
      return;
    }
    const svg = exportSvgAnimation(this.toExportKeyframes(), {
      loop: this.isLooping,
      stroke: '#1a1a1a',
      fill: 'none'
    });
    downloadText('morph-animation.svg', svg, 'image/svg+xml');
    this.lastExportMessage = 'Exported morph-animation.svg';
  }

  exportHtml(): void {
    if (!this.canPlay) {
      return;
    }
    const html = exportHtmlPlayer(this.toExportKeyframes(), {
      loop: this.isLooping,
      stroke: '#1a1a1a',
      fill: 'none'
    });
    downloadText('morph-animation.html', html, 'text/html');
    this.lastExportMessage = 'Exported morph-animation.html';
  }

  lastExportMessage = '';

  /** Build the keyframe list used by the SVG / HTML exporters. */
  toExportKeyframes(): Keyframe[] {
    return this.keyframes.map((k) => ({
      path: k.path,
      easing: k.easing,
      duration: k.duration
    }));
  }

  get canPlay(): boolean {
    return this.keyframes.length >= 2 && this.totalDuration > 0;
  }

  /** Id of the last keyframe, used by the template to disable "move later". */
  get lastKeyframeId(): number {
    return this.keyframes.length ? this.keyframes[this.keyframes.length - 1].id : -1;
  }

  formatTime(ms: number): string {
    return `${(ms / 1000).toFixed(2)}s`;
  }

  trackById = (_: number, item: MorphKeyframe): number => item.id;
}
