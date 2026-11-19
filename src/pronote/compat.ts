/**
 * Compatibility fixes between Pawnote 1.6.x and recent PRONOTE versions.
 */
import { defaultFetcher, type Fetcher } from "@literate.ink/utilities";

/**
 * PRONOTE 2026 writes `try{Start ({...});} catch` in the login page, while Pawnote 1.6.2 extracts
 * the session parameters up to `)}catch`: the extra semicolon makes the login fail with
 * PageUnavailableError. The semicolon is removed before Pawnote parses the page.
 */
export const compatFetcher: Fetcher = async (request) => {
  const response = await defaultFetcher(request);
  if (request.url.pathname.endsWith(".html") && response.content.includes("Start")) {
    response.content = response.content.replace(/(Start\s*\(\s*\{[^}]*\}\s*\))\s*;(\s*\})/u, "$1$2");
  }
  return response;
};

/** Browser of the web Espace Professeurs (0.10.0): Pronote serves professeur.html to a desktop browser. */
export const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/**
 * Fetcher of a web Espace Professeurs session (0.10.0): Pawnote sends the user agent of the PRONOTE mobile application;
 * the web space is asked as a desktop browser asks it.
 */
export const webFetcher = (base: Fetcher = compatFetcher): Fetcher => async (request) => {
  if (request.headers instanceof Headers) request.headers.set("User-Agent", WEB_USER_AGENT);
  else request.headers = { ...(request.headers ?? {}), "User-Agent": WEB_USER_AGENT };
  return base(request);
};

/** Base address of the instance ("https://host/pronote/") from any URL of its spaces. */
export const pronoteBaseUrl = (url: string): string => {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/[^/]*\.html$/i, "/");
  return parsed.toString().replace(/\/+$/, "");
};
