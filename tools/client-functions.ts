/**
 * Discovery tool: lists the functions and tabs declared by a Pronote web client, without logging in.
 *
 * Usage: npx tsx tools/client-functions.ts <https://.../pronote/professeur.html> [filter regexp]
 *
 * The client scripts declare each request with `.inscrire('NomFonction')` and the tab numbers in the
 * TypeGenreOngletInternet enumeration. Both are printed (optionally filtered), to choose the functions
 * to validate with tools/probe.ts after a PRONOTE update. Nothing is written to disk.
 */
const [pageArg, filterArg] = process.argv.slice(2);
if (!pageArg) {
  console.error("Usage: tools/client-functions.ts <https://.../pronote/professeur.html> [filter]");
  process.exit(2);
}
const page = new URL(pageArg);
page.searchParams.set("fd", "1");
const filter = filterArg ? new RegExp(filterArg, "i") : null;
const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36" };

const html = await (await fetch(page, { headers })).text();
const space = page.pathname.split("/").pop()?.replace(/\.html$/, "") ?? "";
const scripts = [...new Set(html.match(new RegExp(`E_[0-9]+_C_[A-F0-9]+_L_[0-9]+/${space}(?:_defer)?\\.js`, "g")) ?? [])];
if (scripts.length === 0) throw new Error("No client script found in the page (is it a PRONOTE space page?)");

let code = "";
for (const script of scripts) {
  code += await (await fetch(new URL(script, page), { headers })).text();
}

const functions = [...new Set([...code.matchAll(/\.inscrire\s*\(\s*['"]([A-Za-z_]+)['"]\s*\)/g)].map((m) => m[1]))].sort();
const tabs = [...code.matchAll(/TypeGenreOngletInternet\[TypeGenreOngletInternet\["(\w+)"\]\s*=\s*(\d+)\]/g)]
  .map((m) => ({ name: m[1], tab: Number(m[2]) }))
  .sort((a, b) => a.tab - b.tab);
const keep = (name: string) => !filter || filter.test(name);

const version = html.match(/PRONOTE (\d{4}\.\d+\.\d+)/)?.[1] ?? "?";
console.log(`PRONOTE ${version} - ${space}: ${functions.length} functions, ${tabs.length} tabs`);
console.log("\nFunctions:");
for (const name of functions.filter(keep)) console.log(`  ${name}`);
console.log("\nTabs:");
for (const { name, tab } of tabs.filter((item) => keep(item.name))) console.log(`  ${String(tab).padStart(3)} ${name}`);
