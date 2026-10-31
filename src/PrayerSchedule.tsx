import { Coordinates, computePrayers, getNextPrayer, PRAYER_LABELS, PrayerName } from "./prayer";

export function PrayerSchedule({
  coords,
  accentColor,
}: {
  coords: Coordinates;
  accentColor: string;
}) {
  const now = new Date();
  const times = computePrayers(now, coords);
  const next = getNextPrayer(now, coords);

  const list: Array<{ id: PrayerName; isPrayer: boolean }> = [
    { id: "subuh", isPrayer: true },
    { id: "terbit", isPrayer: false },
    { id: "dzuhur", isPrayer: true },
    { id: "ashar", isPrayer: true },
    { id: "maghrib", isPrayer: true },
    { id: "isya", isPrayer: true },
  ];

  return (
    <div className="flex flex-col gap-2.5 select-none">
      {/* Header highlight: next prayer */}
      <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/5 border border-white/5">
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full animate-pulse"
            style={{ backgroundColor: accentColor }}
          />
          <span className="text-xs text-neutral-300">
            Berikutnya:{" "}
            <strong className="text-white font-semibold">{next.label}</strong>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold text-white tabular-nums">
            {next.time}
          </span>
          <span
            className="text-[10px] px-1.5 py-0.2 rounded font-mono tabular-nums"
            style={{
              backgroundColor: `${accentColor}22`,
              color: accentColor,
            }}
          >
            {next.diffMinutes > 60
              ? `${Math.floor(next.diffMinutes / 60)}j ${next.diffMinutes % 60}m`
              : `${next.diffMinutes}m`}
          </span>
        </div>
      </div>

      {/* 6-box prayer time grid */}
      <div className="grid grid-cols-3 gap-1.5">
        {list.map(({ id, isPrayer }) => {
          const isNext = next.name === id;
          const time = times[id];
          return (
            <div
              key={id}
              className={`p-2 rounded-lg border transition-all ${
                isNext
                  ? "bg-white/[0.10] border-white/20 shadow-sm"
                  : "bg-white/[0.03] border-white/[0.05]"
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-[11px] font-medium ${
                    isNext ? "text-white" : "text-neutral-400"
                  }`}
                >
                  {PRAYER_LABELS[id]}
                </span>
                {!isPrayer && (
                  <span className="text-[9px] text-neutral-500 uppercase tracking-wider">
                    syuruq
                  </span>
                )}
              </div>
              <div
                className="font-mono text-base font-semibold tabular-nums mt-0.5"
                style={{ color: isNext ? accentColor : "#e4e4e7" }}
              >
                {time}
              </div>
            </div>
          );
        })}
      </div>

      <div className="text-center text-[10.5px] text-neutral-500">
        Hisab Kemenag RI (+2 menit ihtiyati) · Offline
      </div>
    </div>
  );
}
