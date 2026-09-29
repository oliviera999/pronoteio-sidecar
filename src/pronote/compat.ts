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

/** Base address of the instance ("https://host/pronote/") from any URL of its spaces. */
export const pronoteBaseUrl = (url: string): string => {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/[^/]*\.html$/i, "/");
  return parsed.toString().replace(/\/+$/, "");
};
