import assert from "node:assert/strict";
import test from "node:test";

import { blockedIpv4Cidrs, normalizeAllowedIpv4Cidrs } from "../../tools/network_ranges.ts";

test("网络 allowlist 规范化 IPv4 CIDR", () => {
  assert.deepEqual(normalizeAllowedIpv4Cidrs(["10.0.0.1/24", "10.0.1.0/24"]), ["10.0.0.0/23"]);
});

test("网络阻断补集不包含允许地址", () => {
  const blocked = blockedIpv4Cidrs(["127.0.0.1/32"]);
  assert.equal(blocked.includes("127.0.0.1/32"), false);
  assert.equal(blocked.length > 1, true);
});

test("网络范围拒绝 IPv6 和非法前缀", () => {
  assert.throws(() => normalizeAllowedIpv4Cidrs(["::1/128"]), /仅支持 IPv4/);
  assert.throws(() => normalizeAllowedIpv4Cidrs(["10.0.0.1/33"]), /前缀/);
});
