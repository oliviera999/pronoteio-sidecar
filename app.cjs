// Startup file for Phusion Passenger (cPanel "Setup Node.js App"), which loads apps with require():
// the sidecar is an ES module, so it is loaded through a dynamic import. Passenger overrides the
// port given to listen(): PRONOTEIO_HOST and PRONOTEIO_PORT are ignored in this mode.
//
// When the sidecar cannot start, a minimal server answers 503 with the cause (message only, no
// stack trace), because shared hosts rarely give easy access to the application logs.
const startupFailure = (message) => {
  console.error(`pronoteio-sidecar failed to start: ${message}`);
  const server = require("http").createServer((request, response) => {
    response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`pronoteio-sidecar failed to start: ${message}\n`);
  });
  if (typeof PhusionPassenger !== "undefined") {
    server.listen("passenger");
  } else {
    server.listen(Number(process.env.PRONOTEIO_PORT) || 3900, process.env.PRONOTEIO_HOST || "127.0.0.1");
  }
};

// The Pawnote patch normally runs after npm install, but cPanel's "Run NPM Install" may skip or hide a
// failed postinstall: apply it again at each start (it does nothing when already applied).
const patchPawnote = () => {
  const result = require("child_process").spawnSync(process.execPath, [require("path").join(__dirname, "tools", "patch-pawnote.mjs")], {
    cwd: __dirname,
    encoding: "utf8",
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (output) console.error(output);
  return result.status === 0 ? null : `Pawnote patch failed (${output || result.error || "unknown error"})`;
};

let patchError = null;
if (Number(process.versions.node.split(".")[0]) < 20) {
  startupFailure(`Node.js ${process.versions.node} is too old: choose Node.js 20 or later in Setup Node.js App.`);
} else if ((patchError = patchPawnote())) {
  startupFailure(patchError);
} else {
  import("./dist/server.js").catch((error) => {
    console.error(error);
    startupFailure(error && error.message ? error.message : String(error));
  });
}
