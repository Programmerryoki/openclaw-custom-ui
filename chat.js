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
  var messageQueue = [];   // Queue for messages sent while agent is thinking
  var sendTimeoutId = null; // Watchdog timer for stuck thinking
  var SEND_TIMEOUT_MS = 180000; // 3 minutes max thinking time
  var QUEUE_KEY = 'oc_msg_queue';
  var BUSY_KEY = 'oc_agent_busy'; // Persists sending state across reloads
  var serverSessionRunning = false; // True if sessions.list reported status=running

  function saveQueue() { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(messageQueue)); } catch(e) {} }
  function loadQueue() { try { var r = localStorage.getItem(QUEUE_KEY); if (r) messageQueue = JSON.parse(r); } catch(e) {} }
  function markBusy() { try { localStorage.setItem(BUSY_KEY, Date.now().toString()); } catch(e) {} }
  function clearBusy() { try { localStorage.removeItem(BUSY_KEY); } catch(e) {} }
  function wasBusy() { try { var t = localStorage.getItem(BUSY_KEY); return t ? parseInt(t, 10) : 0; } catch(e) { return 0; } }

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

  // Strip OpenClaw server metadata from user messages loaded via chat.history
  // Server prepends: System: [...] lines, Sender (untrusted metadata) blocks, [timestamp] prefix
  function stripServerMetadata(text) {
    if (!text) return text;
    var lines = text.split('\n');
    var startIdx = 0;
    var inSenderBlock = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // Skip System: [...] lines
      if (/^System:\s*\[/.test(line)) { startIdx = i + 1; continue; }
      // Skip Sender (untrusted metadata) block
      if (/^Sender\s*\(untrusted\s+metadata\)/.test(line)) { inSenderBlock = true; startIdx = i + 1; continue; }
      if (inSenderBlock) {
        startIdx = i + 1;
        if (line.trim() === '```' || line.trim() === '') { inSenderBlock = false; }
        continue;
      }
      // Skip [Day YYYY-MM-DD HH:MM TZ] timestamp prefix on the actual message line
      var tsMatch = line.match(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*(.*)/);
      if (tsMatch) {
        lines[i] = tsMatch[1]; // Keep only the text after timestamp
        startIdx = i;
        break;
      }
      // If line doesn't match any metadata pattern, it's the start of actual content
      if (line.trim() && !/^System:|^Sender|^\[/.test(line)) {
        startIdx = i;
        break;
      }
    }
    return lines.slice(startIdx).join('\n').trim();
  }

  function renderMessage(container, role, content) {
    // Skip empty messages
    if (!content || !content.trim()) return;
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
    var icons = { send: '\uD83D\uDCE4', receive: '\uD83E\uDD9E', error: '\u26A0\uFE0F', system: '\u2699\uFE0F', queued: '\uD83D\uDCCB' };
    el.innerHTML = items.slice().reverse().map(function(a) {
      var time = a.time ? new Date(a.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
      var icon = icons[a.type] || '\uD83D\uDD35';
      var colors = { send: '#667eea', receive: '#22c55e', error: '#ef4444', system: '#fbbf24', queued: '#a78bfa' };
      var color = colors[a.type] || '#888';
      return '<div style="padding:6px 10px;margin-bottom:3px;background:#1a1a1a;border-radius:6px;border-left:3px solid ' + color + ';font-size:11px;">' +
        '<div style="font-size:9px;color:#666;margin-bottom:1px;">' + time + '</div>' +
        '<div style="color:#aaa;">' + icon + ' ' + escHtml(a.text) + '</div>' +
      '</div>';
    }).join('');
  }

  // ── Agent Stream Logs (bottom half of activity panel) ──
  // Tracks spawned agents with per-agent tabs and streaming logs
  var agentRuns = {};       // { runId: { label, status, logs: [], startedAt } }
  var activeAgentTab = '';  // Currently selected agent tab runId
  var agentLogsDismissed = false; // User closed the agent logs section
  var AGENT_LOGS_KEY = 'oc_agent_logs';

  function saveAgentLogs() {
    try {
      localStorage.setItem(AGENT_LOGS_KEY, JSON.stringify({ runs: agentRuns, active: activeAgentTab, dismissed: agentLogsDismissed }));
    } catch(e) {}
  }

  function loadAgentLogs() {
    try {
      var raw = localStorage.getItem(AGENT_LOGS_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        agentRuns = data.runs || {};
        activeAgentTab = data.active || '';
        agentLogsDismissed = data.dismissed || false;
        // Validate activeAgentTab still exists
        if (activeAgentTab && !agentRuns[activeAgentTab]) {
          var ids = Object.keys(agentRuns);
          activeAgentTab = ids.length > 0 ? ids[ids.length - 1] : '';
        }
      }
    } catch(e) {}
  }

  function addAgentLog(runId, type, text) {
    if (!agentRuns[runId]) return;
    agentRuns[runId].logs.push({ type: type, text: text, time: Date.now() });
    if (agentRuns[runId].logs.length > 200) agentRuns[runId].logs = agentRuns[runId].logs.slice(-200);
    saveAgentLogs();
    if (activeAgentTab === runId) renderAgentLogEntries();
  }

  function onAgentStart(runId, label) {
    agentRuns[runId] = { label: label || 'Agent', status: 'running', logs: [], startedAt: Date.now() };
    if (!activeAgentTab) activeAgentTab = runId;
    agentLogsDismissed = false;
    saveAgentLogs();
    renderAgentLogs();
  }

  function onAgentEnd(runId, reason) {
    if (!agentRuns[runId]) return;
    agentRuns[runId].status = reason === 'error' ? 'error' : 'stopped';
    addAgentLog(runId, 'lifecycle', reason === 'error' ? 'Agent error' : 'Agent finished' + (reason ? ' (' + reason + ')' : ''));
    saveAgentLogs();
    renderAgentTabs();
  }

  function closeAgentTab(runId) {
    delete agentRuns[runId];
    var ids = Object.keys(agentRuns);
    if (activeAgentTab === runId) activeAgentTab = ids.length > 0 ? ids[ids.length - 1] : '';
    if (ids.length === 0) agentLogsDismissed = true;
    saveAgentLogs();
    renderAgentLogs();
  }

  function closeAllAgentLogs() {
    agentLogsDismissed = true;
    saveAgentLogs();
    renderAgentLogs();
  }

  function selectAgentTab(runId) {
    activeAgentTab = runId;
    saveAgentLogs();
    renderAgentTabs();
    renderAgentLogEntries();
  }

  function fmtLogTime(ts) {
    var d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  function renderAgentLogs() {
    var container = document.getElementById('oc-agent-logs');
    if (!container) return;
    var ids = Object.keys(agentRuns);
    if (ids.length === 0 || agentLogsDismissed) {
      container.style.display = 'none';
      container.innerHTML = '';
      return;
    }
    container.style.display = 'flex';
    container.innerHTML =
      '<div class="oc-alog-header">' +
        '<span class="oc-alog-title">Agent Logs</span>' +
        '<button class="oc-alog-close" title="Close logs">\u00D7</button>' +
      '</div>' +
      '<div class="oc-alog-tabs" id="oc-alog-tabs"></div>' +
      '<div class="oc-alog-entries" id="oc-alog-entries"></div>';

    container.querySelector('.oc-alog-close').addEventListener('click', closeAllAgentLogs);
    renderAgentTabs();
    renderAgentLogEntries();
  }

  function renderAgentTabs() {
    var tabsEl = document.getElementById('oc-alog-tabs');
    if (!tabsEl) return;
    var ids = Object.keys(agentRuns);
    tabsEl.innerHTML = ids.map(function(id) {
      var r = agentRuns[id];
      var active = id === activeAgentTab;
      var statusDot = r.status === 'running' ? '\uD83D\uDFE2' : (r.status === 'error' ? '\uD83D\uDD34' : '\u26AA');
      return '<div class="oc-alog-tab' + (active ? ' active' : '') + '" data-agent-id="' + id + '">' +
        '<span class="oc-alog-tab-dot">' + statusDot + '</span>' +
        '<span class="oc-alog-tab-label">' + escHtml(r.label) + '</span>' +
        '<button class="oc-alog-tab-close" data-close-agent="' + id + '" title="Close">\u00D7</button>' +
      '</div>';
    }).join('');

    tabsEl.querySelectorAll('.oc-alog-tab').forEach(function(tabEl) {
      tabEl.addEventListener('click', function(e) {
        if (e.target.classList.contains('oc-alog-tab-close')) return;
        selectAgentTab(tabEl.getAttribute('data-agent-id'));
      });
    });
    tabsEl.querySelectorAll('.oc-alog-tab-close').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        closeAgentTab(btn.getAttribute('data-close-agent'));
      });
    });
  }

  function renderAgentLogEntries() {
    var el = document.getElementById('oc-alog-entries');
    if (!el || !activeAgentTab || !agentRuns[activeAgentTab]) return;
    var logs = agentRuns[activeAgentTab].logs;
    if (logs.length === 0) {
      el.innerHTML = '<div style="padding:12px;text-align:center;color:#555;font-size:10px;">Waiting for agent output...</div>';
      return;
    }
    var logColors = { tool: '#fbbf24', assistant: '#22c55e', output: '#22c55e', lifecycle: '#667eea', error: '#ef4444' };
    var logIcons = { tool: '\uD83D\uDD27', assistant: '\uD83D\uDCAC', output: '\uD83D\uDCAC', lifecycle: '\u2699\uFE0F', error: '\u26A0\uFE0F' };
    el.innerHTML = logs.map(function(l) {
      var color = logColors[l.type] || '#888';
      var icon = logIcons[l.type] || '\uD83D\uDD35';
      // Output entries get a special multi-line style
      if (l.type === 'output') {
        return '<div class="oc-alog-entry" style="border-left-color:' + color + ';white-space:pre-wrap;line-height:1.4;padding:4px 6px;">' +
          '<span class="oc-alog-time">' + fmtLogTime(l.time) + '</span> ' +
          '<span style="color:' + color + ';">' + icon + '</span> ' +
          '<span class="oc-alog-text">' + escHtml(l.text) + '</span></div>';
      }
      return '<div class="oc-alog-entry" style="border-left-color:' + color + ';">' +
        '<span class="oc-alog-time">' + fmtLogTime(l.time) + '</span> ' +
        '<span style="color:' + color + ';">' + icon + '</span> ' +
        '<span class="oc-alog-text">' + escHtml(l.text) + '</span>' +
      '</div>';
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  function injectAgentLogStyles() {
    if (document.getElementById('oc-alog-styles')) return;
    var style = document.createElement('style');
    style.id = 'oc-alog-styles';
    style.textContent =
      '#oc-agent-logs{display:none;flex-direction:column;border-top:1px solid #2a2a3a;min-height:120px;flex:1;overflow:hidden;}' +
      '.oc-alog-header{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#111;border-bottom:1px solid #2a2a3a;flex-shrink:0;}' +
      '.oc-alog-title{font-size:11px;font-weight:600;color:#ccc;text-transform:uppercase;letter-spacing:0.5px;}' +
      '.oc-alog-close{background:none;border:none;color:#666;font-size:16px;cursor:pointer;padding:0 4px;line-height:1;}' +
      '.oc-alog-close:hover{color:#ef4444;}' +
      '.oc-alog-tabs{display:flex;gap:0;overflow-x:auto;flex-shrink:0;background:#0d0d0d;border-bottom:1px solid #1e1e2e;}' +
      '.oc-alog-tab{display:flex;align-items:center;gap:4px;padding:5px 10px;font-size:10px;color:#888;cursor:pointer;border-right:1px solid #1e1e2e;white-space:nowrap;flex-shrink:0;}' +
      '.oc-alog-tab.active{background:#1a1a2e;color:#e0e0e0;}' +
      '.oc-alog-tab:hover{background:#1a1a2e;}' +
      '.oc-alog-tab-dot{font-size:8px;}' +
      '.oc-alog-tab-label{max-width:80px;overflow:hidden;text-overflow:ellipsis;}' +
      '.oc-alog-tab-close{background:none;border:none;color:#555;font-size:12px;cursor:pointer;padding:0 2px;line-height:1;flex-shrink:0;}' +
      '.oc-alog-tab-close:hover{color:#ef4444;}' +
      '.oc-alog-entries{flex:1;overflow-y:auto;padding:4px 6px;min-height:0;font-family:monospace;}' +
      '.oc-alog-entry{padding:2px 6px;margin-bottom:1px;font-size:10px;color:#aaa;border-left:2px solid #333;line-height:1.5;}' +
      '.oc-alog-time{color:#555;font-size:9px;}' +
      '.oc-alog-text{word-break:break-word;}' +
      /* Light theme overrides */
      '@media (prefers-color-scheme:light){' +
        '#oc-agent-logs{border-top-color:#e5e7eb;}' +
        '.oc-alog-header{background:#f8f9fa;border-bottom-color:#e5e7eb;}' +
        '.oc-alog-title{color:#333;}' +
        '.oc-alog-tabs{background:#fff;border-bottom-color:#e5e7eb;}' +
        '.oc-alog-tab{color:#666;border-right-color:#e5e7eb;}' +
        '.oc-alog-tab.active{background:#eef2ff;color:#333;}' +
        '.oc-alog-entry{color:#555;border-left-color:#ddd;}' +
        '.oc-alog-time{color:#999;}' +
      '}';
    document.head.appendChild(style);
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

  // ── Throttled streaming markdown render ──
  var streamRenderTimer = null;
  var streamRenderEl = null;
  var streamRenderText = '';
  var streamRenderActive = false; // true once first markdown render has been applied
  var STREAM_RENDER_INTERVAL = 300; // ms between markdown re-renders during streaming

  function scheduleStreamRender(el, text) {
    if (!window.ocRenderMarkdown) return;
    streamRenderEl = el;
    streamRenderText = text;
    if (streamRenderTimer) return; // Already scheduled
    streamRenderTimer = setTimeout(function() {
      streamRenderTimer = null;
      if (streamRenderEl && streamRenderText) {
        var rendered = window.ocRenderMarkdown(streamRenderText);
        if (rendered) {
          streamRenderEl.innerHTML = rendered;
          streamRenderActive = true;
          var container = document.getElementById('oc-messages');
          if (container) container.scrollTop = container.scrollHeight;
        }
        // If render produced nothing, keep showing textContent (don't wipe)
      }
    }, STREAM_RENDER_INTERVAL);
  }

  function applyStreamText(el, text) {
    // Always show text immediately, then schedule formatted render
    if (!streamRenderActive) {
      el.textContent = text;
    }
    // Schedule throttled markdown render (updates streamRenderText for pending timer)
    scheduleStreamRender(el, text);
  }

  // Fixed thinking bar above input — doesn't scroll with messages
  // Detect if page uses light theme
  function isLightTheme() { return document.body && getComputedStyle(document.body).backgroundColor.indexOf('255') !== -1; }

  function showThinkingBar() {
    if (document.getElementById('oc-thinking-bar')) return;
    var inputArea = document.querySelector('.input-area') || document.querySelector('.chat-input-area');
    if (!inputArea) return;
    var light = isLightTheme();
    var bar = document.createElement('div');
    bar.id = 'oc-thinking-bar';
    bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 16px;font-size:12px;' +
      (light ? 'background:#f0f4ff;border-top:1px solid #e5e7eb;color:#4f46e5;' : 'background:#12121a;border-top:1px solid #2a2a3a;color:#8b9cf7;');
    bar.innerHTML = loadingDots + ' <span>Agent is thinking...</span>';
    inputArea.parentElement.insertBefore(bar, inputArea);
  }

  function hideThinkingBar() {
    var bar = document.getElementById('oc-thinking-bar');
    if (bar) bar.remove();
  }

  // Show thinking state after reload when agent is still working
  function enterPendingReloadState() {
    showThinkingBar();
    sending = true;
    showStopButton();
    wsChatRunId = 'pending-reload';
    pendingSessionId = activeId;
    streamStartTime = Date.now();
    startStreamCounter();
  }

  function cancelStreamRender() {
    if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
    streamRenderEl = null;
    streamRenderText = '';
    streamRenderActive = false;
  }

  // ── Loading indicator ──
  var loadingDots = '<span style="display:inline-flex;gap:5px;vertical-align:middle;overflow:visible;">' +
    '<span style="width:6px;height:6px;border-radius:50%;background:#667eea;animation:oc-dot 1.4s 0s infinite both;"></span>' +
    '<span style="width:6px;height:6px;border-radius:50%;background:#667eea;animation:oc-dot 1.4s 0.2s infinite both;"></span>' +
    '<span style="width:6px;height:6px;border-radius:50%;background:#667eea;animation:oc-dot 1.4s 0.4s infinite both;"></span>' +
    '</span>';

  function showLoading(container) {
    // Inject animation if not already present (opacity-only to avoid clipping with overflow-x:hidden)
    if (!document.getElementById('oc-loading-style')) {
      var style = document.createElement('style');
      style.id = 'oc-loading-style';
      style.textContent = '@keyframes oc-dot{0%,80%,100%{opacity:0.2}40%{opacity:1}}';
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
      // Don't send placeholder runId — abort by sessionKey only to catch all active runs
      var abortRunId = (wsChatRunId && wsChatRunId !== 'pending-reload') ? wsChatRunId : undefined;
      wsSend({ type: 'req', id: 'abort-' + Date.now(), method: 'chat.abort', params: { sessionKey: wsSessionKey, runId: abortRunId } });
    }
    if (httpReader) { try { httpReader.cancel(); } catch(e) {} httpReader = null; }
    cancelStreamRender();
    var hadQueued = messageQueue.length;
    messageQueue = []; saveQueue(); // Clear queue on manual abort
    renderQueueUI();
    addActivity('system', 'Generation stopped' + (hadQueued > 0 ? ' (' + hadQueued + ' queued cleared)' : ''));
    // Reset state but don't process queue (we just cleared it)
    hideLoading();
    sending = false;
    restoreSendButton();
    stopStreamCounter();
    clearSendTimeout();
    pendingFullText = '';
    pendingSessionId = '';
    wsChatRunId = '';
    wsChatBotEl = null;
    wsChatFullText = '';
    wsChatGotFirst = false;
  }

  // Reset sending state when stuck or disconnected
  function resetSendingState(reason) {
    if (!sending) return;
    cancelStreamRender();
    hideLoading();
    sending = false;
    restoreSendButton();
    stopStreamCounter();
    pendingFullText = '';
    pendingSessionId = '';
    wsChatRunId = '';
    wsChatBotEl = null;
    wsChatFullText = '';
    wsChatGotFirst = false;
    clearSendTimeout();
    addActivity('error', reason || 'Connection lost during generation');
    processQueue(); // Try next queued message
  }

  function startSendTimeout() {
    clearSendTimeout();
    sendTimeoutId = setTimeout(function() {
      if (sending) {
        resetSendingState('Generation timed out (no response for ' + Math.round(SEND_TIMEOUT_MS / 1000) + 's)');
      }
    }, SEND_TIMEOUT_MS);
  }

  function clearSendTimeout() {
    if (sendTimeoutId) { clearTimeout(sendTimeoutId); sendTimeoutId = null; }
  }

  function restoreSendButton() {
    var btn = document.getElementById('oc-send');
    if (btn && btn.dataset.ocOriginal) {
      btn.innerHTML = btn.dataset.ocOriginal;
      btn.title = '';
      btn.classList.remove('oc-abort-mode');
      delete btn.dataset.ocOriginal;
    }
    hideThinkingBar();
    clearBusy();
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

  function extractMessageText(p) {
    if (!p || !p.message) return '';
    var c = p.message.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(function(x) { return x.text || ''; }).join('');
    return '';
  }

  function handleWsChatEvent(msg) {
    if (!sending || !wsChatRunId) return false;
    if (msg.type !== 'event') return false;
    var p = msg.payload;
    if (!p) return false;

    // Match by runId OR sessionKey (ACPX may use different runId for events)
    var runMatch = (p.runId === wsChatRunId);
    var sessionMatch = (p.sessionKey === wsSessionKey);
    if (!runMatch && !sessionMatch) return false;
    if (!runMatch && sessionMatch && p.runId && msg.event === 'chat') {
      wsChatRunId = p.runId; // Adopt server's runId
    }

    var container = document.getElementById('oc-messages');
    if (!container) return false;
    var s = getSession();

    // Handle streaming text — from chat.delta OR agent assistant events
    var streamText = '';
    if (msg.event === 'chat' && p.state === 'delta') {
      streamText = extractMessageText(p);
    } else if (msg.event === 'agent' && p.stream === 'assistant' && p.data) {
      streamText = p.data.text || '';
    }
    if (streamText) {
      if (!wsChatGotFirst) {
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
      wsChatFullText = streamText;
      pendingFullText = streamText;
      startSendTimeout();
      if (wsChatBotEl) applyStreamText(wsChatBotEl, streamText);
      scrollBottom(container);
      return true;
    }
    // Consume empty agent assistant events
    if (msg.event === 'agent' && p.stream === 'assistant') return true;

    // Consume lifecycle start/end for the active run (suppress "Agent spawned"/"Agent finished" noise)
    if (msg.event === 'agent' && p.stream === 'lifecycle' && p.data) {
      if (p.data.phase === 'start') { startSendTimeout(); return true; } // agent started, reset timeout
      if (p.data.phase === 'end') return true;   // chat 'final' handles completion
    }

    if (msg.event === 'chat' && p.state === 'final') {
      cancelStreamRender();
      var content = extractMessageText(p);
      if (!content) content = wsChatFullText;
      if (!wsChatGotFirst) hideLoading();

      if (s && content && content.trim()) {
        // Content available — render directly
        if (!wsChatBotEl) {
          if (window.ocRenderBotMsg) {
            wsChatBotEl = window.ocRenderBotMsg(container);
          } else {
            var div = document.createElement('div');
            div.className = 'oc-msg oc-msg-bot';
            div.style.cssText = 'padding:8px 12px;margin-bottom:8px;border-radius:8px;background:rgba(34,197,94,0.1);font-size:14px;line-height:1.6;';
            container.appendChild(div);
            wsChatBotEl = div;
          }
        }
        s.history.push({ role: 'assistant', content: content });
        s.messages.push({ role: 'assistant', content: content });
        addActivity('receive', content.length > 60 ? content.slice(0, 60) + '...' : content);
        if (wsChatBotEl && window.ocRenderMarkdown) {
          wsChatBotEl.innerHTML = window.ocRenderMarkdown(content);
        } else if (wsChatBotEl) {
          wsChatBotEl.textContent = content;
        }
        saveAll();
        renderSidebar();
      } else if (s) {
        // ACPX persistent sessions: content not in chat.final event
        // Remove empty bot bubble if one was created
        if (wsChatBotEl && wsChatBotEl.parentElement) {
          var msgEl = wsChatBotEl.closest('.message') || wsChatBotEl.closest('.oc-msg');
          if (msgEl) msgEl.remove(); else wsChatBotEl.remove();
        }
        // Keep sending=true — agent may still be working. Switch to pending-reload mode.
        wsChatRunId = 'pending-reload';
        wsChatBotEl = null;
        wsChatFullText = '';
        wsChatGotFirst = false;
        pendingFullText = '';
        showThinkingBar();
        // Poll history to get the response once ACPX persists it
        setTimeout(function() {
          wsSend({ type: 'req', id: 'ch', method: 'chat.history', params: { sessionKey: wsSessionKey, limit: 100 } });
        }, 2000);
        wsSend({ type: 'req', id: 'sl', method: 'sessions.list', params: { limit: 5 } });
        return true;
      }
      sending = false;
      restoreSendButton();
      stopStreamCounter();
      clearSendTimeout();
      pendingFullText = '';
      pendingSessionId = '';
      wsChatRunId = '';
      wsChatBotEl = null;
      wsChatFullText = '';
      wsChatGotFirst = false;
      scrollBottom(container);
      wsSend({ type: 'req', id: 'sl', method: 'sessions.list', params: { limit: 5 } });
      processQueue();
      return true;
    }

    if (msg.event === 'agent' && p.stream === 'lifecycle' && p.data && p.data.phase === 'error') {
      hideLoading();
      if (s) { addActivity('error', p.data.error || p.data.errorMessage || 'Agent error'); }
      sending = false;
      restoreSendButton();
      stopStreamCounter();
      clearSendTimeout();
      wsChatRunId = '';
      processQueue();
      return true;
    }

    // Tool events for active run — reset timeout (agent is alive), but let them fall through to activity panel
    if (msg.event === 'agent' && p.stream === 'tool') {
      startSendTimeout(); // Agent is using tools, reset timeout
    }
    return false;
  }

  // ── Send ──
  function send(text) {
    if (!text.trim()) return;
    var container = document.getElementById('oc-messages');
    if (!container) return;
    if (!token) { showTokenPrompt(container, text); return; }

    // Queue message if already sending
    if (sending) {
      messageQueue.push(text); saveQueue();
      renderQueueUI();
      addActivity('queued', 'Queued: ' + (text.length > 40 ? text.slice(0, 40) + '...' : text));
      return;
    }

    var s = getSession();
    if (!s) return;

    sending = true;
    markBusy();
    showStopButton();
    startSendTimeout();
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
    showThinkingBar();

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
        clearSendTimeout();
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
            cancelStreamRender();
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
            clearSendTimeout();
            pendingFullText = '';
            pendingSessionId = '';
            scrollBottom(container);
            // Refresh stats after response completes
            wsSend({ type: 'req', id: 'sl', method: 'sessions.list', params: { limit: 5 } });
            processQueue();
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
                applyStreamText(botEl, fullText);
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
      clearSendTimeout();
      pendingSessionId = '';
      processQueue();
    });
  }

  // ── Process queued messages ──
  function processQueue() {
    if (messageQueue.length === 0) return;
    var nextText = messageQueue.shift(); saveQueue();
    renderQueueUI();
    // Send via the normal send() flow after a short delay
    setTimeout(function() { send(nextText); }, 500);
  }

  // ── Queue UI ──
  function getQueueContainer() {
    var el = document.getElementById('oc-queue');
    if (!el) {
      // Create queue container above the input area
      var inputArea = document.querySelector('.input-area') || document.querySelector('.chat-input-area');
      if (!inputArea) return null;
      el = document.createElement('div');
      el.id = 'oc-queue';
      inputArea.parentElement.insertBefore(el, inputArea);
    }
    return el;
  }

  // Steer: interrupt agent and send message immediately
  function steerAgent(text) {
    if (!text || !text.trim()) return;
    if (!wsHasReadScope || !ws || ws.readyState !== 1) return;
    addActivity('system', 'Steering agent: ' + (text.length > 40 ? text.slice(0, 40) + '...' : text));
    // Use sessions.steer to interrupt the active run and send new message
    var steerRunId = 'steer-' + Date.now();
    wsSend({
      type: 'req', id: 'st-' + steerRunId, method: 'sessions.steer',
      params: { key: wsSessionKey, message: text }
    });
    // Add to local history
    var s = getSession();
    if (s) {
      s.messages.push({ role: 'user', content: text });
      s.history.push({ role: 'user', content: text });
      var container = document.getElementById('oc-messages');
      if (container) { renderMessage(container, 'user', text); scrollBottom(container); }
      saveAll();
      renderSidebar();
    }
    // Reset into sending state for the steered message
    hideThinkingBar();
    sending = true;
    markBusy();
    showStopButton();
    wsChatRunId = 'pending-reload'; // Will be resolved by chat.final or history
    showThinkingBar();
    startSendTimeout();
  }

  function renderQueueUI() {
    var el = getQueueContainer();
    if (!el) return;
    if (messageQueue.length === 0) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.style.display = 'block';
    var isAgentBusy = sending;
    el.innerHTML =
      '<div class="oc-queue-header">' +
        '<span class="oc-queue-title">\uD83D\uDCCB Queued (' + messageQueue.length + ')</span>' +
        '<button class="oc-queue-clear" title="Clear all">Clear all</button>' +
      '</div>' +
      '<div class="oc-queue-items">' +
      messageQueue.map(function(text, idx) {
        return '<div class="oc-queue-item" data-qi="' + idx + '">' +
          '<span class="oc-queue-num">' + (idx + 1) + '</span>' +
          '<textarea class="oc-queue-input" data-qidx="' + idx + '" rows="1">' + escHtml(text) + '</textarea>' +
          '<div class="oc-queue-actions">' +
            (isAgentBusy ? '<button class="oc-queue-steer" data-qs="' + idx + '" title="Interrupt agent and send now">Steer</button>' : '') +
            '<button class="oc-queue-cancel" data-qc="' + idx + '" title="Remove">\u00D7</button>' +
          '</div>' +
        '</div>';
      }).join('') +
      '</div>';

    // Clear all
    el.querySelector('.oc-queue-clear').addEventListener('click', function() {
      messageQueue = []; saveQueue();
      renderQueueUI();
      addActivity('system', 'Queue cleared');
    });
    // Steer buttons
    el.querySelectorAll('.oc-queue-steer').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(btn.getAttribute('data-qs'), 10);
        if (idx >= 0 && idx < messageQueue.length) {
          var text = messageQueue.splice(idx, 1)[0]; saveQueue();
          renderQueueUI();
          steerAgent(text);
        }
      });
    });
    // Cancel individual
    el.querySelectorAll('.oc-queue-cancel').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(btn.getAttribute('data-qc'), 10);
        if (idx >= 0 && idx < messageQueue.length) {
          var removed = messageQueue.splice(idx, 1)[0]; saveQueue();
          addActivity('system', 'Cancelled: ' + (removed.length > 40 ? removed.slice(0, 40) + '...' : removed));
          renderQueueUI();
        }
      });
    });
    // Edit in place with auto-resize
    el.querySelectorAll('.oc-queue-input').forEach(function(ta) {
      // Auto-resize textarea
      function autoResize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; }
      autoResize();
      ta.addEventListener('input', function() {
        var idx = parseInt(ta.getAttribute('data-qidx'), 10);
        if (idx >= 0 && idx < messageQueue.length) {
          messageQueue[idx] = ta.value;
          saveQueue();
        }
        autoResize();
      });
      ta.addEventListener('blur', function() {
        var idx = parseInt(ta.getAttribute('data-qidx'), 10);
        if (idx >= 0 && idx < messageQueue.length && !messageQueue[idx].trim()) {
          messageQueue.splice(idx, 1); saveQueue();
          renderQueueUI();
        }
      });
    });
  }

  function injectQueueStyles() {
    if (document.getElementById('oc-queue-styles')) return;
    var style = document.createElement('style');
    style.id = 'oc-queue-styles';
    style.textContent =
      '#oc-queue{display:none;padding:8px 16px;border-top:1px solid #2a2a3a;background:#12121a;max-height:200px;overflow-y:auto;}' +
      '.oc-queue-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}' +
      '.oc-queue-title{font-size:11px;font-weight:600;color:#a78bfa;}' +
      '.oc-queue-clear{background:none;border:1px solid #333;color:#888;font-size:10px;padding:2px 8px;border-radius:4px;cursor:pointer;}' +
      '.oc-queue-clear:hover{color:#ef4444;border-color:#ef4444;}' +
      '.oc-queue-items{display:flex;flex-direction:column;gap:4px;}' +
      '.oc-queue-item{display:flex;align-items:flex-start;gap:6px;padding:6px 8px;background:#1a1a2e;border-radius:6px;border-left:3px solid #a78bfa;}' +
      '.oc-queue-num{font-size:9px;color:#a78bfa;font-weight:700;flex-shrink:0;width:14px;text-align:center;padding-top:5px;}' +
      '.oc-queue-input{flex:1;background:transparent;border:1px solid transparent;color:#ccc;font-size:12px;font-family:inherit;outline:none;padding:4px 6px;resize:none;overflow:hidden;border-radius:4px;line-height:1.5;}' +
      '.oc-queue-input:focus{color:#fff;border-color:#a78bfa33;background:#1a1a2e;}' +
      '.oc-queue-actions{display:flex;flex-direction:column;gap:3px;flex-shrink:0;padding-top:2px;}' +
      '.oc-queue-steer{background:#f59e0b;color:#000;border:none;font-size:9px;font-weight:700;padding:3px 8px;border-radius:4px;cursor:pointer;white-space:nowrap;}' +
      '.oc-queue-steer:hover{background:#d97706;}' +
      '.oc-queue-cancel{background:none;border:none;color:#555;font-size:16px;cursor:pointer;padding:0 4px;line-height:1;flex-shrink:0;}' +
      '.oc-queue-cancel:hover{color:#ef4444;}' +
      /* Light theme overrides */
      '[data-oc-theme="light"] #oc-queue{background:#f0f4ff;border-top-color:#e5e7eb;}' +
      '[data-oc-theme="light"] .oc-queue-item{background:#e8ecf5;}' +
      '[data-oc-theme="light"] .oc-queue-input{color:#333;}' +
      '[data-oc-theme="light"] .oc-queue-input:focus{color:#000;background:#fff;}' +
      '[data-oc-theme="light"] .oc-queue-clear{border-color:#ccc;color:#666;}';
    document.head.appendChild(style);
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

    // Clean up empty messages and test texts from all sessions
    var testPatterns = ['PINEAPPLE_TEST_123', 'say exactly: HELLO_WORLD', 'reply with just: test123',
      'respond with exactly: Hello World Test', 'say hello in exactly 3 words',
      'reply with exactly one word: pineapple', 'respond with exactly: PINEAPPLE_TEST_123',
      'say hi', 'Say hello in one word'];
    var cleaned = false;
    function isTestMsg(c) {
      for (var t = 0; t < testPatterns.length; t++) { if (c === testPatterns[t]) return true; }
      return false;
    }
    Object.keys(sessions).forEach(function(sid) {
      var sess = sessions[sid];
      if (sess.messages) {
        var before = sess.messages.length;
        sess.messages = sess.messages.filter(function(m) { return m.content && m.content.trim() && !isTestMsg(m.content); });
        if (sess.messages.length < before) cleaned = true;
      }
      if (sess.history) {
        sess.history = sess.history.filter(function(m) { return m.content && m.content.trim() && !isTestMsg(m.content); });
      }
    });
    if (cleaned) saveAll();

    var input = document.getElementById('oc-input');
    var sendBtn = document.getElementById('oc-send');
    var newChatBtn = document.getElementById('oc-new-chat');
    var exportBtn = document.getElementById('oc-export');
    var searchBtn = document.getElementById('oc-search');
    var settingsBtn = document.getElementById('oc-settings');
    var container = document.getElementById('oc-messages');
    if (!input || !container) return;

    // Inject styles and detect theme
    if (isLightTheme()) document.body.setAttribute('data-oc-theme', 'light');
    injectAgentLogStyles();
    injectQueueStyles();
    var agentLogsDiv = document.getElementById('oc-agent-logs');
    if (!agentLogsDiv) {
      agentLogsDiv = document.createElement('div');
      agentLogsDiv.id = 'oc-agent-logs';
      // Find the best parent: activity panel wrapper (flex column container)
      var logParent = document.querySelector('.oc-activity-panel') || document.querySelector('.oc-sidebar-panel');
      if (logParent) logParent.appendChild(agentLogsDiv);
    }

    // Load persisted agent logs
    loadAgentLogs();

    // Render existing messages + sidebar + activity + agent logs
    renderAllMessages(container);
    renderSidebar();
    renderActivity();
    if (Object.keys(agentRuns).length > 0 && !agentLogsDismissed) renderAgentLogs();

    if (!token) showTokenPrompt(container, null);

    // Load persisted queue and render if any
    loadQueue();
    if (messageQueue.length > 0) renderQueueUI();

    // Auto-resize textarea as user types
    function autoResizeInput() {
      input.style.height = 'auto';
      var maxH = Math.min(input.scrollHeight, 200); // Cap at 200px
      input.style.height = maxH + 'px';
    }
    input.addEventListener('input', function() { updateInputCounter(input); autoResizeInput(); });
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
          } else if (msg.type === 'res') {
            // Handle error responses (chat.send fail, abort fail, etc.)
            if (msg.error || msg.ok === false) {
              if (msg.id && msg.id.startsWith('cs-')) {
                addActivity('error', 'Send failed: ' + (msg.error ? msg.error.message || JSON.stringify(msg.error) : 'unknown'));
                resetSendingState('Send failed: ' + (msg.error ? msg.error.message : 'unknown'));
              }
              if (msg.id && msg.id.startsWith('abort-')) {
                addActivity('error', 'Abort failed: ' + (msg.error ? msg.error.message : 'unknown'));
              }
              if (msg.id && msg.id.startsWith('st-')) {
                addActivity('error', 'Steer failed: ' + (msg.error ? msg.error.message || JSON.stringify(msg.error) : 'unknown'));
              }
            }
            // After connect success, fetch stats + history + models
            if (msg.payload && msg.payload.type === 'hello-ok') {
              wsHasReadScope = true;
              wsSend({ type: 'req', id: 'sl', method: 'sessions.list', params: { limit: 5 } });
              wsSend({ type: 'req', id: 'ch', method: 'chat.history', params: { sessionKey: wsSessionKey, limit: 100 } });
              wsSend({ type: 'req', id: 'ml', method: 'models.list', params: {} });
              // Subscribe to real-time message events for this session (cross-tab sync)
              wsSend({ type: 'req', id: 'ms', method: 'sessions.messages.subscribe', params: { key: wsSessionKey } });
              // Agent busy detection now handled by sessions.list response (status === 'running')
            }
            // Handle sessions.list response → update stats + model subtitle + detect busy
            if (msg.id === 'sl' && msg.payload && msg.payload.sessions) {
              // Check if main session agent is currently running (cross-browser detection)
              var mainSess = null;
              for (var si = 0; si < msg.payload.sessions.length; si++) {
                if (msg.payload.sessions[si].key === wsSessionKey) { mainSess = msg.payload.sessions[si]; break; }
              }
              if (mainSess && mainSess.status === 'running') {
                serverSessionRunning = true;
                if (!sending) enterPendingReloadState();
              } else {
                serverSessionRunning = false;
                // Agent stopped — clear pending state if we were waiting
                if (sending && wsChatRunId === 'pending-reload') {
                  wsSend({ type: 'req', id: 'ch', method: 'chat.history', params: { sessionKey: wsSessionKey, limit: 100 } });
                }
              }
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
            // Handle chat.abort success response
            if (msg.id && msg.id.startsWith('abort-') && msg.payload && msg.payload.ok) {
              addActivity('system', 'Abort confirmed' + (msg.payload.aborted ? '' : ' (no active run)'));
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

      ws.onclose = function() {
        ws = null; wsHasReadScope = false;
        if (sending) resetSendingState('WebSocket disconnected during generation');
        setTimeout(function() { connectWs(); }, 5000);
      };
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
      ws.onclose = function() {
        ws = null;
        if (sending) resetSendingState('WebSocket disconnected during generation');
        setTimeout(function() { connectWs(); }, 5000);
      };
      ws.onerror = function() {};
    });
  }

  function wsSend(data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
  }

  function handleWsEvent(event, payload) {
    if (!payload) return;
    var runId = payload.runId || '';

    if (event === 'agent') {
      var stream = payload.stream || '';
      var d = payload.data || {};

      if (stream === 'lifecycle') {
        if (d.phase === 'start') {
          addActivity('system', 'Agent spawned');
          // Create agent log tab
          var label = d.agentId || d.name || 'Agent';
          if (runId) onAgentStart(runId, label);
        } else if (d.phase === 'end') {
          var reason = d.stopReason || '';
          addActivity('system', 'Agent finished' + (reason ? ' (' + reason + ')' : ''));
          if (runId) onAgentEnd(runId, reason);
        } else if (d.phase === 'error') {
          addActivity('error', 'Agent error: ' + (d.error || d.errorMessage || 'unknown'));
          if (runId) {
            addAgentLog(runId, 'error', d.error || d.errorMessage || 'Unknown error');
            onAgentEnd(runId, 'error');
          }
        }
      } else if (stream === 'tool') {
        var toolName = d.name || d.title || 'unknown';
        if (d.phase === 'start') {
          addActivity('system', 'Tool: ' + toolName);
          if (runId && agentRuns[runId]) {
            addAgentLog(runId, 'tool', toolName + (d.input ? ': ' + (typeof d.input === 'string' ? d.input.slice(0, 100) : JSON.stringify(d.input).slice(0, 100)) : ''));
          }
        } else if (d.phase === 'end' || d.phase === 'result') {
          if (runId && agentRuns[runId]) {
            var result = d.result || d.partialResult || '';
            if (typeof result !== 'string') result = JSON.stringify(result);
            addAgentLog(runId, 'tool', toolName + ' \u2192 ' + (result.length > 120 ? result.slice(0, 120) + '...' : result));
          }
        }
      } else if (stream === 'assistant') {
        // Agent text output — keep one rolling "output" entry instead of many deltas
        if (runId && agentRuns[runId] && d.text) {
          agentRuns[runId]._currentText = d.text;
          var logs = agentRuns[runId].logs;
          // Find or create the rolling output entry
          var outputEntry = null;
          for (var li = logs.length - 1; li >= 0; li--) {
            if (logs[li].type === 'output') { outputEntry = logs[li]; break; }
            if (logs[li].type !== 'assistant' && logs[li].type !== 'output') break; // stop at non-text entries
          }
          var preview = d.text.length > 250 ? '...' + d.text.slice(-250) : d.text;
          if (outputEntry) {
            outputEntry.text = preview;
            outputEntry.time = Date.now();
          } else {
            logs.push({ type: 'output', text: preview, time: Date.now() });
          }
          if (activeAgentTab === runId) renderAgentLogEntries();
        }
      }
    }

    if (event === 'health') {
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

    // Real-time session message — just trigger a history refresh to stay in sync
    if (event === 'session.message' && payload && payload.sessionKey === wsSessionKey) {
      // Debounce: don't re-fetch if we just sent a message ourselves
      if (!sending || wsChatRunId === 'pending-reload') {
        wsSend({ type: 'req', id: 'ch', method: 'chat.history', params: { sessionKey: wsSessionKey, limit: 100 } });
      }
    }

    if (event === 'session.tool') {
      var td = payload.data || payload;
      var tRunId = payload.runId || '';
      if (td.phase === 'start') {
        addActivity('system', 'Tool: ' + (td.name || td.title || 'unknown'));
        if (tRunId && agentRuns[tRunId]) {
          addAgentLog(tRunId, 'tool', (td.name || td.title || 'unknown'));
        }
      }
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
    if (!s || !serverMsgs) return;
    var container = document.getElementById('oc-messages');

    var serverParsed = serverMsgs.map(function(m) {
      var content = typeof m.content === 'string' ? m.content :
        (Array.isArray(m.content) ? m.content.map(function(c) { return c.text || ''; }).join('') : '');
      // Strip server metadata from user messages
      if (m.role === 'user' && content) content = stripServerMetadata(content);
      return { role: m.role, content: content };
    }).filter(function(m) { return (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim(); });

    // Server is the source of truth — replace local if different
    var serverLen = serverParsed.length;
    var localLen = s.messages.length;

    // Check if local matches server (compare last message)
    var inSync = (serverLen === localLen);
    if (inSync && serverLen > 0) {
      var sLast = serverParsed[serverLen - 1];
      var lLast = s.messages[localLen - 1];
      if (sLast.role !== lLast.role || sLast.content !== lLast.content) inSync = false;
    }

    if (!inSync && serverLen > 0) {
      s.messages = serverParsed.slice();
      s.history = serverParsed.slice();
      if (container) renderAllMessages(container);
      saveAll();
      scrollBottom(container);
      renderSidebar();
    }

    // Detect agent busy state from server
    var serverLastRole = serverParsed.length > 0 ? serverParsed[serverParsed.length - 1].role : 'none';
    if (sending && wsChatRunId === 'pending-reload') {
      if (serverLastRole === 'assistant' && !serverSessionRunning) {
        // Agent responded AND session is idle — clear pending
        sending = false;
        restoreSendButton();
        stopStreamCounter();
        clearSendTimeout();
        wsChatRunId = '';
        pendingSessionId = '';
        processQueue();
      } else {
        // Agent still working — refresh sessions.list + chat.history periodically
        setTimeout(function() {
          if (sending && wsChatRunId === 'pending-reload') {
            wsSend({ type: 'req', id: 'sl', method: 'sessions.list', params: { limit: 5 } });
            wsSend({ type: 'req', id: 'ch', method: 'chat.history', params: { sessionKey: wsSessionKey, limit: 100 } });
          }
        }, 5000);
      }
    } else if (serverLastRole === 'user' && !sending) {
      enterPendingReloadState();
    }
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

  // ── Cross-tab sync via storage event ──
  // When another tab changes localStorage, re-render to stay in sync
  window.addEventListener('storage', function(e) {
    if (!e.key) return;
    var container = document.getElementById('oc-messages');

    if (e.key === STORE_KEY) {
      // Sessions/messages changed in another tab
      try {
        if (e.newValue) {
          sessions = JSON.parse(e.newValue);
          if (!activeId || !sessions[activeId]) activeId = Object.keys(sessions)[0] || '';
          if (container) renderAllMessages(container);
          renderSidebar();
          renderActivity();
        }
      } catch(ex) {}
    }

    if (e.key === ACTIVE_KEY && e.newValue) {
      // Active session switched in another tab
      if (e.newValue !== activeId && sessions[e.newValue]) {
        activeId = e.newValue;
        wsSessionKey = sessions[activeId].serverKey || 'agent:claude:main';
        if (container) renderAllMessages(container);
        renderSidebar();
        renderActivity();
      }
    }

    if (e.key === QUEUE_KEY) {
      // Queue changed in another tab
      try {
        messageQueue = e.newValue ? JSON.parse(e.newValue) : [];
        renderQueueUI();
      } catch(ex) {}
    }

    if (e.key === AGENT_LOGS_KEY) {
      // Agent logs changed in another tab
      try {
        if (e.newValue) {
          var data = JSON.parse(e.newValue);
          agentRuns = data.runs || {};
          activeAgentTab = data.active || '';
          agentLogsDismissed = data.dismissed || false;
          if (!activeAgentTab || !agentRuns[activeAgentTab]) {
            var ids = Object.keys(agentRuns);
            activeAgentTab = ids.length > 0 ? ids[ids.length - 1] : '';
          }
          renderAgentLogs();
        } else {
          agentRuns = {};
          activeAgentTab = '';
          renderAgentLogs();
        }
      } catch(ex) {}
    }

    if (e.key === BUSY_KEY) {
      // Sending state changed in another tab
      if (e.newValue && !sending) {
        enterPendingReloadState();
      } else if (!e.newValue && sending && wsChatRunId === 'pending-reload') {
        sending = false;
        restoreSendButton();
        stopStreamCounter();
        clearSendTimeout();
        wsChatRunId = '';
        // Refresh messages from server
        wsSend({ type: 'req', id: 'ch', method: 'chat.history', params: { sessionKey: wsSessionKey, limit: 100 } });
      }
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { init(); connectWs(); });
  } else {
    init();
    connectWs();
  }
})();
