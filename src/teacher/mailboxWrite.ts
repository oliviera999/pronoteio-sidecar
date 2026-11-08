/**
 * Mailbox management: SaisieMessage (tab 131) commands acting on the teacher's own copies of the messages
 * (listePossessionsMessages): pourLu { lu }, archive { archiver }, corbeille, restauration
 * (objetrequetesaisiemessage.js, docs/pronote-matrice/7-communication.md). Every action is reversible
 * (read ↔ unread, archive ↔ unarchive, trash ↔ restore); viderCorbeille, purger and the definitive suppression
 * of a received message are never sent. One request carries every selected discussion, as a multi-selection of
 * the client does; the listing is re-read and each discussion must show the expected folder or read state
 * (502 mailbox_not_applied otherwise). Not validated on a real server.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import type { DiscussionFolder, MailboxAction, MailboxResult, MailboxState } from "../normalise.js";
import { listDiscussions, type DiscussionRow } from "./messaging.js";
import { sendWrite } from "./write.js";

/** SaisieMessage JSON of one mailbox action on the possessions of the selected discussions. */
export const mailboxRequest = (action: MailboxAction, possessions: { N: string }[]): Record<string, unknown> => {
  const list = { listePossessionsMessages: possessions.map((item) => ({ N: item.N })) };
  switch (action) {
    case "read":
      return { commande: "pourLu", ...list, lu: true };
    case "unread":
      return { commande: "pourLu", ...list, lu: false };
    case "archive":
      return { commande: "archive", ...list, archiver: true };
    case "unarchive":
      return { commande: "archive", ...list, archiver: false };
    case "trash":
      return { commande: "corbeille", ...list };
    case "restore":
      return { commande: "restauration", ...list };
  }
};

/** Expected state of a discussion after an action (folder and unread flag, null when unchanged). */
export const expectedState = (action: MailboxAction, before: MailboxState): MailboxState => {
  const folder: Record<MailboxAction, DiscussionFolder | null> = { read: null, unread: null, archive: "archive", unarchive: "inbox", trash: "trash", restore: "inbox" };
  return { ...before, folder: folder[action] ?? before.folder, unread: action === "read" ? false : action === "unread" ? true : before.unread };
};

const stateOf = (row: DiscussionRow): MailboxState => ({
  id: row.discussion.id,
  subject: row.discussion.subject,
  folder: row.discussion.folder,
  unread: row.discussion.unread,
});

export const mailbox = async (session: SessionHandle, action: MailboxAction, ids: string[], dryRun: boolean): Promise<MailboxResult> => {
  const listing = await listDiscussions(session);
  if (listing.disabled) throw new HttpError(409, "messaging_disabled");
  const rows = ids.map((id) => {
    const row = listing.rows.find((item) => item.discussion.id === id);
    if (!row) throw new HttpError(404, "discussion_not_found");
    return row;
  });
  const before = rows.map(stateOf);
  const requests = [mailboxRequest(action, rows.flatMap((row) => row.possessions))];
  const planned = before.map((state) => expectedState(action, state));
  if (dryRun) return { before, after: planned, written: false, dryRun: true, requests, validated: false };
  for (const request of requests) await sendWrite(session, "messageSave", request);
  const reread = await listDiscussions(session);
  const after = planned.map((expected) => {
    const row = reread.rows.find((item) => item.discussion.id === expected.id);
    if (!row) throw new HttpError(502, "mailbox_not_applied");
    const state = stateOf(row);
    // "restore" puts the copy back where it was (inbox or archive): any folder but the trash is accepted.
    const folderOk = action === "restore" ? state.folder !== "trash" : state.folder === expected.folder;
    if (!folderOk || state.unread !== expected.unread) throw new HttpError(502, "mailbox_not_applied");
    return state;
  });
  return { before, after, written: true, dryRun: false, requests, validated: false };
};
