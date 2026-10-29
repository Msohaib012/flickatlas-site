/* FlickAtlas: transparent source-check cycles; own-site metadata only. */
(function (root) {
  'use strict';
  function node(tag, text, cls) {
    var el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }
  function label(key) { return String(key).replace(/_/g, ' '); }
  function format(value) {
    var date = new Date(value);
    if (!value || !isFinite(date.getTime())) return 'not yet recorded';
    try { return new Intl.DateTimeFormat('en-GB', {dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Karachi'}).format(date) + ' PKT'; }
    catch (_) { return date.toISOString(); }
  }
  async function mount() {
    var foot = document.getElementById('site-foot');
    if (!foot || document.getElementById('refresh-cycles')) return;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 8000) : null;
    try {
      var response = await root.fetch('/data/refresh-policy.json', Object.assign({cache:'no-store'}, controller ? {signal:controller.signal} : {}));
      if (!response.ok) return;
      var data = await response.json();
      if (!data || !Array.isArray(data.cycles)) return;
      root.FA_REFRESH_POLICY = data;
      var aside = node('aside', null, 'wrap refresh-cycles-wrap');
      aside.id = 'refresh-cycles';
      var details = node('details', null, 'refresh-cycles');
      details.appendChild(node('summary', 'Data refresh cycles'));
      var content = node('div', null, 'refresh-cycles__content');
      content.appendChild(node('p', data.scheduler, 'refresh-cycles__note'));
      var list = node('dl');
      data.cycles.forEach(function (cycle) {
        list.appendChild(node('dt', cycle.label));
        var dd = node('dd');
        dd.appendChild(node('p', cycle.cadence));
        dd.appendChild(node('p', 'Default order: ' + cycle.order + '.', 'refresh-cycles__note'));
        var checks = (cycle.sources || []).map(function (key) {
          var check = (data.checks || {})[key] || {};
          var status = check.status && check.status !== 'success' ? ' (latest status: ' + check.status + ')' : '';
          return label(key) + ': ' + format(check.last_success) + status;
        });
        if (checks.length) dd.appendChild(node('p', 'Last successful checks — ' + checks.join('; '), 'refresh-cycles__note'));
        list.appendChild(dd);
      });
      content.appendChild(list);
      content.appendChild(node('p', data.note, 'refresh-cycles__note'));
      details.appendChild(content);
      aside.appendChild(details);
      foot.parentNode.insertBefore(aside, foot);
    } catch (_) {
      // Do not invent timestamps or claim a source check when status is unavailable.
    } finally { if (timer) clearTimeout(timer); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
  else mount();
})(window);
