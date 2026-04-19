const groups = [
  { name: "Click + Guide", volume: "100%", muted: false },
  { name: "Drums + Bass", volume: "100%", muted: false },
  { name: "Keys + Pads", volume: "100%", muted: true },
];

export function TransportPanel() {
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
              <p>Vol {group.volume}</p>
            </div>
            <button type="button">{group.muted ? "Unmute" : "Mute"}</button>
          </article>
        ))}
      </div>
    </section>
  );
}
