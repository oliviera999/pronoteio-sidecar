// Startup file for Phusion Passenger (cPanel "Setup Node.js App"), which loads apps with require():
// the sidecar is an ES module, so it is loaded through a dynamic import. Passenger overrides the
// port given to listen(): PRONOTEIO_HOST and PRONOTEIO_PORT are ignored in this mode.
if (Number(process.versions.node.split(".")[0]) < 20) {
  console.error("Node.js " + process.versions.node + " is too old: choose Node.js 20 or later in Setup Node.js App.");
  process.exit(1);
}

import("./dist/server.js").catch((error) => {
  console.error(error);
  process.exit(1);
});
