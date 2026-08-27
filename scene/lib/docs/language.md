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
