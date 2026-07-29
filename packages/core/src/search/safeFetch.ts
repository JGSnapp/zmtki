import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { URL } from 'node:url';

/**
 * Outbound HTTP for agent-supplied URLs. Ported from the odysseus fetcher,
 * which already solved the parts that are easy to get wrong: DNS rebinding,
 * private-range access and dishonest size caps.
 */

export const WEB_FETCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const SOFT_MAX_BYTES = 2 * 1024 * 1024;
export const HARD_MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface SafeFetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Loopback is allowed for local model servers and the agent's own dev server. */
  allowPrivate?: boolean;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  contentType: string;
}

export function isBlockedAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number) as [number, number, number, number];
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true;
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('ff')) return true; // multicast
    // IPv4-mapped addresses must be judged by their embedded IPv4.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isBlockedAddress(mapped[1]);
    return false;
  }
  return true;
}

async function resolvePublicAddress(
  hostname: string,
  allowPrivate: boolean
): Promise<{ address: string; family: number }> {
  if (net.isIP(hostname)) {
    if (!allowPrivate && isBlockedAddress(hostname)) {
      throw new Error(`адрес заблокирован: ${hostname}`);
    }
    return { address: hostname, family: net.isIP(hostname) };
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  for (const record of records) {
    if (allowPrivate || !isBlockedAddress(record.address)) {
      return { address: record.address, family: record.family };
    }
  }
  throw new Error(`хост резолвится только в приватные адреса: ${hostname}`);
}

function requestOnce(
  target: URL,
  address: string,
  options: SafeFetchOptions,
  maxBytes: number
): Promise<{ result: SafeFetchResult; redirectTo?: string }> {
  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        // Connect to the IP we validated, not the hostname. Re-resolving here
        // is what would let DNS rebinding slip past the check above.
        host: address,
        servername: isHttps && !net.isIP(target.hostname) ? target.hostname : undefined,
        port: target.port ? Number(target.port) : isHttps ? 443 : 80,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? 'GET',
        headers: {
          Host: target.host,
          'User-Agent': WEB_FETCH_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          // Compression would make the byte cap a lie, since the cap should
          // bound what we actually decode into memory.
          'Accept-Encoding': 'identity',
          ...(options.body ? { 'Content-Length': String(Buffer.byteLength(options.body)) } : {}),
          ...options.headers
        },
        timeout: options.timeoutMs ?? 20_000
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          resolve({
            result: {
              url: target.toString(),
              status,
              headers: flattenHeaders(res.headers),
              body: Buffer.alloc(0),
              truncated: false,
              contentType: String(res.headers['content-type'] ?? '')
            },
            redirectTo: new URL(location, target).toString()
          });
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        let truncated = false;

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (received - maxBytes))));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            result: {
              url: target.toString(),
              status,
              headers: flattenHeaders(res.headers),
              body: Buffer.concat(chunks),
              truncated,
              contentType: String(res.headers['content-type'] ?? '')
            }
          })
        );
        res.on('close', () => {
          if (truncated) {
            resolve({
              result: {
                url: target.toString(),
                status,
                headers: flattenHeaders(res.headers),
                body: Buffer.concat(chunks),
                truncated: true,
                contentType: String(res.headers['content-type'] ?? '')
              }
            });
          }
        });
        res.on('error', reject);
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('таймаут запроса'));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = Math.min(options.maxBytes ?? SOFT_MAX_BYTES, HARD_MAX_BYTES);
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = new URL(current);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`разрешены только http и https, получено: ${target.protocol}`);
    }
    // Every hop is validated, so an open redirect cannot walk us into the
    // private range after the first check passed.
    const { address } = await resolvePublicAddress(target.hostname, options.allowPrivate ?? false);
    const { result, redirectTo } = await requestOnce(target, address, options, maxBytes);
    if (!redirectTo) return result;
    current = redirectTo;
  }

  throw new Error(`слишком много редиректов: ${rawUrl}`);
}

export async function safeFetchText(rawUrl: string, options: SafeFetchOptions = {}): Promise<string> {
  const result = await safeFetch(rawUrl, options);
  if (result.status >= 400) {
    throw new Error(`HTTP ${result.status} для ${rawUrl}`);
  }
  return result.body.toString('utf8');
}

export async function safeFetchJson<T>(rawUrl: string, options: SafeFetchOptions = {}): Promise<T> {
  const text = await safeFetchText(rawUrl, options);
  return JSON.parse(text) as T;
}
