import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importTypescript(relativeUrl) {
  const sourceUrl = new URL(relativeUrl, import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const output = ts.transpileModule(source, {
    fileName: sourceUrl.pathname,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
    reportDiagnostics: true,
  });
  const errors = output.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors?.length) {
    throw new Error(errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    ).join("\n"));
  }
  const encoded = Buffer.from(`${output.outputText}\n//# sourceURL=${sourceUrl.href}`).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

const {
  applyTimeframeToActive,
  applyTimeframeToAll,
} = await importTypescript("../lib/chart-timeframes.ts");

test("applies one timeframe to all twelve slots and preserves no-op identity", () => {
  const mixed = ["1m", "5m", ...Array.from({ length: 10 }, () => "1m")];
  const unified = applyTimeframeToAll(mixed, "4h", 12);

  assert.deepEqual(unified, Array.from({ length: 12 }, () => "4h"));
  assert.notStrictEqual(unified, mixed);
  assert.strictEqual(applyTimeframeToAll(unified, "4h", 12), unified);
});

test("changes only the active slot and preserves no-op identity", () => {
  const current = Array.from({ length: 12 }, () => "1m");
  const changed = applyTimeframeToActive(current, 7, "1d", 12);

  assert.equal(changed[7], "1d");
  assert.equal(changed.filter((value) => value === "1d").length, 1);
  assert.deepEqual(changed.slice(0, 7), current.slice(0, 7));
  assert.deepEqual(changed.slice(8), current.slice(8));
  assert.strictEqual(applyTimeframeToActive(changed, 7, "1d", 12), changed);
});

test("clamps an out-of-range active slot without changing array length", () => {
  const current = Array.from({ length: 12 }, () => "1m");

  assert.equal(applyTimeframeToActive(current, -9, "5m", 12)[0], "5m");
  const high = applyTimeframeToActive(current, 99, "1w", 12);
  assert.equal(high[11], "1w");
  assert.equal(high.length, 12);
});
