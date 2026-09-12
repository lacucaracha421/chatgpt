import { createContext, useContext, useMemo, type ReactNode } from "react";

type PrivacyContextValue = {
  privacyMode: boolean;
  setPrivacyMode: (privacyMode: boolean) => void;
};

const PrivacyContext = createContext<PrivacyContextValue>({
  privacyMode: false,
  setPrivacyMode: () => undefined,
});

type PrivacyProviderProps = {
  privacyMode: boolean;
  setPrivacyMode: (privacyMode: boolean) => void;
  children: ReactNode;
};

export function PrivacyProvider({ privacyMode, setPrivacyMode, children }: PrivacyProviderProps) {
  const value = useMemo(
    () => ({ privacyMode, setPrivacyMode }),
    [privacyMode, setPrivacyMode],
  );
  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>;
}

export function usePrivacy(): PrivacyContextValue {
  return useContext(PrivacyContext);
}