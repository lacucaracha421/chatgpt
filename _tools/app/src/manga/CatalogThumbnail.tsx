import { usePrivacy } from "../privacy/PrivacyContext";
import { nativeMediaUrl } from "../assets/mediaUrl";
import { MangaCover } from "./MangaCard";

type CatalogThumbnailProps = { src: string | null; title: string; className?: string };

export function CatalogThumbnail({ src, title, className }: CatalogThumbnailProps) {
  const { privacyMode } = usePrivacy();
  return <MangaCover src={src ? nativeMediaUrl(src) : null} title={title} className={className} privacyMode={privacyMode} />;
}
