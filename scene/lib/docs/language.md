# `.tscene` language reference

Runtime and tooling API: [api/index.md](./api/index.md). Overview: [../README.md](../README.md).

Every example below is compiled by the real parser and type checker (`src/docs.check.ts`), so a change
to the grammar breaks this file first.

## Sheets

One file is one sheet. Only `@import`, `--variable` declarations, `@template`, `@override` and nodes may
appear at the top level. Comments are `//` and `/* */`, statements end with `;`, blocks are `{ }`.

```css
// top level
--height: 1.5;

group #stage {
  mesh #box {
    geometry: boxGeometry(1, 1, 1);
    position: vec3(0, var(--height), 0);
  }
}
```

A property outside a node is an error.

```css error: must be inside a node
castShadow: true;
```

## Nodes

```
name .class* #id? (constructor args) { body }
```

| Part | Meaning |
| --- | --- |
| name | the three class name with a lowercase first letter (`mesh`, `meshStandardMaterial`, `pointLight`). `three/addons` counts as three: `loftGeometry`, `roomEnvironment`, `roundedBoxGeometry` |
| `.class` | lays down the body of the `@template` with that name first. Repeatable |
| `#id` | `object.name = "id"`. Referenced with `ref(#id)` |
| `(args)` | constructor arguments, positional only; an overload passes if any signature matches |
| `{ body }` | **instance properties only**. Constructor-only settings like `BoxGeometry.widthSegments` go in the arguments |

Nesting is parenting (`parent.add(child)`). A class that is not an `Object3D` cannot be a child; use it
as a property value instead.

```css
group #stage {
  pointLight #lamp(#ffd9a0, 30, 20) {
    position: vec3(2.5, 3, 2);
    castShadow: true;
  }
  mesh #floor {
    geometry: planeGeometry(20, 20);
    material: meshStandardMaterial { roughness: 0.9; };
    rotation: euler(-90deg, 0, 0);
  }
}
```

## Properties

`name: value;` is the base form. There are two variations.

```css
mesh #box {
  geometry: boxGeometry(1, 1, 1);
  material: meshStandardMaterial { color: color(#ff8a3d); };
  material.opacity: 0.4;    /* dotted path — a property of a nested object */
  lookAt(0, 1, 0);          /* method call — a `name(...)` with no value */
}
```

Read-only fields (`position`, `rotation`, `scale`, `color`, …) are assigned through `copy()`, which is
why `position: vec3(...)` works. A read-only field without a `copy()` cannot be set at all.

A dotted path is checked against the declared type of each segment, with one widening: `Mesh.material`
is declared as the abstract `Material`, so its members resolve against `MeshPhysicalMaterial` — that is
what makes `material.emissive` on a mesh inside a loaded glTF check. The widening is unsound on
purpose: a path that a `MeshBasicMaterial` has no slot for checks, and then does nothing at runtime.

## Values

```css
--tint: #7fd1ff;
mesh #demo {
  geometry: boxGeometry(1, 1, 1);
  material: meshStandardMaterial {
    color: color(var(--tint));           /* var() — a variable */
    opacity: calc(0.5 * 2 - 0.4);        /* calc() — arithmetic, folded to a number */
    map: texture("./t.png");             /* loader */
    side: DoubleSide;                    /* a constant three exports */
    transparent: true;                   /* true / false / null */
    name: "demo";                        /* string */
  };
  renderOrder: 2;                        /* number */
  rotation: euler(45deg, 1rad, 0);       /* deg / rad suffixes */
  morphTargetInfluences: [0, 1];         /* array */
  userData: { hp: 3; tags: ["a"] };      /* record */
  morphTargetInfluences: each(--i, 2, calc(var(--i) / 2));   /* each() — a list */
  visible: true;
}
directionalLight #sun {
  target: ref(#demo);                    /* reference to another node */
}
```

### Records

`{ key: value; … }` goes wherever the declared type is an options bag — an interface or a type literal of
plain data — and wherever it is `any`. An options bag is checked key by key, the way a node body is; an
`any` slot such as `userData` takes whatever you put in it.

```css
mesh #shape {
  /* LoftGeometry's second argument is LoftGeometryOptions: three booleans, all optional */
  geometry: loftGeometry([], { capStart: true; capEnd: true });
  userData: { hp: 3 };
}
```

```css error: has no setting
mesh #typo { geometry: loftGeometry([], { capStrat: true }); }
```

Semicolons and commas both separate entries. An interface with methods on it is a live object, not
settings, so it stays a class the sheet can only build with a constructor call.

### three/addons

The `three/addons` barrel is reflected alongside the entry point, so every addon class is a node or a
value like any other — `loftGeometry`, `roundedBoxGeometry`, `roomEnvironment`, `textGeometry`. The vite
plugin imports each one from the module it is declared in, not from the barrel, so a sheet that names one
addon bundles one addon. `tscene check --no-addons` turns the reflection off.

### tscene/height

`tscene/height` is an opt-in module — `tscene check --module tscene/height`, or `modules` in the vite
plugin — that adds one class: `heightMaterial`. It is everything `meshStandardMaterial` is, plus a
`heightMap` and a `depth` in metres, and it puts brick, stone, panelling and damage on a flat wall by
marching a ray through the height field instead of by modelling any of it.

```css +height
--brick: heightMaterial {
  map: texture("./brick.png");
  normalMap: texture("./brick_n.png");
  heightMap: texture("./brick_h.png");
  depth: 0.03;
}

mesh #wall {
  geometry: boxGeometry(4, 3, 0.2);
  material: var(--brick);
}
```

`depth` is the only number worth setting. How the surface is shaded is decided per pixel from how far
away it is and how square-on it is: a normal map alone out at the fade distance, a marched ray through
the middle, and up close the fragment also writes the depth it appears to have, so the relief intersects
other geometry and catches shadows instead of being painted on. The tiers are a ramp rather than a
switch, so nothing pops as a camera walks towards a wall, and `tuning` moves the ramp for a project whose
idea of "close" is not a few metres.

Because `depth` is a length, the material has to know how much wall one texture tile covers — and it
reads that off the geometry rather than being told, so three centimetres of relief is three centimetres
on a one-metre tile and on a four-metre one alike. A `heightMaterial` with no `heightMap` on it costs
what a standard material costs; the map is what turns the machinery on.

### Constructor aliases

`vec2()` `vec3()` `vec4()` `color()` `euler()` `quat()` `matrix4()` are aliases for the matching three
classes. `color()` takes `#ff8000`, `0xff8000` or `"red"`.

### Loaders

| | loads | arrives as |
| --- | --- | --- |
| `texture(url)` | an image, through `TextureLoader` | `Texture` |
| `hdr(url)` | a Radiance `.hdr`, through `HDRLoader` | `DataTexture` |
| `exr(url)` | an OpenEXR `.exr`, through `EXRLoader` | `DataTexture` |
| `ktx2(url)` | a `.ktx2`, transcoded to whatever the GPU compresses | `CompressedTexture` |
| `gltf(url)` | a `.gltf`/`.glb`, through `GLTFLoader` | `Group` |

`gltf()` may also be used as a node, in which case the loaded scene is added as a child. Relative paths
are rewritten by the vite plugin into `?url` imports, so hashing and copying are the bundler's job. Every
loader downloads a url once; each use gets its own clone, so two nodes can set different `repeat`s on the
same image.

`hdr()` and `exr()` carry linear radiance rather than colour, and default to
`EquirectangularReflectionMapping` — an environment map is what they are almost always for. Set `mapping`
in the body to say otherwise.

```css
scene #world {
  environment: hdr("./venice.hdr");
  mesh #floor {
    geometry: planeGeometry(10, 10);
    material: meshStandardMaterial { map: ktx2("./floor.ktx2"); };
  }
}
```

The addon loaders are imported the first time a sheet asks for one, so a scene with no `.hdr` in it never
downloads the parser for one. `ktx2()` additionally needs `loadScene`'s `ktx2` option — the transcoder is
served, not bundled, and it has to probe the renderer — and `gltf()` needs the `draco` option for a model
that was compressed with it.

```js
await loadScene(sheet, { ktx2: { path: "/basis/", renderer }, draco: "/draco/" });
```

### `var()`

```css
--height: 2;
mesh #a {
  geometry: boxGeometry(1, 1, 1);
  position: vec3(0, var(--height), 0);
  scale: vec3(1, var(--depth, 1), 1);   /* the second argument is a fallback */
}
```

Variables are lexically scoped: a declaration in a block shadows the outer one, and nothing is visible
before its own declaration. The **top-level** variables of an `@import`ed sheet are visible from the
import onwards.

### `calc()`

`+ - * /` with parentheses, folded to a number. It also has a fixed set of functions, and `pi`:

| | |
| --- | --- |
| one argument | `abs` `sign` `sqrt` `exp` `log` `sin` `cos` `tan` `asin` `acos` `atan` `floor` `ceil` `round` |
| two | `atan2(y, x)` `pow(x, e)` `min(a, b)` `max(a, b)` `mod(a, b)` |
| three | `clamp(x, low, high)` `smoothstep(x, edge0, edge1)` |
| none | `pi` |

Angles are radians, `mod` takes the divisor's sign, and `smoothstep` is the S curve — three's
`MathUtils.smoothstep`, not GLSL's argument order.

```css
mesh #a {
  geometry: boxGeometry(1, 1, 1);
  rotation.y: calc(pi / 4);
  scale.x: calc(pow(2, 3) * smoothstep(0.5, 0, 1) - abs(0 - 1));
}
```

Anything the folder cannot work out — an `each()` binding is not known until the loop runs — is left to
the runtime. Everything else has to be a number where it stands.

```css error: works on numbers
mesh #b { renderOrder: calc(sin("x")); }
```

### Properties and methods of a value

A `.name` after a value that is **already closed** reads a property; with arguments it calls a method and
takes what comes back. `[…]` indexes a list. A `.name` *before* an argument list is a `@template` class,
which is what keeps `meshStandardMaterial.glow { }` meaning what it always did.

```css
--profile: splineCurve([vec2(0.2, 0), vec2(1.2, 0.4), vec2(0.2, 1.7)]);
--points: var(--profile).getPoints(40);

mesh #pot {
  geometry: boxGeometry(1, 1, 1);
  scale.x: calc(var(--points)[0].x * 2);
}
```

Both are checked against the same reflected typings as everything else — a misspelled method, a property
that is not there, or indexing something that is not a list are all errors.

```css error: has no method
mesh #c { scale.x: splineCurve([vec2(0, 0)]).getPionts(4).length; }
```

### `each()`

```
each(--name, count | list, value)
```

A list: `value` evaluated once per index when the second argument is a number, and once per item when it
is a list. `--name` is bound to the index or the item, and `--index` and `--count` come along as they do
in [`repeat()`](#repeatn).

Unlike `repeat()`, this is a loop and not an unrolling: the body is checked once and evaluated once per
iteration, so a `loftGeometry()` of thirty thousand points costs thirty thousand evaluations and not
thirty thousand lines of AST. A node inside the body that reads the binding is built fresh every time;
one that does not is shared, exactly as it is anywhere else.

```css
--profile: splineCurve([vec2(0.2, 0), vec2(1.2, 0.4), vec2(0.7, 1.6), vec2(0.2, 1.7)]);

mesh #pot {
  /* one ring per profile point, 24 points around each — a lathe, written out */
  geometry: loftGeometry(
    each(--p, var(--profile).getPoints(40), each(--j, 24, vec3(
      calc(sin(var(--j) / var(--count) * 2 * pi) * var(--p).x),
      var(--p).y,
      calc(cos(var(--j) / var(--count) * 2 * pi) * var(--p).x)
    ))),
    { capStart: true; capEnd: true }
  );
}
```

### `ref()`

`ref(#id)` is the instance built for that `#id`. It is wired up after the whole scene is built, so it may
point at a node declared further down. The one exception is a **constructor argument**: that value has to
exist when the node is constructed, so only earlier nodes work there.

```css
group #stage {
  directionalLight #sun {
    position: vec3(3, 5, 2);
    target: ref(#later);      /* declared below, still fine */
  }
  object3D #later { }
}
```

## `@template`

Declared as a node type plus a name, applied by putting `.name` on a node. Omitting the type makes it
apply to any `Object3D`.

```css
@template mesh.glow {
  material: meshStandardMaterial { color: color(var(--tint, #ff8a3d)); };
  castShadow: true;
}
@template .hidden { visible: false; }

mesh.glow #a { --tint: #7fd1ff; geometry: boxGeometry(1, 1, 1); }
mesh.glow.hidden #b { geometry: boxGeometry(1, 1, 1); }
```

- A node that declares its own `--var` first feeds it to the templates applied to it — **template parameters**.
- Several templates are laid down **in the order written**, and the node's own body wins last (`.a.b` → a, b, body).
- Bodies are checked where they are declared, so a typo in a template nobody uses is still caught.
- Applying a template to a node that is not its declared type is an error.

```css error: is not a
@template mesh.glow { castShadow: true; }
pointLight.glow #lamp { }
```

## `@override`

A body appended to every node a selector reaches, once the whole tree exists. Where a `@template` is
opted into at the node, an `@override` reaches down into nodes that were written elsewhere — inside a
`repeat()`, inside another template, inside an `@import`ed sheet.

```css
@template mesh.enemy { material: meshStandardMaterial { color: color(#ff4040); }; }

group #arena {
  repeat(3) { mesh.enemy #grunt { geometry: boxGeometry(1, 1, 1); } }
  mesh #floor { geometry: planeGeometry(8, 8); }
}

@override #arena mesh.enemy {
  castShadow: true;
  renderOrder: 1;
}
```

A selector is a chain of **compound selectors** separated by whitespace. A compound is the same head a
node is written with — a type, a `#id`, any number of `.template`s, in any order but with no space
between them. Whitespace is the descendant combinator, so `#arena .enemy` is a `.enemy` anywhere under
`#arena` and `#arena.enemy` is one node that is both.

| | matches |
| --- | --- |
| `mesh` | every `mesh` node |
| `#hero` | the node declared `#hero` |
| `.glow` | every node the `.glow` template was applied to |
| `mesh#hero.glow` | a node that is all three |
| `group mesh` | a `mesh` at any depth under a `group` |

- Rules are matched against the tree `@import`s, templates and `repeat()` already produced, so a rule
  never selects a node another rule appended. The order between rules is source order, and the body
  lands after the node's own — so the last thing written wins.
- Only nodes are selected. A material or a geometry is a property of a node, not a node in the tree.
- The body is expanded once **per match**: a child declared in a rule that hits five nodes becomes five
  children, not one shared instance.
- The body is checked against the type the rightmost compound names, where the rule is written — so a
  rule that currently matches nothing is still checked, exactly as an unapplied template is.

```css error: has no property
@override mesh { castShaddow: true; }
```

- A `#id` or `.template` a selector names has to exist; go-to-definition and rename work through it.
- A rule that matches no node is a warning, not an error.

```css error: unknown node
@override #nobody { visible: false; }
```

## `@import`

```css
@import "./shared.tscene";      /* relative — resolved against the importing sheet */
@import "ui-kit/scenes.tscene"; /* bare specifier — resolved out of node_modules */
```

The imported sheet's top-level variables and `@template`s become visible. Its nodes are not added (an
imported sheet is treated as a library). Import cycles are ignored.

## `@bakery`

Settings for a tool rather than for three, so they never touch a three property. Valid at the top level
(the sheet's own settings), in a node, and in a material; a block is merged into whatever a `@template`
already put there, key by key.

```css
@bakery { size: 512; samples: 1024; out: "../public/lightmaps" };

pointLight #lamp(#fff2d8, 6) {
  @bakery { radius: 0.35 };
}
```

The keys are fixed and checked per position — `@bakery { sise: 512 }` is an error with a fix, the way a
misspelled property is. [`bakery.md`](./bakery.md) documents what each one does.

## `@broom`

The same shape as `@bakery`, for the editor rather than the baker. Valid at the top level and in a node —
a material has nothing to say to an editor, so there is no material position.

```css
@broom { grid: 0; scale: 1 };

group #torch {
  @broom { kind: point; icon: "flame"; color: #ffb020; size: [-0.2, 0, -0.2, 0.2, 0.6, 0.2] };
}
```

At the top level, `grid` is the power of two the editor snaps to (`0` is one metre, `-1` is half a metre)
and `scale` is how many metres one unit of an imported map is worth. In a node, `kind` says whether the
editor treats it as a point entity or a brush entity, `icon` and `color` are how a point entity draws when
it has no geometry, `size` is its selection box as `min x y z, max x y z`, and `layer`, `locked` and
`hidden` are the editor state that survives a round trip.

Everything here is advisory: a sheet with no `@broom` in it still loads, and three never sees these keys.

## Brushes

A `brush { … }` is a convex solid, described the way Quake and TrenchBroom describe one — as the
intersection of the half-spaces of its faces. Each `face(p1, p2, p3)` gives a plane through three points
wound counter-clockwise seen from *outside* the solid, and the solid is everything behind all of them at
once. Nothing lists the vertices; they are what the planes intersect at, which is why dragging a face
never leaves a hole.

The whole brush becomes one `Mesh`, with one geometry group and one material slot per face.

```css
--stone: meshStandardMaterial { color: color(#8a8a8a); roughness: 0.9; };

brush #pillar {
  castShadow: true;                                                  /* Mesh properties sit beside the faces */
  face([0, 2, 0], [0, 2, 2], [2, 2, 2]) { material: var(--stone); }  /* +y */
  face([0, 0, 0], [2, 0, 0], [2, 0, 2]) { material: var(--stone); }  /* -y */
  face([2, 0, 0], [2, 2, 0], [2, 2, 2]) { material: var(--stone); }  /* +x */
  face([0, 0, 0], [0, 0, 2], [0, 2, 2]) { material: var(--stone); }  /* -x */
  face([0, 0, 2], [2, 0, 2], [2, 2, 2]) { material: var(--stone); }  /* +z */
  face([0, 0, 0], [0, 2, 0], [2, 2, 0]) { material: var(--stone); }  /* -z */
}
```

One `--stone` declaration is one material, so all six slots share it. A face that names none gets a plain
`meshStandardMaterial`, and every such face shares that one too.

Adding a plane clips the solid; there is no separate operation for it. This is the same box with a corner
taken off, which is seven faces rather than six:

```css
brush #cut {
  face([0, 2, 0], [0, 2, 2], [2, 2, 2]) {}
  face([0, 0, 0], [2, 0, 0], [2, 0, 2]) {}
  face([2, 0, 0], [2, 2, 0], [2, 2, 2]) {}
  face([0, 0, 0], [0, 0, 2], [0, 2, 2]) {}
  face([0, 0, 2], [2, 0, 2], [2, 2, 2]) {}
  face([0, 0, 0], [0, 2, 0], [2, 2, 0]) {}
  face([3, 0, 0], [1, 2, 2], [3, 0, 2]) {}   /* x + y <= 3 */
}
```

### `face(p1, p2, p3)`

The three points name a plane, not a triangle — how far apart they are makes no difference. A face body
takes five keys of its own, and no three property:

| Key | Meaning |
| --- | --- |
| `material` | the material this face renders with |
| `uv` | `paraxial` (default) or `parallel`, described below |
| `offset` | metres along the face's own u and v |
| `scale` | **metres of world per full texture tile** — not a multiplier, so a bigger number means fewer tiles |
| `rotation` | about the uv basis normal; write `30deg` |

```css
brush #floor {
  face([0, 1, 0], [0, 1, 4], [4, 1, 4]) {
    uv: paraxial;
    scale: [2, 2];        /* one tile every two metres */
    offset: [0.5, 0];
    rotation: 30deg;
  }
  face([0, 0, 0], [4, 0, 0], [4, 0, 4]) { uv: parallel; }
  face([4, 0, 0], [4, 1, 0], [4, 1, 4]) {}
  face([0, 0, 0], [0, 0, 4], [0, 1, 4]) {}
  face([0, 0, 4], [4, 0, 4], [4, 1, 4]) {}
  face([0, 0, 0], [0, 1, 0], [4, 1, 0]) {}
}
```

`paraxial` is Quake's system: the u and v axes are the two world axes the face's normal is furthest from,
so a texture keeps sliding across a wall the same way however the wall is rotated, and neighbouring
brushes line up without being told to. `parallel` puts the axes in the face's own plane instead, which is
what you want on a slope that should carry its texture along the slope. `parallel(u, v)` pins the two
axes explicitly.

### What a brush is checked for

The checker builds the solid at compile time whenever every coordinate is a literal, and reports what it
finds — a plane the others already close, two faces on the same plane, three collinear points, and
half-spaces that never close at all:

```css error: do not close a solid
brush #open {
  face([0, 2, 0], [0, 2, 2], [2, 2, 2]) {}
  face([0, 0, 0], [2, 0, 0], [2, 0, 2]) {}
  face([2, 0, 0], [2, 2, 0], [2, 2, 2]) {}
  face([0, 0, 0], [0, 0, 2], [0, 2, 2]) {}
}
```

A face wound the wrong way is the mistake this catches most: its plane faces inward, and the four or six
half-spaces then bound nothing.

## Patches

A `patch { … }` is the curved half of the same toolbox. Where a brush is flat by construction, a patch is
a grid of control points that a *quadratic Bezier* surface is drawn through — an arch, a pipe, a dome, the
inside of a tunnel. It becomes one indexed, smooth-shaded `Mesh` with one material.

Each `row(…)` gives one row of control points. Both the number of rows and the number of points in a row
must be **odd and at least three**, because three points is one span and spans share their end points: 3,
5, 7, 9. Rows run along v, points within a row along u.

```css
--stone: meshStandardMaterial { color: color(#8a8a8a); roughness: 0.9; };

patch #arch {
  material: var(--stone);
  castShadow: true;                                          /* Mesh properties sit beside the rows */
  row([0, 0, 0], [0, 4, 0], [4, 4, 0]);                      /* a quarter turn, seen from -z */
  row([0, 0, 1], [0, 4, 1], [4, 4, 1]);
  row([0, 0, 2], [0, 4, 2], [4, 4, 2]);
}
```

The surface passes through the **corners** of each span and through the midpoint between its two ends —
but *not* through the middle control point. That point is a handle: at the middle of a span the surface
reaches only half way to it. This is the one thing about patches that catches people out, and it is why
an editor draws the control hull as well as the surface.

### `row(p1, p2, p3, …)`

A row takes points and has no body. There is nothing per-point to set: the material, the layout and the
tessellation all belong to the surface as a whole.

| Key on the patch | Meaning |
| --- | --- |
| `material` | the one material the whole surface renders with |
| `subdivisions` | segments per span; leave it out and the curvature picks a count |
| `uv` | `{ scale, offset, rotation }` — the material's layout along the surface |

```css
patch #pipe {
  subdivisions: 6;
  uv: { scale: [2, 2]; offset: [0, 0.5]; rotation: 30deg };
  row([1, 0, 0], [1, 0, 1], [0, 0, 1]);
  row([1, 2, 0], [1, 2, 1], [0, 2, 1]);
  row([1, 4, 0], [1, 4, 1], [0, 4, 1]);
}
```

`scale` and `offset` mean exactly what they mean on a face — metres of world per tile, and metres along
the surface — but they live in a record of their own because a patch *is* a `Mesh`, and `scale`,
`offset` and `rotation` at the top level of one are the object's transform. A face can spell them plainly
because a face is not an object.

The u and v a texture is laid out along are measured **along the surface**, not taken from the parameter.
A span is not travelled at a constant speed, so a texture laid out by parameter visibly bunches up where
the handle pulls; measuring the arc length keeps a tile a tile all the way round a bend.

Left to itself, `subdivisions` comes from how far each span bows away from the straight line between its
ends: a nearly flat patch costs two triangles, a tight one is cut up to sixteen ways per span.

### What a patch is checked for

The checker builds the grid at compile time whenever every coordinate is a literal, and an even or ragged
grid is an error where it is written rather than a surface that never appears:

```css error: odd number of control points
patch #even {
  row([0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]);
  row([0, 0, 1], [1, 0, 1], [2, 0, 1], [3, 0, 1]);
  row([0, 0, 2], [1, 0, 2], [2, 0, 2], [3, 0, 2]);
}
```

```css error: same length
patch #ragged {
  row([0, 0, 0], [1, 0, 0], [2, 0, 0]);
  row([0, 0, 1], [1, 0, 1], [2, 0, 1], [3, 0, 1], [4, 0, 1]);
  row([0, 0, 2], [1, 0, 2], [2, 0, 2]);
}
```

## Builtins

Names that are handled by the language itself rather than looked up in three.

### `repeat(n)`

Unrolls its body n times. Inside each copy `--index` (0-based) and `--count` are bound. Duplicate `#id`
warnings are suppressed for the copies.

```css
group #row {
  repeat(5) {
    mesh #tile {
      geometry: boxGeometry(0.8, 0.2, 0.8);
      position: vec3(calc(var(--index) - 2), 0, 0);
      renderOrder: var(--count);
    }
  }
}
```

### `find(nodeType?, "name")`

Looks up a node by name in the subtree that was already built and applies the body to it — the way to
reach inside a model loaded with `gltf()`. Giving a type asserts it at runtime and checks the body against
it. Adding an `#alias` makes the node available to `ref(#alias)`.

```css
gltf #hero("./hero.glb") {
  find(mesh, "Body") {
    castShadow: true;
    material.opacity: 0.9;   /* Mesh.material is declared as Material, so only its properties */
  }
  find#head("Head") {
    visible: true;
  }
}
```

### `play("clip")`

Plays an animation clip of the model it sits in. The body sets `AnimationAction` properties. Call
[`updateScene(root, dt)`](./api/index.md#updatescene) every frame for the clip to actually advance.

```css
gltf #hero("./hero.glb") {
  play("Idle") {
    timeScale: 0.5;
    weight: 1;
  }
}
```

## Diagnostics

Errors stop the scene from being built; warnings do not.

| Severity | Examples |
| --- | --- |
| error | syntax errors, unknown class/property/method, type mismatch, no matching constructor overload, unknown variable/template/`#id`, a child that is not an `Object3D` |
| warning | a property or variable set twice in one block, `--x` declared twice in one file, a duplicate `#id` (`getObjectByName` only finds the first), a `--x` or `.template` that is never used, an `@override` that matches no node |

Casing typos (`CastShadow`, `Mesh`) are errors that carry a fix — `tscene fix` and the editor quick
fix apply them. Anything more aggressive (spelling corrections, value conversions) is only reported.
