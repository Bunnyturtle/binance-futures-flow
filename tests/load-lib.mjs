import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/**
 * lib/의 TypeScript 모듈을 그대로 테스트하기 위한 로더입니다. 상대 import가
 * 서로를 참조하므로, 데이터 URL 대신 임시 디렉터리에 .mjs로 한 번 펼친 뒤
 * 불러옵니다. 첫 호출에서만 변환하고 이후에는 같은 디렉터리를 재사용합니다.
 */
let compiled;

async function compileLib() {
  const libUrl = new URL("../lib/", import.meta.url);
  const outDir = await mkdtemp(join(tmpdir(), "crypto-flow-lib-"));
  const entries = (await readdir(libUrl)).filter((name) => name.endsWith(".ts"));
  await Promise.all(entries.map(async (name) => {
    const source = await readFile(new URL(name, libUrl), "utf8");
    const output = ts.transpileModule(source, {
      fileName: name,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
      reportDiagnostics: true,
    });
    const errors = output.diagnostics?.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (errors?.length) {
      throw new Error(`${name}: ${errors.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
      ).join("\n")}`);
    }
    // 상대 지정자에 확장자를 붙여 Node ESM 해석기가 찾을 수 있게 합니다.
    const rewritten = output.outputText.replaceAll(
      /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.\.?\/[^"']+?)\2/g,
      (match, prefix, quote, specifier) =>
        specifier.endsWith(".mjs") ? match : `${prefix}${quote}${specifier}.mjs${quote}`,
    );
    await writeFile(join(outDir, name.replace(/\.ts$/, ".mjs")), rewritten, "utf8");
  }));
  return outDir;
}

/** `loadLib("upbit-market")` → lib/upbit-market.ts의 export를 돌려줍니다. */
export async function loadLib(moduleName) {
  compiled ??= compileLib();
  const outDir = await compiled;
  return import(pathToFileURL(join(outDir, `${moduleName}.mjs`)).href);
}
