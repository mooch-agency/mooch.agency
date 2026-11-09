/* form-state.js: one lifecycle for the site's lead forms (the homepage audit
   band and AXBeat's per-row report forms): idle -> submitting -> sent, with
   error and a rate-limit cooldown back to idle.

   The state lives on the element's own data-state attribute, so CSS reads it,
   check-site's Lead forms discipline can see the wiring in the page source,
   and a form rebuilt by a re-render (AXBeat's view switch) can be seeded with
   the state its chain is really in. The machine reads the attribute on every
   call rather than caching it, so a direct attribute write by recovery code
   stays consistent with any machine bound to the same element.

   The transition table is deliberately strict: sent is terminal, so no stray
   timer or late response can resurrect a finished form, and only submitting
   may decide an outcome. Timers are injectable for the unit tests
   (scripts/form-state.test.mjs). Loaded only by pages that carry a lead form,
   the same way motion.js is loaded only by pages that animate. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.moochForm = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  /* How long a 429 holds the form shut. One shared value, matching the
     endpoints' own "give it a minute" copy. */
  var COOLDOWN_MS = 60000;

  /* Legal moves. Anything else is refused, which is the point: a late
     callback cannot drag a sent form back to life, and only an in-flight
     submission can decide how it ended. error -> error lets a repeated
     validation failure re-apply without being special-cased. */
  var MOVES = {
    idle: ["submitting", "error"],
    submitting: ["sent", "error", "cooldown", "idle"],
    error: ["submitting", "error", "idle"],
    cooldown: ["idle"],
    sent: []
  };
  function canMove(from, to) {
    return (MOVES[from] || []).indexOf(to) !== -1;
  }

  /* Random id per form fill. Rides along on each lead POST as
     `idempotency_key`, which api/audit.js and api/axbeat-lead.js store as the
     row's Audit ID, so a retried submission finds its first row instead of
     duplicating it. */
  function newKey() {
    var bytes = null;
    try {
      var c = (typeof crypto !== "undefined") ? crypto : null;
      if (c && c.getRandomValues) {
        bytes = c.getRandomValues(new Uint8Array(16));
      }
    } catch (e) { /* fall through to Math.random below */ }
    var out = "";
    for (var i = 0; i < 16; i++) {
      var b = bytes ? bytes[i] : Math.floor(Math.random() * 256);
      out += (b + 256).toString(16).slice(1);
    }
    return out;
  }

  /* The machine. `el` is whatever carries data-state (the form, or the band
     around it). opts:
       controls   () -> elements to disable while submitting or cooling down
       setTimeout / clearTimeout   injectable timers for tests
       onChange   (state) -> void, after each applied transition */
  function machine(el, opts) {
    opts = opts || {};
    var controls = opts.controls || function () { return []; };
    var setT = opts.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var clearT = opts.clearTimeout || function (id) { clearTimeout(id); };
    var onChange = opts.onChange || function () {};
    var timer = null;
    var key = newKey();

    function state() { return el.getAttribute("data-state") || "idle"; }
    function busy() {
      var s = state();
      return s === "submitting" || s === "cooldown";
    }
    function apply(s) {
      el.setAttribute("data-state", s);
      var off = s === "submitting" || s === "cooldown";
      var list = controls() || [];
      for (var i = 0; i < list.length; i++) if (list[i]) list[i].disabled = off;
      onChange(s);
    }
    function to(s) {
      if (!canMove(state(), s)) return false;
      /* Any real transition retires a pending cooldown timer, so a stale
         timer can never fire into a form that has since moved on. */
      if (timer !== null) { clearT(timer); timer = null; }
      apply(s);
      return true;
    }
    /* A 429: hold the form shut for a beat, then reopen it. */
    function cooldown(ms) {
      if (!to("cooldown")) return false;
      timer = setT(function () { timer = null; to("idle"); }, ms || COOLDOWN_MS);
      return true;
    }
    /* A changed field is a new fill, so it gets a new idempotency key;
       a plain retry of the same fill keeps the old one, which is the point. */
    function refill() { key = newKey(); }

    return {
      state: state,
      busy: busy,
      to: to,
      cooldown: cooldown,
      refill: refill,
      key: function () { return key; }
    };
  }

  /* POST with a deadline. Lead endpoints answer fast, so anything past
     timeoutMs reads as the network being gone and the caller shows its
     network copy instead of hanging in submitting forever. Resolves with
     { res, data } (data already JSON-parsed, {} when the body isn't JSON). */
  function fetchJSON(url, body, opts) {
    opts = opts || {};
    var f = opts.fetch || fetch;
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, opts.timeoutMs || 15000);
    return f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { res: res, data: data };
      });
    }).finally(function () { clearTimeout(t); });
  }

  /* The way out when a lead can't be saved on our side (a server or network
     failure, never a validation verdict). A dead Notion token once ate every
     lead for weeks while the form just said "try again"; one visitor gave up
     and asked on X instead. So the failure message now carries a mailto link
     with the request already written, so sending it takes one click. */
  var FALLBACK_TO = "hey@mooch.agency";
  function mailtoHref(subject, body) {
    return "mailto:" + FALLBACK_TO +
      "?subject=" + encodeURIComponent(subject || "") +
      "&body=" + encodeURIComponent(body || "");
  }
  /* Fills `el` with "<lead> <a>Email hey@mooch.agency</a>". Built from DOM
     nodes rather than innerHTML, so nothing the visitor typed can inject
     markup. onClick (optional) is for the page's analytics event. */
  function renderFallback(el, lead, subject, body, onClick) {
    if (!el) return;
    var doc = el.ownerDocument || document;
    el.textContent = "";
    el.appendChild(doc.createTextNode(lead + " "));
    var a = doc.createElement("a");
    a.className = "form-fallback";
    a.href = mailtoHref(subject, body);
    a.textContent = "Email " + FALLBACK_TO;
    if (onClick) a.addEventListener("click", onClick);
    el.appendChild(a);
  }

  return {
    machine: machine,
    canMove: canMove,
    newKey: newKey,
    fetchJSON: fetchJSON,
    mailtoHref: mailtoHref,
    renderFallback: renderFallback,
    FALLBACK_TO: FALLBACK_TO,
    COOLDOWN_MS: COOLDOWN_MS,
    MOVES: MOVES
  };
});
