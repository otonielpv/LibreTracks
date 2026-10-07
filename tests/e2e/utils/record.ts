import { browser } from "@wdio/globals";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rectOf, runInPage, type Box } from "./annotate.js";

/**
 * Short screen clips for the user guide, rendered frame by frame.
 *
 * Nothing records the screen in real time: a drawn cursor is moved in steps,
 * each step is captured through CDP, and ffmpeg assembles the frames at a
 * fixed rate with per-frame durations. The result is smooth whatever the
 * capture speed is, does not need the window in the foreground, and comes out
 * identical on every re-shoot. The real click still goes through WebDriver,
 * so what the clip shows is what the app actually did.
 *
 * Suited to UI interactions (open a menu, drag a clip). Anything that moves on
 * its own clock (the playhead during playback) plays back at capture speed.
 */

const FPS = 30;
const CURSOR_ID = "lt-guide-cursor";

export type Cdp = <T = unknown>(cmd: string, params?: Record<string, unknown>) => Promise<T>;

type Point = { x: number; y: number };

/**
 * Video mode (the narrated tutorials): every frame comes out at exactly
 * `width`x`height`, and the clip rectangle becomes a CAMERA that zoomTo /
 * zoomOut animate over the page. Captures are taken at the page's device
 * pixel ratio, so a zoom up to `dpr`x stays sharp.
 */
export type VideoOptions = { width: number; height: number; dpr: number; viewport: { w: number; h: number } };

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export class Recorder {
  private frames: Array<{ file: string; seconds: number }> = [];
  /** App audio recorded during realtime() moments: where it goes in the clip. */
  private audioClips: Array<{ at: number; wav: string; trim: number }> = [];
  private dir: string;
  cursor: Point;
  private index = 0;

  constructor(
    private cdp: Cdp,
    private name: string,
    private clip: Box,
    private outDir: string,
    start: Point = { x: clip.x + clip.w * 0.8, y: clip.y + clip.h * 0.85 },
    private video?: VideoOptions,
  ) {
    // Absolute: ffmpeg's concat demuxer resolves list entries from the list's
    // own folder, so a relative outDir pointed at nothing.
    this.outDir = path.resolve(outDir);
    this.dir = path.join(this.outDir, `.frames-${name}`);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.cursor = start;
  }

  private async drawCursor(ripple = 0) {
    await runInPage(
      (id: string, x: number, y: number, r: number) => {
        let el = document.getElementById(id) as HTMLDivElement | null;
        if (!el) {
          el = document.createElement("div");
          el.id = id;
          el.style.cssText =
            "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none";
          el.innerHTML =
            '<div data-ripple style="position:absolute;border-radius:50%;' +
            'background:rgba(255,194,26,.35);border:2px solid #FFC21A"></div>' +
            '<svg width="28" height="32" viewBox="0 0 28 32" style="position:absolute;left:-3px;top:-2px;' +
            'filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))"><path d="M3 2 L3 26 L9.5 20 L14 30 L18 28 ' +
            'L13.5 18.5 L22 18.5 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
          document.body.appendChild(el);
        }
        el.style.transform = `translate(${x}px, ${y}px)`;
        const rp = el.querySelector("[data-ripple]") as HTMLDivElement;
        rp.style.display = r > 0 ? "block" : "none";
        rp.style.width = rp.style.height = `${2 * r}px`;
        rp.style.left = rp.style.top = `${-r}px`;
        rp.style.opacity = String(r > 0 ? Math.max(0.15, 1 - r / 34) : 0);
      },
      CURSOR_ID,
      this.cursor.x,
      this.cursor.y,
      ripple,
    );
  }

  /** Captures the current screen and holds it for `seconds`. */
  async frame(seconds = 1 / FPS, fast = false) {
    const scale = this.video ? this.video.width / (this.clip.w * this.video.dpr) : 1;
    const { data } = await this.cdp<{ data: string }>("Page.captureScreenshot", {
      // JPEG during realtime capture: PNG encoding at 1080p halves the frame rate.
      format: fast ? "jpeg" : "png",
      ...(fast ? { quality: 90 } : {}),
      clip: { x: this.clip.x, y: this.clip.y, width: this.clip.w, height: this.clip.h, scale },
      captureBeyondViewport: false,
    });
    const file = path.join(this.dir, `${String(this.index++).padStart(5, "0")}.${fast ? "jpg" : "png"}`);
    writeFileSync(file, Buffer.from(data, "base64"));
    this.frames.push({ file, seconds });
  }

  async hold(seconds: number) {
    await this.drawCursor();
    await this.frame(seconds);
  }

  /** Glides the cursor to the centre of `selector` (or a point). */
  async moveTo(target: string | Point, ms = 700) {
    let to: Point;
    if (typeof target === "string") {
      const r = await rectOf(target);
      if (!r) throw new Error(`record: ${target} not visible`);
      to = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    } else {
      to = target;
    }
    const from = this.cursor;
    const steps = Math.max(1, Math.round((ms / 1000) * FPS));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out
      this.cursor = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
      await this.drawCursor();
      await this.frame();
    }
  }

  /** Ripple at the cursor, then the real click through WebDriver. */
  async click(selector: string, settleMs = 450) {
    await this.moveTo(selector);
    for (const r of [8, 16, 24]) {
      await this.drawCursor(r);
      await this.frame();
    }
    await runInPage((id: string) => document.getElementById(id)?.remove(), CURSOR_ID);
    const { $ } = await import("@wdio/globals");
    await (await $(selector)).click();
    await browser.pause(settleMs);
    for (const r of [30, 34]) {
      await this.drawCursor(r);
      await this.frame();
    }
    await this.drawCursor();
    await this.frame();
  }

  private async resolve(target: string | Point): Promise<Point> {
    if (typeof target !== "string") return target;
    const r = await rectOf(target);
    if (!r) throw new Error(`record: ${target} not visible`);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  private async ripple() {
    for (const r of [8, 16, 24]) {
      await this.drawCursor(r);
      await this.frame();
    }
  }

  /** Real left click at a point (canvas targets have no element to click). */
  async clickAt(target: Point, settleMs = 450) {
    await this.moveTo(target);
    await this.ripple();
    await browser
      .action("pointer", { id: "guide-mouse", parameters: { pointerType: "mouse" } })
      .move({ x: Math.round(target.x), y: Math.round(target.y) })
      .down({ button: 0 })
      .up({ button: 0 })
      .perform();
    await browser.pause(settleMs);
    await this.drawCursor();
    await this.frame();
  }

  /** Real right click at the target (opens the app's context menu). */
  async rightClick(target: string | Point, settleMs = 450) {
    await this.moveTo(target);
    await this.ripple();
    await browser
      .action("pointer", { id: "guide-mouse", parameters: { pointerType: "mouse" } })
      .move({ x: Math.round(this.cursor.x), y: Math.round(this.cursor.y) })
      .down({ button: 2 })
      .up({ button: 2 })
      .perform();
    await browser.pause(settleMs);
    await this.drawCursor();
    await this.frame();
  }

  /**
   * Press at the cursor, glide to `target` with the button held, release.
   * Every step is a real pointer move, so the app's own drag preview (ghost,
   * drop hints) is what the frames show.
   */
  async dragTo(target: string | Point, ms = 1100, opts: { from?: string | Point } = {}) {
    if (opts.from) await this.moveTo(opts.from);
    const from = this.cursor;
    const to = await this.resolve(target);
    await browser
      .action("pointer", { id: "guide-mouse", parameters: { pointerType: "mouse" } })
      .move({ x: Math.round(from.x), y: Math.round(from.y) })
      .down({ button: 0 })
      .perform(true);
    await this.ripple();
    const steps = Math.max(2, Math.round((ms / 1000) * FPS));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.cursor = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
      await browser
        .action("pointer", { id: "guide-mouse", parameters: { pointerType: "mouse" } })
        .move({ x: Math.round(this.cursor.x), y: Math.round(this.cursor.y) })
        .perform(true);
      await this.drawCursor();
      await this.frame();
    }
    await this.hold(0.3);
    await browser
      .action("pointer", { id: "guide-mouse", parameters: { pointerType: "mouse" } })
      .up({ button: 0 })
      .perform();
    await browser.pause(700);
    await this.drawCursor();
    await this.frame();
  }

  /**
   * Same gesture as dragTo, but injected through CDP Input.dispatchMouseEvent:
   * closer to a real mouse than WebDriver actions. Needed for the song-edge
   * handles, whose pointer-capture drag ignores WebDriver's synthetic moves.
   */
  async dragToCdp(target: string | Point, ms = 1100, opts: { from?: string | Point; modifiers?: number } = {}) {
    if (opts.from) await this.moveTo(opts.from);
    const from = this.cursor;
    const to = await this.resolve(target);
    const mods = opts.modifiers ?? 0;
    const mouse = (type: string, p: Point, buttons: number) =>
      this.cdp("Input.dispatchMouseEvent", {
        type,
        x: p.x,
        y: p.y,
        button: "left",
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
        modifiers: mods,
        pointerType: "mouse",
      });
    await mouse("mouseMoved", from, 0);
    await mouse("mousePressed", from, 1);
    await this.ripple();
    const steps = Math.max(2, Math.round((ms / 1000) * FPS));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.cursor = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
      await mouse("mouseMoved", this.cursor, 1);
      await this.drawCursor();
      await this.frame();
    }
    await this.hold(0.3);
    await mouse("mouseReleased", this.cursor, 0);
    await browser.pause(700);
    await this.drawCursor();
    await this.frame();
  }

  /** Types text a character at a time, one frame per key. */
  async type(text: string) {
    for (const ch of text) {
      await browser.keys([ch]);
      await this.drawCursor();
      await this.frame(0.06);
    }
  }

  async key(name: string, settleMs = 500) {
    await browser.keys([name]);
    await browser.pause(settleMs);
    await this.drawCursor();
    await this.frame();
  }

  /** Total length of what has been recorded so far, in seconds. */
  get seconds() {
    return this.frames.reduce((total, f) => total + f.seconds, 0);
  }

  /** Holds the last picture until the clip is `total` seconds long. */
  async holdUntil(total: number) {
    const missing = total - this.seconds;
    if (missing > 0.02) await this.hold(missing);
  }

  /** 16:9 camera box around `target`, at most `maxZoom`x, inside the page. */
  private cameraFor(target: Box, margin: number, maxZoom: number): Box {
    if (!this.video) throw new Error("record: zoom needs video mode");
    const { viewport: vp, width, height } = this.video;
    const aspect = width / height;
    let w = Math.max(target.w + 2 * margin, (target.h + 2 * margin) * aspect, vp.w / maxZoom);
    w = Math.min(w, vp.w);
    const h = w / aspect;
    const cx = target.x + target.w / 2;
    const cy = target.y + target.h / 2;
    const x = Math.min(Math.max(cx - w / 2, 0), vp.w - w);
    const y = Math.min(Math.max(cy - h / 2, 0), vp.h - h);
    return { x, y, w, h };
  }

  private async animateCamera(to: Box, ms: number) {
    const from = { ...this.clip };
    const steps = Math.max(1, Math.round((ms / 1000) * FPS));
    for (let i = 1; i <= steps; i++) {
      const e = ease(i / steps);
      this.clip = {
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        w: from.w + (to.w - from.w) * e,
        h: from.h + (to.h - from.h) * e,
      };
      await this.drawCursor();
      await this.frame();
    }
  }

  /** Smoothly zooms the camera onto an element (or box). */
  async zoomTo(target: string | Box, opts: { ms?: number; margin?: number; maxZoom?: number } = {}) {
    const box = typeof target === "string" ? await rectOf(target) : target;
    if (!box) throw new Error(`record: ${String(target)} not visible`);
    await this.animateCamera(this.cameraFor(box, opts.margin ?? 80, opts.maxZoom ?? 2), opts.ms ?? 900);
  }

  /** Back to the whole page. */
  async zoomOut(ms = 800) {
    if (!this.video) throw new Error("record: zoom needs video mode");
    await this.animateCamera({ x: 0, y: 0, w: this.video.viewport.w, h: this.video.viewport.h }, ms);
  }

  /**
   * Records something that moves on its own clock (playback, a playhead) for
   * `ms` of real time. Frames come as fast as captures allow and each one
   * lasts as long as it really took, so it plays back at true speed.
   */
  async realtime(ms: number) {
    const end = Date.now() + ms;
    let last = Date.now();
    while (Date.now() < end) {
      await this.drawCursor();
      await this.frame(0, true);
      const now = Date.now();
      this.frames[this.frames.length - 1].seconds = (now - last) / 1000;
      last = now;
    }
  }

  /**
   * realtime() while recording what the app plays (loopback of the default
   * speaker, scripts/tutorial-video/loopback.py). The WAV and where it starts
   * in this clip are written next to the clip as <name>.audio.json.
   */
  async realtimeWithAudio(ms: number, loopbackScript: string) {
    const wav = path.join(this.dir, `audio-${this.audioClips.length}.wav`);
    const proc = spawn("python", [loopbackScript, wav, String(ms / 1000 + 1.5)], { stdio: ["ignore", "pipe", "inherit"] });
    const start = await new Promise<number>((resolve, reject) => {
      let buf = "";
      proc.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        const m = buf.match(/START ([0-9.]+)/);
        if (m) resolve(Number(m[1]));
      });
      proc.on("exit", () => reject(new Error("loopback recorder exited before starting")));
    });
    const at = this.seconds;
    const t0 = Date.now() / 1000;
    await this.realtime(ms);
    await new Promise((resolve) => proc.on("exit", resolve));
    this.audioClips.push({ at, wav, trim: Math.max(0, t0 - start) });
  }

  /** Writes <name>.mp4 and <name>.webp (poster = last frame) next to the shots. */
  async encode() {
    await runInPage((id: string) => document.getElementById(id)?.remove(), CURSOR_ID);
    // The concat demuxer decodes every entry with the FIRST file's codec: the
    // JPEG frames of realtime() between PNGs were dropped ("Invalid PNG
    // signature") and playback came out as a still picture. One format.
    for (const f of this.frames) {
      if (!f.file.endsWith(".jpg")) continue;
      const png = f.file.replace(/\.jpg$/, ".png");
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", f.file, png]);
      f.file = png;
    }
    const list = this.frames
      .map((f) => `file '${f.file.replace(/\\/g, "/")}'\nduration ${f.seconds.toFixed(4)}`)
      .join("\n");
    const last = this.frames[this.frames.length - 1];
    const listFile = path.join(this.dir, "list.txt");
    // The concat demuxer ignores the duration of the final entry unless the
    // file is repeated once more.
    writeFileSync(listFile, `${list}\nfile '${last.file.replace(/\\/g, "/")}'\n`);
    const mp4 = path.join(this.outDir, `${this.name}.mp4`);
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listFile,
        "-vf",
        this.video
          ? `fps=${FPS},scale=${this.video.width}:${this.video.height}:flags=lanczos,setsar=1`
          : // Wide clips are capped at 1800px: the docs column shows them at ~900.
            `fps=${FPS},scale='min(1800,iw)':-2`,
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        this.video ? "18" : "24",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        mp4,
      ],
      { stdio: "inherit" },
    );
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", last.file, "-quality", "82", path.join(this.outDir, `${this.name}.webp`)], {
      stdio: "inherit",
    });
    if (this.audioClips.length > 0) {
      const kept = this.audioClips.map((c, i) => {
        const dest = path.join(this.outDir, `${this.name}.audio-${i}.wav`);
        execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", c.trim.toFixed(3), "-i", c.wav, dest]);
        return { at: c.at, wav: path.basename(dest) };
      });
      writeFileSync(path.join(this.outDir, `${this.name}.audio.json`), JSON.stringify(kept, null, 2));
    }
    rmSync(this.dir, { recursive: true, force: true });
    console.log(`[guideshots] wrote ${this.name}.mp4 (${this.frames.length} frames)`);
  }
}
