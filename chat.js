// OpenClaw Chat Client — Multi-session support
// Elements: #oc-messages, #oc-input, #oc-send, #oc-new-chat, #oc-sessions,
//           #oc-activity, #oc-export, #oc-search, #oc-settings
// Custom renderers: window.ocRenderUserMsg, window.ocRenderBotMsg, window.ocOnStreamChunk

(function() {
  'use strict';

  var API_PATH = '/v1/chat/completions';
  var MODEL = 'openclaw';
  var STORE_KEY = 'oc_sessions';
  var ACTIVE_KEY = 'oc_active_session';

  var sessions = {};    // { id: { name, history, messages, createdAt } }
  var activeId = '';
  var sending = false;
  var token = '';

  // ── Persistence ──
  function saveAll() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(sessions));
      localStorage.setItem(ACTIVE_KEY, activeId);
    } catch(e) {}
  }

  function loadAll() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) sessions = JSON.parse(raw);
      activeId = localStorage.getItem(ACTIVE_KEY) || '';
    } catch(e) {}
  }

  function getSession() {
    return sessions[activeId] || null;
  }

  function genId() {
    return 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  }

  // ── Token ──
  function loadToken() {
    var params = new URLSearchParams(window.location.search);
    var t = params.get('token') || params.get('t');
    if (t) { try { localStorage.setItem('oc_token', t); } catch(e) {} return t; }
    var hash = window.location.hash.slice(1);
    if (hash) {
      var hp = new URLSearchParams(hash);
      t = hp.get('token');
      if (t) { try { localStorage.setItem('oc_token', t); } catch(e) {} return t; }
    }
    try { t = localStorage.getItem('oc_token'); } catch(e) {}
    return t || '';
  }

  function saveToken(t) {
    token = t;
    try { localStorage.setItem('oc_token', t); } catch(e) {}
    connectWs();
  }

  function showTokenPrompt(container, retryText) {
    var existing = document.getElementById('oc-token-prompt');
    if (existing) existing.remove();
    var div = document.createElement('div');
    div.id = 'oc-token-prompt';
    div.style.cssText = 'padding:16px;margin:8px 0;border-radius:8px;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.3);';
    div.innerHTML =
      '<div style="font-size:13px;font-weight:600;color:#fbbf24;margin-bottom:8px;">Gateway Token Required</div>' +
      '<div style="font-size:12px;color:#aaa;margin-bottom:12px;">Run <code style="background:#1a1a1a;padding:2px 6px;border-radius:3px;font-size:11px;">openclaw dashboard</code> to open with token auto-injected.</div>' +
      '<div style="display:flex;gap:8px;">' +
        '<input id="oc-token-input" type="password" placeholder="Or paste token here..." style="flex:1;padding:8px 12px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e0e0e0;font-size:13px;outline:none;" />' +
        '<button id="oc-token-submit" style="padding:8px 16px;background:#fbbf24;color:#000;border:none;border-radius:6px;font-weight:600;font-size:13px;cursor:pointer;">Connect</button>' +
      '</div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    var tokenInput = document.getElementById('oc-token-input');
    var tokenSubmit = document.getElementById('oc-token-submit');
    function submitToken() {
      var t = tokenInput.value.trim();
      if (!t) return;
      saveToken(t);
      div.remove();
      if (retryText) send(retryText);
    }
    tokenInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); submitToken(); } });
    tokenSubmit.addEventListener('click', submitToken);
    tokenInput.focus();
  }

  // ── Rendering ──
  function escHtml(s) {
    var d = document.createElement('div'); d.textContent = s; return d.innerHTML;
  }

  function renderMessage(container, role, content) {
    if (role === 'user') {
      if (window.ocRenderUserMsg) {
        window.ocRenderUserMsg(container, content);
      } else {
        var div = document.createElement('div');
        div.className = 'oc-msg oc-msg-user';
        div.innerHTML = '<strong>You:</strong> ' + escHtml(content);
        div.style.cssText = 'padding:8px 12px;margin-bottom:8px;border-radius:12px 12px 0 12px;background:rgba(102,126,234,0.15);font-size:14px;line-height:1.6;margin-left:auto;max-width:80%;text-align:right;';
        container.appendChild(div);
      }
    } else {
      if (window.ocRenderBotMsg) {
        var el = window.ocRenderBotMsg(container);
        if (window.ocRenderMarkdown) { el.innerHTML = window.ocRenderMarkdown(content); }
        else { el.textContent = content; }
      } else {
        var div2 = document.createElement('div');
        div2.className = 'oc-msg oc-msg-bot';
        div2.style.cssText = 'padding:8px 12px;margin-bottom:8px;border-radius:8px;background:rgba(34,197,94,0.1);font-size:14px;line-height:1.6;';
        if (window.ocRenderMarkdown) { div2.innerHTML = window.ocRenderMarkdown(content); }
        else { div2.style.whiteSpace = 'pre-wrap'; div2.textContent = content; }
        container.appendChild(div2);
      }
    }
  }

  function renderAllMessages(container) {
    var existing = container.querySelectorAll('.message, .oc-msg');
    for (var i = 0; i < existing.length; i++) existing[i].remove();
    var s = getSession();
    if (!s) return;
    for (var j = 0; j < s.messages.length; j++) {
      renderMessage(container, s.messages[j].role, s.messages[j].content);
    }
    container.scrollTop = container.scrollHeight;
  }

  function scrollBottom(container) { container.scrollTop = container.scrollHeight; }

  // ── Sidebar ──
  function renderSidebar() {
    var el = document.getElementById('oc-sessions');
    if (!el) return;
    var ids = Object.keys(sessions).sort(function(a, b) {
      return (sessions[b].createdAt || 0) - (sessions[a].createdAt || 0);
    });
    if (window.ocRenderSidebar) {
      window.ocRenderSidebar(el, ids, sessions, activeId);
    } else {
      el.innerHTML = ids.map(function(id) {
        var s = sessions[id];
        var active = id === activeId;
        var msgCount = s.messages ? s.messages.length : 0;
        var preview = msgCount > 0 ? s.messages[0].content.slice(0, 40) : 'Empty';
        return '<div class="oc-session-item' + (active ? ' active' : '') + '" data-sid="' + id + '" style="' +
          'padding:10px 12px;margin-bottom:6px;border-radius:8px;cursor:pointer;transition:all 0.15s;position:relative;' +
          'background:' + (active ? '#222' : '#1a1a1a') + ';' +
          'border-left:2px solid ' + (active ? '#667eea' : 'transparent') + ';">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(s.name) + '</div>' +
            '<button class="oc-del-btn" data-del="' + id + '" style="background:none;border:none;color:#555;font-size:14px;cursor:pointer;padding:0 2px;line-height:1;flex-shrink:0;" title="Delete">&times;</button>' +
          '</div>' +
          '<div style="font-size:10px;color:#666;">' + msgCount + ' msgs — ' + escHtml(preview) + '</div>' +
        '</div>';
      }).join('');
    }
    // Bind clicks — switch session
    el.querySelectorAll('[data-sid]').forEach(function(item) {
      item.addEventListener('click', function(e) {
        if (e.target.closest('.oc-del-btn')) return;
        switchSession(item.getAttribute('data-sid'));
      });
    });
    // Bind clicks — delete session
    el.querySelectorAll('.oc-del-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-del');
        if (id) deleteSession(id);
      });
    });
  }

  function switchSession(id) {
    if (!sessions[id] || id === activeId) return;
    activeId = id;
    wsSessionKey = sessions[id].serverKey || 'agent:claude:main';
    saveAll();
    var container = document.getElementById('oc-messages');
    if (container) renderAllMessages(container);
    renderSidebar();
    renderActivity();
    // Load server-side history for the session
    if (wsHasReadScope && ws && ws.readyState === 1 && sessions[id].serverKey) {
      wsSend({ type: 'req', id: 'ch', method: 'chat.history', params: { sessionKey: sessions[id].serverKey, limit: 100 } });
    }
  }

  // ── Activity Panel ──
  function addActivity(type, text) {
    var s = getSession();
    if (!s) return;
    if (!s.activity) s.activity = [];
    s.activity.push({ type: type, text: text, time: new Date().toISOString() });
    if (s.activity.length > 50) s.activity = s.activity.slice(-50);
    saveAll();
    renderActivity();
  }

  function renderActivity() {
    var el = document.getElementById('oc-activity');
    if (!el) return;
    var s = getSession();
    var items = (s && s.activity) ? s.activity : [];
    if (items.length === 0) {
      el.innerHTML = '<div style="padding:20px;text-align:center;color:#666;font-size:11px;">No activity yet</div>';
      return;
    }
    var icons = { send: '\uD83D\uDCE4', receive: '\uD83E\uDD9E', error: '\u26A0\uFE0F', system: '\u2699\uFE0F' };
    el.innerHTML = items.slice().reverse().map(function(a) {
      var time = a.time ? new Date(a.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
      var icon = icons[a.type] || '\uD83D\uDD35';
      var colors = { send: '#667eea', receive: '#22c55e', error: '#ef4444', system: '#fbbf24' };
      var color = colors[a.type] || '#888';
      return '<div style="padding:8px 12px;margin-bottom:4px;background:#1a1a1a;border-radius:6px;border-left:3px solid ' + color + ';font-size:11px;">' +
        '<div style="font-size:9px;color:#666;margin-bottom:2px;">' + time + '</div>' +
        '<div style="color:#aaa;">' + icon + ' ' + escHtml(a.text) + '</div>' +
      '</div>';
    }).join('');
  }

  // ── Input & streaming counters ──
  var streamStartTime = 0;

  function countWords(text) {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }

  function updateInputCounter(input) {
    var el = document.getElementById('oc-input-counter');
    if (!el) {
      el = document.createElement('div');
      el.id = 'oc-input-counter';
      el.style.cssText = 'font-size:10px;color:#555;padding:2px 8px;text-align:right;';
      input.parentNode.insertBefore(el, input.nextSibling);
    }
    var text = input.value;
    if (!text.trim()) { el.textContent = ''; return; }
    el.textContent = countWords(text) + ' words, ' + text.length + ' chars';
  }

  function updateStreamCounter(wordCount) {
    var el = document.getElementById('oc-stream-counter');
    if (wordCount === -1) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'oc-stream-counter';
      el.style.cssText = 'position:fixed;bottom:80px;right:24px;font-size:10px;color:#888;background:rgba(15,15,15,0.85);padding:4px 10px;border-radius:6px;border:1px solid #333;z-index:50;font-family:monospace;';
      document.body.appendChild(el);
    }
    var elapsed = streamStartTime ? ((Date.now() - streamStartTime) / 1000).toFixed(1) : '0.0';
    if (wordCount === 0) {
      el.textContent = 'Waiting... ' + elapsed + 's';
    } else {
      el.textContent = wordCount + ' words \u00B7 ' + elapsed + 's';
    }
  }

  var streamCounterInterval = null;
  function startStreamCounter() {
    stopStreamCounter();
    streamCounterInterval = setInterval(function() {
      if (!sending) { stopStreamCounter(); return; }
      var wc = countWords(pendingFullText);
      updateStreamCounter(wc);
    }, 200);
  }
  function stopStreamCounter() {
    if (streamCounterInterval) { clearInterval(streamCounterInterval); streamCounterInterval = null; }
    updateStreamCounter(-1);
  }

  // ── Loading indicator ──
  var loadingDots = '<span style="display:inline-flex;gap:4px;vertical-align:middle;">' +
    '<span style="width:8px;height:8px;border-radius:50%;background:#667eea;animation:oc-dot 1.2s 0s infinite both;"></span>' +
    '<span style="width:8px;height:8px;border-radius:50%;background:#667eea;animation:oc-dot 1.2s 0.2s infinite both;"></span>' +
    '<span style="width:8px;height:8px;border-radius:50%;background:#667eea;animation:oc-dot 1.2s 0.4s infinite both;"></span>' +
    '</span>';

  function showLoading(container) {
    // Inject animation if not already present
    if (!document.getElementById('oc-loading-style')) {
      var style = document.createElement('style');
      style.id = 'oc-loading-style';
      style.textContent = '@keyframes oc-dot{0%,80%,100%{opacity:0.3;transform:scale(0.8)}40%{opacity:1;transform:scale(1.2)}}';
      document.head.appendChild(style);
    }
    // Allow per-version custom loading
    if (window.ocShowLoading) {
      window.ocShowLoading(container, loadingDots);
    } else {
      var el = document.createElement('div');
      el.id = 'oc-loading';
      el.style.cssText = 'display:flex;align-items:center;gap:10px;padding:14px 18px;margin-bottom:8px;font-size:13px;color:#aaa;background:rgba(102,126,234,0.08);border-radius:10px;border-left:3px solid #667eea;';
      el.innerHTML = loadingDots + ' <span>Thinking...</span>';
      container.appendChild(el);
    }
    container.scrollTop = container.scrollHeight;
  }

  function hideLoading() {
    if (window.ocHideLoading) { window.ocHideLoading(); return; }
    var el = document.getElementById('oc-loading');
    if (el) el.remove();
  }

  // ── Save before unload (catch mid-stream navigation) ──
  var pendingFullText = '';
  var pendingSessionId = '';

  function saveBeforeUnload() {
    if (sending && pendingFullText && pendingSessionId && sessions[pendingSessionId]) {
      var s = sessions[pendingSessionId];
      s.history.push({ role: 'assistant', content: pendingFullText });
      s.messages.push({ role: 'assistant', content: pendingFullText });
      if (!s.activity) s.activity = [];
      s.activity.push({ type: 'receive', text: '(saved mid-stream) ' + (pendingFullText.length > 40 ? pendingFullText.slice(0, 40) + '...' : pendingFullText), time: new Date().toISOString() });
      saveAll();
    }
  }

  window.addEventListener('beforeunload', saveBeforeUnload);
  window.addEventListener('pagehide', saveBeforeUnload);

  // ── Abort / Stop ──
  var httpReader = null; // Reference to HTTP stream reader for abort

  function abortGeneration() {
    if (!sending) return;
    if (wsHasReadScope && ws && ws.readyState === 1) {
      wsSend({ type: 'req', id: 'abort-' + Date.now(), method: 'chat.abort', params: { sessionKey: wsSessionKey, runId: wsChatRunId || undefined } });
    }
    if (httpReader) { try { httpReader.cancel(); } catch(e) {} httpReader = null; }
    addActivity('system', 'Generation stopped');
  }

  function restoreSendButton() {
    var btn = document.getElementById('oc-send');
    if (btn && btn.dataset.ocOriginal) {
      btn.innerHTML = btn.dataset.ocOriginal;
      btn.title = '';
      btn.classList.remove('oc-abort-mode');
      delete btn.dataset.ocOriginal;
    }
  }

  function showStopButton() {
    var btn = document.getElementById('oc-send');
    if (btn && !btn.dataset.ocOriginal) {
      btn.dataset.ocOriginal = btn.innerHTML;
      btn.innerHTML = '&#x25A0;';
      btn.title = 'Stop generation';
      btn.classList.add('oc-abort-mode');
    }
  }

  // ── WebSocket persistent chat (chat.send) ──
  var wsHasReadScope = false;
  var wsSessionKey = 'agent:claude:main';
  var wsChatRunId = '';
  var wsChatBotEl = null;
  var wsChatFullText = '';
  var wsChatGotFirst = false;
  var availableModels = [];

  function handleWsChatEvent(msg) {
    if (!sending || !wsChatRunId) return false;
    if (msg.type !== 'event') return false;
    var p = msg.payload;
    if (!p || p.runId !== wsChatRunId) return false;

    var container = document.getElementById('oc-messages');
    if (!container) return false;
    var s = getSession();

    if (msg.event === 'agent' && p.stream === 'assistant' && p.data) {
      var text = p.data.text || '';
      if (text && !wsChatGotFirst) {
        wsChatGotFirst = true;
        hideLoading();
        if (window.ocRenderBotMsg) {
          wsChatBotEl = window.ocRenderBotMsg(container);
        } else {
          var div = document.createElement('div');
          div.className = 'oc-msg oc-msg-bot';
          div.style.cssText = 'padding:8px 12px;margin-bottom:8px;border-radius:8px;background:rgba(34,197,94,0.1);font-size:14px;line-height:1.6;white-space:pre-wrap;';
          container.appendChild(div);
          wsChatBotEl = div;
        }
      }
      if (text) {
        wsChatFullText = text;
        pendingFullText = text;
        if (wsChatBotEl) {
          if (window.ocOnStreamChunk) window.ocOnStreamChunk(wsChatBotEl, text);
          else wsChatBotEl.textContent = text;
        }
        scrollBottom(container);
      }
      return true;
    }

    // Consume lifecycle start/end for the active run (suppress "Agent spawned"/"Agent finished" noise)
    if (msg.event === 'agent' && p.stream === 'lifecycle' && p.data) {
      if (p.data.phase === 'start') return true; // silently consume
      if (p.data.phase === 'end') return true;   // chat 'final' handles completion
    }

    if (msg.event === 'chat' && p.state === 'final') {
      var content = '';
      if (p.message && p.message.content) {
        if (typeof p.message.content === 'string') content = p.message.content;
        else if (Array.isArray(p.message.content)) {
          content = p.message.content.map(function(c) { return c.text || ''; }).join('');
        }
      }
      if (!content) content = wsChatFullText;
      if (!wsChatGotFirst) hideLoading();
      if (s) {
        s.history.push({ role: 'assistant', content: content });
        s.messages.push({ role: 'assistant', content: content });
        addActivity('receive', content.length > 60 ? content.slice(0, 60) + '...' : content);
        if (wsChatBotEl && window.ocRenderMarkdown) {
          wsChatBotEl.innerHTML = window.ocRenderMarkdown(content);
        }
        saveAll();
        renderSidebar();
      }
      sending = false;
      restoreSendButton();
      stopStreamCounter();
      pendingFullText = '';
      pendingSessionId = '';
      wsChatRunId = '';
      wsChatBotEl = null;
      wsChatFullText = '';
      wsChatGotFirst = false;
      scrollBottom(container);
      wsSend({ type: 'req', id: 'sl', method: 'sessions.list', params: { limit: 5 } });
      return true;
    }

    if (msg.event === 'agent' && p.stream === 'lifecycle' && p.data && p.data.phase === 'error') {
      hideLoading();
      if (s) { addActivity('error', p.data.error || p.data.errorMessage || 'Agent error'); }
      sending = false;
      restoreSendButton();
      stopStreamCounter();
      wsChatRunId = '';
      return true;
    }

    return false;
  }

  // ── Send ──
  function send(text) {
    if (sending || !text.trim()) return;
    var container = document.getElementById('oc-messages');
    if (!container) return;
    if (!token) { showTokenPrompt(container, text); return; }

    var s = getSession();
    if (!s) return;

    sending = true;
    showStopButton();
    pendingFullText = '';
    pendingSessionId = activeId;
    streamStartTime = Date.now();
    startStreamCounter();
    addActivity('send', text.length > 60 ? text.slice(0, 60) + '...' : text);
    renderMessage(container, 'user', text);
    s.messages.push({ role: 'user', content: text });
    s.history.push({ role: 'user', content: text });
    // Update session name from first message
    if (s.messages.length === 1) {
      s.name = text.length > 30 ? text.slice(0, 30) + '...' : text;
      renderSidebar();
    }
    saveAll();
    showLoading(container);

    // Prefer WebSocket chat.send (persistent session) over HTTP (stateless)
    if (wsHasReadScope && ws && ws.readyState === 1) {
      var runId = 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      wsChatRunId = runId;
      wsChatBotEl = null;
      wsChatFullText = '';
      wsChatGotFirst = false;
      wsSend({
        type: 'req', id: 'cs-' + runId, method: 'chat.send',
        params: { sessionKey: wsSessionKey, message: text, idempotencyKey: runId }
      });
      return;
    }

    // Fallback: HTTP SSE (stateless, new agent per request)
    var botEl = null;
    var fullText = '';

    fetch(API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ model: MODEL, messages: s.history, stream: true })
    }).then(function(res) {
      if (res.status === 401) {
        token = '';
        try { localStorage.removeItem('oc_token'); } catch(e) {}
        s.history.pop(); s.messages.pop(); saveAll();
        hideLoading();
        if (window.ocRenderBotMsg) {
          botEl = window.ocRenderBotMsg(container);
        } else {
          botEl = document.createElement('div');
          botEl.className = 'oc-msg oc-msg-bot';
          botEl.style.cssText = 'padding:8px 12px;margin-bottom:8px;border-radius:8px;background:rgba(34,197,94,0.1);font-size:14px;line-height:1.6;';
          container.appendChild(botEl);
        }
        botEl.textContent = 'Token expired or invalid.';
        botEl.style.color = '#fbbf24';
        sending = false;
        restoreSendButton();
        stopStreamCounter();
        pendingSessionId = '';
        showTokenPrompt(container, text);
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);

      // Don't hide loading yet — wait for first content chunk
      var reader = res.body.getReader();
      httpReader = reader;
      var decoder = new TextDecoder();
      var buffer = '';
      var gotFirstChunk = false;
      function read() {
        return reader.read().then(function(result) {
          if (result.done) {
            if (!gotFirstChunk) hideLoading(); // stream ended with no content
            s.history.push({ role: 'assistant', content: fullText });
            s.messages.push({ role: 'assistant', content: fullText });
            addActivity('receive', fullText.length > 60 ? fullText.slice(0, 60) + '...' : fullText);
            // Re-render final message with markdown
            if (botEl && window.ocRenderMarkdown) {
              botEl.innerHTML = window.ocRenderMarkdown(fullText);
            }
            saveAll();
            renderSidebar();
            sending = false;
            restoreSendButton();
            stopStreamCounter();
            pendingFullText = '';
            pendingSessionId = '';
            scrollBottom(container);
            // Refresh stats after response completes
            wsSend({ type: 'req', id: 'sl', method: 'sessions.list', params: { limit: 5 } });
            return;
          }
          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line.startsWith('data: ')) continue;
            var data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              var parsed = JSON.parse(data);
              var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
              if (delta && delta.content) {
                // First real content — hide loading and create bot element
                if (!gotFirstChunk) {
                  gotFirstChunk = true;
                  hideLoading();
                  if (window.ocRenderBotMsg) {
                    botEl = window.ocRenderBotMsg(container);
                  } else {
                    var div = document.createElement('div');
                    div.className = 'oc-msg oc-msg-bot';
                    div.style.cssText = 'padding:8px 12px;margin-bottom:8px;border-radius:8px;background:rgba(34,197,94,0.1);font-size:14px;line-height:1.6;white-space:pre-wrap;';
                    container.appendChild(div);
                    botEl = div;
                  }
                }
                fullText += delta.content;
                pendingFullText = fullText;
                if (window.ocOnStreamChunk) { window.ocOnStreamChunk(botEl, fullText); }
                else { botEl.textContent = fullText; }
                scrollBottom(container);
              }
            } catch(e) {}
          }
          return read();
        });
      }
      return read();
    }).catch(function(err) {
      hideLoading();
      if (!botEl) {
        if (window.ocRenderBotMsg) {
          botEl = window.ocRenderBotMsg(container);
        } else {
          botEl = document.createElement('div');
          botEl.className = 'oc-msg oc-msg-bot';
          botEl.style.cssText = 'padding:8px 12px;margin-bottom:8px;border-radius:8px;font-size:14px;';
          container.appendChild(botEl);
        }
      }
      botEl.textContent = 'Error: ' + err.message;
      botEl.style.color = '#ef4444';
      addActivity('error', err.message);
      sending = false;
      restoreSendButton();
      stopStreamCounter();
      pendingSessionId = '';
    });
  }

  // ── New Chat ──
  function newChat() {
    var id = genId();
    sessions[id] = { name: 'New Chat', history: [], messages: [], createdAt: Date.now() };
    activeId = id;
    saveAll();
    var container = document.getElementById('oc-messages');
    if (container) container.innerHTML = '';
    renderSidebar();
    // Create server-side session
    if (wsHasReadScope && ws && ws.readyState === 1) {
      wsSend({ type: 'req', id: 'sc-' + id, method: 'sessions.create', params: { label: 'New Chat' } });
    }
  }

  // ── Delete Session ──
  function deleteSession(id) {
    if (!sessions[id]) return;
    var serverKey = sessions[id].serverKey;
    if (serverKey && wsHasReadScope && ws && ws.readyState === 1) {
      wsSend({ type: 'req', id: 'sd-' + Date.now(), method: 'sessions.delete', params: { key: serverKey } });
    }
    delete sessions[id];
    var ids = Object.keys(sessions);
    if (ids.length === 0) {
      newChat();
    } else if (id === activeId) {
      activeId = ids[0];
      wsSessionKey = sessions[activeId].serverKey || 'agent:claude:main';
      var container = document.getElementById('oc-messages');
      if (container) renderAllMessages(container);
    }
    saveAll();
    renderSidebar();
  }

  // ── Export ──
  function exportChat() {
    var s = getSession();
    if (!s || s.messages.length === 0) return;
    var text = s.messages.map(function(m) {
      return (m.role === 'user' ? 'You' : 'OpenClaw') + ':\n' + m.content;
    }).join('\n\n---\n\n');
    var blob = new Blob([text], { type: 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'openclaw-chat-' + new Date().toISOString().slice(0, 10) + '.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── Search ──
  function toggleSearch() {
    var container = document.getElementById('oc-messages');
    if (!container) return;
    var existing = document.getElementById('oc-search-bar');
    if (existing) { existing.remove(); return; }
    var bar = document.createElement('div');
    bar.id = 'oc-search-bar';
    bar.style.cssText = 'position:sticky;top:0;z-index:10;padding:8px;background:rgba(15,15,15,0.95);border-bottom:1px solid #333;display:flex;gap:8px;';
    bar.innerHTML = '<input id="oc-search-input" type="text" placeholder="Search messages..." style="flex:1;padding:6px 10px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e0e0e0;font-size:13px;outline:none;" />' +
      '<button id="oc-search-clear" style="padding:6px 10px;background:#333;border:none;border-radius:6px;color:#aaa;font-size:12px;cursor:pointer;">Clear</button>';
    container.insertBefore(bar, container.firstChild);
    var searchInput = document.getElementById('oc-search-input');
    searchInput.focus();
    searchInput.addEventListener('input', function() {
      var q = searchInput.value.toLowerCase();
      var msgs = container.querySelectorAll('.message, .oc-msg');
      for (var i = 0; i < msgs.length; i++) {
        msgs[i].style.display = (!q || msgs[i].textContent.toLowerCase().indexOf(q) !== -1) ? '' : 'none';
      }
    });
    document.getElementById('oc-search-clear').addEventListener('click', function() {
      bar.remove();
      var msgs = container.querySelectorAll('.message, .oc-msg');
      for (var i = 0; i < msgs.length; i++) msgs[i].style.display = '';
    });
  }

  // ── Settings ──
  function showSettings() {
    var existing = document.getElementById('oc-settings-modal');
    if (existing) { existing.remove(); return; }
    var s = getSession();
    var msgCount = s ? s.messages.length : 0;
    var sessionCount = Object.keys(sessions).length;
    var overlay = document.createElement('div');
    overlay.id = 'oc-settings-modal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:1000;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML =
      '<div style="background:#1a1d27;border:1px solid #333;border-radius:12px;padding:24px;max-width:400px;width:90%;color:#e0e0e0;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;"><span style="font-size:16px;font-weight:600;">Settings</span><button id="oc-settings-close" style="background:none;border:none;color:#666;font-size:20px;cursor:pointer;">&times;</button></div>' +
        '<div style="font-size:12px;color:#888;margin-bottom:12px;">Gateway Token</div>' +
        '<div style="display:flex;gap:8px;margin-bottom:16px;">' +
          '<input id="oc-settings-token" type="password" value="' + escHtml(token) + '" style="flex:1;padding:8px;background:#0f1117;border:1px solid #333;border-radius:6px;color:#e0e0e0;font-size:12px;font-family:monospace;" />' +
          '<button id="oc-settings-save-token" style="padding:8px 12px;background:#22c55e;border:none;border-radius:6px;color:white;font-size:12px;font-weight:600;cursor:pointer;">Save</button>' +
        '</div>' +
        '<div style="font-size:12px;color:#888;margin-bottom:8px;">Session</div>' +
        '<div style="font-size:12px;color:#aaa;margin-bottom:16px;">' + sessionCount + ' session(s), ' + msgCount + ' messages in active chat</div>' +
        '<div style="display:flex;gap:8px;margin-bottom:8px;">' +
          '<button id="oc-settings-export" style="flex:1;padding:8px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#aaa;font-size:12px;cursor:pointer;">Export Chat</button>' +
          '<button id="oc-settings-clear" style="flex:1;padding:8px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);border-radius:6px;color:#ef4444;font-size:12px;cursor:pointer;">Delete Session</button>' +
        '</div>' +
        '<button id="oc-settings-clear-all" style="width:100%;padding:8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;color:#ef4444;font-size:11px;cursor:pointer;opacity:0.7;">Clear All Sessions</button>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('oc-settings-close').addEventListener('click', function() { overlay.remove(); });
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
    document.getElementById('oc-settings-save-token').addEventListener('click', function() {
      var t = document.getElementById('oc-settings-token').value.trim();
      if (t) { saveToken(t); overlay.remove(); }
    });
    document.getElementById('oc-settings-export').addEventListener('click', function() { exportChat(); overlay.remove(); });
    document.getElementById('oc-settings-clear').addEventListener('click', function() { deleteSession(activeId); overlay.remove(); });
    document.getElementById('oc-settings-clear-all').addEventListener('click', function() { clearAllSessions(); overlay.remove(); });
  }

  // ── Init ──
  function init() {
    token = loadToken();
    loadAll();

    // Ensure at least one session exists
    if (Object.keys(sessions).length === 0) {
      var id = genId();
      sessions[id] = { name: 'New Chat', history: [], messages: [], createdAt: Date.now() };
      activeId = id;
      saveAll();
    }
    if (!activeId || !sessions[activeId]) {
      activeId = Object.keys(sessions)[0];
      saveAll();
    }
    // Ensure default session has a server key
    var defS = sessions[activeId];
    if (defS && !defS.serverKey) { defS.serverKey = wsSessionKey; saveAll(); }

    var input = document.getElementById('oc-input');
    var sendBtn = document.getElementById('oc-send');
    var newChatBtn = document.getElementById('oc-new-chat');
    var exportBtn = document.getElementById('oc-export');
    var searchBtn = document.getElementById('oc-search');
    var settingsBtn = document.getElementById('oc-settings');
    var container = document.getElementById('oc-messages');
    if (!input || !container) return;

    // Render existing messages + sidebar + activity
    renderAllMessages(container);
    renderSidebar();
    renderActivity();

    if (!token) showTokenPrompt(container, null);

    // Detect unanswered user message (e.g. reload before response arrived)
    var s = getSession();
    if (s && s.history.length > 0 && s.history[s.history.length - 1].role === 'user' && token) {
      var lastUserText = s.history[s.history.length - 1].content;
      var retryDiv = document.createElement('div');
      retryDiv.id = 'oc-retry-notice';
      retryDiv.style.cssText = 'padding:10px 14px;margin-bottom:8px;border-radius:8px;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.25);font-size:12px;color:#fbbf24;display:flex;align-items:center;justify-content:space-between;gap:8px;';
      retryDiv.innerHTML =
        '<span>Last message didn\'t receive a response.</span>' +
        '<button id="oc-retry-btn" style="padding:5px 12px;background:#fbbf24;color:#000;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">Retry</button>';
      container.appendChild(retryDiv);
      container.scrollTop = container.scrollHeight;
      document.getElementById('oc-retry-btn').addEventListener('click', function() {
        retryDiv.remove();
        // Remove the unanswered user message so send() re-adds it cleanly
        var cs = getSession();
        if (cs) {
          if (cs.history.length > 0 && cs.history[cs.history.length - 1].role === 'user') cs.history.pop();
          if (cs.messages.length > 0 && cs.messages[cs.messages.length - 1].role === 'user') cs.messages.pop();
          // Remove the rendered user message so it doesn't duplicate
          var msgs = container.querySelectorAll('.message, .oc-msg');
          if (msgs.length > 0) msgs[msgs.length - 1].remove();
          saveAll();
        }
        send(lastUserText);
      });
    }

    input.addEventListener('input', function() { updateInputCounter(input); });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        var text = input.value; input.value = ''; input.style.height = 'auto'; updateInputCounter(input); send(text);
      }
    });
    if (sendBtn) sendBtn.addEventListener('click', function() {
      if (sending) { abortGeneration(); return; }
      var text = input.value; input.value = ''; input.style.height = 'auto'; updateInputCounter(input); send(text);
    });
    if (newChatBtn) newChatBtn.addEventListener('click', newChat);
    if (exportBtn) exportBtn.addEventListener('click', exportChat);
    if (searchBtn) searchBtn.addEventListener('click', toggleSearch);
    if (settingsBtn) settingsBtn.addEventListener('click', showSettings);
  }

  // ── WebSocket for live gateway events (agent, tool, session stats) ──
  // Uses Ed25519 device identity for full operator.read access (auto-paired on localhost)
  var ws = null;
  var wsReqId = 0;
  var wsDeviceKeys = null; // { keypair, pubB64url, deviceId }

  function b64url(buf) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function initDeviceKeys() {
    if (wsDeviceKeys) return Promise.resolve(wsDeviceKeys);
    return crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']).then(function(kp) {
      return crypto.subtle.exportKey('raw', kp.publicKey).then(function(raw) {
        return crypto.subtle.digest('SHA-256', raw).then(function(hash) {
          wsDeviceKeys = {
            keypair: kp,
            pubB64url: b64url(raw),
            deviceId: Array.from(new Uint8Array(hash)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('')
          };
          return wsDeviceKeys;
        });
      });
    });
  }

  function connectWs() {
    if (!token || ws) return;
    initDeviceKeys().then(function(dev) {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      try { ws = new WebSocket(proto + '//' + location.host + '/v1/'); } catch(e) { return; }

      ws.onmessage = function(evt) {
        try {
          var msg = JSON.parse(evt.data);
          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            var nonce = msg.payload.nonce;
            var signedAt = Date.now();
            var scopes = ['operator.read', 'operator.write'];
            var payloadStr = ['v3', dev.deviceId, 'openclaw-control-ui', 'webchat', 'operator',
              scopes.join(','), String(signedAt), token, nonce, 'web', ''].join('|');
            crypto.subtle.sign('Ed25519', dev.keypair.privateKey, new TextEncoder().encode(payloadStr)).then(function(sig) {
              wsSend({
                type: 'req', id: 'c' + (++wsReqId), method: 'connect',
                params: {
                  minProtocol: 3, maxProtocol: 3,
                  client: { id: 'openclaw-control-ui', displayName: 'Custom UI', mode: 'webchat', version: '2026.3.24', platform: 'web' },
                  role: 'operator', scopes: scopes, auth: { token: token },
                  device: { id: dev.deviceId, publicKey: dev.pubB64url, signature: b64url(sig), nonce: nonce, signedAt: signedAt },
                  caps: ['tool-events']
                }
              });
            });
          } else if (msg.type === 'res' && msg.ok && !msg.error) {
            // After connect success, fetch stats + history + models
            if (msg.payload && msg.payload.type === 'hello-ok') {
              wsHasReadScope = true;
              wsSend({ type: 'req', id: 'sl', method: 'sessions.list', params: { limit: 5 } });
              wsSend({ type: 'req', id: 'ch', method: 'chat.history', params: { sessionKey: wsSessionKey, limit: 100 } });
              wsSend({ type: 'req', id: 'ml', method: 'models.list', params: {} });
            }
            // Handle sessions.list response → update stats + model subtitle
            if (msg.id === 'sl' && msg.payload && msg.payload.sessions) {
              var sess = msg.payload.sessions;
              var defaults = msg.payload.defaults || {};
              if (sess.length > 0) {
                var latest = sess[0];
                var modelName = latest.model || defaults.model;
                if (window.ocUpdateStats) window.ocUpdateStats({
                  connected: true, model: modelName,
                  contextTokens: latest.contextTokens || defaults.contextTokens,
                  totalTokens: latest.totalTokens, totalTokensFresh: latest.totalTokensFresh,
                  estimatedCostUsd: latest.estimatedCostUsd,
                  inputTokens: latest.inputTokens, outputTokens: latest.outputTokens,
                  sessionCount: msg.payload.count
                });
                var subtitleEl = document.getElementById('oc-model-subtitle');
                if (subtitleEl) subtitleEl.textContent = modelName || '';
              }
            }
            // Handle chat.history response → load server-side messages
            if (msg.id === 'ch' && msg.payload && msg.payload.messages) {
              loadServerHistory(msg.payload.messages);
            }
            // Handle models.list response
            if (msg.id === 'ml' && msg.payload && msg.payload.models) {
              availableModels = msg.payload.models;
              renderModelPicker();
            }
            // Handle sessions.create response → link local session to server key
            if (msg.id && msg.id.startsWith('sc-') && msg.payload && msg.payload.key) {
              var localId = msg.id.slice(3);
              if (sessions[localId]) {
                sessions[localId].serverKey = msg.payload.key;
                wsSessionKey = msg.payload.key;
                saveAll();
              }
            }
            // Handle sessions.patch response → update resolved model
            if (msg.id && msg.id.startsWith('sp-') && msg.payload && msg.payload.resolved) {
              var resolved = msg.payload.resolved;
              var sub = document.getElementById('oc-model-subtitle');
              if (sub && resolved.model) sub.textContent = resolved.model;
              if (window.ocUpdateStats) window.ocUpdateStats({ model: resolved.model });
            }
          } else if (msg.type === 'event') {
            if (!handleWsChatEvent(msg)) {
              handleWsEvent(msg.event, msg.payload);
            }
          }
        } catch(e) {}
      };

      ws.onclose = function() { ws = null; wsHasReadScope = false; setTimeout(function() { connectWs(); }, 5000); };
      ws.onerror = function() {};
    }).catch(function() {
      // Ed25519 not supported — fallback to simple webchat-ui connection
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      try { ws = new WebSocket(proto + '//' + location.host + '/v1/'); } catch(e) { return; }
      ws.onmessage = function(evt) {
        try {
          var msg = JSON.parse(evt.data);
          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            wsSend({
              type: 'req', id: 'c' + (++wsReqId), method: 'connect',
              params: {
                minProtocol: 3, maxProtocol: 3,
                client: { id: 'webchat-ui', displayName: 'Custom UI', mode: 'webchat', version: '1.0.0', platform: 'web' },
                role: 'operator', auth: { token: token }, caps: ['tool-events']
              }
            });
          } else if (msg.type === 'event') { handleWsEvent(msg.event, msg.payload); }
        } catch(e) {}
      };
      ws.onclose = function() { ws = null; setTimeout(function() { connectWs(); }, 5000); };
      ws.onerror = function() {};
    });
  }

  function wsSend(data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
  }

  function handleWsEvent(event, payload) {
    if (!payload) return;

    if (event === 'agent') {
      var stream = payload.stream || '';
      var d = payload.data || {};
      if (stream === 'lifecycle') {
        if (d.phase === 'start') addActivity('system', 'Agent spawned');
        else if (d.phase === 'end') addActivity('system', 'Agent finished' + (d.stopReason ? ' (' + d.stopReason + ')' : ''));
        else if (d.phase === 'error') addActivity('error', 'Agent error: ' + (d.error || d.errorMessage || 'unknown'));
      } else if (stream === 'tool') {
        if (d.phase === 'start') addActivity('system', 'Tool: ' + (d.name || d.title || 'unknown'));
      }
    }

    if (event === 'health') {
      // Extract model/session info from health event
      var stats = {};
      if (payload.agents && payload.agents.length > 0) {
        var agent = payload.agents[0];
        stats.model = agent.model || agent.agentId;
      }
      if (payload.sessions) {
        stats.sessionCount = payload.sessions.count;
      }
      stats.connected = true;
      if (window.ocUpdateStats) window.ocUpdateStats(stats);
    }

    if (event === 'sessions.changed') {
      if (window.ocUpdateStats) window.ocUpdateStats(payload);
    }

    if (event === 'session.tool') {
      var td = payload.data || payload;
      if (td.phase === 'start') addActivity('system', 'Tool: ' + (td.name || td.title || 'unknown'));
    }
  }

  function clearAllSessions() {
    sessions = {};
    activeId = '';
    newChat();
  }

  // ── Server-side history loading ──
  function loadServerHistory(serverMsgs) {
    var s = getSession();
    if (!s || !serverMsgs || serverMsgs.length === 0) return;
    // Only replace if server has more data or local is empty
    if (s.messages.length >= serverMsgs.length) return;
    s.messages = serverMsgs.map(function(m) {
      var content = typeof m.content === 'string' ? m.content :
        (Array.isArray(m.content) ? m.content.map(function(c) { return c.text || ''; }).join('') : '');
      return { role: m.role, content: content };
    }).filter(function(m) { return m.role === 'user' || m.role === 'assistant'; });
    s.history = s.messages.slice();
    saveAll();
    var container = document.getElementById('oc-messages');
    if (container) renderAllMessages(container);
    renderSidebar();
  }

  // ── Model picker ──
  function renderModelPicker() {
    var el = document.getElementById('oc-model-subtitle');
    if (!el || availableModels.length === 0) return;
    el.style.cursor = 'pointer';
    el.title = 'Click to change model';
    el.addEventListener('click', function(e) {
      e.stopPropagation();
      showModelDropdown(el);
    });
  }

  function showModelDropdown(anchor) {
    var existing = document.getElementById('oc-model-dropdown');
    if (existing) { existing.remove(); return; }
    var dd = document.createElement('div');
    dd.id = 'oc-model-dropdown';
    dd.style.cssText = 'position:fixed;z-index:200;background:#1a1d27;border:1px solid #333;border-radius:8px;padding:4px;min-width:220px;max-height:300px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,0.4);';
    var rect = anchor.getBoundingClientRect();
    dd.style.top = (rect.bottom + 4) + 'px';
    dd.style.left = rect.left + 'px';
    availableModels.forEach(function(m) {
      var modelId = typeof m === 'string' ? m : (m.id || m.name || '');
      if (!modelId) return;
      var item = document.createElement('div');
      item.style.cssText = 'padding:8px 12px;cursor:pointer;border-radius:4px;font-size:12px;color:#e0e0e0;transition:background 0.1s;';
      item.textContent = modelId;
      item.addEventListener('mouseenter', function() { item.style.background = '#333'; });
      item.addEventListener('mouseleave', function() { item.style.background = ''; });
      item.addEventListener('click', function() { switchModel(modelId); dd.remove(); });
      dd.appendChild(item);
    });
    document.body.appendChild(dd);
    setTimeout(function() {
      document.addEventListener('click', function closeDd(e) {
        if (!dd.contains(e.target) && e.target !== anchor) { dd.remove(); document.removeEventListener('click', closeDd); }
      });
    }, 0);
  }

  function switchModel(modelId) {
    if (!wsHasReadScope || !ws || ws.readyState !== 1) return;
    wsSend({ type: 'req', id: 'sp-' + Date.now(), method: 'sessions.patch', params: { key: wsSessionKey, model: modelId } });
    var sub = document.getElementById('oc-model-subtitle');
    if (sub) sub.textContent = modelId;
    if (window.ocUpdateStats) window.ocUpdateStats({ model: modelId });
    addActivity('system', 'Model → ' + modelId);
  }

  window.ocSend = send;
  window.ocNewChat = newChat;
  window.ocExportChat = exportChat;
  window.ocToggleSearch = toggleSearch;
  window.ocShowSettings = showSettings;
  window.ocSwitchSession = switchSession;
  window.ocDeleteSession = deleteSession;
  window.ocClearAllSessions = clearAllSessions;
  window.ocAbortGeneration = abortGeneration;
  window.ocSwitchModel = switchModel;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { init(); connectWs(); });
  } else {
    init();
    connectWs();
  }
})();
