export type Event<T> = { event: string; id: number; payload: T };
export type UnlistenFn = () => void;

export async function listen<T>(_event: string, _handler: (event: Event<T>) => void): Promise<UnlistenFn> {
  return () => undefined;
}

export async function once<T>(_event: string, _handler: (event: Event<T>) => void): Promise<UnlistenFn> {
  return () => undefined;
}

export async function emit(_event: string, _payload?: unknown): Promise<void> {}
