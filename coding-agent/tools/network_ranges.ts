type Range = { start: number; end: number };

function ipv4ToNumber(value: string): number {
  const parts = value.split(".");
  if (parts.length !== 4) throw new Error("沙箱网络范围仅支持 IPv4 CIDR");
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new Error("IPv4 地址格式非法");
    const byte = Number(part);
    if (byte > 255) throw new Error("IPv4 地址格式非法");
    result = result * 256 + byte;
  }
  return result >>> 0;
}

function numberToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

function parseCidr(value: string): Range {
  const [address, prefixText, ...rest] = value.trim().split("/");
  if (rest.length > 0 || address === undefined) throw new Error("IPv4 CIDR 格式非法");
  if (address.includes(":")) throw new Error("沙箱网络范围仅支持 IPv4 CIDR");
  const prefix = prefixText === undefined ? 32 : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error("IPv4 CIDR 前缀必须在 0 到 32 之间");
  const ip = ipv4ToNumber(address);
  const block = 2 ** (32 - prefix);
  const start = Math.floor(ip / block) * block;
  return { start, end: start + block - 1 };
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function rangeToCidrs(range: Range): string[] {
  const cidrs: string[] = [];
  let current = range.start;
  while (current <= range.end) {
    let size = 1;
    while (size < 2 ** 32 && current % (size * 2) === 0) size *= 2;
    while (size > range.end - current + 1) size /= 2;
    const prefix = 32 - Math.log2(size);
    cidrs.push(numberToIpv4(current) + "/" + prefix);
    current += size;
  }
  return cidrs;
}

export function blockedIpv4Cidrs(allowedCidrs: string[]): string[] {
  if (allowedCidrs.length === 0) return ["0.0.0.0/0"];
  const allowed = mergeRanges(allowedCidrs.map(parseCidr));
  const blocked: Range[] = [];
  let cursor = 0;
  for (const range of allowed) {
    if (cursor < range.start) blocked.push({ start: cursor, end: range.start - 1 });
    cursor = range.end + 1;
  }
  if (cursor <= 0xffffffff) blocked.push({ start: cursor, end: 0xffffffff });
  return blocked.flatMap(rangeToCidrs);
}

export function normalizeAllowedIpv4Cidrs(values: string[]): string[] {
  return mergeRanges(values.map(parseCidr)).flatMap(rangeToCidrs);
}
