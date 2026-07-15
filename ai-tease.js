/* AI tease — fires every time the hero deck scrolls into view. The deck's last
   word reveals AS "skynet." (in the sentence's own sans), holds a beat, then
   does a fast guilty flip back to "AI.", like someone covering up a typo. No
   replay path, no hint anywhere else. No-JS and reduced-motion visitors only
   ever see "AI." (the real markup). */
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;

  var tease = document.querySelector('.ai-tease');
  if (!tease) return;

  var SYNONYM = 'skynet.';
  var REAL = 'AI.';
  var HOLD = 800;   // how long the "mistake" sits before it's corrected
  var SWAP = 160;   // blur duration when skynet has to be faded in (re-entry only)
  var COVER = 120;  // the quick guilty correction: blur out, swap, blur back
  var running = false;

  function run() {
    var word = tease.querySelector('.word');
    if (!word || running) return; // motion.js hasn't split text yet, or already mid-tease
    running = true;

    var anims = word.getAnimations ? word.getAnimations() : [];
    var pending = anims.filter(function (a) { return a.playState !== 'finished'; });

    if (pending.length) {
      // First load: let the word reveal AS skynet through the deck's own stagger.
      word.textContent = SYNONYM;
      Promise.all(pending.map(function (a) { return a.finished; }))
        .catch(function () {})
        .then(function () { setTimeout(coverUp, HOLD); });
    } else {
      // Re-entry (already settled): fade skynet in, since there's no stagger to ride.
      tease.classList.add('tease-swap');
      setTimeout(function () {
        word.textContent = SYNONYM;
        tease.classList.remove('tease-swap');
        setTimeout(coverUp, HOLD);
      }, SWAP);
    }
  }

  // The tell: a quick blur out, swap skynet -> AI, blur back. Fast, like a cover-up.
  function coverUp() {
    var word = tease.querySelector('.word');
    if (!word) { running = false; return; }
    tease.classList.add('tease-swap');
    setTimeout(function () {
      word.textContent = REAL;
      tease.classList.remove('tease-swap');
      running = false;
    }, COVER);
  }

  function armWhenVisible() {
    if (!('IntersectionObserver' in window)) { run(); return; } // run() waits for the stagger itself
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        io.disconnect(); // once per page load only; scrolling back up won't re-fire. A reload does.
        run();
      });
    }, { threshold: 0.6 });
    io.observe(tease.closest('.hero-deck') || tease);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', armWhenVisible);
  } else {
    armWhenVisible();
  }
})();
