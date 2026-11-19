/**
 * Asynchronous jobs for the heavy reads (P4, 0.9.0): several classes, student files in bulk.
 *
 * A long request may outlast the timeout of the web server in front of the sidecar (Apache + Passenger on cPanel),
 * which then delivers it again or answers an error to Moodle. A job answers at once:
 *   POST /jobs { "requests": [{ "url": "/roster?resource=c%3AT06" }, …] }   → 202 { jobid, status, progress }
 *   GET  /jobs/{jobid}                                                     → { status, progress, results }
 * - only reads (GET) of the routes listed in JOB_ROUTES, run one after the other inside the process (app.inject with the
 *   internal token, the session of the job, the bulk priority of the queue and a longer wait);
 * - a partial answer of students/files?ids=… (queue deadline reached) is completed: the remaining ids are asked again
 *   after retry_after, and the files merged;
 * - progress: requests done / total; results: [{ url, status, body }] in the order asked;
 * - a job belongs to the session that created it (another session gets 404 not_found); its result is kept in memory
 *   for PRONOTEIO_JOB_TTL seconds (600 at most), never on disk, and lost at restart.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { INTERNAL_HEADER, INTERNAL_TOKEN } from "./auth.js";
import { HttpError } from "./errors.js";

/** Read routes a job may run. */
export const JOB_ROUTES = [
  "/timetable",
  "/timetable/resource",
  "/homework",
  "/roster",
  "/students/files",
  "/grades/context",
  "/grades/overview",
  "/notebook",
  "/assessments",
  "/absences",
  "/competencies",
  "/reports/context",
  "/reports",
];

export const MAX_JOB_REQUESTS = 50;
const MAX_JOBS = 20;
const JOB_TTL_MS = Math.min(600, Math.max(30, Number.parseInt(process.env.PRONOTEIO_JOB_TTL ?? "600", 10) || 600)) * 1000;
/** Rounds of completion of a partial students/files answer. */
const MAX_ROUNDS = 20;

type JobResult = { url: string; status: number; body: unknown };

type Job = {
  id: string;
  session: string;
  /** 0.10.0: web headers of the creating request (X-Pronoteio-Web-Session, X-Pronoteio-Web), forwarded to each read. */
  web?: Record<string, string>;
  status: "queued" | "running" | "done" | "failed";
  created: number;
  finished: number | null;
  expires: number;
  total: number;
  done: number;
  results: JobResult[];
  error: string | null;
};

const jobs = new Map<string, Job>();

const purge = (now = Date.now()) => {
  for (const [id, job] of jobs) if (job.expires < now) jobs.delete(id);
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Route of a job url, null when not allowed. */
export const jobRoute = (url: string): string | null => {
  if (typeof url !== "string" || !url.startsWith("/") || url.includes("#")) return null;
  const path = url.split("?")[0];
  return JOB_ROUTES.includes(path) ? path : null;
};

const view = (job: Job) => ({
  jobid: job.id,
  status: job.status,
  progress: { done: job.done, total: job.total },
  created: Math.floor(job.created / 1000),
  finished: job.finished === null ? null : Math.floor(job.finished / 1000),
  expires: Math.floor(job.expires / 1000),
  ...(job.status === "done" || job.status === "failed" ? { results: job.results } : {}),
  ...(job.error ? { error: job.error } : {}),
});

/** Statistics for the health check (no content). */
export const jobStats = () => {
  purge();
  const list = [...jobs.values()];
  return { jobs: list.length, running: list.filter((job) => job.status === "running" || job.status === "queued").length };
};

const runOne = async (app: FastifyInstance, session: string, url: string, web: Record<string, string> = {}): Promise<JobResult> => {
  const inject = async (target: string) => {
    const response = await app.inject({
      method: "GET",
      url: target,
      headers: { [INTERNAL_HEADER]: INTERNAL_TOKEN, "x-pronoteio-session": session, "x-pronoteio-job": "1", ...web },
    });
    let body: unknown = response.body;
    try {
      body = JSON.parse(response.body);
    } catch {
      // Not JSON: kept as text.
    }
    return { status: response.statusCode, body, headers: response.headers };
  };
  let answer = await inject(url);
  // students/files?ids=…: complete a partial answer (queue deadline reached) with the remaining ids.
  if (url.split("?")[0] === "/students/files") {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const body = answer.body as { partial?: boolean; remaining?: string[]; retry_after?: number; items?: unknown[]; read?: string[] };
      if (answer.status === 429) {
        await sleep(Math.max(1, Number((answer.body as { retry_after?: number })?.retry_after ?? 1)) * 1000);
        answer = await inject(url);
        continue;
      }
      if (answer.status !== 200 || !body?.partial || !body.remaining?.length) break;
      await sleep(Math.max(1, Number(body.retry_after ?? 1)) * 1000);
      const next = new URL(url, "http://sidecar");
      next.searchParams.set("ids", body.remaining.join(","));
      const more = await inject(`${next.pathname}?${next.searchParams.toString()}`);
      if (more.status !== 200) break;
      const rest = more.body as typeof body;
      answer = {
        ...more,
        body: {
          ...rest,
          items: [...(body.items ?? []), ...(rest.items ?? [])],
          read: [...(body.read ?? []), ...(rest.read ?? [])],
        },
      };
    }
  }
  return { url, status: answer.status, body: answer.body };
};

const run = async (app: FastifyInstance, job: Job, urls: string[]): Promise<void> => {
  job.status = "running";
  try {
    for (const url of urls) {
      job.results.push(await runOne(app, job.session, url, job.web));
      job.done++;
    }
    job.status = "done";
  } catch (error) {
    job.status = "failed";
    job.error = "internal";
    void error;
  }
  job.finished = Date.now();
  job.expires = job.finished + JOB_TTL_MS;
};

type JobBody = { requests: { url: string }[] };

export const registerJobs = (app: FastifyInstance): void => {
  app.post<{ Body: JobBody }>(
    "/jobs",
    {
      schema: {
        body: {
          type: "object",
          required: ["requests"],
          properties: {
            requests: {
              type: "array",
              minItems: 1,
              maxItems: MAX_JOB_REQUESTS,
              items: { type: "object", required: ["url"], properties: { url: { type: "string", minLength: 2, maxLength: 12_000 } } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const session = String(request.headers["x-pronoteio-session"] ?? "");
      if (session === "") throw new HttpError(401, "session_expired");
      const urls = request.body.requests.map((item) => item.url);
      const refused = urls.filter((url) => jobRoute(url) === null);
      if (refused.length > 0) throw new HttpError(400, "validation_failed:requests.url", { fields: ["requests.url"] });
      purge();
      if ([...jobs.values()].filter((job) => job.status === "running" || job.status === "queued").length >= MAX_JOBS) {
        throw new HttpError(429, "rate_limited", { retry_after: 30 }, { "retry-after": "30" });
      }
      const now = Date.now();
      const web: Record<string, string> = {};
      for (const name of ["x-pronoteio-web-session", "x-pronoteio-web"]) {
        const value = String(request.headers[name] ?? "");
        if (value !== "") web[name] = value;
      }
      const job: Job = { id: randomUUID(), session, web, status: "queued", created: now, finished: null, expires: now + JOB_TTL_MS * 3,
        total: urls.length, done: 0, results: [], error: null };
      jobs.set(job.id, job);
      void run(app, job, urls);
      return reply.code(202).send(view(job));
    },
  );

  app.get<{ Params: { id: string } }>("/jobs/:id", async (request) => {
    purge();
    const job = jobs.get(request.params.id);
    if (!job || job.session !== String(request.headers["x-pronoteio-session"] ?? "")) throw new HttpError(404, "job_not_found");
    return view(job);
  });
};
