import { promises as dns } from 'node:dns';

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\.0\.0\.0/,
  /^::1$/i,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i,
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

const BLOCKED_PORTS = new Set([22, 23, 25, 110, 143, 993, 995, 3306, 5432, 6379, 27017]);

export function isPrivateUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    let hostname = normalizeHostname(url.hostname);
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);

    if (hostname.includes('::ffff:')) {
      hostname = normalizeMappedIpv6(hostname);
    }

    if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) return true;
    if (BLOCKED_PORTS.has(port)) return true;
    return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    return false;
  }
}

export async function assertPublicHttpUrl(urlString: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw validationError('URL must be a fully-formed http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw validationError('URL must start with http:// or https://');
  }
  if (isPrivateUrl(parsed.href)) {
    throw permissionError('Access to private/local addresses or sensitive ports is not allowed');
  }
  if (await resolvesToPrivateIp(parsed.href)) {
    throw permissionError('Domain resolves to private address');
  }
}

export function validationError(message: string): Error {
  return Object.assign(new Error(message), { classification: 'validation_error' });
}

export function permissionError(message: string): Error {
  return Object.assign(new Error(message), { classification: 'permission_denied' });
}

export function networkError(message: string): Error {
  return Object.assign(new Error(message), { classification: 'network' });
}

export function cleanText(input: string): string {
  return decodeHtml(input)
    .replace(/\u0000/g, '')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripHtml(html: string): string {
  return cleanText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

export function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanText(match[1] ?? '') : null;
}

export function htmlToMarkdown(html: string): string {
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) => {
    return `[${stripHtml(label)}](${decodeHtml(href)})`;
  });
  return cleanText(out);
}

function normalizeHostname(hostname: string): string {
  let h = hostname.toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h;
}

function normalizeMappedIpv6(hostname: string): string {
  const dotted = hostname.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})/i);
  if (dotted) return dotted[1]!;
  const hex = hostname.match(/::ffff:([0-9a-f]+):([0-9a-f]+)/i);
  if (!hex) return hostname;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

async function resolvesToPrivateIp(urlString: string): Promise<boolean> {
  try {
    const url = new URL(urlString);
    const hostname = normalizeHostname(url.hostname);
    if (/^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i.test(hostname)) return false;
    const checks: string[] = [];
    try {
      checks.push(...(await dns.resolve4(hostname)));
    } catch {
      /* ignore */
    }
    try {
      checks.push(...(await dns.resolve6(hostname)).map((ip) => `[${ip}]`));
    } catch {
      /* ignore */
    }
    return checks.some((ip) => isPrivateUrl(`http://${ip}`));
  } catch {
    return false;
  }
}

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
}
