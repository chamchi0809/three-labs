/**
 * The demo map's generated textures, packed into the sheet that goes off to be baked.
 *
 * `render/sample.ts` answers `broom:brick/map` out of arithmetic so that the editor has something to
 * show before a project has any textures of its own. Nothing outside the editor knows that scheme: the
 * baker running in node would try to open a file called `broom:brick/map`, and the preview — which goes
 * through tscene's own loader rather than the editor's palette — would do the same in the browser.
 *
 * So a sheet on its way out has its `broom:` urls replaced by `data:` urls holding the same pixels. Six
 * PNGs, generated once and cached, and the sheet stops depending on anything the editor knows.
 *
 * This is only ever the demo map's problem. A real project's textures are files, and files are what both
 * halves already understand.
 */
import { SCHEME, sampleTexture } from "../render/sample.ts";

/** `broom:` followed by a pattern and a slot. One word and two names — never a path, never a query */
const URL_PATTERN = /broom:[a-z0-9]+\/[a-z0-9]+/g;

const packed = new Map<string, string>();

/**
 * The sheet with every generated texture inlined.
 *
 * Text in, text out, because that is what both the bake and the preview take — rewriting the parsed
 * document instead would mean two encodings of the same map, and the one that goes to the baker has to
 * be the one the designer is looking at.
 */
export async function inlineSamples(text: string): Promise<string> {
  const urls = [...new Set(text.match(URL_PATTERN) ?? [])];
  if (!urls.length) return text;
  const inlined = new Map<string, string>();
  for (const url of urls) {
    const data = await dataUrl(url);
    if (data) inlined.set(url, data);
  }
  return text.replace(URL_PATTERN, (url) => inlined.get(url) ?? url);
}

/** every sheet of a project on its way out, keyed as it was */
export async function inlineAll(files: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(files)) out[name] = await inlineSamples(text);
  return out;
}

/**
 * One generated texture as a PNG data url.
 *
 * The rows go out in reverse. A `DataTexture` is `flipY = false` — its first row is at v = 0 — and a
 * texture decoded from a PNG is `flipY = true`, so writing the rows in the order they are held would
 * sample the pattern upside down. Which is invisible on brickwork and is not invisible at all on the
 * normal map derived from it, where it would tilt every surface the wrong way.
 */
async function dataUrl(url: string): Promise<string | undefined> {
  const found = packed.get(url);
  if (found) return found;

  const texture = sampleTexture(url);
  const image = texture?.image as { data: Uint8Array; width: number; height: number } | undefined;
  if (!image) return undefined;

  const { width, height, data } = image;
  const flipped = new Uint8ClampedArray(data.length);
  const stride = width * 4;
  for (let row = 0; row < height; row++) {
    flipped.set(data.subarray(row * stride, (row + 1) * stride), (height - 1 - row) * stride);
  }

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.putImageData(new ImageData(flipped, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const encoded = `data:image/png;base64,${base64(await blob.arrayBuffer())}`;
  packed.set(url, encoded);
  return encoded;
}

/** a quarter of a megabyte at a time would blow the argument limit, so it goes in chunks */
function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

/** whether a sheet mentions the editor's own textures at all — what the checks assert against */
export const usesSamples = (text: string): boolean => text.includes(SCHEME);
