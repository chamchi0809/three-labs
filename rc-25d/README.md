# three-rc-25d

Turnkey screen-space Holographic Radiance Cascades lighting for three.js
WebGPU, in the style of Path of Exile 2.

`ScreenSpaceRC` owns the complete deferred pipeline: a guard-band G-buffer
that follows the camera, one flatland HRC solve in the image plane, temporal
history, and the final composite. Applications provide a renderer, ordinary
node materials, and one render call per frame.

`SplitRC` is the same package's world-space solver: full 3D diffuse GI by
Split Radiance Cascades, traced against a voxelisation of the scene. Same
one-call-per-frame shape, different trade-offs — see
[Full 3D GI](#full-3d-gi-split-radiance-cascades).

## Quick start

```ts
import { ScreenSpaceRC } from '@rc25d/radiance-cascades';
import {
  BoxGeometry,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';

const renderer = new WebGPURenderer();
await renderer.init();

const scene = new Scene();
const camera = new PerspectiveCamera();
const lighting = new ScreenSpaceRC(renderer, {
  padding: 0.25,
  groundHeight: 0,
});

const lampMaterial = new MeshStandardNodeMaterial({
  color: 0x000000,
  emissive: 0xff6030,
  emissiveIntensity: 12,
});
scene.add(new Mesh(new BoxGeometry(1, 1, 1), lampMaterial));

renderer.setAnimationLoop(() => {
  renderer.setRenderTarget(null);
  lighting.render(scene, camera);
});
```

`render(scene, camera)` renders the view and field G-buffers, runs the RC
field, composites the result, and resizes the internal viewport buffers
automatically. Pass `false` as the third argument to reuse the previous light
field while still rendering the camera view and final composite. This lets an
application run lighting at a fixed rate independently of its display rate;
the composite reprojects each pixel's world position against the camera pose
of the most recent field update, so intermediate camera motion stays correct:

```ts
lighting.render(scene, camera, updateLightingThisFrame);
```

## Screen-space behavior

Every field update mirrors the view camera and symmetrically widens its
frustum by `padding` (0.25 widens it to 1.5x), then renders emissive radiance
plus an occluder mask through it. Emitters and occluders somewhat outside the
visible frame therefore keep lighting and shadowing the view; how far
off-screen that guarantee reaches is directly controlled by `padding`.

In `footprint` domain the widened frustum becomes a **parallel** projection
covering the same ground, keeping the camera's orientation so the box still hugs
the visible region. Only under a parallel projection is the field's
world-to-texel map affine, and only then can the field be locked to the world: a
perspective camera images the tilted ground through a homography, so translating
it moves near ground faster than far ground, no single offset holds every
texel's phase, and the whole solve re-quantizes every frame — every shadow edge
and light pool crawls. The extents are quantized to fixed geometric steps for
the same reason, since their scale is the one part of the map an offset cannot
absorb. Coverage stops at twice the distance to the ground point the camera
looks at, because a box reaching the horizon would be coarse everywhere.
Texel world size is then uniform over the whole field, which also makes the
local floor estimate below resolve at its true radius everywhere instead of only
at one depth.

The solve itself is flatland: light propagates and is occluded in a 2D field.
Whatever stands locally above the floor occludes, its emissive value is the
radiance it contributes, and open floor is the space light travels through.
There is no separate light or occluder registry and no bounced light.

The field is treated as a participating medium rather than as emitters and
blockers: a texel absorbs in proportion to its mask value and emits the light
it absorbs, so a partially covered silhouette edge is genuinely
semi-transparent instead of snapping between lit and blocked. That is what
lets shadow edges track a silhouette continuously as it moves across the grid.

In `footprint` domain the occluder mask comes from each texel's height above
the **local** floor rather than a global ground plane. The floor is estimated
per texel as a wide, coverage-weighted low pass of the G-buffer's height
field, over a neighborhood of `floorRadius` world units. A box filter
reproduces any linear height field exactly, so a constant slope reads as floor
however high it climbs and a raised floor level reads as floor in its
interior, while genuinely local elevation — walls, steps, crates — stands out
and occludes. `stepHeight` sets the rise at which a surface becomes a full
occluder. Ramps and stacked floor levels therefore need no special handling,
and `groundHeight` is only the fallback where the field sees nothing at all
plus the pivot of the footprint flattening.

`floorRadius` is therefore the scale of the design: it should exceed the
footprint of the smallest thing that must occlude, and stay below half the
extent of the smallest raised floor level. A mass wider than twice that radius
reads its own core as a floor level, but only its core — the rim within one
radius of every edge still sees the drop and stays solid, a closed ring far
thicker than a ray's march step, so no light crosses the mass either way. Its
top comes out an enclosed open floor that whatever stands on it lights
directly.

Emissive surfaces always absorb whatever their height, since a texel only
emits what it also absorbs — a light lying on the floor still lights the
scene.

Because the field holds one surface per texel, in `imagePlane` domain the
composite validates that the texel it samples actually belongs to the pixel's
surface before accepting its light — a reprojection depth test against the field
camera, which is also the disocclusion test on frames that reuse an older field.
Footprint domain needs no equivalent: flattened, the field sees every surface a
top-down map can hold.

What footprint domain does need is grounding. Flatland occlusion is a property of
the top-down silhouette, so light reaching a floor texel from beyond a mass is
blocked, but light reaching it from every open direction is not — a crate's own
footprint stays as bright as the floor it sits on and reads as a decal. A contact
shadow supplies that missing near-field occlusion: `contactStrength` sets how far
standing geometry darkens the up-facing surfaces around its base, softening over
`contactRadius`, ramping to full over `stepHeight` of rise.

It comes from a field-resolution chain of its own: a per-texel occlusion weight
in [0, 1] — how far the texel rises above its local floor, times its silhouette
coverage — then a separable Gaussian over `contactRadius`, the same
two-pass filter three.js's own contact shadow example uses. `contactRadius` is
that Gaussian's standard deviation, not where it is truncated. The distinction
decides whether the shadow is visible at all: the kernel cuts off at 2.5 sigma,
so treating the radius as the cutoff makes the actual softening 0.4× what was
asked for, and since a Gaussian over a silhouette is only 0.5 at the silhouette's
own edge, a tight one at moderate strength is a few percent of darkening across a
handful of pixels. Nothing to see. Gaussian and not box:
a box average of a silhouette is a linear ramp whose ends are creases the eye
reads as edges, and each tap crossing the silhouette steps the result by a full
`1/taps`, which at the tap spacing a world-sized reach needs becomes wide flat
bands — a visible grid of them, once two separable passes cross. Tapering weights
have neither problem.

The composite then squares what it reads, and that squaring is what makes the blur
a contact shadow rather than a wash. A Gaussian over a silhouette is an erf: half
strength at the silhouette's own edge, with a long flat shoulder outside it. Read
straight, any reach wide enough to soften the shadow under a prop also lays a broad
half-strength band along the foot of every wall, and the only radius without one is
a radius too small to soften anything — a hard silhouette decal, which is what this
replaced. Squaring leaves the interior alone and collapses the shoulder, so the
darkness stays under the mass with a short tail outside it.

Everything the blur carries is bounded and pre-weighted, and the composite only
scales what it reads. What decides whether a surface *receives* the shadow is its
own rise above its own local floor: a floor takes it in full, a surface a
`stepHeight` up takes none, because it is a raised mass rather than something's
ground. That has to be a separate bounded factor — a top-down neighborhood gives
a crate's top and the floor at its base the same reading, and reconstructing the
difference downstream by subtracting heights or dividing blurred channels puts an
unbounded function on interpolated data. Near a wall, where the wide floor
estimate sits above the floor itself, such a subtraction goes negative and *adds*
occlusion; blotches, with an edge wherever it saturates.

Being an occlusion factor rather than a light rejection, it multiplies ambient
along with the solved light and cannot black a surface out. Applied to the light
alone it would leave a flat plateau of pure ambient under every raised mass,
which is a decal of a different kind.

Every silhouette grounds equally, whether or not the geometry casting it rests on
what it darkens. A vertical falloff used to weight each occluder by how far its
underside cleared the surface below, so a hovering prop grounded less than a
resting one, and it was dropped. The distinction is not in the field G-buffer — a
top-down map holds the *nearest* surface per texel, which is a mass's top, so a
floating dodecahedron and a column standing on the floor are the same silhouette —
which meant a back-face-only render of the entire scene per field update to find
the undersides, a second blurred channel to carry them, and a knob whose useful
value depended on how far a given scene's props happened to float. Three moving
parts, one of which had to be retuned per scene, to make hovering things dimmer.

The solve also produces the flatland irradiance vector (net direction light
arrives from) alongside the fluence, and in footprint mode the composite
weights each pixel's received light by how its surface normal faces that
direction — flatland N·L. Wall faces turned toward a lamp light up, back
faces fall dark, and floors (no footprint facing) keep full omnidirectional
reception. The weighting scales with the footprint amount, so image-plane
scenes are unaffected.

## Holographic Radiance Cascades

The solver is HRC ([arXiv 2505.02041](https://arxiv.org/abs/2505.02041)),
after
[Yaazarai's](https://github.com/Yaazarai/Volumetric-HRC) reference
implementation, rather than vanilla RC. Instead of a probe lattice with a ring
of directions per probe, HRC runs four 90-degree frustums, one per axis. Within
a frustum, probes are *planes* perpendicular to its axis: cascade n has planes
every 2^n texels and 2^n + 1 rays per plane, so probe count halves and ray
count doubles exactly as in vanilla RC — but no ray is ever marched. Cascade
n's rays are *extensions*, each built in constant time from two cascade n-1
rays chained across two planes, which also means every ray carries log2(size)
samples of angular diffusion. That is the practical difference: total work is
independent of interval length, and a moving light does not alias the way a
marched interval does.

Merging is likewise not vanilla RC's. Cascade n's rays bound 2^n cones per
plane, and each cone is its two bounding rays — weighted by their share of the
cone's angular span — merged with the cascade n+1 cones that begin at their
endpoints. Odd planes land exactly on a cascade n+1 plane; even planes do not,
so their rays are extended to double length, merged against the far plane, and
interpolated against the near plane's already-merged fluence. Interpolating
*fluence* rather than position is what keeps the volumetrics correct. Cascade
0's merge is per-texel fluence, and the four frustums are summed into the
final light.

Plane counts halve per cascade and the four frustums are the same field read
rotated, so the field itself has to be square and power-of-two.

Which 2D domain that field lives in is declared by the application through
`domain`, not inferred from the camera, so the lighting does not morph as the
camera pitches or orbits:

- `imagePlane` uses raw on-screen silhouettes. Correct for side-on cameras,
  where world height *is* the image's vertical axis.
- `footprint` (the default) collapses geometry onto its ground footprint
  before the field renders and is sampled, which puts an elevated emitter's
  light on the floor beneath it instead of a parallax-shifted spot and makes
  walls occlude and receive by footprint. Correct for top-down and isometric
  cameras.

## Full 3D GI: Split Radiance Cascades

`SplitRC` is a second, independent solver in the same package: world-space
Split Radiance Cascades ([arXiv 2607.20384](https://arxiv.org/abs/2607.20384)),
real 3D diffuse global illumination rather than a flatland approximation. It
replaces `ScreenSpaceRC` rather than extending it — same one call per frame,
no shared state:

```ts
import { SplitRC } from '@rc25d/radiance-cascades';

const lighting = new SplitRC(renderer, { skyIntensity: 1 });

renderer.setAnimationLoop(() => {
  renderer.setRenderTarget(null);
  lighting.render(scene, camera);
});
```

`render(scene, camera)` voxelises the scene the first time it sees it, renders
a G-buffer, runs the cascade solve, and composites. Call `build(scene)` again
after editing geometry in place; `dispose()` releases everything.

Rays are traced against a voxel grid of the scene's albedo and emission
(`VoxelScene`), so geometry off-screen and behind the camera still occludes and
still bounces. That is the whole difference from the screen-space solver: no
guard band, no reprojection test, no domain choice.

### How the cascade is laid out

Four cascades, `K = 4` and `l = 4`: cascade *n* has `Θₙ = 4·2ⁿ` angular
resolution (`2Θₙ² = 32, 128, 512, 2048` directions), probe spacing `Δsₙ = Δs₀·2ⁿ`,
and covers the interval from `t₀·[0,1,5,21]` to `t₀·[1,5,21,85]` with
`t₀ ≈ 1.6·Δs₀`. Probes are sparse: only the ones some surface actually needs
exist, held in a GPU hashmap keyed by quantised grid coordinate and LOD, and
allocated by seeding — screen pixels seed cascade 0, each cascade *n* probe
seeds its nearest cascade *n+1* probe. Interpolation renormalises over the
trilinear neighbours that happen to exist, which is what makes never
initialising the full lattice safe.

The "split" is in how rays feed cascades. A ray is cast once from an on-screen
surface, and where it lands decides what every cascade above learns from it:
cascades below the hit interval receive `J = 0, β = 1` (nothing blocked yet),
the cascade owning the hit receives `J = Lᵢ, β = 0`, cascades above receive
nothing. Merging is `merge(J, β, I) = J + β·I` — premultiplied-alpha
compositing, and associative, which is why one ray can be split across the
chain and still reconstruct the same radiance as a per-cascade trace.

Rays are handed out by an R2 (plastic-number) sequence, jittered per frame,
with probes sharing a parent getting contiguous segments via a hierarchical
prefix sum, so a probe's directions stay stratified frame to frame instead of
clumping. Accumulation is temporal and in pure world space (`temporalBlend`),
so ray count per frame can sit far below direction count; a direction that got
no ray this frame keeps its history untouched rather than decaying.

LODs are separate from cascades: each doubles `Δs₀` and `t₀`, chosen from the
binary log of the **Chebyshev** distance to the camera so the boundary is a
grid-aligned cube. Consecutive LODs overlap by 0.9 and blend linearly across
the overlap, which is what hides the seam. Second bounce comes from the
previous frame's cascade-0 irradiance field, sampled at each ray's hit point.

### Options

```ts
const lighting = new SplitRC(renderer, {
  probeSpacing: undefined,  // Δs₀ in world units; defaults to 4 voxels
  probeCapacity: 8192,      // cascade 0 probes; higher cascades hold a quarter each
  rayDensity: 0.0625,       // rays per frame as a fraction of a 1080p frame's pixels
  skyColor: undefined,      // radiance for rays that leave the scene
  skyIntensity: 1,
  temporalBlend: 0.85,      // §5.2 history kept when new rays arrive
  lodCount: 4,
  lodDistance: undefined,   // Chebyshev distance where LOD 1 begins; defaults to 16 Δs₀
  voxel: { resolution: 128, maxPoints: 1 << 22, padding: 0.02 },
});
```

`temporalBlend` and `skyIntensity` stay settable at runtime.

`await lighting.stats()` reports probes allocated per cascade against capacity
plus rays issued. A cascade sitting at capacity is dropping probes, which shows
up as unlit patches — raise `probeCapacity` or `probeSpacing`.

`lighting.debugView` swaps what the composite pass writes, one of
`SPLIT_DEBUG_VIEWS`: `composite`, `light` (irradiance with no albedo),
`emissive`, `albedo`, `normal`, `lod` (LOD assignment, blended across the
overlap band exactly as the solve blends it) and `voxel` (the grid at the
visible surface — what the rays actually hit). They are branches on a uniform
inside the one composite shader, so switching costs nothing but a comparison.

### Limitations

- The voxel grid is refilled every frame from the current object transforms, so
  moving objects light and occlude from where they are; `build()` is only needed
  when a mesh's own vertices change. Meshes added or removed after the build are
  picked up automatically into a reserved 1/16 of the point budget, and toggling
  `visible` — on the mesh or on any parent — stops it lighting and occluding from
  the next frame. What is fixed
  at build time is the grid's extent — geometry that moves outside the built
  bounds is clipped — and the sampling density, which is chosen once to fit the
  whole scene. Thin geometry below one voxel does not occlude.
- Where two emitters share a voxel, the brighter one does not win; the last write
  does. At 128³ over a level that is two lights inside one voxel.
- Probe budgets are fixed at construction and probes are dropped, not evicted,
  once a cascade fills. `stats()` is the only signal.
- Multibounce reuses the primary cascade-0 irradiance field rather than the
  paper's separate coarser secondary cache, so a ray hitting geometry with no
  cascade-0 probe of its own contributes its first bounce only.
- Probe grid coordinates are 9 bits signed per axis, so a scene needs to fit
  ±256 probe cells per axis at LOD 0.
- The solve holds the whole cascade chain in storage buffers and is bounded by
  WebGPU's eight-storage-buffers-per-stage limit, which several kernels sit
  exactly at.

## Materials

Use a standard `MeshStandardNodeMaterial`:

```ts
const material = new MeshStandardNodeMaterial({ color: 0x808080 });
material.colorNode = myProceduralColor;
```

The standard three.js `emissive`, `emissiveIntensity`, `emissiveMap`,
`colorNode`, maps, and vertex colors feed the internal G-buffers
automatically.

## Options

```ts
const lighting = new ScreenSpaceRC(renderer, {
  padding: 0.25,          // extra view fraction beyond every frustum edge
  domain: 'footprint',    // or 'imagePlane' for side-on cameras
  resolution: undefined,  // field extent in pixels, a power of two;
                          // defaults to the power of two at or below half the
                          // drawing buffer's longer side, within [256, 512]
  groundHeight: 0,        // fallback floor / flattening pivot only
  floorRadius: 1.5,       // world radius of the local floor estimate
  stepHeight: 0.7,        // rise above the local floor that fully occludes, and
                          // the contact shadow's scale in both directions
  contactStrength: 0.6,   // how far standing geometry darkens the floor at its
                          // base, in [0, 1]; 0 disables the term
  contactRadius: 0.05,    // world sigma that darkening softens over; this small
                          // is a tight contact line, near the per-texel floor
  sky: 0x000000,
  temporalBlend: 0,
  ambient: 0x101218,
  ambientIntensity: 1,
  normalOffsetTexels: 2.5,
  antialias: true,     // resolve the composite through FXAA
});
```

`antialias` is on because a deferred pipeline cannot multisample its composite —
one G-buffer texel holds one surface — and this lighting model puts hard,
high-contrast transitions right on geometric creases: a floor inside a silhouette
reads inpainted light and contact shadow while the side face beside it is fully
lit. Unresolved, every crease and silhouette in the frame serrates. The
composite goes to a linear HDR target and the resolve pass carries it out, so
tone mapping and output encoding still happen exactly once. It costs one
fullscreen pass and one viewport-sized target.

Runtime controls are available through `domain`, `temporalBlend`,
`ambientIntensity`, `ambientColor`, `contactStrength`, and `contactRadius`.
Applications that swap
between
projections should set `domain` when they swap and reset their temporal
history alongside. Call `dispose()` when the pipeline is no longer needed.

## Advanced access

The high-level renderer exposes `lightTexture`, `directTexture`,
`distanceTexture` (a near-field silhouette distance: exact out to 63 texels,
"far away" past that, which is as far as anything reads it),
`floorTexture` (the estimated local floor height),
`maskTexture` (the radiance and occluder mask the solve runs on),
and `contactTexture` (the blurred contact occluder presence in red, before the
composite squares it and the receiving surface and `contactStrength` scale it) in
guard-band field space, plus `fieldWidth`/`fieldHeight`.

`FieldSpaceRC` is the low-level texture-space HRC engine for applications that
want to own their G-buffer and composite. Give it a square power-of-two `size`
and one `emission` texture — rgb is each texel's emissivity, alpha its
absorption density in [0, 1] — then run it with `update()`. `absorption` sets
how opaque a fully dense texel is (transmittance is `exp2(-a * absorption)`,
default 8). `ScreenSpaceRC` runs one of these engines over its guard-band
image plane.

## Limitations

- Propagation and occlusion are 2D. With a side-on camera a tall wall shadows
  everything behind its full on-screen silhouette; with a top-down camera
  footprint flattening relies on geometry having top-facing surfaces (boxes,
  cylinders, capsules) — an uncapped vertical quad collapses to a degenerate
  line and stops occluding.
- One field means one surface per texel, and it is the surface nearest the field
  camera — the highest one, once flattened. An emitter hidden from the field (a
  lamp tucked under an overhang) contributes nothing, and in `imagePlane` domain
  a pixel the field could not see falls back to ambient rather than borrowing a
  stranger's light.
- The local floor estimate is a fixed-radius low pass, so it cannot separate
  features smaller than `floorRadius` from the floor, or floor levels closer
  together than `stepHeight`. A mass thicker than twice that radius keeps only a
  solid rim, so its top becomes a sealed floor level that goes unlit unless
  something stands on it.
- The contact shadow's reach is a fixed world sigma, not a function of the
  occluder's size, so `contactRadius` has to suit the props that matter most in a
  scene. It also grounds every silhouette equally: something hovering well clear of
  the floor darkens it exactly as much as something resting on it.
- Occlusion is purely 2D: anything standing above the local floor blocks light
  regardless of how high the light itself is, so a chest-height beam does not
  clear a crate and a wall top is lit like the floor it rises from.
- Lighting is direct-only and not radiometric; intensities are arbitrary
  linear values handled by the host renderer's tone mapping.
- Emissive surfaces are also solid and therefore occlude rays.
- The field is square, power-of-two, and fixed at construction. In
  `imagePlane` domain the field camera widens its narrower axis to cover a
  square region — keeping texels square, so HRC's diagonal rays stay diagonal
  in world space — which spends part of the field outside a wide view.
- HRC's cost grows as O(size^2 · log size) in both memory and passes: 512
  costs about 36 MB and 70 solve passes, 1024 four times that. The default
  resolution is capped at 512 for that reason, so a 4K drawing buffer gets a
  relatively coarser field than the old marched solver's half-resolution one.
- `footprint` domain's parallel field spends its resolution uniformly, so a
  shallow, near-horizontal camera — whose visible ground runs to the horizon —
  gets a coarse field and loses the ground past twice its look-at distance. It
  suits cameras that look down; side-on views belong in `imagePlane`.
- The field G-buffer's world positions are stored in half floats, which limits
  scenes to modest world-space coordinate magnitudes.

## Development

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm check
pnpm build
```

The demo requires a WebGPU-capable browser. It updates the light field at
60 Hz and renders the camera view at the display rate. The Inspector's
`Benchmark 4K` action measures 30 offscreen 3840x2160 frames with a 60 Hz
lighting cadence, reports CPU submission time, timestamp-query GPU active
time, end-to-end queue time, and PASS/FAIL against a 300 fps target. Live
profiling is disabled by default because resolving timestamp queries every
animation frame materially changes the measured workload.

### Demo scenes

The demo starts in the interactive **Rooms** scene: four separate square rooms at
four floor heights, each walled in on its own and standing on its own plate, with
no outer enclosure — everything between them is void. Four narrow sloping
corridors cross that void into the rooms' doorways, in a ring that descends 3.6
units and climbs back. It runs in `footprint` domain, so the corridors and all
four floor levels read as open ground while walls, crates and pillars occlude —
lights spill out of the doorways and down the corridors between levels, and
nothing lights the void but what escapes them. Walls take their top and their
base from the floor beneath each corner rather than from fixed heights, so a
corridor's walls run down its slope with it and no wall hangs over the void.
Use the renderer Inspector's
`Scene` control to switch between Rooms, Platformer, and PICA PICA, and its
`Solver` control to switch between the 2.5D screen-space solver and the 3D
split cascades — the panel swaps its controls with the solver, since the two
share only `Temporal`, `Scene` and `Emission`. The
**Platformer** scene is a side-scrolling 2.5D level in `imagePlane` domain, so
platforms occlude by their on-screen silhouettes while lamps, crystals, and
the player's projectiles light the level.

#### PICA PICA scene license

The demo loads **PICA PICA - Mini Diorama 01** by SEED.EA from the Bevy asset
mirror. The scene is licensed under
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) and is included
for non-commercial demonstration only. Attribution and the pinned source are
stored alongside the asset in
`apps/demo/public/assets/pica_pica/LICENSE.md`.
