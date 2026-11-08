/**
 * Notification centre (CentraleNotifications, tab 7: the home tab; refused without a tab), read only, validated on
 * the demo server (capture 0024): called WITHOUT data, answers liste[{ L, ident, liste[{ type, action, date, id,
 * titre { _T: 21 }, message { _T: 21 }, modalites, compteur }] }]. Titles and messages are HTML turned into plain
 * text. The write form ({ estSaisie: true, idNotif, onBtnClick | onNotifClick }) is never sent.
 */
import type { SessionHandle } from "pawnote";
import { listOf, parsePronoteDate } from "../pronote/encoding.js";
import { plainText, seconds, type Notification } from "../normalise.js";
import { isAccessDenied } from "./competencies.js";
import { callFunction, isTabClosed } from "./functions.js";

const html = (value: unknown): string => {
  const raw = value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;
  return typeof raw === "string" ? raw : "";
};

const integer = (value: unknown): number | null => {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) ? number : null;
};

export const notificationsFromAnswer = (data: Record<string, any>): Notification[] =>
  listOf<any>(data?.liste).flatMap((group) => {
    const label = String(group?.L ?? "").trim();
    return listOf<any>(group?.liste).map((item, index) => {
      const date = parsePronoteDate(item?.date?.V ?? item?.date);
      const title = plainText(html(item?.titre), 500);
      return {
        id: item?.id !== undefined && item?.id !== null && String(item.id) !== "" ? String(item.id) : `${label}|${index + 1}|${title}`,
        group: label,
        kind: String(item?.type ?? ""),
        action: String(item?.action ?? ""),
        date: date ? seconds(date) : 0,
        title,
        text: plainText(html(item?.message), 2000),
        count: integer(item?.compteur),
      };
    });
  });

export const notifications = async (session: SessionHandle): Promise<{ available: boolean; reason: string; items: Notification[] }> => {
  if (isTabClosed(session, "notifications")) return { available: false, reason: "tab_closed", items: [] };
  let data: Record<string, any>;
  try {
    data = await callFunction(session, "notifications");
  } catch (error) {
    if (isAccessDenied(error)) return { available: false, reason: "access_denied", items: [] };
    throw error;
  }
  if (!data || Object.keys(data).length === 0) return { available: false, reason: "access_denied", items: [] };
  return { available: true, reason: "", items: notificationsFromAnswer(data) };
};
