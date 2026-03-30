// OpenClaw Panel Manager — Collapsible + Resizable sidebar and activity panels
// Toggle buttons are created dynamically as thin edge strips between grid cells
// Expects: .oc-sidebar-panel, .oc-activity-panel
// Grid container: .app (or .app[data-grid-base])

(function() {
  'use strict';

  var STORE = 'oc_panels';
  var MIN_SIDEBAR = 180;
  var MIN_ACTIVITY = 240;
  var STRIP_W = 14;
  var state = { sidebarOpen: true, activityOpen: true, sidebarWidth: 0, activityWidth: 0 };

  function load() {
    try { var s = localStorage.getItem(STORE); if (s) state = JSON.parse(s); } catch(e) {}
  }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch(e) {}
  }

  function applyState() {
    var sidebar = document.querySelector('.oc-sidebar-panel');
    var activity = document.querySelector('.oc-activity-panel');
    var app = document.querySelector('.app[data-grid-base]') || document.querySelector('.app');
    if (!app) return;

    if (sidebar) {
      sidebar.style.display = state.sidebarOpen ? '' : 'none';
      if (state.sidebarOpen && state.sidebarWidth) sidebar.style.width = state.sidebarWidth + 'px';
    }
    if (activity) {
      activity.style.display = state.activityOpen ? '' : 'none';
      if (state.activityOpen && state.activityWidth) activity.style.width = state.activityWidth + 'px';
    }

    updateGrid(app, sidebar, activity);
    updateToggles();
  }

  function updateToggles() {
    var ts = document.getElementById('oc-toggle-sidebar');
    var ta = document.getElementById('oc-toggle-activity');
    if (ts) ts.textContent = state.sidebarOpen ? '\u2039' : '\u203A';
    if (ta) ta.textContent = state.activityOpen ? '\u203A' : '\u2039';
  }

  function updateGrid(app, sidebar, activity) {
    if (!app) return;
    var navW = app.dataset.navWidth || '';
    var sideW = state.sidebarOpen ? (state.sidebarWidth ? state.sidebarWidth + 'px' : (app.dataset.sidebarWidth || '240px')) : '0px';
    var actW = state.activityOpen ? (state.activityWidth ? state.activityWidth + 'px' : (app.dataset.activityWidth || '380px')) : '0px';
    var strip = STRIP_W + 'px';

    if (navW) {
      // 4-col + 2 strips: nav | sidebar | strip | main | strip | activity
      app.style.gridTemplateColumns = navW + ' ' + sideW + ' ' + strip + ' 1fr ' + strip + ' ' + actW;
    } else if (app.dataset.layout === 'two-panel') {
      // 2-col + 1 strip: main | strip | activity
      app.style.gridTemplateColumns = '1fr ' + strip + ' ' + actW;
    } else {
      // sidebar + strip + main
      app.style.gridTemplateColumns = sideW + ' ' + strip + ' 1fr';
    }
  }

  function createToggleStrip(id, label, side, insertBefore) {
    var strip = document.createElement('div');
    strip.id = id;
    strip.className = 'oc-toggle-strip';
    strip.style.cssText = 'display:flex;align-items:center;justify-content:center;cursor:pointer;' +
      'background:transparent;transition:background 0.15s;font-size:12px;color:#555;user-select:none;height:100%;min-width:' + STRIP_W + 'px;';
    strip.textContent = label;
    strip.title = 'Toggle ' + side;
    strip.addEventListener('mouseenter', function() { strip.style.background = 'rgba(102,126,234,0.1)'; strip.style.color = '#667eea'; });
    strip.addEventListener('mouseleave', function() { strip.style.background = 'transparent'; strip.style.color = '#555'; });
    if (insertBefore && insertBefore.parentNode) {
      insertBefore.parentNode.insertBefore(strip, insertBefore);
    }
    return strip;
  }

  function createResizer(panel, side, minW, stateKey) {
    var resizer = document.createElement('div');
    resizer.className = 'oc-resizer';
    resizer.style.cssText = 'position:absolute;top:0;' + side + ':-3px;width:6px;height:100%;cursor:col-resize;z-index:10;';
    panel.style.position = 'relative';
    panel.appendChild(resizer);

    var startX, startW;
    function onMouseDown(e) {
      e.preventDefault();
      startX = e.clientX;
      startW = panel.offsetWidth;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }
    function onMouseMove(e) {
      var diff = side === 'right' ? e.clientX - startX : startX - e.clientX;
      var newW = Math.max(minW, startW + diff);
      panel.style.width = newW + 'px';
      state[stateKey] = newW;
      var app = document.querySelector('.app[data-grid-base]') || document.querySelector('.app');
      var sidebar = document.querySelector('.oc-sidebar-panel');
      var activity = document.querySelector('.oc-activity-panel');
      updateGrid(app, sidebar, activity);
    }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      save();
    }
    resizer.addEventListener('mousedown', onMouseDown);
  }

  function init() {
    load();

    var app = document.querySelector('.app[data-grid-base]') || document.querySelector('.app');
    var sidebar = document.querySelector('.oc-sidebar-panel');
    var activity = document.querySelector('.oc-activity-panel');
    if (!app) return;

    // Find main panel (the panel that is not sidebar or activity)
    var children = Array.from(app.children);
    var mainPanel = null;
    children.forEach(function(c) {
      if (!c.classList.contains('oc-sidebar-panel') && !c.classList.contains('oc-activity-panel') &&
          !c.classList.contains('icon-nav') && c.tagName !== 'SCRIPT') {
        mainPanel = c;
      }
    });

    // Create toggle strips — insert them into the grid with explicit column placement
    var hasNav = !!app.dataset.navWidth;
    var colOffset = hasNav ? 1 : 0; // nav takes column 1 if present

    if (sidebar && mainPanel) {
      var sideStrip = createToggleStrip('oc-toggle-sidebar', '\u2039', 'sidebar', mainPanel);
      // sidebar = col offset+1, strip = col offset+2, main = col offset+3
      sidebar.style.gridColumn = String(colOffset + 1);
      sideStrip.style.gridColumn = String(colOffset + 2);
      mainPanel.style.gridColumn = String(colOffset + 3);
      sideStrip.addEventListener('click', function() {
        state.sidebarOpen = !state.sidebarOpen;
        save();
        applyState();
      });
    }

    if (activity) {
      var actStrip = createToggleStrip('oc-toggle-activity', '\u203A', 'activity', activity);
      if (sidebar && mainPanel) {
        // strip = col offset+4, activity = col offset+5
        actStrip.style.gridColumn = String(colOffset + 4);
        activity.style.gridColumn = String(colOffset + 5);
      } else if (app.dataset.layout === 'two-panel') {
        // main = 1, strip = 2, activity = 3
        if (mainPanel) mainPanel.style.gridColumn = '1';
        actStrip.style.gridColumn = '2';
        activity.style.gridColumn = '3';
      } else {
        // sidebar + strip + main layout (no activity separate handling)
        actStrip.style.gridColumn = String(colOffset + 3);
        activity.style.gridColumn = String(colOffset + 4);
      }
      actStrip.addEventListener('click', function() {
        state.activityOpen = !state.activityOpen;
        save();
        applyState();
      });
    }

    // Create resizers
    if (sidebar) createResizer(sidebar, 'right', MIN_SIDEBAR, 'sidebarWidth');
    if (activity) createResizer(activity, 'left', MIN_ACTIVITY, 'activityWidth');

    // Auto-collapse on small screens
    if (window.innerWidth < 800) {
      state.sidebarOpen = false;
      state.activityOpen = false;
    }

    applyState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
