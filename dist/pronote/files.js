import { cipherKeys, encrypt } from "./request.js";
export const downloadUrl = (session, file) => {
    const { key, iv } = cipherKeys(session);
    const token = encrypt(JSON.stringify({ N: file.N, Actif: true }), key, iv);
    return `${session.information.url}/FichiersExternes/${token}/${encodeURIComponent(String(file.L ?? ""))}?Session=${session.information.id}`;
};
//# sourceMappingURL=files.js.map