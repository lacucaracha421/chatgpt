// Node 25+ defines its own global localStorage/sessionStorage (undefined without
// --localstorage-file), which hides jsdom's when Node is newer than .node-version.
// Shared by the desktop setup and vitest.mobile.config.ts.
for (const name of ["localStorage", "sessionStorage"] as const) {
  const storage = (globalThis as { jsdom?: { window: Window } }).jsdom?.window[name];
  if (storage && globalThis[name] !== storage) Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true });
}

export {};
