// SPDX-License-Identifier: AGPL-3.0-or-later
// Hand-rolled SVG charts for the traffic page (no chart library in the bundle).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TrafficDay, TrafficTick } from "../api";
import { platformById } from "../platforms";
import { formatBytes, formatMbps, formatRate } from "../stores/traffic";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** 0, nice step, ... covering max; returns the ticks (at least [0, x]) */
function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/** byte-based axis: snap the top to a power-of-1024 friendly scale */
function byteTicks(max: number) {
  const unit = max >= 1024 ** 3 ? 1024 ** 3 : max >= 1024 ** 2 ? 1024 ** 2 : max >= 1024 ? 1024 : 1;
  return niceTicks(max / unit).map((t) => t * unit);
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x + 12, 0), Math.max(0, width - 200));
  return (
    <div className="viz-tooltip" style={{ left, top: Math.max(0, y - 8) }}>
      {children}
    </div>
  );
}

const PAD = { top: 12, right: 12, bottom: 24, left: 64 };

/** Live download / upload rate over the last minutes. */
export function RateChart({ samples, height = 220 }: { samples: TrafficTick[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const w = Math.max(width, 320);
  const iw = w - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;

  const now = samples.length ? samples[samples.length - 1].ts : Date.now();
  const span = 10 * 60_000;
  const t0 = now - span;
  const pts = samples.filter((s) => s.ts >= t0);
  const max = Math.max(1024, ...pts.map((s) => Math.max(s.rxRate, s.txRate)));
  const ticks = byteTicks(max);
  const top = ticks[ticks.length - 1];
  const x = (ts: number) => PAD.left + ((ts - t0) / span) * iw;
  const y = (v: number) => PAD.top + ih - (v / top) * ih;
  const path = (key: "rxRate" | "txRate") => pts.map((s, i) => `${i ? "L" : "M"}${x(s.ts).toFixed(1)},${y(s[key]).toFixed(1)}`).join("");

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (!pts.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ts = t0 + ((e.clientX - r.left) / r.width) * span;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].ts - ts) < Math.abs(pts[best].ts - ts)) best = i;
    setHover(best);
  };
  const h = hover !== null ? pts[hover] : null;

  return (
    <div ref={ref} className="viz" style={{ position: "relative" }}>
      <div className="viz-legend">
        <span><i style={{ background: "var(--series-1)" }} />下行（下载）</span>
        <span><i style={{ background: "var(--series-2)" }} />上行（上传）</span>
      </div>
      {width > 0 && (
        <svg width={w} height={height} role="img" aria-label="最近 10 分钟的实时网速">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={w - PAD.right} y1={y(t)} y2={y(t)} className="viz-grid" />
              <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="viz-axis">{formatRate(t)}</text>
            </g>
          ))}
          {[10, 7.5, 5, 2.5, 0].map((m) => (
            <text key={m} x={x(now - m * 60_000)} y={height - 6} textAnchor={m === 10 ? "start" : m === 0 ? "end" : "middle"} className="viz-axis">
              {m === 0 ? "现在" : `${m} 分钟前`}
            </text>
          ))}
          <path d={path("txRate")} className="viz-line" style={{ stroke: "var(--series-2)" }} />
          <path d={path("rxRate")} className="viz-line" style={{ stroke: "var(--series-1)" }} />
          {h && (
            <g>
              <line x1={x(h.ts)} x2={x(h.ts)} y1={PAD.top} y2={PAD.top + ih} className="viz-crosshair" />
              <circle cx={x(h.ts)} cy={y(h.txRate)} r={4} className="viz-dot" style={{ fill: "var(--series-2)" }} />
              <circle cx={x(h.ts)} cy={y(h.rxRate)} r={4} className="viz-dot" style={{ fill: "var(--series-1)" }} />
            </g>
          )}
          <rect x={PAD.left} y={PAD.top} width={iw} height={ih} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
      )}
      {h && (
        <Tooltip x={x(h.ts)} y={PAD.top} width={w}>
          <div className="viz-tooltip-title">{new Date(h.ts).toLocaleTimeString()}</div>
          <div><i style={{ background: "var(--series-1)" }} />下行 <b>{formatRate(h.rxRate)}</b> <span className="viz-muted">{formatMbps(h.rxRate)}</span></div>
          <div><i style={{ background: "var(--series-2)" }} />上行 <b>{formatRate(h.txRate)}</b> <span className="viz-muted">{formatMbps(h.txRate)}</span></div>
        </Tooltip>
      )}
      {!pts.length && <div className="viz-empty">等待数据…（每 2 秒采样一次）</div>}
    </div>
  );
}

/** Rounded-top bar anchored to the baseline. */
function barPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Total traffic per day for the last 30 days. */
export function DailyChart({ days, height = 220 }: { days: TrafficDay[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const w = Math.max(width, 320);
  const iw = w - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;

  const series = useMemo(() => {
    const byDay = new Map(days.map((d) => [d.day, d]));
    const out: TrafficDay[] = [];
    const d = new Date();
    d.setDate(d.getDate() - 29);
    for (let i = 0; i < 30; i++) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      out.push(byDay.get(key) ?? { day: key, rx: 0, tx: 0, platforms: {} });
      d.setDate(d.getDate() + 1);
    }
    return out;
  }, [days]);

  const max = Math.max(1024 * 1024, ...series.map((d) => d.rx + d.tx));
  const ticks = byteTicks(max);
  const top = ticks[ticks.length - 1];
  const slot = iw / series.length;
  const bw = Math.max(2, slot - 2); // 2px surface gap between bars
  const y = (v: number) => PAD.top + ih - (v / top) * ih;
  const h = hover !== null ? series[hover] : null;

  return (
    <div ref={ref} className="viz" style={{ position: "relative" }}>
      {width > 0 && (
        <svg width={w} height={height} role="img" aria-label="最近 30 天每日流量">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={w - PAD.right} y1={y(t)} y2={y(t)} className="viz-grid" />
              <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="viz-axis">{formatBytes(t, 0)}</text>
            </g>
          ))}
          {series.map((d, i) => {
            const total = d.rx + d.tx;
            const bx = PAD.left + i * slot + 1;
            const bh = Math.max(0, PAD.top + ih - y(total));
            return (
              <g key={d.day}>
                {total > 0 && <path d={barPath(bx, y(total), bw, bh)} style={{ fill: "var(--series-1)", opacity: hover === null || hover === i ? 1 : 0.55 }} />}
                {(i % 5 === 4 || i === series.length - 1) && (
                  <text x={bx + bw / 2} y={height - 6} textAnchor="middle" className="viz-axis">{i === series.length - 1 ? "今天" : d.day.slice(5)}</text>
                )}
                <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={ih} fill="transparent"
                  onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
              </g>
            );
          })}
        </svg>
      )}
      {h && (
        <Tooltip x={PAD.left + (hover! + 1) * slot} y={PAD.top} width={w}>
          <div className="viz-tooltip-title">{h.day}</div>
          <div>合计 <b>{formatBytes(h.rx + h.tx)}</b></div>
          <div className="viz-muted">下行 {formatBytes(h.rx)} · 上行 {formatBytes(h.tx)}</div>
          {Object.entries(h.platforms)
            .sort((a, b) => b[1][0] + b[1][1] - (a[1][0] + a[1][1]))
            .slice(0, 5)
            .map(([p, v]) => (
              <div key={p} className="viz-muted">{platformById(p).name}：{formatBytes(v[0] + v[1])}</div>
            ))}
        </Tooltip>
      )}
    </div>
  );
}
