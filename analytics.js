/* Vercel analytics loader, with a per-device opt-out.

   Our own browsing was counting as real traffic, which matters on numbers
   this small: a handful of self-visits moves a 15% conversion figure enough
   to read the page wrong. Visiting any page once with ?notrack=1 sets a flag
   in localStorage, and this file then loads neither the Web Analytics script
   nor the Speed Insights one, so that browser stops reporting entirely.
   ?notrack=0 clears it.

   Both are gated, not just Web Analytics: reloading a page fifty times while
   building it skews Speed Insights harder than it skews pageviews.

   The flag is per browser profile, not per machine: repeat it in each
   browser you actually use. It also cannot survive clearing site data.

   Gating the script tags is the whole mechanism, and it has to be: the
   insights script Vercel serves reads no localStorage at all (its only
   opt-out is a disableAutoTrack config flag), so once it loads there is
   nothing to switch off. The va-disable key name is borrowed from Vercel's
   SDK convention for familiarity, nothing more. */
(function () {
  var flag;
  try {
    var wanted = new URLSearchParams(location.search).get("notrack");
    if (wanted === "1") localStorage.setItem("va-disable", "1");
    if (wanted === "0") localStorage.removeItem("va-disable");
    flag = localStorage.getItem("va-disable");
  } catch (e) {
    /* Private mode or blocked storage: fall through and track as normal
       rather than silently dropping everyone's analytics. */
  }

  if (flag === "1") {
    /* Replace the inline queueing shim with a no-op and drop anything it
       already collected. Left alone, every track() call on the page would
       push into an array that now has no reader and never empties. */
    window.va = function () {};
    window.vaq = [];
    return;
  }

  /* async, not defer: a script inserted this way is async whatever we set,
     and ordering does not matter here because the inline window.va shim
     queues any event fired before the real script lands. */
  ["/_vercel/insights/script.js", "/_vercel/speed-insights/script.js"].forEach(function (src) {
    var s = document.createElement("script");
    s.async = true;
    s.src = src;
    document.head.appendChild(s);
  });
})();
