// Bot-wall / ban detection.
//
// The goal is not to defeat anti-bot systems but to *notice* them: when a site
// says "you are blocked" we should back off and tell the user loudly instead of
// hammering the host until the block becomes permanent.
//
// Three detectable situations:
//   - rate-limited: HTTP 429
//   - blocked:      HTTP 403 (or an interstitial like Cloudflare's error 1020)
//   - challenge:    a JS/captcha interstitial, often served with HTTP 200 or 503
//
// Markers are split into "strong" (vendor-specific strings that do not occur in
// ordinary content) and "weak" (generic wording such as "captcha" that a normal
// article might legitimately contain). Weak markers only fire on suspiciously
// small documents.

const STRONG_MARKERS = [
  { re: /just a moment/i, vendor: "cloudflare", kind: "challenge" },
  { re: /checking your browser before accessing|checking if the site connection is secure/i, vendor: "cloudflare", kind: "challenge" },
  { re: /enable javascript and cookies to continue/i, vendor: "cloudflare", kind: "challenge" },
  { re: /attention required!?\s*[|\-–]?\s*cloudflare/i, vendor: "cloudflare", kind: "blocked" },
  { re: /cf-chl-|__cf_chl|cf_chl_opt|cf-mitigated/i, vendor: "cloudflare", kind: "challenge" },
  { re: /error\s*1020|access denied.*cloudflare/i, vendor: "cloudflare", kind: "blocked" },
  { re: /request unsuccessful\.?\s*incapsula/i, vendor: "imperva", kind: "blocked" },
  { re: /_incap_ses|incapsula incident id|incident id:\s*\d/i, vendor: "imperva", kind: "blocked" },
  { re: /pardon our interruption/i, vendor: "imperva", kind: "blocked" },
  { re: /reference\s*#\s*\d+\.[0-9a-f]{6,}/i, vendor: "akamai", kind: "blocked" },
  { re: /akamai bot manager|_abck\b/i, vendor: "akamai", kind: "challenge" },
  { re: /access denied - sucuri|sucuri website firewall|cloudproxy/i, vendor: "sucuri", kind: "blocked" },
  { re: /datadome/i, vendor: "datadome", kind: "challenge" },
  { re: /px-captcha|perimeterx/i, vendor: "perimeterx", kind: "challenge" },
  { re: /distil_r_captcha|distil captcha/i, vendor: "distil", kind: "challenge" },
];

// Generic wording: only meaningful when the response is small enough to be an
// interstitial rather than a real page.
const WEAK_MARKERS = [
  { re: /g-recaptcha|hcaptcha|recaptcha/i, vendor: "captcha", kind: "challenge" },
  { re: /are you a robot|verify you are human|are you a human/i, vendor: "captcha", kind: "challenge" },
  { re: /unusual traffic from your computer network|automated queries/i, vendor: "captcha", kind: "blocked" },
  { re: /ddos protection by|protected by cloudflare/i, vendor: "cloudflare", kind: "challenge" },
];

// Response headers that name the vendor even when the body carries no marker.
// These are matched against the flattened "key: value" header text.
const HEADER_MARKERS = [
  { re: /^server:\s*cloudflare\b/mi, vendor: "cloudflare" },
  { re: /^cf-ray:/mi, vendor: "cloudflare" },
  { re: /^cf-mitigated:/mi, vendor: "cloudflare" },
  { re: /^server:\s*akamaighost\b/mi, vendor: "akamai" },
  { re: /^x-akamai-/mi, vendor: "akamai" },
  { re: /^x-sucuri-(id|block|cache):/mi, vendor: "sucuri" },
  { re: /^x-datadome/mi, vendor: "datadome" },
  { re: /^x-iinfo:|^x-cdn:\s*incapsula/mi, vendor: "imperva" },
  { re: /^server:.*incapsula/mi, vendor: "imperva" },
  { re: /^server:\s*Zonealarm|^server:\s*wts\/waf/mi, vendor: "waf" },
];

const WEAK_MAX_LENGTH = 15000;

function headersToText(headers) {
  if (!headers) return "";
  if (typeof headers.forEach === "function" && typeof headers.get === "function") {
    const parts = [];
    headers.forEach((v, k) => parts.push(`${k}: ${v}`));
    return parts.join("\n");
  }
  if (typeof headers === "object") {
    return Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  }
  return "";
}

export function detectVendor(text) {
  const hay = String(text || "");
  for (const m of STRONG_MARKERS) if (m.re.test(hay)) return m.vendor;
  for (const m of HEADER_MARKERS) if (m.re.test(hay)) return m.vendor;
  return null;
}

// Looks for a bot-wall interstitial in a response body. Returns null when the
// body looks like ordinary content.
export function detectInterstitial(body) {
  const text = String(body || "");
  if (!text) return null;

  for (const m of STRONG_MARKERS) {
    if (m.re.test(text)) return { kind: m.kind, vendor: m.vendor, reason: `${m.vendor} ${m.kind}` };
  }
  if (text.length <= WEAK_MAX_LENGTH) {
    for (const m of WEAK_MARKERS) {
      if (m.re.test(text)) return { kind: m.kind, vendor: m.vendor, reason: `${m.vendor} ${m.kind}` };
    }
  }
  return null;
}

// Classifies an HTTP response. Returns null for anything that is not a ban (a
// plain 5xx is a server problem, 401 is authentication — neither is a block).
export function detectBan({ status, headers, body } = {}) {
  const headerText = headersToText(headers);
  const vendor = detectVendor(`${headerText}\n${String(body || "").slice(0, 8000)}`);

  if (status === 401 || status === 407) return null;

  if (status === 429) {
    return {
      kind: "rate-limited",
      vendor,
      status,
      reason: vendor ? `rate limited by ${vendor} (HTTP 429)` : "rate limited (HTTP 429)",
    };
  }

  if (status === 403) {
    return {
      kind: "blocked",
      vendor,
      status,
      reason: vendor ? `blocked by ${vendor} (HTTP 403)` : "request blocked (HTTP 403)",
    };
  }

  if (status === 503) {
    const interstitial = detectInterstitial(body);
    if (interstitial) return { ...interstitial, status };
    if (vendor) {
      return { kind: "challenge", vendor, status, reason: `bot challenge from ${vendor} (HTTP 503)` };
    }
    return null; // plain overloaded server, not a block
  }

  if (status >= 500) return null;

  // 2xx carrying an interstitial instead of content.
  return detectInterstitial(body);
}

export function describeBan(ban) {
  if (!ban) return "";
  const vendor = ban.vendor ? ` [${ban.vendor}]` : "";
  const status = ban.status ? ` HTTP ${ban.status}` : "";
  return `${ban.reason || ban.kind}${vendor}${status}`;
}
