// Deliver the initial and viewport-crossing entries that the browser supplies.
export function translationObserver(w, created = () => {}) {
  const observers = new Set();
  const measures = new WeakMap();
  const update = () => { for (const observer of observers) observer.update(); };
  w.addEventListener('scroll', update);
  w.addEventListener('resize', update);
  return class {
    constructor(callback, options = {}) {
      this.cb = entries => callback(entries.map(entry => ({ intersectionRatio: entry.isIntersecting ? 1 : 0, ...entry })));
      this.options = options;
      this.targets = new Map();
      this.states = new Map();
      observers.add(this);
      created(this);
    }
    observe(target) {
      if (!measures.has(target)) measures.set(target, target.getBoundingClientRect.bind(target));
      this.targets.set(target, measures.get(target));
      w.setTimeout(() => this.update(), 0);
    }
    unobserve(target) { this.targets.delete(target); this.states.delete(target); }
    disconnect() { this.targets.clear(); this.states.clear(); }
    update() {
      const margins = (this.options.rootMargin || '0px 0px 0px 0px').split(' ').map(Number.parseFloat);
      const entries = [];
      for (const [target, measure] of this.targets) {
        const rect = measure();
        const isIntersecting = rect.width > 0 && rect.height > 0 && rect.bottom > -margins[0] && rect.top < w.innerHeight + margins[2];
        if (this.states.get(target) === isIntersecting) continue;
        this.states.set(target, isIntersecting);
        entries.push({ target, isIntersecting, boundingClientRect: rect });
      }
      if (entries.length) this.cb(entries);
    }
  };
}
