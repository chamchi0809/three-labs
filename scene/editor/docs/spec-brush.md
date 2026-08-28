# `brush` — convex solids in tscene

Status: **specification**. Implemented by M1 (syntax) and M2 (kernel).

This describes an addition to the tscene *core* language, not to the editor. Everything the editor saves
has to be a file the plain `tscene` runtime, checker, LSP and vite plugin already understand — otherwise
the editor's output is a private format wearing a `.tscene` extension.

---

## 1. Why a core syntax and not a registry class

The alternative was a `--module` class: `brush(...)` registered like any user constructor. It was rejected
because a brush is not a leaf object the language merely instantiates:

- **The checker has to see inside it.** A face is three points and a material reference; a bad plane, a
  non-convex set of half-spaces, a `var()` that resolves to a texture rather than a material — all of
  these are static errors, and a registry class reduces them to "some opaque args".
- **Round-trip needs stable spans.** M4 edits the source surgically. A registry call is one expression to
  the parser, so moving one vertex would rewrite the whole call. Faces have to be addressable nodes.
- **The LSP has to complete inside it.** `uv:` modes, face material names, the `@broom` knobs.

So `brush` joins `BUILTINS` in `names.ts` — the table that already holds `repeat`, `find` and `play` — as
a new kind of entry: a builtin that *is* a node rather than a value.

## 2. Grammar

```
brush .class #id {
  <Mesh properties>

  face(<p1>, <p2>, <p3>) {
    material: <material>;
    uv:       paraxial | parallel(<u-axis>, <v-axis>);
    offset:   <vec2>;    /* metres, along the face's u and v */
    scale:    <vec2>;    /* metres of world per full texture tile */
    rotation: <angle>;   /* degrees, about the face normal */
  }
  ...
}
```

`brush` nests, is parented, takes `.class`/`#id`, and accepts `@override` like any other node. A brush
with fewer than four faces, or whose half-spaces bound no volume, is a **checker error**, not a runtime
warning: an empty brush in a level is always a mistake.

### Faces are three points

Decision 9. A face is the plane through `p1`, `p2`, `p3`, wound counter-clockwise when seen from outside
— the Quake `.map` convention, and the reason TrenchBroom's vertex editing is stable across a save.
Normal-plus-distance would be one number shorter and would lose the u/v anchor that the paraxial system
derives from the same three points.

Points are `vec3` in metres, Y-up (decision 7). They are snapped to the grid ladder in
[`src/grid/snap.ts`](../src/grid/snap.ts), so every coordinate written to a file is an exact binary
fraction and re-reading a brush yields the identical plane.

### Materials

Materials are not `Object3D`s, so they cannot be `ref()` targets. The existing `--var` idiom already
covers sharing, and gets no new syntax:

```
--stone: meshStandardMaterial { color: #8a8681; roughness: 0.9; };

brush {
  face(...) { material: var(--stone); }
}
```

A brush becomes **one `Mesh`** (decision 10). Per-face materials are realised as a material array plus
geometry groups on that single mesh, so face count does not become draw-call count.

## 3. `@broom` — entity and editor metadata

Modelled exactly on the existing `@bakery` at-rule: a knob table in `names.ts` with per-position
validation, so an unknown knob is a checker error and the LSP completes the known ones.

`@template` **is** the entity definition (decision 8). `@broom` is how a template says what the editor
should do with it:

```
@template torch {
  @broom {
    kind:  point;          /* point | brush */
    icon:  "torch.png";
    color: #ffb060;
    size:  -0.2 -0.2 -0.2  0.2 0.2 0.2;   /* editor bounding box, metres */
  }
  pointLight { intensity: 4; distance: 8; }
}
```

`@broom` also carries per-node editor state that is not scene data — layer membership, lock, visibility —
so that reopening a map restores the workspace without a sidecar file.

## 4. What M1 must touch

The house rule is explicit: *new syntax means updating every consumer of it*. For `brush` and `@broom`
that is, at minimum:

| Consumer | Change |
| --- | --- |
| `scene/lib/src/parse.ts` | `brush` node, `face()` block, `@broom` at-rule |
| `scene/lib/src/check.ts` | convexity, ≥4 faces, degenerate planes, uv-mode arity, `@broom` knobs |
| `scene/lib/src/runtime.ts` | half-space → `BufferGeometry`, groups, material array, one `Mesh` |
| `scene/lib/src/names.ts` | `BUILTINS.brush`, `BROOM` knob table |
| `scene/lib/src/lsp.ts` | completion and hover for `brush`, `face`, `uv` modes, `@broom` knobs |
| `scene/vscode` | tmLanguage patterns, snippets |
| `scene/lib/docs/language.md`, `README.md` | reference entries — `docs.check.ts` **fails** without them |

`docs.check.ts` compiles every example in those documents with the real parser and checker, and requires
every `BUILTINS` name to appear in the language reference. It is the gate on M1, not a follow-up chore.
