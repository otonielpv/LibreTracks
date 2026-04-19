import { useState } from "react";

const initialGroups = [
  { id: "group-monitor", name: "Click + Guide", volume: 100, muted: false },
  { id: "group-rhythm", name: "Drums + Bass", volume: 92, muted: false },
  { id: "group-keys", name: "Keys + Pads", volume: 78, muted: true },
];

const initialTracks = [
  { id: "track-click", name: "Click", group: "Click + Guide", volume: 100, muted: false },
  { id: "track-guide", name: "Guide", group: "Click + Guide", volume: 86, muted: false },
  { id: "track-drums", name: "Drums", group: "Drums + Bass", volume: 94, muted: false },
  { id: "track-bass", name: "Bass", group: "Drums + Bass", volume: 88, muted: false },
  { id: "track-keys", name: "Keys", group: "Keys + Pads", volume: 72, muted: true },
];

export function TransportPanel() {
  const [groups, setGroups] = useState(initialGroups);
  const [tracks, setTracks] = useState(initialTracks);

  return (
    <section className="panel">
      <div className="transport">
        <button type="button">Play</button>
        <button type="button">Pause</button>
        <button type="button">Stop</button>
        <strong>00:00.000</strong>
      </div>

      <div className="group-list">
        {groups.map((group) => (
          <article className="group-row" key={group.name}>
            <div>
              <h3>{group.name}</h3>
              <p>Vol {group.volume}%</p>
            </div>
            <div className="row-controls">
              <label className="slider-field">
                <span>Volumen</span>
                <input
                  aria-label={`Volumen de grupo ${group.name}`}
                  max="100"
                  min="0"
                  type="range"
                  value={group.volume}
                  onChange={(event) => {
                    const volume = Number(event.target.value);
                    setGroups((currentGroups) =>
                      currentGroups.map((currentGroup) =>
                        currentGroup.id === group.id
                          ? { ...currentGroup, volume }
                          : currentGroup,
                      ),
                    );
                  }}
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  setGroups((currentGroups) =>
                    currentGroups.map((currentGroup) =>
                      currentGroup.id === group.id
                        ? { ...currentGroup, muted: !currentGroup.muted }
                        : currentGroup,
                    ),
                  );
                }}
              >
                {group.muted ? "Unmute" : "Mute"}
              </button>
            </div>
          </article>
        ))}
      </div>

      <div className="track-header">
        <div>
          <h2>Tracks</h2>
          <p>Lista inicial para la fase de mezcla y timeline.</p>
        </div>
        <div className="track-actions">
          <button type="button">Crear Cancion</button>
          <button type="button">Importar Pistas</button>
          <button type="button">Abrir Proyecto</button>
        </div>
      </div>

      <div className="track-list">
        {tracks.map((track) => (
          <article className="track-row" key={track.id}>
            <div className="track-meta">
              <strong>{track.name}</strong>
              <span>{track.group}</span>
            </div>

            <label className="slider-field track-slider">
              <span>Vol {track.volume}%</span>
              <input
                aria-label={`Volumen de pista ${track.name}`}
                max="100"
                min="0"
                type="range"
                value={track.volume}
                onChange={(event) => {
                  const volume = Number(event.target.value);
                  setTracks((currentTracks) =>
                    currentTracks.map((currentTrack) =>
                      currentTrack.id === track.id
                        ? { ...currentTrack, volume }
                        : currentTrack,
                    ),
                  );
                }}
              />
            </label>

            <button
              type="button"
              onClick={() => {
                setTracks((currentTracks) =>
                  currentTracks.map((currentTrack) =>
                    currentTrack.id === track.id
                      ? { ...currentTrack, muted: !currentTrack.muted }
                      : currentTrack,
                  ),
                );
              }}
            >
              {track.muted ? "Unmute" : "Mute"}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
