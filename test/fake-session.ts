import type { SessionHandle } from "pawnote";

/**
 * Session whose Pronote calls are answered by a handler keyed on the function name (no encryption, no
 * compression: the request body carries the payload as an object and the answer is returned as is). The handler
 * receives the "data" member sent and returns the "data" member of the answer; it may throw a Pronote
 * "Erreur" envelope by returning { Erreur: { Titre } }. Every call is recorded in "calls".
 */
export type FakeCall = { name: string; data: Record<string, any> | undefined };

export const fakeSession = (
  handlers: Record<string, (data: Record<string, any> | undefined, call: FakeCall) => Record<string, any>>,
): SessionHandle & { calls: FakeCall[] } => {
  const calls: FakeCall[] = [];
  const session = {
    calls,
    instance: { version: [2026, 2, 8] },
    user: { name: "Prof", resources: [{ id: "109#p", name: "Prof" }] },
    information: { url: "https://demo.example/pronote", id: "s", accountKind: 3, aesKey: "0123456789abcdef", aesIV: "fedcba9876543210", skipCompression: true, skipEncryption: true, order: 0 },
    queue: { push: (fn: () => Promise<unknown>) => fn() },
    fetcher: async (request: { content?: string }) => {
      const body = JSON.parse(String(request.content ?? "{}"));
      const name = String(body.id);
      const data = body.dataSec?.data;
      const call: FakeCall = { name, data };
      calls.push(call);
      const handler = handlers[name];
      if (!handler) return { content: JSON.stringify({ Erreur: { Titre: `Vos droits sont insuffisants pour effectuer cette opération (${name})` } }), headers: {}, status: 200 };
      const answer = handler(data, call);
      if (answer && "Erreur" in answer) return { content: JSON.stringify(answer), headers: {}, status: 200 };
      return { content: JSON.stringify({ dataSec: { data: answer } }), headers: {}, status: 200 };
    },
  };
  return session as unknown as SessionHandle & { calls: FakeCall[] };
};
