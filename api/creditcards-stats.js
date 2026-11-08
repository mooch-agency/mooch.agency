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

const { guard, makeLimiter, refererPolicy } = require("./_guard.js");

const ALLOWED_HOSTS = ["mooch.agency", "localhost", "127.0.0.1"];

// Admission goes through api/_guard.js, the same door as every other
// function here. CREDITCARDS_STATS_KILL=1 pauses the endpoint, same
// convention as the others.
const limiter = makeLimiter({ perMin: 60, perDay: 2000 });

const ADMIT = {
  methods: ["GET"],
  killEnv: "CREDITCARDS_STATS_KILL",
  // Read-only endpoint: a privacy browser stripping both headers isn't worth
  // blocking, the rate caps are the backstop. Same stance as copy-count GET.
  // Only this project's own preview names count as trusted, not all of
  // vercel.app.
  origin: refererPolicy({
    hosts: ALLOWED_HOSTS,
    suffixes: [".mooch.agency"],
    projectPreviews: true,
  }),
  limiter,
  reply: {
    method: (res) => { res.statusCode = 405; res.end("Method not allowed"); },
    kill: (res) => { res.statusCode = 503; res.end("Stats are paused. Back shortly."); },
    origin: (res) => { res.statusCode = 403; res.end("Forbidden"); },
    rate: (res) => { res.statusCode = 429; res.end("Slow down a moment, then try again."); },
  },
};

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
  const admit = guard(req, res, ADMIT);
  if (!admit) return;
  if (admit.rateLimited) return admit.replyRate();
  // Nothing to validate on a bare GET: the request is admitted, so it counts.
  admit.commitRate();

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
