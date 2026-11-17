import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApp, post, get } from "./helpers/app.js";

const { setUpdateRunner } = await import("../src/admin.js");

const script = new URL("../tools/cpanel-update.sh", import.meta.url).pathname;

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.org", ...args], { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};

/**
 * Bare "origin", the application (a clone with the real script) and a fake curl that answers /health/public like the
 * restarted sidecar: version of package.json and commit of HEAD, or nothing when that version is "broken".
 */
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "sidecar-update-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const app = join(root, "app");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, work);
  mkdirSync(join(work, "tools"));
  cpSync(script, join(work, "tools", "cpanel-update.sh"));
  writeFileSync(join(work, ".gitignore"), "var/\ntmp/\n");
  writeFileSync(join(work, "package.json"), `{\n  "name": "s",\n  "version": "0.8.0"\n}\n`);
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "v0.8.0");
  git(work, "push", "--quiet", "origin", "HEAD:main");
  git(root, "clone", "--quiet", origin, app);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const curl = join(bin, "curl");
  writeFileSync(curl, `#!/bin/bash
[ -n "\${FAKE_DELAY:-}" ] && sleep "$FAKE_DELAY"
version=$(sed -n 's/^ *"version" *: *"\\([^"]*\\)".*/\\1/p' "$FAKE_APP/package.json")
[ "$version" = "\${FAKE_BROKEN:-none}" ] && exit 22
commit=$(git -C "$FAKE_APP" rev-parse --short=7 HEAD)
echo "{\\"ok\\":true,\\"version\\":\\"$version\\",\\"commit\\":\\"$commit\\"}"
`);
  chmodSync(curl, 0o755);
  const npm = join(bin, "npm");
  writeFileSync(npm, "#!/bin/bash\necho \"npm $*\" >> \"$FAKE_APP/npm.log\"\n");
  chmodSync(npm, 0o755);
  const publish = (version: string) => {
    writeFileSync(join(work, "package.json"), `{\n  "name": "s",\n  "version": "${version}"\n}\n`);
    git(work, "commit", "--quiet", "-am", `v${version}`);
    git(work, "push", "--quiet", "origin", "HEAD:main");
    return git(work, "rev-parse", "HEAD");
  };
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    HOME: root,
    CURL: curl,
    NPM: npm,
    FAKE_APP: app,
    PRONOTEIO_UPDATE_WAIT: "4",
    PRONOTEIO_UPDATE_POLL: "1",
    PRONOTEIO_UPDATE_LOG: join(root, "update.log"),
    PRONOTEIO_UPDATE_LOCK: join(root, "update.lock"),
    ...extra,
  });
  const run = (extra: Record<string, string> = {}) =>
    spawnSync("/bin/bash", [join(app, "tools", "cpanel-update.sh"), "https://sidecar.example"], { env: env(extra), encoding: "utf8" });
  const result = () => JSON.parse(readFileSync(join(app, "var", "update-result.json"), "utf8"));
  return { root, app, publish, run, env, result, log: () => readFileSync(join(root, "update.log"), "utf8") };
};

test("simulated update: new commit merged, restarted, new version checked, logged", () => {
  const t = setup();
  const before = git(t.app, "rev-parse", "HEAD");
  const target = t.publish("0.9.0");
  const run = t.run();
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(git(t.app, "rev-parse", "HEAD"), target);
  assert.ok(existsSync(join(t.app, "tmp", "restart.txt")));
  const result = t.result();
  assert.equal(result.result, "ok");
  assert.equal(result.old.commit, before);
  assert.equal(result.new.commit, target);
  assert.equal(result.old.version, "0.8.0");
  assert.equal(result.new.version, "0.9.0");
  assert.match(t.log(), new RegExp(`${before.slice(0, 7)} -> ${target.slice(0, 7)} \\(0\\.8\\.0 -> 0\\.9\\.0\\) ok`));
  assert.ok(readFileSync(join(t.app, "npm.log"), "utf8").includes("ci --omit=dev"), "npm ci: package.json changed");
  // Nothing new: only the keep-alive call, no log line.
  const again = t.run();
  assert.equal(again.status, 0);
  assert.equal(t.log().trim().split("\n").length, 1);
  rmSync(t.root, { recursive: true });
});

test("an update that breaks the health check is rolled back to the previous commit", () => {
  const t = setup();
  const before = git(t.app, "rev-parse", "HEAD");
  t.publish("0.9.0-broken");
  const run = t.run({ FAKE_BROKEN: "0.9.0-broken" });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.equal(git(t.app, "rev-parse", "HEAD"), before);
  const result = t.result();
  assert.equal(result.result, "rolled_back");
  assert.equal(result.health, `0.8.0@${before.slice(0, 7)}`);
  assert.match(t.log(), /health failed .*: rollback/);
  assert.match(t.log(), /rollback to .* \(0\.8\.0\) ok/);
  rmSync(t.root, { recursive: true });
});

test("two simultaneous updates: only one runs", async () => {
  const t = setup();
  t.publish("0.9.0");
  const start = () =>
    new Promise<number>((resolve) => {
      const child = spawn("/bin/bash", [join(t.app, "tools", "cpanel-update.sh"), "https://sidecar.example"], { env: t.env({ FAKE_DELAY: "1" }) });
      child.on("exit", (code) => resolve(code ?? -1));
    });
  const codes = await Promise.all([start(), start()]);
  assert.deepEqual([...codes].sort(), [0, 75]);
  assert.equal((t.log().match(/ ok$/gm) ?? []).length, 1);
  assert.match(t.log(), /update already running: skipped/);
  rmSync(t.root, { recursive: true });
});

test("POST /admin/update runs the script and answers old and new versions; one at a time", async () => {
  const root = mkdtempSync(join(tmpdir(), "sidecar-admin-"));
  const file = join(root, "update-result.json");
  process.env.PRONOTEIO_UPDATE_RESULT = file;
  let runs = 0;
  setUpdateRunner((target) => {
    runs++;
    setTimeout(() => writeFileSync(target, JSON.stringify({ at: "x", old: { commit: "a", version: "0.8.0" },
      new: { commit: "b", version: "0.9.0" }, result: "ok", health: "0.9.0@b" })), 700);
  });
  const app = await buildApp({ logger: false });
  const [first, second] = await Promise.all([post(app, "/admin/update", {}), new Promise((r) => setTimeout(r, 100)).then(() => post(app, "/admin/update", {}))]);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().result, "ok");
  assert.equal(first.json().old.version, "0.8.0");
  assert.equal(first.json().new.version, "0.9.0");
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().code, "rate_limited");
  assert.equal(runs, 1);
  const last = await get(app, "/admin/update");
  assert.equal(last.json().last.result, "ok");
  const unsigned = await app.inject({ method: "POST", url: "/admin/update", payload: {} });
  assert.equal(unsigned.statusCode, 401);
  delete process.env.PRONOTEIO_UPDATE_RESULT;
  await app.close();
  rmSync(root, { recursive: true });
});
