/* twing documentation — shared behaviour.
   No dependencies, no network. Every feature degrades to plain HTML if JS is off. */
(function () {
  "use strict";

  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  /* ── theme ─────────────────────────────────────────────── */
  function initTheme() {
    var root = document.documentElement;
    var KEY = "twing-docs-theme";
    var saved = LS.get(KEY);
    if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);

    var btn = document.getElementById("themeBtn");
    if (!btn) return;
    function label() {
      var t = root.getAttribute("data-theme");
      btn.textContent = t === "light" ? "☀ light" : t === "dark" ? "☾ dark" : "◐ auto";
    }
    function cycle() {
      var cur = root.getAttribute("data-theme");
      var next = cur === "light" ? "dark" : cur === "dark" ? null : "light";
      if (next) { root.setAttribute("data-theme", next); LS.set(KEY, next); }
      else { root.removeAttribute("data-theme"); LS.del(KEY); }
      label();
    }
    label();
    btn.addEventListener("click", cycle);
    btn.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); cycle(); }
    });
  }

  /* ── active top-nav link ───────────────────────────────── */
  function initNav() {
    var here = location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll(".navlinks a").forEach(function (a) {
      var href = a.getAttribute("href");
      if (href === here) a.classList.add("active");
    });
  }

  /* ── auto table of contents + scrollspy ────────────────── */
  function initToc() {
    var side = document.querySelector(".sidebar .links");
    if (!side) return;
    var heads = document.querySelectorAll("main section[id] > h2, main section[id] h3[id]");
    if (!heads.length) { side.closest(".sidebar").style.display = "none"; return; }

    var map = [];
    heads.forEach(function (h) {
      var sec = h.tagName === "H2" ? h.parentElement : h;
      var id = h.tagName === "H2" ? sec.id : h.id;
      if (!id) return;
      var a = document.createElement("a");
      a.href = "#" + id;
      var num = h.querySelector(".num");
      a.textContent = (h.textContent || "").replace(num ? num.textContent : "", "").trim();
      if (h.tagName === "H3") a.className = "lvl3";
      side.appendChild(a);
      map.push({ el: h.tagName === "H2" ? sec : h, link: a });
    });

    if (!("IntersectionObserver" in window)) return;
    var visible = new Set();
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) visible.add(en.target); else visible.delete(en.target);
      });
      var first = map.filter(function (m) { return visible.has(m.el); })[0];
      map.forEach(function (m) { m.link.classList.toggle("on", !!first && m === first); });
    }, { rootMargin: "-72px 0px -70% 0px", threshold: 0 });
    map.forEach(function (m) { obs.observe(m.el); });
  }

  /* ── copy buttons on code blocks ───────────────────────── */
  function initCopy() {
    document.querySelectorAll("pre").forEach(function (pre) {
      if (pre.querySelector(".copybtn")) return;
      var b = document.createElement("button");
      b.className = "copybtn";
      b.type = "button";
      b.textContent = "copy";
      b.addEventListener("click", function () {
        var code = pre.querySelector("code");
        var text = (code ? code.innerText : pre.innerText).replace(/\n?copy$/, "");
        var done = function () {
          b.textContent = "copied"; b.classList.add("done");
          setTimeout(function () { b.textContent = "copy"; b.classList.remove("done"); }, 1400);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, fallback);
        } else { fallback(); }
        function fallback() {
          var ta = document.createElement("textarea");
          ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); done(); } catch (e) {}
          document.body.removeChild(ta);
        }
      });
      pre.appendChild(b);
    });
  }

  /* ── in-page search / filter ───────────────────────────── */
  function initSearch() {
    var input = document.getElementById("q");
    if (!input) return;
    var units = Array.prototype.slice.call(document.querySelectorAll("[data-s]"));
    var sections = Array.prototype.slice.call(document.querySelectorAll("main section[id]"));
    var nores = document.querySelector(".nores");

    function apply(term) {
      term = term.trim().toLowerCase();
      if (!term) {
        document.body.classList.remove("searching");
        units.forEach(function (u) { u.classList.remove("hidden-by-search"); });
        sections.forEach(function (s) { s.classList.remove("hidden-by-search"); });
        if (nores) nores.classList.remove("show");
        return;
      }
      document.body.classList.add("searching");
      var hits = 0;
      units.forEach(function (u) {
        var hit = (u.textContent || "").toLowerCase().indexOf(term) !== -1;
        u.classList.toggle("hidden-by-search", !hit);
        if (hit) hits++;
      });
      sections.forEach(function (s) {
        var any = s.querySelector("[data-s]:not(.hidden-by-search)");
        var selfHit = (s.textContent || "").toLowerCase().indexOf(term) !== -1;
        s.classList.toggle("hidden-by-search", !any && !selfHit);
      });
      if (nores) nores.classList.toggle("show", hits === 0);
    }

    var t;
    input.addEventListener("input", function () {
      clearTimeout(t);
      t = setTimeout(function () { apply(input.value); }, 90);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { input.value = ""; apply(""); input.blur(); }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && document.activeElement !== input &&
          !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
        e.preventDefault(); input.focus(); input.select();
      }
    });
  }

  /* ── tier filter chips ─────────────────────────────────── */
  function initFilters() {
    var groups = document.querySelectorAll("[data-filters]");
    groups.forEach(function (bar) {
      var targetSel = bar.getAttribute("data-filters");
      var items = Array.prototype.slice.call(document.querySelectorAll(targetSel));
      var chips = Array.prototype.slice.call(bar.querySelectorAll(".fchip"));
      var counter = bar.querySelector(".fcount");
      var active = "all";

      function render() {
        var shown = 0;
        items.forEach(function (it) {
          var ok = active === "all" || it.getAttribute("data-tier") === active;
          it.style.display = ok ? "" : "none";
          if (ok) shown++;
        });
        chips.forEach(function (c) { c.classList.toggle("on", c.getAttribute("data-val") === active); });
        if (counter) counter.textContent = shown + " of " + items.length + " shown";
      }
      chips.forEach(function (c) {
        c.addEventListener("click", function () { active = c.getAttribute("data-val"); render(); });
      });
      render();
    });
  }

  /* ── persistent checklist ──────────────────────────────── */
  function initChecklist() {
    var lists = document.querySelectorAll("[data-checklist]");
    lists.forEach(function (list) {
      var key = "twing-docs-check:" + list.getAttribute("data-checklist");
      var state = {};
      try { state = JSON.parse(LS.get(key) || "{}"); } catch (e) { state = {}; }

      var items = Array.prototype.slice.call(list.querySelectorAll("[data-check]"));
      var barFill = document.querySelector(list.getAttribute("data-bar") || "#noBar");
      var pct = document.querySelector(list.getAttribute("data-pct") || "#noPct");
      var resetBtn = document.querySelector(list.getAttribute("data-reset") || "#noReset");

      function paint() {
        var done = 0;
        items.forEach(function (it) {
          var id = it.getAttribute("data-check");
          var on = !!state[id];
          it.classList.toggle("done", on);
          var box = it.querySelector(".box");
          if (box) {
            box.textContent = on ? "✓" : "";
            box.setAttribute("role", "checkbox");
            box.setAttribute("tabindex", "0");
            box.setAttribute("aria-checked", on ? "true" : "false");
          }
          if (on) done++;
        });
        var p = items.length ? Math.round((done / items.length) * 100) : 0;
        if (barFill) barFill.style.width = p + "%";
        if (pct) pct.textContent = done + " / " + items.length + "  ·  " + p + "%";
      }

      items.forEach(function (it) {
        var id = it.getAttribute("data-check");
        var box = it.querySelector(".box");
        if (!box) return;
        function toggle() {
          if (state[id]) delete state[id]; else state[id] = 1;
          LS.set(key, JSON.stringify(state));
          paint();
        }
        box.addEventListener("click", toggle);
        box.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
        });
      });

      if (resetBtn) {
        resetBtn.addEventListener("click", function () {
          state = {}; LS.del(key); paint();
        });
      }
      paint();
    });
  }

  /* ── clickable component map ───────────────────────────── */
  function initNodeMap() {
    var panel = document.getElementById("nodePanel");
    if (!panel) return;
    var nodes = Array.prototype.slice.call(document.querySelectorAll("[data-node]"));
    var store = {};
    document.querySelectorAll("[data-nodeinfo]").forEach(function (tpl) {
      store[tpl.getAttribute("data-nodeinfo")] = tpl.innerHTML;
    });

    function select(id) {
      nodes.forEach(function (n) { n.classList.toggle("sel", n.getAttribute("data-node") === id); });
      panel.innerHTML = store[id] || '<p class="hint">Nothing recorded for this component.</p>';
    }
    nodes.forEach(function (n) {
      n.setAttribute("tabindex", "0");
      n.setAttribute("role", "button");
      n.addEventListener("click", function () { select(n.getAttribute("data-node")); });
      n.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(n.getAttribute("data-node")); }
      });
    });
    var first = panel.getAttribute("data-default");
    if (first) select(first);
  }

  /* ── expand / collapse all accordions ──────────────────── */
  function initAccordionControls() {
    document.querySelectorAll("[data-toggle-all]").forEach(function (btn) {
      var sel = btn.getAttribute("data-toggle-all");
      btn.addEventListener("click", function () {
        var all = Array.prototype.slice.call(document.querySelectorAll(sel));
        var anyClosed = all.some(function (d) { return !d.open; });
        all.forEach(function (d) { d.open = anyClosed; });
        btn.textContent = anyClosed ? "collapse all" : "expand all";
      });
    });
  }

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  ready(function () {
    initTheme();
    initNav();
    initToc();
    initCopy();
    initSearch();
    initFilters();
    initChecklist();
    initNodeMap();
    initAccordionControls();
  });
})();
