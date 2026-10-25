'use strict';
/** 极简 Markdown → HTML。只支持简报里会用到的东西：标题、列表、表格、引用、代码、粗体、链接。 */
(function () {
  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(text) {
    let s = esc(text);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_m, c) => {
      codes.push(esc(c));
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => `<a href="${u}" data-ext="1">${t}</a>`);
    s = s.replace(/(^|[^\w">=\/])(https?:\/\/[^\s<)）]+)/g, (_m, pre, url) => {
      const trailing = url.match(/[.,;:!?·。，、）】」』]+$/);
      const tail = trailing ? trailing[0] : '';
      const clean = tail ? url.slice(0, -tail.length) : url;
      return `${pre}<a href="${clean}" data-ext="1">${clean}</a>${tail}`;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
    return s;
  }

  const isUl = (l) => /^\s*[-*+]\s+/.test(l);
  const isOl = (l) => /^\s*\d+[.)]\s+/.test(l);

  function cells(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map((c) => c.trim());
  }

  function render(md) {
    const lines = md.replace(/\r/g, '').split('\n');
    const out = [];
    const buf = [];
    let i = 0;

    const flush = () => {
      if (buf.length) {
        out.push('<p>' + inline(buf.join(' ')) + '</p>');
        buf.length = 0;
      }
    };

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { flush(); i++; continue; }

      if (/^\s*```/.test(line)) {
        flush(); i++;
        const code = [];
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }

      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flush();
        const lv = Math.min(h[1].length, 4);
        out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
        i++;
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push('<hr/>'); i++; continue; }

      if (/^\s*>\s?/.test(line)) {
        flush();
        const q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push('<blockquote>' + inline(q.join(' ')) + '</blockquote>');
        continue;
      }

      if (line.includes('|') && lines[i + 1] && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1])) {
        flush();
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        let tbl = '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
        for (const r of rows) {
          tbl += '<tr>' + head.map((_c, k) => `<td>${inline(r[k] || '')}</td>`).join('') + '</tr>';
        }
        out.push(tbl + '</tbody></table>');
        continue;
      }

      if (/^\s*→/.test(line)) {
        flush();
        out.push('<p class="callout">' + inline(line.replace(/^\s*→\s*/, '')) + '</p>');
        i++;
        continue;
      }

      if (isUl(line) || isOl(line)) {
        flush();
        const ordered = isOl(line);
        const items = [];
        while (i < lines.length && (isUl(lines[i]) || isOl(lines[i]))) {
          items.push(lines[i++].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>` + items.map((t) => `<li>${inline(t)}</li>`).join('') + `</${tag}>`);
        continue;
      }

      buf.push(line);
      i++;
    }
    flush();
    return out.join('\n');
  }

  window.renderMarkdown = render;
})();
