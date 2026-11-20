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
// 0.10.0: login to the web Espace Professeurs (professeur.html, "Domicile" mode) instead of the mobile space.
// Pawnote always opens mobile.<space>.html with the flags of the mobile application: the mobile space has fewer tabs
// (no skills, report cards nor referentials). Two changes, both inert for the existing logins:
// 1. the page of the session information (K) drops "mobile." when its argument carries web: true;
// 2. pronoteioLoginWeb, a copy of loginCredentials without bydlg nor the request of a mobile token, which throws the
//    SecurityError of a double authentication (PIN) instead of a token login the web space cannot do.
const WEB_MARKER = "/*pronoteio-web-space*/";
const pagePattern = /return`mobile\.\$\{(\w)\}\.html`\}\)\((\w)\.kind\)\)/;
const loginPattern = /async\(e,s\)=>\{const t=\w+\(s\.url\),\{information:n,version:i\}=await \w+\(\{base:t,kind:s\.kind,cookies:\[\],params:\{\.\.\.\w+,bydlg:"A6ABB224-12DD-4E31-AD3E-8A39A1C2C335"\}\},e\.fetcher\);[^]*?(\w+)\(u\)\?\w+\(e,\{token:u\.jetonConnexionAppliMobile,username:(\w)\.login\?\?s\.username,deviceUUID:s\.deviceUUID\}\):(\w+)\(e,u,\2,s\.username\)\}/;
for (const file of ["index.mjs", "index.js"]) {
  const path = join(dist, file);
  let source = readFileSync(path, "utf8");
  if (source.includes(WEB_MARKER)) {
    console.log(`pawnote ${version} ${file}: web space already patched`);
    continue;
  }
  const page = source.match(pagePattern);
  const login = source.match(loginPattern);
  const security = file === "index.js" ? source.match(/exports\.SecurityError=(\w+)/) : source.match(/(\w+) as SecurityError\b/);
  if (!page || !login || !security) {
    console.error(`pawnote ${version} ${file}: login code not found, the web Espace Professeurs will not open`);
    failed = true;
    continue;
  }
  const [, inner, outer] = page;
  source = source.replace(pagePattern, () =>
    `return\`mobile.\${${inner}}.html\`})(${outer}.kind).replace(/^mobile\\./,${outer}.web?"":"mobile."))${WEB_MARKER}`);
  const [code, needsSecurity, identity] = login;
  const web = code
    .replace("kind:s.kind,cookies:[]", "kind:s.kind,web:!0,cookies:[]")
    .replace(',bydlg:"A6ABB224-12DD-4E31-AD3E-8A39A1C2C335"', "")
    .replace("requestFirstMobileAuthentication:!0", "requestFirstMobileAuthentication:!1")
    .replace(/\w+\(e,\{token:u\.jetonConnexionAppliMobile,username:\w\.login\?\?s\.username,deviceUUID:s\.deviceUUID\}\):/,
      `(()=>{throw new ${security[1]}(u,${identity},s.username)})():`);
  void needsSecurity;
  source += file === "index.js" ? `\nexports.pronoteioLoginWeb=${web};${WEB_MARKER}\n` : `\nexport const pronoteioLoginWeb=${web};${WEB_MARKER}\n`;
  writeFileSync(path, source);
  console.log(`pawnote ${version} ${file}: web space patched`);
}

// 0.11.1: classes of a lesson. Pawnote keeps the groups (G 2) of a lesson but drops its classes (G 1) and parts of
// classes (G 57): a lesson of a whole class came with no group, and the attendance of a Moodle course linked to that
// class found no lesson. The three genres go to groupNames, in the order of the answer, as in src/teacher/timetable.ts.
const CLASSES_MARKER = "/*pronoteio-lesson-classes*/";
const classesPattern = /(case 17:\w\.push\(s\.L\);break;)case 2:(\w)\.push\(s\.L\)/;
for (const file of ["index.mjs", "index.js"]) {
  const path = join(dist, file);
  const source = readFileSync(path, "utf8");
  if (source.includes(CLASSES_MARKER)) {
    console.log(`pawnote ${version} ${file}: lesson classes already patched`);
    continue;
  }
  if (!classesPattern.test(source)) {
    console.error(`pawnote ${version} ${file}: lesson decoder not found, the timetable will miss the classes`);
    failed = true;
    continue;
  }
  writeFileSync(path, source.replace(classesPattern, (_, head, groups) => `${head}case 1:case 57:case 2:${groups}.push(s.L)${CLASSES_MARKER}`));
  console.log(`pawnote ${version} ${file}: lesson classes patched`);
}

process.exit(failed ? 1 : 0);
