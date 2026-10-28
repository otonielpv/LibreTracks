import type { SongRegionSummary } from "@libretracks/shared/models";

export function SongCover({ region }: { region: SongRegionSummary }) {
  if (!region.coverImage || !/^data:image\/(jpeg|png|webp);base64,/.test(region.coverImage)) return null;
  return <img className="lt-song-cover" src={region.coverImage} alt="" width={40} height={40}
    draggable={false} onLoad={(event) => { event.currentTarget.style.visibility = ""; }}
    onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />;
}