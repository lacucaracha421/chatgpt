import { ClockIcon } from "@heroicons/react/24/outline";
import type { ComponentProps } from "react";
import { useWorkloadProfile } from "../app/workloadProfile";
import { Badge } from "../shared/ui/Badge";
import { VideoTileMedia } from "../video/VideoTileMedia";

export function AssetVideoTileMedia(props: ComponentProps<typeof VideoTileMedia>) {
  const state = props.asset.media.preparationState;
  if (state === "pending" || state === "processing") return <PendingVideoTile />;
  return <VideoTileMedia {...props} compactBadge durationVisible={props.asset.width > 100} />;
}

function PendingVideoTile() {
  const { lightweight, restricted, ready } = useWorkloadProfile();
  const caption = lightweight ? "가벼운 모드로 대기 중"
    : ready && restricted ? "일반 모드로 전환 중"
    : "준비 중";
  return <div className="video-tile video-tile--pending">
    <ClockIcon className="video-tile__status-icon" aria-hidden="true" />
    <Badge className="video-tile__status" role="status">{caption}</Badge>
  </div>;
}
