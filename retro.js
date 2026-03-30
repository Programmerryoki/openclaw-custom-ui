// v9 retro renderers + particles + version switcher
function createParticles() {
    var particles = document.getElementById('particles');
    for (var i = 0; i < 20; i++) {
        var particle = document.createElement('div');
        particle.className = 'particle';
        particle.style.left = Math.random() * 100 + '%';
        particle.style.animationDelay = Math.random() * 3 + 's';
        particle.style.animationDuration = (Math.random() * 2 + 2) + 's';
        particles.appendChild(particle);
    }
}
createParticles();

// Auto-resize textarea
var textarea = document.getElementById('oc-input');
if (textarea) {
    textarea.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
    });
}

// Version switcher localStorage sync
document.querySelectorAll('.vsw a').forEach(function(el) {
    el.addEventListener('click', function() {
        var v = el.textContent.trim().toLowerCase();
        try { localStorage.setItem('openclawUIVersion', v); } catch(e) {}
    });
});

// Custom renderers for v9 retro style
function ocTime() {
    return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

window.ocRenderUserMsg = function(container, text) {
    var div = document.createElement('div');
    div.className = 'message user';
    div.innerHTML = '<div class="message-bubble"><div class="message-author" style="text-align:right;">PLAYER_1 <span style="color:#666;font-size:5px;">' + ocTime() + '</span></div><div class="message-text"></div></div>';
    div.querySelector('.message-text').textContent = text.toUpperCase();
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
};

window.ocRenderBotMsg = function(container) {
    var div = document.createElement('div');
    div.className = 'message';
    div.innerHTML = '<div class="message-bubble"><div class="message-author">OPENCLAW_BOT <span style="color:#666;font-size:5px;">' + ocTime() + '</span></div><div class="message-text"></div></div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div.querySelector('.message-text');
};

window.ocOnStreamChunk = function(el, fullText) {
    el.textContent = fullText.toUpperCase();
};

// Loading indicator — render as retro bot message
window.ocShowLoading = function(container, dotsHtml) {
    var div = document.createElement('div');
    div.id = 'oc-loading';
    div.className = 'message';
    div.innerHTML = '<div class="message-avatar"><div class="pixel-sprite"></div></div>' +
        '<div class="message-bubble"><div class="message-author">OPENCLAW_BOT</div>' +
        '<div class="message-text" style="color:#fbbf24;">' + dotsHtml + ' THINKING...</div></div>';
    container.appendChild(div);
};

window.ocHideLoading = function() {
    var el = document.getElementById('oc-loading');
    if (el) el.remove();
};

// RPG stats update handler
function fmtTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
}

window.ocUpdateStats = function(data) {
    var hpEl = document.getElementById('oc-stat-hp');
    var mpEl = document.getElementById('oc-stat-mp');
    var goldEl = document.getElementById('oc-stat-gold');
    var lvlEl = document.getElementById('oc-stat-lvl');

    var ctxEl = document.getElementById('oc-stat-ctx');

    if (data.contextTokens != null && data.totalTokens != null) {
        var max = data.contextTokens;
        var used = data.totalTokens;
        var remaining = max - used;
        var pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
        if (hpEl) hpEl.textContent = 'HP: ' + fmtTokens(remaining > 0 ? remaining : 0) + '/' + fmtTokens(max);
        if (mpEl) mpEl.textContent = 'MP: ' + fmtTokens(used) + '/' + fmtTokens(max);
        if (ctxEl) ctxEl.textContent = 'CTX: ' + fmtTokens(used) + '/' + fmtTokens(max) + ' (' + pct + '%)';
    }
    if (data.estimatedCostUsd != null && goldEl) {
        goldEl.textContent = 'GOLD: $' + data.estimatedCostUsd.toFixed(3);
    }
    if (data.totalTokens != null && lvlEl) {
        var lvl = Math.floor(data.totalTokens / 1000) + 1;
        lvlEl.textContent = 'LVL: ' + lvl;
    }
};

// Custom sidebar renderer (retro style)
window.ocRenderSidebar = function(el, ids, sessions, activeId) {
    el.innerHTML = ids.map(function(id) {
        var s = sessions[id];
        var active = id === activeId;
        var msgCount = s.messages ? s.messages.length : 0;
        var name = (s.name || 'NEW QUEST').toUpperCase();
        return '<div class="session-item' + (active ? ' active' : '') + '" data-sid="' + id + '">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + name + '</div>' +
                '<button class="oc-del-btn" data-del="' + id + '" style="background:none;border:none;color:#555;font-family:\'Press Start 2P\',monospace;font-size:6px;cursor:pointer;padding:0 2px;line-height:1;flex-shrink:0;" title="Delete">X</button>' +
            '</div>' +
            '<div style="font-size:6px;color:#666;margin-top:4px;">LVL ' + msgCount + ' • ' + msgCount + ' msgs</div>' +
        '</div>';
    }).join('');
};
