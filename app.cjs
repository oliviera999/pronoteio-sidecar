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

if (Number(process.versions.node.split(".")[0]) < 20) {
  startupFailure(`Node.js ${process.versions.node} is too old: choose Node.js 20 or later in Setup Node.js App.`);
} else {
  import("./dist/server.js").catch((error) => {
    console.error(error);
    startupFailure(error && error.message ? error.message : String(error));
  });
}
