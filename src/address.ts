/**
 * Addresses allowed to call the sidecar (P11, 0.9.0): PRONOTEIO_ALLOWED_IPS lists the addresses of the Moodle server
 * (exact IPv4 or IPv6, or IPv4 CIDR "203.0.113.0/24"); empty: any address (the signature still applies). The public
 * routes (/health/public, /errors, unsigned /health) stay open. Behind the web server (Passenger), the client address
 * is read from X-Forwarded-For (PRONOTEIO_TRUST_PROXY, default true under Passenger only).
 */
const ipv4 = (value: string): number | null => {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    result = result * 256 + Number(part);
  }
  return result;
};

/** "::ffff:203.0.113.5" → "203.0.113.5". */
const plain = (address: string): string => address.trim().replace(/^::ffff:/i, "").toLowerCase();

export const addressAllowed = (address: string | undefined, allowed: string[]): boolean => {
  if (allowed.length === 0) return true;
  if (!address) return false;
  const ip = plain(address);
  for (const rule of allowed.map(plain)) {
    if (!rule.includes("/")) {
      if (rule === ip) return true;
      continue;
    }
    const [network, bits] = rule.split("/");
    const base = ipv4(network);
    const value = ipv4(ip);
    const size = Number(bits);
    if (base === null || value === null || !Number.isInteger(size) || size < 0 || size > 32) continue;
    const mask = size === 0 ? 0 : (0xffffffff << (32 - size)) >>> 0;
    if (((base & mask) >>> 0) === ((value & mask) >>> 0)) return true;
  }
  return false;
};
