/* Mooch widget state. One explicit state variable per widget, one render(state)
   that derives every class, label and attribute, timers cleared on re-entry, and
   a generation token so a stale timeout or transitionend can never act on a dead
   transition. Grown from two bugs: the copy button that stuck on "Copied" after
   a double click (the second click captured "Copied" as the label to restore),
   and the disclosure that snapped open when closed mid-animation (the open
   click's transitionend listener fired on the close transition).

   Two shared behaviours ship on top of the core, both bound from data
   attributes so the shared file knows nothing about any page:

   Copy button: any [data-copy-target="<id>"] element. The label is captured at
   bind time, never read back after a click. Optional attributes:
     data-copy-event="<name>"    analytics event fired after a successful copy
     data-copy-event-title      include { prompt: document.title } in the event
     data-copy-slug="<slug>"    POST /api/copy-count after a successful copy
   The counter display is any .copy-count[data-copy-slug], synced from GET
   /api/copy-count on load and bumped by the POST's own response. Both the
   event and the POST fire only after the clipboard write resolves, so the
   numbers count copies that happened, not clicks that tried.

   Disclosure: any .disclosure-toggle[aria-controls] (see ui.css). The collapse
   is JS-gated via .is-collapsible, so with no JS the content renders in full.

   The core (reducers, generation token, controllers) is dependency-injected and
   exported for node --test; the DOM glue below only runs in a browser. Loaded
   like motion.js, by the pages that use it, just before </body>. */
(function () {
  "use strict";

  // Timing lives here, once, not per page. The restore is deliberately long
  // enough to read; the flash matches .just-copied's feel in ui.css.
  var RESTORE_MS = 2000;
  var FLASH_MS = 400;

  // A monotonic token. Each user action takes the next token; callbacks it
  // schedules check isCurrent before touching the widget, so a later action
  // silently retires everything the earlier one left in flight.
  function makeGen() {
    var gen = 0;
    return {
      next: function () { return ++gen; },
      isCurrent: function (g) { return g === gen; }
    };
  }

  // Copy button phases: idle, copied. Rejection never claims "Copied".
  function copyReducer(phase, ev) {
    switch (ev) {
      case "copy_ok": return "copied";
      case "copy_fail": return "idle";
      case "restore": return phase === "copied" ? "idle" : phase;
    }
    return phase;
  }

  // Disclosure phases: closed, opening, open, closing. A toggle from any
  // phase heads the other way; settle events land only from the matching
  // in-flight phase, so a stale settle changes nothing.
  function disclosureReducer(phase, ev) {
    switch (ev) {
      case "toggle": return (phase === "closed" || phase === "closing") ? "opening" : "closing";
      case "settled_open": return phase === "opening" ? "open" : phase;
      case "settled_closed": return phase === "closing" ? "closed" : phase;
    }
    return phase;
  }

  // The copy counter never renders a value lower than the one shown: the
  // load GET and the click POST can resolve in either order (Notion round
  // trips are slow and uneven), and a late GET must not tick the number back.
  function counterMerge(shown, next) {
    return (shown !== null && next < shown) ? shown : next;
  }

  function countLabel(n) {
    return "Copied " + n.toLocaleString("en-GB") + (n === 1 ? " time" : " times");
  }

  /* Controller for one copy button. fx supplies the effects:
       write(text) -> Promise   clipboard write
       schedule(fn, ms) -> id   timer; cancel(id) clears it
       render(phase)            derive label and classes from the phase
       copied()                 optional, fires once per successful copy
       restoreMs                optional override of RESTORE_MS            */
  function createCopyController(fx) {
    var phase = "idle";
    var timer = null;
    var gen = makeGen();
    var restoreMs = fx.restoreMs || RESTORE_MS;
    function set(ev) { phase = copyReducer(phase, ev); fx.render(phase); }
    function click(text) {
      var g = gen.next();
      if (timer !== null) { fx.cancel(timer); timer = null; }
      var p;
      try { p = fx.write(text); } catch (e) { p = Promise.reject(e); }
      return p.then(function () {
        if (!gen.isCurrent(g)) return;
        set("copy_ok");
        if (fx.copied) fx.copied();
        timer = fx.schedule(function () {
          timer = null;
          if (!gen.isCurrent(g)) return;
          set("restore");
        }, restoreMs);
      }, function () {
        if (!gen.isCurrent(g)) return;
        set("copy_fail");
      });
    }
    return { click: click, phase: function () { return phase; } };
  }

  /* Controller for one disclosure. fx supplies:
       measure() -> px          full content height (scrollHeight)
       setMax(value)            inline max-height ("", "123px", "none")
       setOpenClass(bool)       the .open class
       reduced() -> bool        prefers-reduced-motion
       expectTransitionEnd(fn)  call fn when the next max-height transition
                                on the body ends (the glue filters the event)
       defer(fn)                two animation frames later
       render(phase)            derive label and aria-expanded               */
  function createDisclosureController(fx) {
    var phase = "closed";
    var gen = makeGen();
    function set(ev) { phase = disclosureReducer(phase, ev); fx.render(phase); }
    function toggle() {
      var g = gen.next();
      set("toggle");
      if (phase === "opening") {
        // Hold the measured height only while the open animation runs, then
        // release it, so a later reflow (narrower window, late font swap)
        // cannot re-clip the content.
        fx.setMax(fx.measure() + "px");
        fx.setOpenClass(true);
        if (fx.reduced()) {
          fx.setMax("none");
          set("settled_open");
        } else {
          fx.expectTransitionEnd(function () {
            if (!gen.isCurrent(g)) return; // closed mid-open: stay closed
            fx.setMax("none");
            set("settled_open");
          });
        }
      } else {
        // Animating down from "none" does not transition, so land on a
        // concrete height for a frame before removing .open.
        fx.setMax(fx.measure() + "px");
        fx.defer(function () {
          if (!gen.isCurrent(g)) return; // reopened mid-close: stay open
          fx.setOpenClass(false);
          fx.setMax("");
          set("settled_closed");
        });
      }
    }
    return { toggle: toggle, phase: function () { return phase; } };
  }

  var core = {
    RESTORE_MS: RESTORE_MS,
    FLASH_MS: FLASH_MS,
    makeGen: makeGen,
    copyReducer: copyReducer,
    disclosureReducer: disclosureReducer,
    counterMerge: counterMerge,
    countLabel: countLabel,
    createCopyController: createCopyController,
    createDisclosureController: createDisclosureController
  };
  if (typeof module !== "undefined" && module.exports) module.exports = core;
  if (typeof document === "undefined") return;

  // ── DOM glue ──────────────────────────────────────────────────────────────
  function onReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  onReady(function () {
    // Counters, keyed by slug so a button's POST can bump its display.
    var counters = {};
    document.querySelectorAll(".copy-count[data-copy-slug]").forEach(function (el) {
      var slug = el.getAttribute("data-copy-slug");
      var shown = null;
      var flashTimer = null;
      function setCount(count, animate) {
        var next = counterMerge(shown, count);
        if (shown !== null && next === shown) return;
        shown = next;
        // Setting the attribute is what un-hides a fresh page's "0" state:
        // ui.css hides the element only while data-copy-count="0".
        el.setAttribute("data-copy-count", next);
        el.textContent = countLabel(next);
        if (animate) {
          if (flashTimer !== null) clearTimeout(flashTimer);
          el.classList.add("just-copied");
          flashTimer = setTimeout(function () {
            flashTimer = null;
            el.classList.remove("just-copied");
          }, FLASH_MS);
        }
      }
      counters[slug] = setCount;
      // Refresh the baked number from the live count. Failures leave the
      // build-time number in place, so a Notion hiccup never breaks the page.
      fetch("/api/copy-count?slug=" + encodeURIComponent(slug))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) { if (data) setCount(data.count); })
        .catch(function () {});
    });

    function bumpCount(slug) {
      fetch("/api/copy-count", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: slug })
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) { if (data && counters[slug]) counters[slug](data.count, true); })
        .catch(function () {});
    }

    function fireEvent(btn) {
      var name = btn.getAttribute("data-copy-event");
      if (!name) return;
      try {
        if (!window.va) return;
        var ev = { name: name };
        if (btn.hasAttribute("data-copy-event-title")) ev.data = { prompt: document.title };
        window.va("event", ev);
      } catch (e) { /* a blocked script never throws into the page */ }
    }

    document.querySelectorAll("[data-copy-target]").forEach(function (btn) {
      var boundLabel = btn.textContent; // captured once, at bind time
      var ctrl = createCopyController({
        write: function (text) { return navigator.clipboard.writeText(text); },
        schedule: function (fn, ms) { return setTimeout(fn, ms); },
        cancel: function (id) { clearTimeout(id); },
        render: function (phase) {
          btn.textContent = phase === "copied" ? "Copied" : boundLabel;
          btn.classList.toggle("copied", phase === "copied");
        },
        copied: function () {
          fireEvent(btn);
          var slug = btn.getAttribute("data-copy-slug");
          if (slug) bumpCount(slug);
        }
      });
      btn.addEventListener("click", function () {
        var target = document.getElementById(btn.getAttribute("data-copy-target"));
        if (!target) return;
        ctrl.click(target.textContent.trim());
      });
    });

    document.querySelectorAll(".disclosure-toggle[aria-controls]").forEach(function (btn) {
      var body = document.getElementById(btn.getAttribute("aria-controls"));
      if (!body) return;
      var openLabel = "Show less";
      var closedLabel = btn.textContent.trim();
      var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

      // Clamp first, then measure: scrollHeight is the full content height
      // either way, but clientHeight must reflect the collapsed box.
      body.classList.add("is-collapsible");
      btn.hidden = body.scrollHeight <= body.clientHeight + 24;

      // One persistent listener; the controller registers the callback that
      // the next max-height transition end should run. A stale callback is
      // retired by its generation token inside the controller.
      var pendingEnd = null;
      body.addEventListener("transitionend", function (e) {
        if (e.target !== body || e.propertyName !== "max-height") return;
        var fn = pendingEnd;
        pendingEnd = null;
        if (fn) fn();
      });

      var ctrl = createDisclosureController({
        measure: function () { return body.scrollHeight; },
        setMax: function (v) { body.style.maxHeight = v; },
        setOpenClass: function (on) { body.classList.toggle("open", on); },
        reduced: function () { return reduced.matches; },
        expectTransitionEnd: function (fn) { pendingEnd = fn; },
        defer: function (fn) {
          requestAnimationFrame(function () { requestAnimationFrame(fn); });
        },
        render: function (phase) {
          var open = phase === "opening" || phase === "open";
          btn.textContent = open ? openLabel : closedLabel;
          btn.setAttribute("aria-expanded", String(open));
        }
      });
      btn.addEventListener("click", ctrl.toggle);
    });
  });
})();
