// Draggable splitters between the sidebar, the map and the preview. Sizes persist per
// browser; double-click a splitter (or press Home) to reset it. Arrow keys nudge it.

const KEY = 'mountain-maker.layout';
const DEFAULTS = { sidebarPx: 340, mapFraction: 0.5 };

type Layout = typeof DEFAULTS;

function load(): Layout {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(l: Layout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    // Storage can be unavailable (private mode); sizes just won't persist.
  }
}

export function initLayout(app: HTMLElement, main: HTMLElement, onResize: () => void) {
  const layout = load();
  const apply = () => {
    const maxSidebar = Math.max(260, window.innerWidth - 320);
    layout.sidebarPx = Math.min(Math.max(layout.sidebarPx, 260), maxSidebar);
    layout.mapFraction = Math.min(Math.max(layout.mapFraction, 0.1), 0.9);
    app.style.setProperty('--sidebar-w', `${layout.sidebarPx}px`);
    main.style.setProperty('--map-fr', `${layout.mapFraction}fr`);
    main.style.setProperty('--preview-fr', `${1 - layout.mapFraction}fr`);
    onResize();
  };

  const bind = (el: HTMLElement, axis: 'x' | 'y', set: (clientPos: number) => void, nudge: (d: number) => void, reset: () => void) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
      const move = (ev: PointerEvent) => {
        set(axis === 'x' ? ev.clientX : ev.clientY);
        apply();
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        document.body.classList.remove('resizing-x', 'resizing-y');
        save(layout);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up, { once: true });
      el.addEventListener('pointercancel', up, { once: true });
    });
    el.addEventListener('dblclick', () => {
      reset();
      apply();
      save(layout);
    });
    el.addEventListener('keydown', (e) => {
      const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      const fwd = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      if (e.key === back || e.key === fwd) nudge(e.key === fwd ? 1 : -1);
      else if (e.key === 'Home') reset();
      else return;
      e.preventDefault();
      apply();
      save(layout);
    });
  };

  bind(
    document.getElementById('split-sidebar')!,
    'x',
    (x) => (layout.sidebarPx = x - app.getBoundingClientRect().left),
    (d) => (layout.sidebarPx += d * 20),
    () => (layout.sidebarPx = DEFAULTS.sidebarPx),
  );
  bind(
    document.getElementById('split-map')!,
    'y',
    (y) => {
      const r = main.getBoundingClientRect();
      layout.mapFraction = (y - r.top) / r.height;
    },
    (d) => (layout.mapFraction += d * 0.03),
    () => (layout.mapFraction = DEFAULTS.mapFraction),
  );

  window.addEventListener('resize', apply);
  apply();
}
