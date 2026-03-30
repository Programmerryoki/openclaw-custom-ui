// v7 custom renderers + version switcher
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
    div.innerHTML = '<div class="message-header"><div class="avatar user">R</div><div class="message-author">You</div><span style="font-size:10px;color:#aaa;">' + ocTime() + '</span></div><div class="message-content"></div>';
    div.querySelector('.message-content').textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
};

window.ocRenderBotMsg = function(container) {
    var div = document.createElement('div');
    div.className = 'message';
    div.innerHTML = '<div class="message-header"><div class="avatar">\uD83E\uDD9E</div><div class="message-author">OpenClaw</div><span style="font-size:10px;color:#aaa;">' + ocTime() + '</span></div><div class="message-content"></div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div.querySelector('.message-content');
};

window.ocOnStreamChunk = function(el, fullText) {
    el.textContent = fullText;
};

// Stats update handler
function fmtTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
}

window.ocUpdateStats = function(data) {
    var ctxEl = document.getElementById('oc-stat-context');
    var costEl = document.getElementById('oc-stat-cost');
    var modelEl = document.getElementById('oc-stat-model');

    if (data.contextTokens != null && data.totalTokens != null && ctxEl) {
        ctxEl.textContent = fmtTokens(data.totalTokens) + '/' + fmtTokens(data.contextTokens);
    }
    if (data.estimatedCostUsd != null && costEl) {
        costEl.textContent = '$' + data.estimatedCostUsd.toFixed(4);
    }
    if (data.model && modelEl) {
        modelEl.textContent = data.model;
    }
};
