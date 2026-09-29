const currentWebview = {
  onDragDropEvent: async (_handler: (event: unknown) => void) => () => undefined,
  setZoom: async (_scale: number) => undefined,
};

export function getCurrentWebview() { return currentWebview; }
