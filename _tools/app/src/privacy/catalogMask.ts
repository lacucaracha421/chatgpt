import { usePrivacy } from "./PrivacyContext";
import { catalogContentMasked } from "../shared/privacy/catalogMask";

export function useCatalogMasked(requestedPrivacy = false): boolean {
  const { privacyMode, nsfwFilter } = usePrivacy();
  return catalogContentMasked(requestedPrivacy || privacyMode, nsfwFilter);
}
