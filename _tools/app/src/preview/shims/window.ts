const noop = async () => undefined;
const currentWindow = {
  minimize: noop,
  toggleMaximize: noop,
  close: noop,
  hide: noop,
  show: noop,
  setFocus: noop,
  startResizeDragging: async (_direction: string) => undefined,
  isMaximized: async () => false,
  isFullscreen: async () => false,
  isResizable: async () => false,
  onResized: async (_handler: () => void) => () => undefined,
  onCloseRequested: async (_handler: (event: { preventDefault(): void }) => void) => () => undefined,
};

export function getCurrentWindow() { return currentWindow; }
export const appWindow = currentWindow;
