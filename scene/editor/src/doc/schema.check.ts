/**
 * An entity type's fields, edited as one table over two blocks.
 *
 * node --experimental-strip-types --disable-warning=ExperimentalWarning src/doc/schema.check.ts
 */
import { strict as assert } from "node:assert";
import { parse } from "tscene";
import { report, test } from "../check.ts";
import { catalogueOfSheets, newEntityDef } from "./catalogue.ts";
import { printValue } from "../io/literal.ts";
import {
  addSchemaField, removeSchemaField, renameSchemaField, schemaOf, setSchemaDefault, setSchemaKnob,
  setSchemaType, typeOfValue,
} from "./schema.ts";
import { num, str } from "./props.ts";

const sheet = `@template entity.spawn {
  @entity { hp: 30; kind: "grunt"; loose: true }
  @fields { kind: { type: enum; options: ["grunt", "brute"] }; note: { type: lines } }
}
`;

const def = () => catalogueOfSheets([parse(sheet, "a.tscene")]).objects.find((d) => d.name === "spawn")!;

test("a row's type is the declaration where there is one and the default's own where there is not", () => {
  const rows = schemaOf(def());
  assert.deepEqual(rows.map((r) => [r.name, r.type, r.declared]), [
    ["hp", "float", false], // `hp: 30` earns a number box without being told
    ["kind", "enum", true],
    ["loose", "bool", false],
    ["note", "lines", true], // declared but never defaulted — still a field of the type
  ]);
  assert.equal(typeOfValue(undefined), "text");
});

test("a field added is declared and defaulted at once, under a name nothing else has", () => {
  const once = addSchemaField(def());
  assert.deepEqual(schemaOf(once).find((r) => r.name === "field1"), {
    name: "field1", type: "text", declared: true, value: str(""), field: { name: "field1", type: "text" },
  });
  assert.ok(schemaOf(addSchemaField(once)).some((r) => r.name === "field2"), "and the next one is field2");
});

test("a type picked drags its default with it, unless the value already fits", () => {
  const int = setSchemaType(def(), "hp", "int");
  assert.equal(printValue(schemaOf(int).find((r) => r.name === "hp")!.value!), "0", "a float 30 is not an int 30");
  const same = setSchemaDefault(setSchemaType(def(), "hp", "float"), "hp", num(7));
  assert.equal(printValue(schemaOf(same).find((r) => r.name === "hp")!.value!), "7");
  // the knobs that only meant something for the old type go with it
  const ranged = setSchemaKnob(setSchemaKnob(int, "hp", "min", 1), "hp", "max", 9);
  assert.deepEqual(ranged.declared.find((f) => f.name === "hp"), { name: "hp", type: "int", min: 1, max: 9 });
  const text = setSchemaType(ranged, "hp", "text");
  assert.deepEqual(text.declared.find((f) => f.name === "hp"), { name: "hp", type: "text" });
  const base = def();
  assert.equal(setSchemaKnob(base, "nothing", "doc", "x"), base, "a row that is not there is not invented");
});

test("a rename moves both halves, and refuses a name the type already has", () => {
  const moved = renameSchemaField(def(), "kind", "sort");
  const row = schemaOf(moved).find((r) => r.name === "sort")!;
  assert.equal(row.type, "enum", "the declaration came along");
  assert.equal(printValue(row.value!), '"grunt"', "and so did the default");
  assert.equal(schemaOf(moved).some((r) => r.name === "kind"), false);
  const base = def();
  assert.equal(renameSchemaField(base, "kind", "hp"), base, "hp is taken, so nothing happened");
  assert.equal(renameSchemaField(base, "kind", "  "), base);
});

test("a field deleted leaves neither half behind", () => {
  const gone = removeSchemaField(def(), "kind");
  assert.deepEqual(schemaOf(gone).map((r) => r.name), ["hp", "loose", "note"]);
  assert.deepEqual(removeSchemaField(newEntityDef("x"), "nothing").declared, []);
});

report("schema");
