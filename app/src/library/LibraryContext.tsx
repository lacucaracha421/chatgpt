import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
} from "react";
import type { LibraryGateway, LibrarySummary } from "./types";
import { commandErrorMessage } from "./errorMessage";

export const LIBRARY_PATH_STORAGE_KEY = "lakomics.libraryPath";

type LibraryContextValue = {
  gateway: LibraryGateway;
  library: LibrarySummary | null;
  error: string | null;
  openLibrary(path: string): Promise<void>;
};

const LibraryContext = createContext<LibraryContextValue | null>(null);

export function LibraryProvider({
  children,
  gateway,
}: PropsWithChildren<{ gateway: LibraryGateway }>) {
  const [library, setLibrary] = useState<LibrarySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tryOpenLibrary = useCallback(
    async (path: string) => {
      setError(null);
      try {
        const summary = await gateway.openLibrary(path);
        setLibrary(summary);
        localStorage.setItem(LIBRARY_PATH_STORAGE_KEY, path);
        return true;
      } catch (error) {
        setError(commandErrorMessage(error, "라이브러리를 열 수 없습니다."));
        return false;
      }
    },
    [gateway],
  );
  const openLibrary = useCallback(
    async (path: string) => {
      await tryOpenLibrary(path);
    },
    [tryOpenLibrary],
  );

  useEffect(() => {
    const path = localStorage.getItem(LIBRARY_PATH_STORAGE_KEY);
    if (path) {
      void tryOpenLibrary(path).then((opened) => {
        if (!opened && localStorage.getItem(LIBRARY_PATH_STORAGE_KEY) === path) {
          localStorage.removeItem(LIBRARY_PATH_STORAGE_KEY);
        }
      });
    }
  }, [tryOpenLibrary]);

  return (
    <LibraryContext.Provider value={{ gateway, library, error, openLibrary }}>
      {children}
    </LibraryContext.Provider>
  );
}

export function useLibrary(): LibraryContextValue {
  const context = useContext(LibraryContext);
  if (!context) {
    throw new Error("useLibrary must be used within a LibraryProvider");
  }
  return context;
}
