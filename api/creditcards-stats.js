// Vercel serverless function: live-ish market stats for /creditcards, proxying
// OpenSea's v2 collection endpoints for Jack Butcher's Credits.
//
//   GET → { floorEth, floorUsd, supply, owners, updatedAt }
//
// Why a proxy and not a page-side fetch: OpenSea returns 401 to any request
// carrying a browser Origin header, and the site's CSP only allows same-origin
// connect-src anyway. Server-to-server the same endpoints answer keyless
// (verified 24 Sep 2026); OPENSEA_API_KEY is honoured if that ever changes,
// with no code change needed on the page.
//
// Why CDN caching, unlike api/copy-count.js: the brief is "live price, about
// every 30 minutes", which is exactly one upstream fetch per half hour under
// s-maxage=1800. Nobody needs a fresher floor, OpenSea never sees a traffic
// spike from us, and stale-while-revalidate keeps the page instant while the
// edge refreshes behind it. The page bakes fallback numbers at build time, so
// a failure here changes nothing visible.

const ALLOWED_HOSTS = ["mooch.agency", "localhost", "127.0.0.1"];

const RATE_PER_MIN = 60;
const RATE_PER_DAY = 2000;

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { min: [], day: [] };
  rec.min = rec.min.filter((t) => now - t < 60_000);
  rec.day = rec.day.filter((t) => now - t < 86_400_000);
  if (rec.min.length >= RATE_PER_MIN || rec.day.length >= RATE_PER_DAY) {
    hits.set(ip, rec);
    return true;
  }
  rec.min.push(now);
  rec.day.push(now);
  hits.set(ip, rec);
  return false;
}

// Matches api/copy-count.js: drop records with nothing left in a live window,
// so a warm instance doesn't hold a key for every IP that ever visited.
function pruneDeadHits() {
  const now = Date.now();
  for (const [key, rec] of hits) {
    const liveMin = rec.min.some((t) => now - t < 60_000);
    const liveDay = rec.day.some((t) => now - t < 86_400_000);
    if (!liveMin && !liveDay) hits.delete(key);
  }
}

function isAllowedHost(host) {
  return (
    ALLOWED_HOSTS.includes(host) ||
    host.endsWith(".mooch.agency") ||
    host === "mooch-agency.vercel.app" ||
    (host.startsWith("mooch-agency-") && host.endsWith(".vercel.app"))
  );
}

function originOk(req) {
  const src = req.headers.origin || req.headers.referer || "";
  // Read-only endpoint: a privacy browser stripping both headers isn't worth
  // blocking, the rate caps are the backstop. Same stance as copy-count GET.
  if (!src) return true;
  let host;
  try { host = new URL(src).hostname; } catch { return false; }
  return isAllowedHost(host);
}

async function opensea(path) {
  const headers = { accept: "application/json" };
  if (process.env.OPENSEA_API_KEY) headers["x-api-key"] = process.env.OPENSEA_API_KEY;
  const res = await fetch(`https://api.opensea.io/api/v2/${path}`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`OpenSea ${res.status} on ${path}`);
  return res.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end("Method not allowed");
  }
  if (!originOk(req)) {
    res.statusCode = 403;
    return res.end("Forbidden");
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  const limited = rateLimited(ip);
  pruneDeadHits();
  if (limited) {
    res.statusCode = 429;
    return res.end("Slow down a moment, then try again.");
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const [col, stats] = await Promise.all([
      opensea("collections/credits"),
      opensea("collections/credits/stats"),
    ]);

    const floorEth = stats.total && stats.total.floor_price;
    const supply = col.total_supply;
    const owners = stats.total && stats.total.num_owners;
    const usdPerEth = Number(
      col.pricing_currencies &&
      col.pricing_currencies.listing_currency &&
      col.pricing_currencies.listing_currency.usd_price,
    );
    // A malformed payload must not get cached for half an hour as zeros:
    // treat it the same as OpenSea being down and let the page keep its
    // baked numbers.
    if (typeof floorEth !== "number" || typeof supply !== "number" || typeof owners !== "number") {
      throw new Error("OpenSea payload missing a field");
    }

    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
    return res.end(
      JSON.stringify({
        floorEth,
        floorUsd: Number.isFinite(usdPerEth) ? Math.round(floorEth * usdPerEth) : null,
        supply,
        owners,
        updatedAt: new Date().toISOString(),
      }),
    );
  } catch (e) {
    console.error("creditcards-stats failed", e && e.message);
    res.statusCode = 502;
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify({ error: "Stats unavailable." }));
  }
};
