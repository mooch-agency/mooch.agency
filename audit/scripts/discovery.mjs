// Page DISCOVERY primitives: which pages exist, and which of them belong to the
// site we were asked to audit.
//
// Extracted from run-pipeline.mjs for the same reason page-fallback.mjs was: so
// the host-matching rules can be unit-tested without a browser or the network.
//
// The rule that matters: a site is identified by its REGISTRABLE HOST, not by
// the exact origin of the URL a lead typed into the form. sambleinnovations.com
// 307s to www.sambleinnovations.com (29 Jul, aud_ms5wzapuwu93mo). Comparing the
// rendered anchors against the submitted apex origin binned every link on the
// page, the audit collapsed to the homepage alone, and the lead got a
// "good shape" report off one page of a thirteen-page site.

// www and non-www are the same site; a redirect between them (either direction)
// must not change what counts as internal.
export function sameSiteFactory(site) {
  const base = (() => {
    try {
      return new URL(site).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  return (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '') === base;
    } catch {
      return false;
    }
  };
}

// Origin + path, no query, no hash, no trailing slash. Two links to the same
// page in different forms collapse to one inventory entry.
export function cleanUrl(u) {
  const x = new URL(u);
  return (x.origin + x.pathname).replace(/\/$/, '');
}

// Rendered homepage -> the internal-link inventory the picker chooses from.
// `landedUrl` is where the homepage fetch ACTUALLY ended up after redirects, not
// the URL that was submitted: the homepage is dropped by comparing against that,
// so a redirecting site does not list its own homepage as a page to audit.
export function buildInventory(page, landedUrl) {
  const sameSite = sameSiteFactory(landedUrl);
  const home = cleanUrl(landedUrl);
  const inv = [];
  const seen = new Set();
  for (const l of page?.links || []) {
    if (!sameSite(l.href)) continue;
    let clean;
    try {
      clean = cleanUrl(l.href);
    } catch {
      continue;
    }
    if (clean === home || seen.has(clean)) continue;
    seen.add(clean);
    inv.push({ url: clean, label: l.label || '' });
  }
  return inv;
}

// A URL from the inventory (rendered link, raw HTML, or sitemap), rewritten onto
// the host the homepage actually landed on. Only the host changes; path, query
// and hash pass through untouched, and a URL that isn't this site or is already
// on the landed host comes back unchanged.
//
// The sitemap prints its own idea of the site's host, which is not necessarily
// the working one (apexvolumetrics.com, 30 Jul: the apex host 308s to www AND
// resets the connection outright on some requests). A browser follows that
// redirect fine almost every time, but the pre-redirect hop is one more thing
// that can fail on a flaky host. Retrying a failed fetch on the landed host
// before writing the page off as unreadable turns that into a retry instead of
// a different page silently entering the audit.
export function onLandedHost(url, landedUrl) {
  try {
    const u = new URL(url);
    const sameSite = sameSiteFactory(landedUrl);
    if (!sameSite(u.href)) return url;
    const landed = new URL(landedUrl);
    if (u.host === landed.host) return url;
    u.protocol = landed.protocol;
    u.host = landed.host;
    return u.href;
  } catch {
    return url;
  }
}
