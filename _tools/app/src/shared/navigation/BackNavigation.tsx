import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type PropsWithChildren } from "react";

type BackHandler = () => boolean | void;
type Registration = { id: symbol; priority: number; order: number; handler: BackHandler };

type BackNavigation = {
  register: (handler: BackHandler, priority: number) => () => void;
  requestBack: () => boolean;
};

const BackNavigationContext = createContext<BackNavigation | null>(null);

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export function BackNavigationProvider({ children }: PropsWithChildren) {
  const registrations = useRef<Registration[]>([]);
  const nextOrder = useRef(0);
  const register = useCallback((handler: BackHandler, priority: number) => {
    const registration = { id: Symbol(), priority, order: nextOrder.current++, handler };
    registrations.current.push(registration);
    return () => {
      registrations.current = registrations.current.filter(({ id }) => id !== registration.id);
    };
  }, []);
  const requestBack = useCallback(() => {
    const ordered = [...registrations.current].sort((left, right) => right.priority - left.priority || right.order - left.order);
    for (const registration of ordered) {
      if (registration.handler() !== false) return true;
    }
    return false;
  }, []);
  const value = useMemo(() => ({ register, requestBack }), [register, requestBack]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isEditableTarget(event.target)) return;
      if (requestBack()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [requestBack]);

  return <BackNavigationContext.Provider value={value}>{children}</BackNavigationContext.Provider>;
}

export function useBackRequest() {
  return useContext(BackNavigationContext)?.requestBack ?? (() => false);
}

export function useBackHandler(handler: BackHandler, priority = 0, enabled = true) {
  const navigation = useContext(BackNavigationContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!navigation || !enabled) return;
    return navigation.register(() => handlerRef.current(), priority);
  }, [enabled, navigation, priority]);
}

export function useBackNavigationContext() {
  return useContext(BackNavigationContext);
}
