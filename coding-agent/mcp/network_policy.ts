import dns from "node:dns/promises";
import net from "node:net";

const BLOCKED_IPV4 = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[0-1])\./];

export type McpNetworkPolicyOptions = {
  maxRedirects?: number;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
  maxHeaderBytes?: number;
  maxConcurrentRequests?: number;
  maxRetries?: number;
  retryDelayMs?: number;
};

function isBlockedAddress(address: string): boolean {
  if (net.isIPv4(address)) return BLOCKED_IPV4.some((pattern) => pattern.test(address));
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  return true;
}

async function validateAddress(url: URL): Promise<void> {
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some((item) => isBlockedAddress(item.address))) throw new Error("MCP 目标解析到了禁止访问的本地或私有地址");
}

export async function validateMcpOrigin(origin: string, allowedOrigins: string[]): Promise<void> {
  const url = new URL(origin);
  if (url.protocol !== "https:") throw new Error("MCP 远程连接只允许 HTTPS");
  if (!allowedOrigins.includes(url.origin)) throw new Error(`MCP 目标 Origin 未获允许: ${url.origin}`);
  await validateAddress(url);
}

function combineSignals(signal: AbortSignal | null | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("MCP 网络请求超时")), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } };
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    let released = false;
    return () => { if (!released) { released = true; this.active -= 1; this.waiters.shift()?.(); } };
  }
}

function retryableStatus(status: number): boolean { return status === 408 || status === 429 || status >= 500; }

export class McpNetworkPolicy {
  private readonly options: Required<McpNetworkPolicyOptions>;
  private readonly semaphore: Semaphore;
  private readonly allowedOrigins: string[];

  constructor(allowedOrigins: string[], options: McpNetworkPolicyOptions = {}) {
    this.allowedOrigins = allowedOrigins;
    this.options = {
      maxRedirects: options.maxRedirects ?? 2,
      totalTimeoutMs: options.totalTimeoutMs ?? 60_000,
      maxResponseBytes: options.maxResponseBytes ?? 4 * 1024 * 1024,
      maxHeaderBytes: options.maxHeaderBytes ?? 64 * 1024,
      maxConcurrentRequests: options.maxConcurrentRequests ?? 4,
      maxRetries: options.maxRetries ?? 2,
      retryDelayMs: options.retryDelayMs ?? 150,
    };
    this.semaphore = new Semaphore(this.options.maxConcurrentRequests);
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const release = await this.semaphore.acquire();
    try { return await this.request(input, init, 0); } finally { release(); }
  };

  private async request(input: RequestInfo | URL, init: RequestInit | undefined, redirectCount: number): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== "https:") throw new Error("MCP 网络请求只允许 HTTPS");
    if (!this.allowedOrigins.includes(url.origin)) throw new Error(`MCP 网络目标未获允许: ${url.origin}`);
    await validateAddress(url);
    const method = request.method.toUpperCase();
    const canRetry = method === "GET" || method === "HEAD";
    const attempts = canRetry ? this.options.maxRetries : 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      const timeout = combineSignals(request.signal, this.options.totalTimeoutMs);
      try {
        const response = await fetch(request.clone(), { redirect: "manual", signal: timeout.signal });
        timeout.dispose();
        const headerBytes = [...response.headers].reduce((total, [name, value]) => total + name.length + value.length, 0);
        if (headerBytes > this.options.maxHeaderBytes) throw new Error("MCP 响应 Header 超过大小限制");
        if (response.headers.get("content-length") !== null && Number(response.headers.get("content-length")) > this.options.maxResponseBytes) throw new Error("MCP 响应超过大小限制");
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (location === null) throw new Error("MCP 重定向缺少 Location");
          if (redirectCount >= this.options.maxRedirects) throw new Error("MCP 重定向次数超过限制");
          const redirected = new URL(location, url);
          if (!this.allowedOrigins.includes(redirected.origin)) throw new Error("MCP 重定向目标未获允许");
          return this.request(redirected, init, redirectCount + 1);
        }
        if (canRetry && retryableStatus(response.status) && attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs * 2 ** attempt));
          continue;
        }
        const body = await response.arrayBuffer();
        if (body.byteLength > this.options.maxResponseBytes) throw new Error("MCP 响应超过大小限制");
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) {
        timeout.dispose();
        lastError = error;
        if (attempt >= attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("MCP 网络请求失败");
  };
}
