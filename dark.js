// v1 custom renderers + version switcher
document.querySelectorAll('.vsw a').forEach(function(el) {
    el.addEventListener('click', function() {
        var v = el.textContent.trim();
        try { localStorage.setItem('openclawUIVersion', v); } catch(e) {}
    });
});

function ocTime() {
    return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

window.ocRenderUserMsg = function(container, text) {
    var div = document.createElement('div');
    div.className = 'message user';
    div.innerHTML = '<div class="message-header"><div class="avatar user">R</div><div class="author">You</div><span style="font-size:10px;color:#555;">' + ocTime() + '</span></div><div class="message-text"></div>';
    div.querySelector('.message-text').textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
};

window.ocRenderBotMsg = function(container) {
    var div = document.createElement('div');
    div.className = 'message';
    div.innerHTML = '<div class="message-header"><div class="avatar">\uD83E\uDD9E</div><div class="author">OpenClaw</div><span style="font-size:10px;color:#555;">' + ocTime() + '</span></div><div class="message-text"></div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div.querySelector('.message-text');
};

window.ocOnStreamChunk = function(el, fullText) {
    el.textContent = fullText;
};

// Loading indicator — render as bot message bubble
window.ocShowLoading = function(container, dotsHtml) {
    var div = document.createElement('div');
    div.id = 'oc-loading';
    div.className = 'message';
    div.innerHTML = '<div class="message-header"><div class="avatar">\uD83E\uDD9E</div><div class="author" style="color:#667eea;">OpenClaw</div></div>' +
        '<div class="message-text" style="color:#888;font-size:13px;">' + dotsHtml + ' <span style="margin-left:4px;">Thinking...</span></div>';
    container.appendChild(div);
};

window.ocHideLoading = function() {
    var el = document.getElementById('oc-loading');
    if (el) el.remove();
};

// Wire Settings nav icon
document.querySelectorAll('.nav-icon').forEach(function(el) {
    if (el.dataset.label === 'Settings') {
        el.addEventListener('click', function() { if (window.ocShowSettings) window.ocShowSettings(); });
    }
});

// Stats update handler
function fmtTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
}

window.ocUpdateStats = function(data) {
    var ctxEl = document.getElementById('oc-stat-context');
    var fillEl = document.getElementById('oc-stat-context-fill');
    var pctEl = document.getElementById('oc-stat-context-pct');
    var modelEl = document.getElementById('oc-stat-model');
    var costEl = document.getElementById('oc-stat-cost');

    if (data.totalTokens != null && data.contextTokens != null && ctxEl) {
        var used = data.totalTokens;
        var max = data.contextTokens;
        var pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
        ctxEl.textContent = fmtTokens(used) + '/' + fmtTokens(max);
        if (fillEl) fillEl.style.width = pct + '%';
        if (pctEl) pctEl.textContent = pct + '%';
    }
    if (data.model && modelEl) {
        modelEl.textContent = data.model;
    }
    if (data.estimatedCostUsd != null && costEl) {
        costEl.textContent = '$' + data.estimatedCostUsd.toFixed(4);
    }
};

// Custom sidebar renderer
window.ocRenderSidebar = function(el, ids, sessions, activeId) {
    el.innerHTML = ids.map(function(id) {
        var s = sessions[id];
        var active = id === activeId;
        var msgCount = s.messages ? s.messages.length : 0;
        return '<div class="list-item' + (active ? ' active' : '') + '" data-sid="' + id + '" style="position:relative;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<div class="list-item-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (s.name || 'New Chat') + '</div>' +
                '<button class="oc-del-btn" data-del="' + id + '" style="background:none;border:none;color:#555;font-size:14px;cursor:pointer;padding:0 2px;line-height:1;flex-shrink:0;" title="Delete">&times;</button>' +
            '</div>' +
            '<div class="list-item-meta">' + msgCount + ' messages</div>' +
        '</div>';
    }).join('');
};
