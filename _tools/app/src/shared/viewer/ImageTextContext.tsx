import { createContext, useContext } from "react";
import type { ImageTextSectionProps } from "./ImageTextSection";

/** Viewer-owned data; the ordinary gallery information panel has no translation section. */
export const ImageTextContext = createContext<(ImageTextSectionProps & { assetId: string }) | null>(null);
export const useViewerImageText = () => useContext(ImageTextContext);
