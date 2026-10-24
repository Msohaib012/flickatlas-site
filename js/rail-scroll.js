/* Compact accessible controls for native horizontal poster rails. */
(function (root) {
  "use strict";
  function metrics(left, scrollWidth, clientWidth) {
    const max = Math.max(0, scrollWidth - clientWidth);
    return { max, value: max > 0 ? Math.max(0, Math.min(100, left / max * 100)) : 0 };
  }
  const doc = root.document;
  const reduced = () => !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches);
  let idCounter = 0;
  function uniqueId() {
    let id;
    do { id = "fa-rail-" + (++idCounter); } while (doc && doc.getElementById && doc.getElementById(id));
    return id;
  }
  function railHeading(rail) {
    const section = rail.closest && rail.closest("section");
    let heading = section && section.querySelector && section.querySelector("h1,h2,h3,h4,h5,h6");
    const name = heading && (heading.textContent || "").trim().replace(/\s+/g, " ");
    return name || "Titles";
  }
  function enhance(rails) {
    Array.from(rails || []).forEach(rail => {
      if (!rail || (rail.dataset && rail.dataset.scrollEnhanced)) return;
      let name = railHeading(rail);
      if (!rail.id || (doc && doc.getElementById && doc.getElementById(rail.id) !== rail)) rail.id = uniqueId();
      const controls = doc.createElement("div");
      controls.className = "rail-controls";
      controls.setAttribute("role", "group");
      controls.setAttribute("aria-label", name + " navigation");
      const makeButton = (direction, label, glyph) => {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "rail-control-button rail-control-" + direction;
        button.setAttribute("aria-label", "Scroll " + name + " " + (direction === "prev" ? "backward" : "forward"));
        button.setAttribute("aria-controls", rail.id);
        button.textContent = glyph;
        button.addEventListener("click", () => rail.scrollBy({ left: direction === "prev" ? -rail.clientWidth * 0.85 : rail.clientWidth * 0.85, behavior: reduced() ? "auto" : "smooth" }));
        return button;
      };
      const prev = makeButton("prev", "Previous", "‹");
      const page = doc.createElement("span");
      page.className = "rail-page";
      page.setAttribute("aria-live", "polite");
      page.setAttribute("aria-atomic", "true");
      const next = makeButton("next", "Next", "›");
      controls.appendChild(prev); controls.appendChild(page); controls.appendChild(next);
      rail.insertAdjacentElement("afterend", controls);
      if (rail.dataset) rail.dataset.scrollEnhanced = "true";
      if (rail.classList) rail.classList.add("rail-scroll-enhanced");
      let queued = false;
      const sync = () => {
        queued = false;
        const freshName=railHeading(rail);if(freshName!==name){name=freshName;controls.setAttribute("aria-label",name+" navigation");prev.setAttribute("aria-label","Scroll "+name+" backward");next.setAttribute("aria-label","Scroll "+name+" forward");}
        const max = Math.max(0, rail.scrollWidth - rail.clientWidth);
        const count = max > 1 ? Math.max(1, Math.ceil(rail.scrollWidth / Math.max(1, rail.clientWidth))) : 1;
        const current = max > 1 ? Math.min(count, Math.round(Math.max(0, rail.scrollLeft) / max * (count - 1)) + 1) : 1;
        controls.hidden = max <= 1;
        prev.disabled = max <= 1 || rail.scrollLeft <= 1;
        next.disabled = max <= 1 || rail.scrollLeft >= max - 1;
        page.textContent = current + " / " + count;
        page.setAttribute("aria-label", "Page " + current + " of " + count + " in " + name);
      };
      const schedule = () => {
        if (queued) return;
        queued = true;
        (root.requestAnimationFrame || (fn => root.setTimeout(fn, 0)))(sync);
      };
      rail.addEventListener("scroll", schedule, { passive: true });
      if (typeof root.ResizeObserver !== "undefined") new root.ResizeObserver(schedule).observe(rail);
      if (typeof root.MutationObserver !== "undefined") new root.MutationObserver(schedule).observe(rail, { childList: true, subtree: true });
      root.addEventListener("resize", schedule, { passive: true });
      sync();
    });
  }
  function scan() { if (doc && doc.querySelectorAll) enhance(doc.querySelectorAll(".scroller")); }
  if (doc) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", scan, { once: true }); else scan();
    if (typeof root.MutationObserver !== "undefined" && doc.documentElement) {
      const observer = new root.MutationObserver(records => {
        if (records.some(record => record.type === "childList" && Array.from(record.addedNodes || []).some(node => node.nodeType === 1))) scan();
      });
      observer.observe(doc.documentElement, { childList: true, subtree: true });
    }
  }
  root.FARailScroll = { enhance, metrics };
})(window);
