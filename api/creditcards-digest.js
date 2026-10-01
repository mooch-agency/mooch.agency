// Vercel cron target: the Credit Cards perk alert.
//
//   GET, Authorization: Bearer $CRON_SECRET  ->  { ok, ... } run summary
//
// Schedule: "0 7 * * *" in vercel.json, 07:00 UTC. The page and the email
// deliberately promise no time of day (dropped 1 Oct 2026): perks reach
// perks[] when a human has checked them, so the cron is a floor, not a clock.
//
// This file is only the transport: auth, and wiring the real Stripe, Resend
// and Blob calls into runDigest (api/_creditcards-digest.js), which holds the
// rules and is unit-tested without any of them. Ported from
// monitoring-the-situation (api/daily.ts, src/notify.ts, src/storage.ts).
//
//   Feed        data/creditcards.json perks[], bundled with the function
//               (includeFiles in vercel.json), each decorated with its status
//               for today by scripts/creditcards-perks.mjs (imported, so the
//               open/ended rule has one home). Perks are human-written and the
//               push redeploys, so a run reads whatever was added by then.
//   Recipients  Stripe subscriptions on STRIPE_PRICE_ID, status active or
//               trialing, customer email expanded. Stripe is the list.
//   Send        Resend REST, one email per recipient, Idempotency-Key from
//               the recipient plus the sorted item ids.
//   State       the ids already sent, as one private JSON blob in Vercel Blob
//               (a local file when BLOB_READ_WRITE_TOKEN is unset, for dev).
//
// No run lock, unlike MTS's daily.ts. MTS needed one because two runs would
// each spend X credits and race on several state files. Here an overlapping
// manual run computes the same items for the same people, so Resend drops
// the duplicate sends by idempotency key, and the state write is a union
// (mergeState), so neither run can erase the other's ids.
//
// Env (Vercel `mooch.agency` project, none committed):
//   CRON_SECRET            Vercel sends it as the bearer token; anything else 401s
//   STRIPE_SECRET_KEY      reads subscriptions, signs the portal links
//   STRIPE_PRICE_ID        only subscriptions on this price get the digest
//   RESEND_API_KEY         sends as mb@mooch.agency (domain verified for MTS)
//   BLOB_READ_WRITE_TOKEN  the project's Blob store (a private store)

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { timingSafeEqual } = require("node:crypto");
const { getStripe, normaliseEmail, portalUrl } = require("./_creditcards");
const { runDigest } = require("./_creditcards-digest");

const FEED_PATH = path.join(__dirname, "..", "data", "creditcards.json");
// perks-state, not state: the first version tracked project ids and was
// never deployed. A fresh name means no run can ever read those as perks.
const STATE_PATH = "creditcards-digest/perks-state.json";

const RESEND_URL = "https://api.resend.com/emails";
const FROM_ADDRESS = "Credit Cards <mb@mooch.agency>";
// "Reply and a human answers" has to be true, so replies go to the public
// inbox Tahi and Natalie read, not the sending address.
const REPLY_TO = "hey@mooch.agency";
// Resend's default limit is a couple of requests a second. Sends go one at a
// time with this gap; at ~0.6s each, maxDuration 300 covers ~450 subscribers.
// Past that, move to Resend's /emails/batch (100 per call).
const SEND_GAP_MS = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Auth ----------------------------------------------------------------------------

/** Constant-time bearer check, as MTS's api/daily.ts. timingSafeEqual throws
 * on unequal lengths, so length goes first; that leaks only the length of
 * the real secret, which isn't the secret. */
function isAuthorized(req, secret) {
  const header = String(req.headers.authorization || "");
  if (!secret || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// --- State: Vercel Blob over REST, or a local file -------------------------------------
//
// Raw REST rather than @vercel/blob so `stripe` stays this feature's only new
// dependency. These are the same two calls the SDK makes (v2.8, API version
// 12): PUT to the Blob API to write, GET on the store's private host to read.
// If Vercel changes them, the read-back check in saveState fails the run
// loudly rather than letting it reseed forever.

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || "";
}
// Read-write tokens look like vercel_blob_rw_<storeId>_<secret>.
function blobStoreId(token) {
  return token.split("_")[3] || "";
}

async function readStateText() {
  const token = blobToken();
  if (!token) {
    // On Vercel the filesystem is thrown away after each invocation, so a
    // file there would look empty every morning and reseed instead of send.
    if (process.env.VERCEL) throw new Error("BLOB_READ_WRITE_TOKEN is not set");
    try {
      return await fs.readFile(localStatePath(), "utf8");
    } catch {
      return undefined;
    }
  }
  const url = `https://${blobStoreId(token)}.private.blob.vercel-storage.com/${STATE_PATH}?cache=0`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Blob read failed: ${res.status}`);
  return res.text();
}

async function writeStateText(text) {
  const token = blobToken();
  if (!token) {
    if (process.env.VERCEL) throw new Error("BLOB_READ_WRITE_TOKEN is not set");
    await fs.writeFile(localStatePath(), text);
    return;
  }
  const res = await fetch(`https://vercel.com/api/blob/?${new URLSearchParams({ pathname: STATE_PATH })}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "x-api-version": "12",
      "x-vercel-blob-store-id": blobStoreId(token),
      "x-vercel-blob-access": "private",
      "x-add-random-suffix": "0",
      "x-allow-overwrite": "1",
      "x-content-type": "application/json",
    },
    body: text,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Blob write failed: ${res.status}`);
}

function localStatePath() {
  return process.env.CREDITCARDS_STATE_FILE || path.join(os.tmpdir(), "creditcards-digest-state.json");
}

/** The stored state, or null when nothing has ever been stored (first run).
 * A read error throws instead: treating it as "no state" would reseed and
 * silently swallow that day's new perks. Corrupt JSON also throws, for
 * the same reason. */
async function loadState() {
  const raw = await readStateText();
  if (raw === undefined) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.sentIds)) throw new Error("Digest state is not { sentIds: [] }");
  return parsed;
}

/** Merge-on-write, then read back to prove it landed. */
async function saveState(merge) {
  const next = merge(await loadState());
  await writeStateText(JSON.stringify(next, null, 2));
  const check = await loadState();
  if (!check || check.sentIds.length < next.sentIds.length) throw new Error("Digest state did not persist");
}

// --- Feed -----------------------------------------------------------------------------

/** perks[], each with `status` for today (UTC, as the page's bake works it
 * out) and `typeLabel` for the email. A literal import path, so Vercel's file
 * tracer bundles the module with the function. */
async function loadPerks(now = new Date()) {
  const { perkStatus, PERK_TYPES, todayUtc } = await import("../scripts/creditcards-perks.mjs");
  const labels = Object.fromEntries(PERK_TYPES.map((t) => [t.slug, t.label]));
  const today = todayUtc(now);
  const data = JSON.parse(await fs.readFile(FEED_PATH, "utf8"));
  return (Array.isArray(data.perks) ? data.perks : []).map((p) => ({ ...p, status: perkStatus(p, today), typeLabel: labels[p.type] || "" }));
}

// --- Recipients -----------------------------------------------------------------------

/** Every active or trialing subscription on our price, one entry per email.
 * Filtering by price matters: the Stripe account may bill for other things,
 * and their customers must never get this email. */
async function listRecipients(stripe, price) {
  const byEmail = new Map();
  for await (const sub of stripe.subscriptions.list({ price, limit: 100, expand: ["data.customer"] })) {
    if (sub.status !== "active" && sub.status !== "trialing") continue;
    const c = sub.customer;
    if (!c || typeof c !== "object" || c.deleted || !c.email) continue;
    const email = normaliseEmail(c.email);
    if (email && !byEmail.has(email.toLowerCase())) byEmail.set(email.toLowerCase(), { email, customerId: c.id });
  }
  return [...byEmail.values()];
}

// --- Send -----------------------------------------------------------------------------

/** One Resend send. Never throws. One retry on a network error, 5xx or 429;
 * the Idempotency-Key makes that retry safe if the first attempt actually
 * landed and only the response was lost. The key only ever goes in the
 * Authorization header and is never echoed. */
function makeSender(apiKey) {
  let last = 0;
  return async function send(msg) {
    if (!apiKey) return { ok: false, error: "RESEND_API_KEY is not set" };
    const wait = last + SEND_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();

    const body = JSON.stringify({
      from: FROM_ADDRESS,
      to: [msg.to],
      reply_to: REPLY_TO,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      headers: { "List-Unsubscribe": `<${msg.manageUrl}>` },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(RESEND_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "Idempotency-Key": msg.idempotencyKey,
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const json = await res.json().catch(() => ({}));
          return { ok: true, id: json.id };
        }
        // 409 means Resend already has a send under this key: either the
        // payload differs (a by-hand re-run after UK midnight, when the date
        // in the email has moved on) or the first request is still in flight
        // (Vercel delivering the cron twice). Either way this person has, or
        // is getting, this digest. Counting it as a failure would hold state
        // and turn the documented re-run into one that can never succeed.
        if (res.status === 409) return { ok: true, deduped: true };
        if (attempt === 0 && (res.status >= 500 || res.status === 429)) {
          await sleep(1500);
          continue;
        }
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        // Scrub addresses: Resend validation errors can quote the recipient,
        // and this string ends up in the cron log.
        return {
          ok: false,
          // 4xx is about this send, so runDigest may still advance state.
          // 5xx is the pipe: it withholds. So is a 429 that survived the
          // retry: Resend's quota is shared across every Mooch sender, so a
          // 429 mid-run means the pipe is shut for everyone still to come,
          // not that this address is bad. A 4xx on EVERY recipient (bad key,
          // unverified domain) still withholds, because runDigest needs at
          // least one success.
          perRecipient: res.status >= 400 && res.status < 500 && res.status !== 429,
          error: `Resend responded ${res.status}${detail ? `: ${detail.replace(/[^\s"'<>@]+@[^\s"'<>]+/g, "[email]")}` : ""}`,
        };
      } catch (err) {
        if (attempt === 0) {
          await sleep(1500);
          continue;
        }
        return { ok: false, error: err && err.name === "TimeoutError" ? "Resend timed out" : "Resend unreachable" };
      }
    }
    return { ok: false, error: "Resend failed" };
  };
}

// --- Handler ----------------------------------------------------------------------------

module.exports = async (req, res) => {
  if (!isAuthorized(req, process.env.CRON_SECRET)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const startedAt = Date.now();
  try {
    const stripe = getStripe();
    const price = process.env.STRIPE_PRICE_ID;
    const secret = process.env.STRIPE_SECRET_KEY;

    const result = await runDigest({
      now: new Date(startedAt),
      loadPerks: () => loadPerks(new Date(startedAt)),
      loadState,
      saveState,
      listRecipients: async () => {
        if (!stripe || !price) throw new Error("STRIPE_SECRET_KEY or STRIPE_PRICE_ID is not set");
        return listRecipients(stripe, price);
      },
      manageUrlFor: (r) => portalUrl(r.customerId, secret),
      send: makeSender(process.env.RESEND_API_KEY),
    });

    const summary = { ...result, errors: (result.errors || []).map(scrubSecrets), durationMs: Date.now() - startedAt };
    if (!result.ok) console.error("creditcards-digest: run failed", JSON.stringify(summary));
    else if (result.failedRecipients) console.error("creditcards-digest: some recipients failed (state advanced)", JSON.stringify(summary));
    return res.status(result.ok ? 200 : 500).json(summary);
  } catch (e) {
    const error = scrubSecrets((e && e.message) || "failed");
    console.error("creditcards-digest: run threw", error);
    return res.status(500).json({ ok: false, error, durationMs: Date.now() - startedAt });
  }
};

// Stripe's auth errors quote a masked fragment of the key they were given
// ("Invalid API Key provided: sk_test_****abcd"). Strip anything key-shaped
// before a message reaches a log or a response.
function scrubSecrets(s) {
  return String(s).replace(/\b(?:sk|rk|pk|whsec|re)_[A-Za-z0-9_*]+/g, "[key]").replace(/vercel_blob_rw_[A-Za-z0-9_]+/g, "[key]");
}

// Exported for tests only.
module.exports.__testables = { isAuthorized, blobStoreId, scrubSecrets, makeSender, loadPerks };
