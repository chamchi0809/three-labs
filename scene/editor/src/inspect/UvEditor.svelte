<script lang="ts">
  /**
   * The UV editor: where the material actually sits on the face.
   *
   * The numbers above it say the offset is 0.25 and the scale is 1; this says what that looks like — the
   * face's outline drawn over the material's own grid, in tiles, so that "half a tile off" is something a
   * designer can see is half a square rather than something they have to work out. The tile grid is the
   * point of it: a wall whose seams do not land on its corners is obvious here and invisible in a column
   * of numbers.
   *
   * It draws in tile space rather than in metres because that is the space every number in the panel is
   * in, and because a face that is 6 m across at 2 m per tile and one that is 3 m across at 1 m per tile
   * are the same picture, which is exactly the fact a designer is trying to check.
   */
  import type { Vec2 } from "tscene";
  import type { Brush } from "../brush/brush.ts";
  import { uvPolygon } from "../doc/inspect.ts";

  type Props = { brush: Brush; face: number };
  let { brush, face }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  const HEIGHT = 132;

  const polygon = $derived(uvPolygon(brush, face));

  $effect(() => {
    const view = canvas;
    const loop = polygon;
    if (!view) return;
    const dpr = window.devicePixelRatio || 1;
    const w = view.clientWidth;
    view.width = Math.round(w * dpr);
    view.height = Math.round(HEIGHT * dpr);
    const c = view.getContext("2d");
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(c, loop, w, HEIGHT);
  });

  const style = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function draw(c: CanvasRenderingContext2D, loop: Vec2[], w: number, h: number) {
    c.clearRect(0, 0, w, h);
    if (!loop.length) return;

    // the face and the tile it sits on are both worth seeing, so the frame is the outline grown to
    // include the origin tile — a material slid a long way off shows as a face a long way from its grid
    let lo: Vec2 = [0, 0];
    let hi: Vec2 = [1, 1];
    for (const p of loop) {
      lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])];
      hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])];
    }
    const pad = 10;
    const span = Math.max(hi[0] - lo[0], 1e-6);
    const rise = Math.max(hi[1] - lo[1], 1e-6);
    // one scale for both axes: a square tile has to look square, or the picture is lying about the thing
    // it exists to show
    const k = Math.min((w - pad * 2) / span, (h - pad * 2) / rise);
    const ox = (w - span * k) / 2 - lo[0] * k;
    // v grows upwards on the wall and downwards on a canvas
    const oy = (h - rise * k) / 2 + hi[1] * k;
    const at = (p: Vec2): [number, number] => [ox + p[0] * k, oy - p[1] * k];

    c.lineWidth = 1;
    c.strokeStyle = style("--line") || "#24272c";
    c.beginPath();
    for (let u = Math.floor(lo[0]); u <= Math.ceil(hi[0]); u++) {
      const [x] = at([u, 0]);
      c.moveTo(Math.round(x) + 0.5, 0);
      c.lineTo(Math.round(x) + 0.5, h);
    }
    for (let v = Math.floor(lo[1]); v <= Math.ceil(hi[1]); v++) {
      const [, y] = at([0, v]);
      c.moveTo(0, Math.round(y) + 0.5);
      c.lineTo(w, Math.round(y) + 0.5);
    }
    c.stroke();

    // the material's origin, which is the corner every offset is measured from
    c.strokeStyle = style("--edge") || "#3d4653";
    c.beginPath();
    const [zx, zy] = at([0, 0]);
    c.moveTo(Math.round(zx) + 0.5, 0);
    c.lineTo(Math.round(zx) + 0.5, h);
    c.moveTo(0, Math.round(zy) + 0.5);
    c.lineTo(w, Math.round(zy) + 0.5);
    c.stroke();

    c.beginPath();
    loop.forEach((p, i) => {
      const [x, y] = at(p);
      if (i) c.lineTo(x, y);
      else c.moveTo(x, y);
    });
    c.closePath();
    c.fillStyle = "#7aa2f722";
    c.fill();
    c.strokeStyle = style("--accent") || "#7aa2f7";
    c.lineWidth = 1.5;
    c.stroke();

    c.fillStyle = style("--accent") || "#7aa2f7";
    for (const p of loop) {
      const [x, y] = at(p);
      c.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
  }
</script>

<canvas bind:this={canvas} style:height={`${HEIGHT}px`}></canvas>

<style>
  canvas {
    display: block; width: 100%;
    background: var(--sunk); border: 1px solid var(--line); border-radius: 3px;
  }
</style>
