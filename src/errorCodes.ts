/**
 * Stable error codes of the sidecar (P7, 0.9.0), documented in the README and served by GET /errors.
 *
 * Every error answer keeps its historical "error" member (read by local_pronoteio up to 2026112100: same values,
 * prefixes and details as before) and gains:
 * - "code": one of the stable codes below, the one a client should branch on;
 * - "message": a fixed French sentence, never built from Pronote data (no name, no id, no Pronote message);
 * - the members of the case: retry_after (rate_limited), candidates (ambiguous), fields (validation_failed), reason…
 * 0.15.0: web_login_backoff (429, retry_after, backoff_until), answered by the guard of the web logins without any call
 * to Pronote (webLoginGuard.ts); web_session_required carries the same two members during that back-off.
 * 0.16.0: collect_running (409, collectid), answered to a second grouped read of an account (collect.ts) and to the
 * read of a block that is not read yet (error collect_block_not_ready).
 */

export type StableCode =
  | "rate_limited"
  | "session_expired"
  | "session_replaced"
  | "login_failed"
  | "pronote_unavailable"
  | "pronote_format_changed"
  | "not_found"
  | "ambiguous"
  | "forbidden"
  | "validation_failed"
  | "duplicate_write"
  | "web_session_required"
  | "web_session_expired"
  | "web_login_backoff"
  | "collect_running"
  | "internal";

export type ErrorCodeInfo = {
  code: StableCode;
  /** Usual HTTP status. */
  status: number;
  message: string;
  /** What the client should do. */
  action: string;
  /** Members added to the answer in this case. */
  members: string[];
};

export const ERROR_CODES: ErrorCodeInfo[] = [
  { code: "rate_limited", status: 429, message: "Trop d'appels à Pronote : la file d'attente est pleine pour le moment.",
    action: "Réessayer après retry_after secondes (en-tête Retry-After).", members: ["retry_after"] },
  { code: "session_expired", status: 401, message: "La session Pronote a expiré.",
    action: "Se reconnecter avec le jeton, puis renvoyer la requête.", members: [] },
  { code: "session_replaced", status: 401, message: "La session Pronote a été fermée par Pronote (connexion depuis un autre poste).",
    action: "Se reconnecter avec le jeton, puis renvoyer la requête.", members: [] },
  { code: "login_failed", status: 401, message: "La connexion à Pronote a échoué (identifiants, jeton, code PIN ou double authentification).",
    action: "Vérifier la liaison du compte ; le champ error précise la cause.", members: [] },
  { code: "pronote_unavailable", status: 502, message: "Pronote ne répond pas ou a renvoyé une erreur.",
    action: "Réessayer plus tard.", members: ["reason"] },
  { code: "pronote_format_changed", status: 502, message: "Le format de Pronote a changé : la réponse n'est pas celle attendue.",
    action: "Ne pas réessayer : mettre à jour le sidecar (route et champ en cause dans function et field).",
    members: ["function", "field", "reason", "pronoteversion"] },
  { code: "not_found", status: 404, message: "Élément introuvable dans Pronote.", action: "Relire la liste avant de réessayer.", members: [] },
  { code: "ambiguous", status: 409, message: "Plusieurs éléments correspondent : préciser lequel.",
    action: "Choisir parmi candidates et renvoyer avec l'identifiant complet.", members: ["candidates"] },
  { code: "forbidden", status: 403, message: "Opération refusée (droits, onglet fermé, mode simulation ou saisie verrouillée).",
    action: "Ne pas réessayer sans changer de réglage ; le champ error précise la cause.", members: [] },
  { code: "validation_failed", status: 400, message: "Requête invalide : un champ manque ou est mal formé.",
    action: "Corriger les champs listés dans fields.", members: ["fields"] },
  { code: "duplicate_write", status: 401, message: "Requête signée déjà reçue et traitée.",
    action: "Ne pas renvoyer une écriture ; une lecture peut être renvoyée avec une nouvelle signature.", members: [] },
  { code: "web_session_required", status: 409,
    message: "Cette fonction demande un onglet absent de la session mobile : il faut une session de l'Espace Professeurs web.",
    action: "Ouvrir la session web (POST /session/login avec space: web) puis renvoyer la requête avec X-Pronoteio-Web-Session ; si retry_after est présent, ne pas tenter de connexion web avant ce délai.",
    members: ["onglet", "function", "retry_after", "backoff_until"] },
  { code: "web_session_expired", status: 401, message: "La session de l'Espace Professeurs web a expiré.",
    action: "Rouvrir la session web (POST /session/login avec space: web) puis renvoyer la requête.", members: [] },
  { code: "web_login_backoff", status: 429,
    message: "Pronote a refusé une connexion à l'Espace Professeurs web : aucune nouvelle tentative n'est envoyée avant la fin du délai de reprise.",
    action: "Ne pas tenter de connexion web avant retry_after secondes (en-tête Retry-After, instant backoff_until) ; une connexion avec le code PIN saisi par l'enseignant reste possible.",
    members: ["retry_after", "backoff_until"] },
  { code: "collect_running", status: 409,
    message: "Une lecture groupée de ce compte est déjà en cours, ou le bloc demandé n'est pas encore lu.",
    action: "Suivre la lecture en cours (GET /collect/{collectid}) au lieu d'en lancer une autre ; lire un bloc quand son état est done ou partial.",
    members: ["collectid"] },
  { code: "internal", status: 500, message: "Erreur interne du sidecar.", action: "Réessayer ; consulter /health si elle persiste.", members: [] },
];

const BY_CODE = new Map(ERROR_CODES.map((item) => [item.code, item]));

const LOGIN = new Set(["bad_credentials", "pin_required", "bad_pin", "security_setup_required", "double_auth_required", "login_failed",
  "web_token_refused"]);
const FORBIDDEN = new Set([
  "access_denied", "write_mode_simulate", "grade_write_disabled", "service_not_in_period", "not_main_teacher", "list_not_mine",
  "assessment_locked", "assessment_without_comments", "comments_closed", "comment_not_editable", "messaging_disabled", "recipient_refuses",
  "attendance_locked", "attendance_not_allowed", "absence_not_allowed", "late_not_allowed", "absence_not_deletable",
  "absence_settled", "absence_already_entered", "reply_not_possible", "survey_closed", "news_locked", "meeting_entry_closed",
  "tab_closed", "lesson_not_editable", "lesson_rooms_not_editable", "pronote_refused", "invalid_signature", "invalid_timestamp",
  "forbidden", "address_not_allowed", "exclusive_mode",
]);
const VALIDATION = new Set([
  "invalid_request", "invalid_json", "validation_failed", "range_too_large", "comment_too_long", "audience_required",
  "delete_without_id", "homework_without_students", "confirmation_required", "invalid_lesson_id", "invalid_include",
]);

/** Stable code of an error answer (status and historical "error" string). */
export const stableCode = (status: number, error: string, method = "GET"): StableCode => {
  const base = error.split(":")[0];
  if (BY_CODE.has(base as StableCode) && base !== "internal") return base as StableCode;
  if (base === "replayed_request") return "duplicate_write";
  if (base === "web_session_required_after_write") return "web_session_required";
  if (base === "collect_block_not_ready") return "collect_running";
  if (LOGIN.has(base)) return "login_failed";
  if (base.startsWith("pronote_format_changed")) return "pronote_format_changed";
  if (base.endsWith("_ambiguous") || base === "ambiguous") return "ambiguous";
  if (base.endsWith("_not_found") || status === 404) return "not_found";
  if (FORBIDDEN.has(base) || status === 403) return "forbidden";
  if (VALIDATION.has(base) || base.startsWith("invalid_") || base.endsWith("_required") || status === 400) return "validation_failed";
  if (status === 429) return "rate_limited";
  if (base === "pronote_error" || status === 502 || status === 503 || status === 504) return "pronote_unavailable";
  void method;
  return "internal";
};

export const messageOf = (code: StableCode): string => BY_CODE.get(code)?.message ?? BY_CODE.get("internal")!.message;

/** Candidates of an ambiguous error ("lesson_ambiguous:<id> ; <id>"), only ids (lesson ids carry no student data). */
const candidatesOf = (error: string): string[] | undefined => {
  if (!error.startsWith("lesson_ambiguous:")) return undefined;
  return error.slice("lesson_ambiguous:".length).split(" ; ").map((item) => item.trim()).filter(Boolean);
};

/** Fields of a schema validation error of Fastify (ajv), without the values. */
export const fieldsOf = (error: unknown): string[] | undefined => {
  const validation = (error as { validation?: { instancePath?: string; params?: { missingProperty?: string } }[] })?.validation;
  if (!Array.isArray(validation)) return undefined;
  const fields = validation.map((item) => {
    const path = String(item.instancePath ?? "").replace(/^\//, "").replace(/\//g, ".");
    const missing = item.params?.missingProperty;
    return missing ? (path ? `${path}.${missing}` : missing) : path;
  }).filter(Boolean);
  return fields.length ? [...new Set(fields)] : undefined;
};

/** Body of an error answer: historical "error", stable "code", French "message", members of the case. */
export const errorBody = (status: number, error: string, extra: Record<string, unknown> = {}, method = "GET", cause?: unknown) => {
  const code = (typeof extra.code === "string" && BY_CODE.has(extra.code as StableCode) ? extra.code : stableCode(status, error, method)) as StableCode;
  const body: Record<string, unknown> = { error, ...extra, code, message: messageOf(code) };
  if (code === "ambiguous" && body.candidates === undefined) {
    const candidates = candidatesOf(error);
    if (candidates) body.candidates = candidates;
  }
  if (code === "validation_failed" && body.fields === undefined) {
    const fields = fieldsOf(cause) ?? (error.startsWith("validation_failed:") ? [error.slice("validation_failed:".length)] : undefined);
    if (fields) body.fields = fields;
  }
  return body;
};
