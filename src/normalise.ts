import type { Assignment, TimetableClassActivity, TimetableClassDetention, TimetableClassLesson } from "pawnote";
import type { GradeStatus } from "./pronote/encoding.js";

/** Shapes documented in plugin/classes/connector/connector_interface.php (timestamps in seconds). */
export type Lesson = {
  id: string;
  subject: string;
  teacher: string;
  rooms: string[];
  groups: string[];
  start: number;
  end: number;
  cancelled: boolean;
  status: string;
};

export type Homework = {
  id: string;
  subject: string;
  description: string;
  due: number;
  groups: string[];
  attachments: { name: string; url: string }[];
};

export type Resource = { id: string; name: string; type: "class" | "group" };

export type Student = {
  id: string;
  firstname: string;
  lastname: string;
  email: string | null;
  birthdate: number | null;
};

/** Absence (Pronote genre 13) or late arrival (genre 14) read in a call sheet. */
export type Absence = {
  id: string;
  studentid: string;
  start: number;
  end: number;
  justified: boolean;
  reason: string;
  kind: "absence" | "late";
};

export type Grade = { studentid: string; value: number | null; status: GradeStatus };

/** Assessment options, all settable from Moodle. */
export type Assessment = {
  /** Existing Pronote assessment to update, null to create one. */
  id: string | null;
  title: string;
  /** Assessment date (seconds). */
  date: number;
  /** Date from which students and parents see the grade (seconds), null for immediately. */
  publication: number | null;
  /** Scale ("barème"). */
  max: number;
  coefficient: number;
  /** "Ramener sur 20". */
  scaleTo20: boolean;
  /** "Devoir facultatif": only counted if it raises the average. */
  optional: boolean;
  /** "Bonus": only points above the average count. */
  bonus: boolean;
  comment: string;
};

export type Period = { id: string; name: string; current: boolean };

export type Service = {
  id: string;
  name: string;
  subject: string;
  resourceid: string;
  resourcename: string;
  type: "class" | "group";
  /** Periods (stable ids) in which the service is graded: a group may be graded by semester only. */
  periods: string[];
};

export type GradeContext = {
  periods: Period[];
  services: Service[];
  /** Largest scale accepted by the school, null when unknown. */
  maxScale: number | null;
};

export type PushResult = {
  assessmentid: string | null;
  written: number;
  rejected: { studentid: string; reason: string }[];
  dryRun: boolean;
};

/** One subject line of a report card. Averages as Pronote shows them (usually out of 20). */
export type ReportSubject = {
  subject: string;
  teachers: string[];
  coefficient: number | null;
  average: number | null;
  classAverage: number | null;
  min: number | null;
  max: number | null;
  /** Annotation written instead of the average ("Abs", "Disp"...), "" otherwise. */
  status: string;
  comments: string[];
};

/** General comment of a report card: kind from its Pronote genre (0 general, 1-3/8 class council, 4-6 comment, 7 CPE). */
export type ReportComment = { kind: "general" | "council" | "comment" | "cpe" | "other"; title: string; text: string };

/** Report card ("bulletin") of a student for a period, read in the teacher space (PageBulletins). */
export type Report = {
  studentid: string;
  lastname: string;
  firstname: string;
  period: string;
  average: number | null;
  classAverage: number | null;
  subjects: ReportSubject[];
  comments: ReportComment[];
  /** Summaries written by Pronote in the footer ("3 demi-journées dont 1 non justifiée"...). */
  attendance: { absences: string; lates: string; punishments: string; sanctions: string };
  /** Message of Pronote when there is no report card to show (not published, no grade...), "" otherwise. */
  message: string;
};

export type ReportContext = {
  /** Whether the account may open the report card tab, null when unknown. */
  allowed: boolean | null;
  classes: { id: string; name: string; principal: boolean; taught: boolean }[];
  periods: Period[];
};

export const seconds = (date: Date): number => Math.floor(date.getTime() / 1000);

export const lessonFromPawnote = (
  item: TimetableClassLesson | TimetableClassActivity | TimetableClassDetention,
): Lesson | null => {
  if (item.is !== "lesson") return null;
  return {
    id: item.id,
    subject: item.subject?.name ?? "",
    teacher: item.teacherNames.join(", "),
    rooms: [...item.classrooms],
    groups: [...item.groupNames],
    start: seconds(item.startDate),
    end: seconds(item.endDate),
    cancelled: item.canceled,
    status: item.status ?? "",
  };
};

export const homeworkFromPawnote = (item: Assignment): Homework => ({
  id: item.id,
  subject: item.subject.name,
  description: item.description,
  due: seconds(item.deadline),
  // TODO: Pawnote does not expose the target groups of an assignment; resolve them via item.resourceID.
  groups: [],
  attachments: item.attachments.map((file) => ({ name: file.name, url: file.url })),
});

/** Splits a Pronote display name "NOM Prénom" (upper-case words form the last name). */
export const splitDisplayName = (label: string): { lastname: string; firstname: string } => {
  const words = label.trim().split(/\s+/);
  let index = 0;
  while (index < words.length - 1 && /\p{L}/u.test(words[index]) && words[index] === words[index].toLocaleUpperCase("fr")) {
    index++;
  }
  if (index === 0) index = 1;
  return { lastname: words.slice(0, index).join(" "), firstname: words.slice(index).join(" ") };
};

/** Lesson of the teacher read in the teacher space (PageEmploiDuTemps), with its notebook flags. */
export type TeacherLesson = Lesson & {
  /** The lesson has a notebook entry ("cahier de textes"). */
  hasNotebook: boolean;
  /** The notebook entry is published to students and families. */
  notebookPublished: boolean;
  /** The call sheet has been done. */
  attendanceDone: boolean;
  /** The teacher may modify this lesson (Pronote "modifiable": rights of the profile and lock of the week). */
  editable: boolean;
  /** The rooms and equipment of this lesson may be changed (Pronote "ressourcesModifiables"). */
  roomsEditable: boolean;
};

/** File or link attached to a notebook content or homework. The file URL is bound to the current session. */
export type Attachment = { name: string; kind: "file" | "link"; url: string | null };

/** Category kinds of a notebook content (PageSaisieCahierDeTextes_General.ListeCategories[].G). */
export const CONTENT_KIND = {
  custom: 0,
  lesson: 1,
  correction: 2,
  writtenTest: 3,
  oralTest: 4,
  td: 5,
  tp: 6,
  skillsAssessment: 7,
  epi: 8,
  ap: 9,
  visio: 12,
  ccf: 13,
  certifyingAssessment: 14,
} as const;

/** Content kinds that flag an assessment. */
export const ASSESSMENT_KINDS: number[] = [
  CONTENT_KIND.writtenTest,
  CONTENT_KIND.skillsAssessment,
  CONTENT_KIND.ccf,
  CONTENT_KIND.certifyingAssessment,
];

export type NotebookContent = {
  id: string;
  title: string;
  /** HTML. */
  description: string;
  /** HTML. */
  objectives: string;
  category: { name: string; kind: number };
  /** Written test, skills assessment, CCF, certifying assessment, or linked to a graded assessment. */
  isAssessment: boolean;
  attachments: Attachment[];
  themes: string[];
};

export type NotebookHomework = {
  id: string;
  /** HTML. */
  description: string;
  /** Due date (seconds). */
  due: number;
  /** Date given (seconds), null when unknown. */
  given: number | null;
  /** Estimated duration in minutes, null when unset. */
  minutes: number | null;
  /** 0 unset, 1 easy, 2 medium, 3 hard. */
  difficulty: number;
  /** 0 none, 1 paper, 2 online (Pronote), 3 kiosk, 4 audio recording. */
  returnKind: number;
  forAll: boolean;
  /** "NOM Prénom" of the targeted students, only when not for all. */
  students: string[];
  attachments: Attachment[];
};

/** Notebook entry ("cahier de textes") of one lesson. */
export type Notebook = {
  lesson: TeacherLesson;
  locked: boolean;
  published: boolean;
  /** Publication date (seconds), null when unknown. */
  publication: number | null;
  /** Note for the next lesson: teacher only, never shown to students. */
  noteForNext: string;
  /** Private comment: teacher only. */
  privateComment: string;
  contents: NotebookContent[];
  homework: NotebookHomework[];
};

export type NotebookResult = { items: Notebook[]; lessons: number; truncated: boolean };

/** Assessment planned in the teacher's notebook, in the grade entry or in the school written tests list. */
export type PlannedAssessment = {
  id: string;
  source: "notebook" | "grades" | "dslist";
  date: number;
  end: number | null;
  subject: string;
  groups: string[];
  title: string;
  /** Notebook: category name; grades: "graded"; dslist: "written test". */
  kind: string;
  published: boolean | null;
  publication: number | null;
  coefficient: number | null;
  max: number | null;
  details: string;
};

export type SourceState = { available: boolean; reason: string; count: number };
export type Sources = Record<string, SourceState>;
export type AssessmentsResult = { items: PlannedAssessment[]; sources: Sources };

/** Information on the open session, for the health check. */
export type SessionInfo = {
  displayname: string;
  version: string;
  tabs: number[];
  rights: Record<string, unknown>;
  maxScale: number | null;
  functions: Record<string, { name: string; onglet: number | null; configured: boolean }>;
  writeMode: "simulate" | "live";
  classes: { id: string; name: string; type: "class" | "group"; taught: boolean; principal: boolean }[];
};

/** Comparable form of a label: lower case, no accents, single spaces. */
export const normalise = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** Plain text of an HTML fragment, whitespace collapsed, truncated. */
export const plainText = (html: string, max = 300): string => {
  const text = html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/* ---- Lot 2 (0.7.0): grades overview, skills, report comments, messaging, news, locker, quizzes ---- */

/** Label filter: a wanted label matches a group when equal or when the group starts with it ("1G" keeps "1G3"). */
export const matchesLabels = (groups: string[], wanted: string[]): boolean => {
  const filter = wanted.map(normalise).filter(Boolean);
  if (filter.length === 0) return true;
  const own = groups.map(normalise);
  return filter.some((label) => own.some((group) => group === label || group.startsWith(label)));
};

export type OverviewGrade = {
  /** "NOM Prénom". */
  student: string;
  value: number | null;
  status: GradeStatus;
  comment: string;
};

export type OverviewAssessment = {
  id: string;
  title: string;
  date: number;
  publication: number | null;
  max: number | null;
  coefficient: number | null;
  optional: boolean;
  bonus: boolean;
  locked: boolean;
  hasGrades: boolean;
  classAverage: number | null;
  /** Sub-service ("Écrit", "Oral") the assessment belongs to, "" when the service has none. */
  subservice: string;
  grades: OverviewGrade[];
};

export type OverviewService = Service & { assessments: OverviewAssessment[] };

export type GradeOverview = {
  periods: Period[];
  period: { id: string; name: string };
  services: OverviewService[];
};

export type Unavailable = { available: false; reason: string };

export type CompetencyRating = { student: string; skill: string; level: number | null; observation: string };

export type CompetencyItem = {
  id: string;
  title: string;
  date: number | null;
  publication: number | null;
  subject: string;
  resourcename: string;
  type: "class" | "group";
  skills: { id: string; name: string; domain: string }[];
  ratings: CompetencyRating[];
};

export type CompetencyOverview = {
  available: boolean;
  reason: string;
  levels: { code: number; name: string }[];
  period: { id: string; name: string };
  items: CompetencyItem[];
};

export type ReportComments = {
  available: boolean;
  reason: string;
  class: { id: string; name: string };
  period: { id: string; name: string };
  service: { id: string; name: string };
  closed: boolean;
  maxLength: number | null;
  classComment: string | null;
  students: { student: string; comment: string | null; general: string | null }[];
};

export type DiscussionFolder = "inbox" | "sent" | "drafts" | "archive" | "trash";

/** Kind of a messaging participant or recipient, from its TypeHttpRessource (1, 2, 3, 4, 5, 34). */
export type ParticipantKind = "class" | "group" | "teacher" | "student" | "parent" | "staff" | "unknown";

export type Participant = { label: string; kind: ParticipantKind };

export type Discussion = {
  id: string;
  subject: string;
  participants: string[];
  lastDate: number;
  unread: boolean;
  count: number;
  folder: DiscussionFolder;
  /** Participants read with SaisiePublicMessage ([] in listings and when the call fails). */
  participantsDetail: Participant[];
  canReply: boolean;
  /** Discussion of the "drafts" folder. */
  draft: boolean;
};

export type DiscussionsResult = { available: boolean; reason: string; disabled: boolean; items: Discussion[] };

export type Message = { id: string; author: string; date: number; text: string; attachments: Attachment[]; draft: boolean };

/* ---- Communication (0.2.0), docs/pronoteio/communication.md section 4 ---- */

export type RecipientKind = "class" | "group" | "teacher" | "student" | "parent" | "staff";

/** Possible recipient of a message (ListePublics), minimised: label, nature, classes and children only. */
export type Recipient = {
  /** "r:<kind>|<label>". */
  id: string;
  kind: RecipientKind;
  label: string;
  /** Student: his or her classes; class or group: []. */
  classes: string[];
  /** Refuses messages (discussionInterdit / refusMess). */
  refuses: boolean;
  /** Parent only: label and class of each child. */
  children: { label: string; class: string }[];
  /** Teacher: "main" | "tutor" | ""; staff: function label; otherwise "". */
  role: string;
  /** Student, class or group taught by the account. */
  taught: boolean;
};

export type RecipientsResult = {
  available: boolean;
  reason: string;
  disabled: boolean;
  items: Recipient[];
  total: number;
  truncated: boolean;
};

export type MessagingPrefs = {
  disabled: boolean;
  onlyParentsStudents: boolean;
  /** Hour from which messages are sent, null when unknown. */
  hourBefore: number | null;
  /** Hour until which messages are sent, null when unknown. */
  hourAfter: number | null;
  /** 1 Monday … 7 Sunday. */
  workingDays: { day: number; active: boolean }[];
  nonWorkingDays: { day: number; active: boolean; holiday: boolean }[];
  autoReply: string;
  /** Next opening computed from the ranges (seconds), null when open or unknown. */
  reopensAt: number | null;
};

export type NewsScope = "received" | "sent" | "drafts" | "templates" | "library";

export type NewsQuestionKind = "ack" | "text" | "single" | "multiple" | "none" | "noanswer";

export type NewsAnswer = { choices: number[]; text: string; acknowledged: boolean };

export type NewsQuestion = {
  /** "q1", "q2"… */
  id: string;
  /** HTML. */
  text: string;
  kind: NewsQuestionKind;
  choices: { rank: number; label: string; free: boolean }[];
  maxLength: number | null;
  answer: NewsAnswer | null;
};

export type NewsItem = {
  id: string;
  title: string;
  date: number;
  author: string;
  category: string;
  read: boolean;
  survey: boolean;
  /** HTML (texts of the questions, kept for compatibility). */
  text: string;
  attachments: Attachment[];
  kind: "information" | "survey";
  scope: NewsScope;
  published: boolean;
  state: "published" | "future" | "past" | "draft" | "template";
  start: number | null;
  end: number | null;
  /** detailPublicSuccinct. */
  publicSummary: string;
  sharedWith: string[];
  locked: boolean;
  anonymous: boolean;
  /** estAuteur. */
  mine: boolean;
  withoutAnswer: number | null;
  answeredPercent: number | null;
  questions: NewsQuestion[];
};

export type NewsResults = {
  news: { id: string; title: string; kind: "information" | "survey"; anonymous: boolean; recipients: number | null; answered: number | null };
  nominative: boolean;
  questions: {
    id: string;
    /** Raw text (HTML as Pronote sends it). */
    text: string;
    kind: NewsQuestionKind;
    total: number | null;
    answered: number | null;
    choices: { rank: number; label: string; count: number }[];
    /** Free answers, without names. */
    texts: string[];
    /** [] unless nominative. */
    respondents: { label: string; class: string; date: number | null; answer: NewsAnswer }[];
  }[];
};

export type DistributionList = {
  /** "dl:<label>". */
  id: string;
  label: string;
  public: boolean;
  mine: boolean;
  author: string;
  members: Participant[];
  count: number;
};

export type Notification = {
  id: string;
  /** Label of the notification group. */
  group: string;
  /** Raw "type". */
  kind: string;
  action: string;
  date: number;
  title: string;
  text: string;
  count: number | null;
};

export type MeetingWish = {
  /** "w<n>". */
  id: string;
  /** Label of the parent. */
  with: string;
  student: string;
  class: string;
  duration: number | null;
  wish: number | null;
  validated: boolean | null;
};

export type MeetingSession = {
  /** "mt:<label>|<date>". */
  id: string;
  label: string;
  date: number;
  /** "HH:MM". */
  start: string;
  end: string;
  entryFrom: number | null;
  entryTo: number | null;
  canEnterWishes: boolean;
  canEnterUnavailability: boolean;
  wishOptions: { code: number; label: string }[];
  wishes: MeetingWish[];
  unavailability: { slotStart: number | null; slotMinutes: number | null; session: number[]; mine: number[] };
  planningVisible: boolean;
  planning: { start: number; end: number | null; with: string; student: string; room: string; happened: boolean | null; visio: boolean }[];
};

export type Appointment = {
  /** "rdv:<date>|<subject>". */
  id: string;
  date: number;
  end: number | null;
  subject: string;
  /** Raw description. */
  description: string;
  participants: string[];
  place: string;
  status: string;
  mode: string;
};

export type ForumTopic = {
  /** "ft:<title>|<date>". */
  id: string;
  title: string;
  author: string;
  subject: string;
  themes: string[];
  state: string;
  moderated: boolean;
  unread: number;
  members: number;
  toModerate: number;
  excluded: number;
  date: number;
};

export type ForumPost = {
  id: string;
  author: string;
  date: number;
  /** HTML. */
  text: string;
  important: boolean;
  state: string;
};

/* ---- Write inputs and results of the communication lot ---- */

export type WriteAttachmentRef = { name: string; fileId?: string; url?: string };

export type MessageRecipientKind = RecipientKind | "list";

export type MessageWrite = {
  mode: "new" | "reply" | "draft" | "draft_update" | "draft_delete";
  subject?: string;
  /** Plain text: lines become paragraphs. */
  text?: string;
  /** "list": distribution list, replaced by its members. */
  recipients?: { kind: MessageRecipientKind; label: string }[];
  /** Reply: id of the discussion; draft update or deletion: id of the discussion of the "drafts" folder. */
  discussion?: string;
  attachments?: WriteAttachmentRef[];
  dryRun: boolean;
};

export type MessageWriteResult = {
  /** Draft modes add the draft text, so that Moodle can restore it. */
  before: (Discussion & { text?: string }) | null;
  after: { subject: string; recipients: string[]; text: string; attachments: string[]; discussion: Discussion | null; deleted: boolean };
  /** True for new and reply, false for drafts. */
  irreversible: boolean;
  written: boolean;
  dryRun: boolean;
  request: Record<string, unknown>;
  validated: false;
};

export type MailboxAction = "read" | "unread" | "archive" | "unarchive" | "trash" | "restore";

export type MailboxState = { id: string; subject: string; folder: DiscussionFolder; unread: boolean };

export type MailboxResult = {
  before: MailboxState[];
  after: MailboxState[];
  written: boolean;
  dryRun: boolean;
  requests: Record<string, unknown>[];
  validated: false;
};

export type DistributionListWrite = {
  action: "create" | "update" | "delete";
  /** update, delete: "dl:<label>". */
  id?: string;
  label?: string;
  public?: boolean;
  members?: { kind: RecipientKind; label: string }[];
};

export type DistributionListWriteResult = {
  before: DistributionList | null;
  after: DistributionList | null;
  written: boolean;
  dryRun: boolean;
  request: Record<string, unknown>;
  validated: false;
};

export type NewsResponseWrite = {
  read?: boolean | null;
  acknowledge?: boolean | null;
  answers?: { question: string; choices?: number[]; text?: string }[];
  remove?: boolean;
};

export type NewsResponseResult = {
  before: NewsItem;
  after: NewsItem;
  written: boolean;
  dryRun: boolean;
  request: Record<string, unknown>;
  irreversible: boolean;
  validated: false;
};

export type NewsAudience = {
  classes?: string[];
  groups?: string[];
  students?: boolean;
  /** avecResp1 / avecResp2. */
  parents?: "none" | "one" | "all";
  mainTeachers?: boolean;
  tutors?: boolean;
  individuals?: { kind: RecipientKind; label: string }[];
};

export type NewsWrite = {
  mode: "create" | "update" | "delete" | "publish" | "unpublish";
  id?: string;
  kind?: "information" | "survey";
  title?: string;
  /** Nature label. */
  category?: string;
  /** HTML: content of an information, optional introduction of a survey. */
  text?: string;
  start?: number;
  end?: number | null;
  anonymous?: boolean;
  template?: boolean;
  audience?: NewsAudience;
  questions?: { text: string; kind: "ack" | "text" | "single" | "multiple" | "none"; choices?: { label: string; free?: boolean }[]; maxLength?: number | null }[];
  attachments?: WriteAttachmentRef[];
};

export type NewsWriteResult = {
  before: NewsItem | null;
  after: NewsItem | null;
  written: boolean;
  dryRun: boolean;
  request: Record<string, unknown>;
  irreversible: boolean;
  limits: { maxTitle: number | null; maxAnswer: number | null };
  audienceCount: { parents: number | null; mainTeachers: number | null; tutors: number | null };
  validated: false;
};

export type MeetingWishesWrite = {
  wishes?: { id: string; duration?: number | null; wish?: number | null }[];
  unavailability?: number[] | null;
};

export type MeetingWishesResult = {
  before: MeetingSession;
  after: MeetingSession;
  written: boolean;
  dryRun: boolean;
  requests: Record<string, unknown>[];
  validated: false;
};

export type LockerItem = {
  id: string;
  name: string;
  date: number;
  from: string;
  read: boolean;
  category: string;
  files: Attachment[];
};

export type Quiz = {
  id: string;
  name: string;
  subject: string;
  level: string;
  questions: number;
  tags: string[];
  executions: number;
};
