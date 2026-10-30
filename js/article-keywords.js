/* Visible news keywords from the article's saved fields only.
   This helper never generates, fetches, or infers keywords. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.FAArticleKeywords = api;
})(typeof window !== "undefined" ? window : null, function () {
  function normalize(values) {
    if (!Array.isArray(values)) return [];
    const out = [];
    const seen = new Set();
    for (const value of values) {
      if (typeof value !== "string") continue;
      const term = value.replace(/\s+/g, " ").trim();
      if (!term || term.length > 100) continue;
      const key = term.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(term);
      if (out.length >= 12) break;
    }
    return out;
  }

  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function render(values, escape) {
    const terms = normalize(values);
    if (!terms.length) return "";
    const esc = typeof escape === "function" ? escape : escapeHtml;
    return `<section class="content-card article-keywords" aria-labelledby="article-keywords-heading" style="margin-top:14px"><h2 id="article-keywords-heading">Keywords</h2><div class="kw-chips" aria-label="Article keywords">${terms.map(term => `<span class="kw-chip">${esc(term)}</span>`).join("")}</div></section>`;
  }

  return { normalize, render };
});
