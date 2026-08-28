# Round-trip — editing tscene source from a GUI

Status: **specification**. Implemented by M4.

Decision 5: **full round-trip, surgical editing**. Opening a `.tscene`, dragging one vertex and saving
must produce a file whose diff is that one vertex. Comments, blank lines, indentation, `--var`
declarations, `repeat()`, `each()`, `@import` and `@override` all survive untouched.

This is the hardest subsystem in the project, and the reason is worth stating plainly.

---

## 1. The core tension

TrenchBroom edits a mutable data model and serialises it. tscene's canonical artifact is **programmable
source text**: a level may be forty lines of `repeat()` that expand to four hundred nodes. Serialising
the model would flatten the program into its output — a correct scene, and a destroyed source file.

So the editor never regenerates. It **patches**.

## 2. Provenance

Parsing produces, for every runtime node, a provenance record:

```
{ file, span: [start, end], derivation: Direct | Repeat | Each | Template | Override }
```

- **`Direct`** — the node has its own literal text. Fully editable; a GUI change rewrites exactly the
  bytes of the property being changed, leaving the rest of the node's span alone.
- **`Repeat` / `Each`** — the node is one iteration of a loop. Its text is shared with its siblings.
- **`Template`** — the node came from `@template` expansion.
- **`Override`** — the property's winning value was written by an `@override` rule elsewhere.

## 3. Derived-node policy

Editing one node of a `repeat(20)` is ambiguous: change all twenty, or break this one out? Guessing is
worse than asking. On an edit to a non-`Direct` node the editor offers three actions:

1. **Unroll** — replace the loop with its expansion, then apply the edit to the one node. Explicit, and
   the diff shows the cost.
2. **Jump to source** — open the `repeat()`/`@template` and let the edit be made where it belongs, so it
   applies to every instance.
3. **Reject** — refuse the drag and say why. The default for accidental drags.

The editor marks derived nodes in the viewport, so the choice is not a surprise at drag time.

## 4. `@override` and the inspector

`@override` rules use descendant selectors, apply in source order, last-written-wins, and land **after**
the node's own body. A property set inside a node therefore *cannot* beat an override targeting it.

Two consequences the inspector must respect:

- It shows the **effective** value with its origin ("from `@override .wall`"), not the node-local literal.
  Showing the literal would show a value that is not what renders.
- Editing an overridden property routes the write to the **override rule**, not to the node body —
  writing to the body would produce a file where the GUI value and the rendered value disagree.

## 5. Patch mechanics

The edit unit is a text splice against the original buffer:

```
{ file, span: [start, end], text }
```

Splices are collected per transaction, sorted, checked for overlap, and applied back-to-front so that
earlier spans keep their offsets. After applying, the file is **re-parsed and re-checked**; a patch that
fails to parse is rolled back and reported as an editor bug rather than written to disk. That re-parse is
the invariant that keeps the round-trip honest — the editor never trusts its own splice.

Number formatting is fixed by the grid: coordinates are exact binary fractions, written with the shortest
decimal that reads back identically, so a save touches no coordinate the user did not move.

## 6. Multi-file

`@import` means a map is a graph of files. Provenance carries the file, patches are grouped by file, and
a transaction may write several. Imported files opened read-only (from `node_modules`, say) reject edits
at the same point as a derived node, with the same three choices minus "unroll".
