/** Request schemas of every route, read from the routes of the application (contracts/requests.json, P10). */
export const requestContracts = async () => {
  const { buildApp, routesOf } = await import("../../src/app.js");
  const { PUBLIC_ROUTES } = await import("../../src/auth.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  const routes = routesOf(app)
    .map((route) => ({ ...route, signed: !PUBLIC_ROUTES.has(route.url) || route.url === "/health" }))
    .sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
  await app.close();
  return { note: "Schémas des requêtes de toutes les routes, extraits du code (npm run contracts:requests). /health : signée pour le rapport complet.", routes };
};
