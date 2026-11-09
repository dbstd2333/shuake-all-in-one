// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import { AppAPI, RECONNECTED, onEvent, type TrafficDay, type TrafficOverview, type TrafficTick } from "../api";

const MAX_SAMPLES = 300; // 10 minutes at one sample every 2 s

interface TrafficState {
  scope: TrafficOverview["scope"] | null;
  interfaces: string[];
  samples: TrafficTick[];
  latest: TrafficTick | null;
  days: TrafficDay[];
  /** bytes since the overview was loaded, added onto today's row live */
  liveToday: { rx: number; tx: number; platforms: Record<string, [number, number]> };
  loaded: boolean;
  load(): Promise<void>;
  init(): () => void;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const useTraffic = create<TrafficState>((set, get) => ({
  scope: null,
  interfaces: [],
  samples: [],
  latest: null,
  days: [],
  liveToday: { rx: 0, tx: 0, platforms: {} },
  loaded: false,

  async load() {
    try {
      const ov = await AppAPI.TrafficOverview();
      set({
        scope: ov.scope,
        interfaces: ov.interfaces ?? [],
        samples: ov.samples ?? [],
        latest: ov.latest ?? null,
        days: ov.days ?? [],
        liveToday: { rx: 0, tx: 0, platforms: {} },
        loaded: true,
      });
    } catch {
      /* older backend without traffic support: the page shows an empty state */
    }
  },

  init() {
    const offs = [
      onEvent("traffic:tick", (t: TrafficTick) =>
        set((s) => {
          const samples = [...s.samples, { ...t, jobs: undefined }].slice(-MAX_SAMPLES);
          // keep today's total moving between overview reloads (2 s * rate = bytes in the interval)
          const sec = 2;
          const system = s.scope !== "engines";
          const live = { ...s.liveToday, platforms: { ...s.liveToday.platforms } };
          live.rx += (system ? t.rxRate : t.engineRxRate) * sec;
          live.tx += (system ? t.txRate : t.engineTxRate) * sec;
          for (const j of t.jobs ?? []) {
            const v = live.platforms[j.platform] ?? [0, 0];
            live.platforms[j.platform] = [v[0] + j.rxRate * sec, v[1] + j.txRate * sec];
          }
          return { samples, latest: t, liveToday: live };
        }),
      ),
      onEvent(RECONNECTED, () => void get().load()),
    ];
    void get().load();
    // reload every 5 minutes so the live estimate never drifts far from the stored totals
    const timer = window.setInterval(() => void get().load(), 5 * 60_000);
    return () => {
      offs.forEach((off) => off());
      window.clearInterval(timer);
    };
  },
}));

/** days with the live increment folded into today's row */
export function daysWithLive(days: TrafficDay[], live: TrafficState["liveToday"]): TrafficDay[] {
  const t = today();
  const out = days.map((d) => ({ ...d, platforms: { ...d.platforms } }));
  let row = out.find((d) => d.day === t);
  if (!row) {
    row = { day: t, rx: 0, tx: 0, platforms: {} };
    out.push(row);
  }
  row.rx += live.rx;
  row.tx += live.tx;
  for (const [p, v] of Object.entries(live.platforms)) {
    const cur = row.platforms[p] ?? [0, 0];
    row.platforms[p] = [cur[0] + v[0], cur[1] + v[1]];
  }
  return out;
}

export function formatBytes(n?: number, digits = 1): string {
  if (!n || n < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`;
}

export const formatRate = (bps?: number) => `${formatBytes(bps)}/s`;

/** bits per second, the unit bandwidth plans are sold in */
export function formatMbps(bps?: number): string {
  const mbps = ((bps ?? 0) * 8) / 1_000_000;
  return mbps >= 10 ? `${mbps.toFixed(0)} Mbps` : `${mbps.toFixed(mbps >= 1 ? 1 : 2)} Mbps`;
}

export { today as trafficToday };
