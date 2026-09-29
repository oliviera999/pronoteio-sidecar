/**
 * Adapts Pawnote 1.6.2 to the PRONOTE 2026 authentication (run automatically after npm install).
 *
 * Up to PRONOTE 2025, the answer to the challenge was AES(every other character of
 * AES^-1(challenge)). The 2026 web client (getNouveauChallenge) sends AES(challenge) directly:
 * Pawnote then fails with BadCredentialsError even with the right password. The patch keeps the old
 * scheme for older servers and uses the new one from version 2026.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const MARKER = "/*pronoteio-challenge-2026*/";

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`Node.js ${process.versions.node} is too old: the sidecar needs Node.js 20 or later.`);
  process.exit(1);
}

// cPanel (CloudLinux) runs npm in a separate virtual environment holding node_modules: resolve
// Pawnote from the current directory first, then from the application folder.
const resolvePawnote = () => {
  for (const base of [join(process.cwd(), "package.json"), import.meta.url]) {
    try {
      return createRequire(base).resolve("pawnote");
    } catch {
      // Try the next location.
    }
  }
  throw new Error("pawnote is not installed");
};
const dist = dirname(resolvePawnote());
const version = JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8")).version;

// "(session, keyBuffer, ...) => { const iv = createBuffer(aesIV); try { <old scheme> } catch { throw BadCredentials } }"
const pattern = /(\(e,s,t\)=>\{const (\w)=[\w.]+\.util\.createBuffer\(e\.information\.aesIV\);)(try\{const e=[\w.]+\.util\.decodeUtf8\((\w+)\.decrypt\(s\.challenge,t,\2\)\))/;

let failed = false;
for (const file of ["index.mjs", "index.js"]) {
  const path = join(dist, file);
  const source = readFileSync(path, "utf8");
  if (source.includes(MARKER)) {
    console.log(`pawnote ${version} ${file}: already patched`);
    continue;
  }
  const match = source.match(pattern);
  if (!match) {
    console.error(`pawnote ${version} ${file}: challenge code not found, PRONOTE 2026 login will fail`);
    failed = true;
    continue;
  }
  const [, head, iv, tail, aes] = match;
  const patched = `${head}${MARKER}if((e.instance?.version?.[0]??0)>=2026)return ${aes}.encrypt(s.challenge,t,${iv});${tail}`;
  writeFileSync(path, source.replace(pattern, patched));
  console.log(`pawnote ${version} ${file}: patched`);
}
process.exit(failed ? 1 : 0);
