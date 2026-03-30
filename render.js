// OpenClaw Markdown + LaTeX + Code Renderer
// Converts markdown text to formatted HTML. No external dependencies.
// Supports: headers, bold, italic, strikethrough, code blocks, inline code,
//           links, images, lists, tables, blockquotes, horizontal rules,
//           LaTeX math ($..$ and $$..$$), and mermaid placeholders.

(function() {
  'use strict';

  // ── Escape HTML ──
  function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Code block syntax highlighting (basic keyword-based) ──
  var KEYWORDS = /\b(function|var|let|const|if|else|for|while|return|import|export|from|class|def|self|async|await|try|catch|finally|throw|new|typeof|instanceof|in|of|yield|switch|case|break|continue|default|do|with|as|is|not|and|or|True|False|None|true|false|null|undefined|void|this|super|extends|implements|interface|type|enum|struct|fn|pub|mod|use|crate|impl|trait|match|loop|mut|ref|where|package|main|fmt|func|go|chan|select|defer|map|set|int|float|double|string|bool|char|byte|long|short|unsigned|signed|static|final|abstract|public|private|protected|override|virtual|readonly|extern|volatile|register|inline|template|typename|namespace|using|include|define|ifdef|ifndef|endif|pragma|print|println|printf|echo|raise|except|lambda|nonlocal|global|del|pass|assert|elif|exec|eval)\b/g;
  var STRINGS = /(["'`])(?:(?!\1|\\).|\\.)*\1/g;
  var COMMENTS = /(\/\/.*$|\/\*[\s\S]*?\*\/|#(?!\{).*$)/gm;
  var NUMBERS = /\b(\d+\.?\d*(?:e[+-]?\d+)?|0x[\da-f]+|0b[01]+|0o[0-7]+)\b/gi;

  function highlightCode(code, lang) {
    var html = esc(code);
    // Order matters: comments first, then strings, then keywords, then numbers
    var tokens = [];
    var id = 0;
    // Extract comments
    html = html.replace(COMMENTS, function(m) { var k = '\x00C' + (id++) + '\x00'; tokens.push([k, '<span class="oc-cm">' + m + '</span>']); return k; });
    // Extract strings
    html = html.replace(STRINGS, function(m) { var k = '\x00S' + (id++) + '\x00'; tokens.push([k, '<span class="oc-str">' + m + '</span>']); return k; });
    // Keywords
    html = html.replace(KEYWORDS, '<span class="oc-kw">$&</span>');
    // Numbers
    html = html.replace(NUMBERS, '<span class="oc-num">$&</span>');
    // Restore tokens
    for (var i = 0; i < tokens.length; i++) {
      html = html.replace(tokens[i][0], tokens[i][1]);
    }
    return html;
  }

  // ── Inline markdown ──
  function renderInline(text) {
    var s = esc(text);
    // Images: ![alt](url)
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;margin:4px 0;" />');
    // Links: [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:#60a5fa;text-decoration:underline;">$1</a>');
    // Inline LaTeX: $...$  (not $$)
    s = s.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, '<span class="oc-math-inline">$1</span>');
    // Bold+Italic: ***text***
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    // Bold: **text**
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic: *text*
    s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    // Strikethrough: ~~text~~
    s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // Inline code: `text`
    s = s.replace(/`([^`]+)`/g, '<code class="oc-ic">$1</code>');
    return s;
  }

  // ── Block-level markdown ──
  function renderMarkdown(text) {
    if (!text) return '';
    var lines = text.split('\n');
    var html = '';
    var i = 0;
    var inList = false;
    var listType = '';

    while (i < lines.length) {
      var line = lines[i];

      // Block LaTeX: $$...$$
      if (line.trim().startsWith('$$')) {
        var mathLines = [line.trim().slice(2)];
        i++;
        while (i < lines.length && !lines[i].trim().endsWith('$$')) {
          mathLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) {
          var lastLine = lines[i].trim();
          mathLines.push(lastLine.slice(0, lastLine.length - 2));
          i++;
        }
        html += '<div class="oc-math-block">' + esc(mathLines.join('\n').trim()) + '</div>';
        continue;
      }

      // Code blocks: ```lang
      if (line.trim().startsWith('```')) {
        var lang = line.trim().slice(3).trim();
        var codeLines = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // skip closing ```
        var code = codeLines.join('\n');
        var langLabel = lang ? '<div class="oc-code-lang">' + esc(lang) + '</div>' : '';
        html += '<div class="oc-code-block">' + langLabel + '<pre><code>' + highlightCode(code, lang) + '</code></pre></div>';
        continue;
      }

      // Close list if current line isn't a list item
      if (inList && !/^\s*[-*+]\s/.test(line) && !/^\s*\d+[.)]\s/.test(line) && line.trim() !== '') {
        html += listType === 'ul' ? '</ul>' : '</ol>';
        inList = false;
      }

      // Horizontal rule
      if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
        html += '<hr style="border:none;border-top:1px solid #333;margin:12px 0;" />';
        i++;
        continue;
      }

      // Headers
      var hMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (hMatch) {
        var level = hMatch[1].length;
        var sizes = { 1: '1.6em', 2: '1.35em', 3: '1.15em', 4: '1em', 5: '0.9em', 6: '0.85em' };
        html += '<div style="font-size:' + sizes[level] + ';font-weight:700;margin:16px 0 8px;color:inherit;">' + renderInline(hMatch[2]) + '</div>';
        i++;
        continue;
      }

      // Blockquote
      if (line.trim().startsWith('> ')) {
        var quoteLines = [];
        while (i < lines.length && (lines[i].trim().startsWith('> ') || lines[i].trim().startsWith('>'))) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        html += '<blockquote class="oc-bq">' + renderMarkdown(quoteLines.join('\n')) + '</blockquote>';
        continue;
      }

      // Table
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*[-:]+/.test(lines[i + 1])) {
        var tableLines = [];
        while (i < lines.length && lines[i].includes('|')) {
          tableLines.push(lines[i]);
          i++;
        }
        html += renderTable(tableLines);
        continue;
      }

      // Unordered list
      var ulMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
      if (ulMatch) {
        if (!inList || listType !== 'ul') {
          if (inList) html += listType === 'ul' ? '</ul>' : '</ol>';
          html += '<ul class="oc-list">';
          inList = true;
          listType = 'ul';
        }
        html += '<li>' + renderInline(ulMatch[2]) + '</li>';
        i++;
        continue;
      }

      // Ordered list
      var olMatch = line.match(/^(\s*)\d+[.)]\s+(.*)/);
      if (olMatch) {
        if (!inList || listType !== 'ol') {
          if (inList) html += listType === 'ul' ? '</ul>' : '</ol>';
          html += '<ol class="oc-list">';
          inList = true;
          listType = 'ol';
        }
        html += '<li>' + renderInline(olMatch[2]) + '</li>';
        i++;
        continue;
      }

      // Empty line
      if (line.trim() === '') {
        if (inList) {
          html += listType === 'ul' ? '</ul>' : '</ol>';
          inList = false;
        }
        html += '<div style="height:8px;"></div>';
        i++;
        continue;
      }

      // Paragraph
      html += '<p style="margin:4px 0;line-height:1.7;">' + renderInline(line) + '</p>';
      i++;
    }

    if (inList) html += listType === 'ul' ? '</ul>' : '</ol>';
    return html;
  }

  // ── Table renderer ──
  function renderTable(lines) {
    if (lines.length < 2) return '';
    function parseCells(line) {
      return line.split('|').map(function(c) { return c.trim(); }).filter(function(c) { return c !== ''; });
    }
    var headers = parseCells(lines[0]);
    // lines[1] is the separator, parse alignment
    var aligns = parseCells(lines[1]).map(function(c) {
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });
    var html = '<div class="oc-table-wrap"><table class="oc-table"><thead><tr>';
    for (var h = 0; h < headers.length; h++) {
      html += '<th style="text-align:' + (aligns[h] || 'left') + '">' + renderInline(headers[h]) + '</th>';
    }
    html += '</tr></thead><tbody>';
    for (var r = 2; r < lines.length; r++) {
      var cells = parseCells(lines[r]);
      html += '<tr>';
      for (var c = 0; c < headers.length; c++) {
        html += '<td style="text-align:' + (aligns[c] || 'left') + '">' + renderInline(cells[c] || '') + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  // ── Inject styles ──
  function injectStyles() {
    if (document.getElementById('oc-render-styles')) return;
    var style = document.createElement('style');
    style.id = 'oc-render-styles';
    style.textContent =
      '.oc-rendered{line-height:1.7;word-wrap:break-word;overflow-wrap:break-word;}' +
      '.oc-rendered p{margin:4px 0;}' +
      '.oc-rendered strong{font-weight:700;}' +
      '.oc-rendered em{font-style:italic;}' +
      '.oc-rendered del{text-decoration:line-through;opacity:0.6;}' +
      '.oc-rendered img{max-width:100%;border-radius:8px;margin:8px 0;display:block;}' +
      '.oc-ic{background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:Consolas,Monaco,monospace;font-size:0.9em;}' +
      '.oc-code-block{background:#0d1117;border:1px solid #30363d;border-radius:8px;margin:8px 0;overflow:hidden;}' +
      '.oc-code-block pre{margin:0;padding:12px 16px;overflow-x:hidden;white-space:pre-wrap;word-wrap:break-word;word-break:break-all;font-size:13px;line-height:1.5;font-family:Consolas,Monaco,monospace;}' +
      '.oc-code-block code{color:#e6edf3;background:none;padding:0;}' +
      '.oc-code-lang{padding:4px 16px;background:rgba(255,255,255,0.04);border-bottom:1px solid #30363d;font-size:11px;color:#888;font-family:sans-serif;}' +
      '.oc-kw{color:#ff7b72;}' +
      '.oc-str{color:#a5d6ff;}' +
      '.oc-cm{color:#8b949e;font-style:italic;}' +
      '.oc-num{color:#79c0ff;}' +
      '.oc-bq{border-left:3px solid #444;padding:4px 12px;margin:8px 0;color:#aaa;background:rgba(255,255,255,0.03);border-radius:0 4px 4px 0;}' +
      '.oc-list{padding-left:24px;margin:4px 0;}' +
      '.oc-list li{margin:2px 0;}' +
      '.oc-table-wrap{overflow-x:hidden;margin:8px 0;}' +
      '.oc-table{border-collapse:collapse;width:100%;font-size:13px;}' +
      '.oc-table th,.oc-table td{border:1px solid #333;padding:6px 12px;}' +
      '.oc-table th{background:rgba(255,255,255,0.06);font-weight:600;}' +
      '.oc-table tr:nth-child(even){background:rgba(255,255,255,0.02);}' +
      '.oc-math-inline{background:rgba(139,92,246,0.12);color:#c4b5fd;padding:2px 6px;border-radius:4px;font-family:"Times New Roman",serif;font-style:italic;font-size:1.05em;}' +
      '.oc-math-block{background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.2);border-radius:8px;padding:16px;margin:8px 0;text-align:center;font-family:"Times New Roman",serif;font-style:italic;font-size:1.15em;color:#c4b5fd;white-space:pre-wrap;}';
    document.head.appendChild(style);
  }

  // ── Public API ──
  window.ocRenderMarkdown = function(text) {
    injectStyles();
    return '<div class="oc-rendered">' + renderMarkdown(text) + '</div>';
  };

  // Auto-inject styles on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectStyles);
  } else {
    injectStyles();
  }
})();
