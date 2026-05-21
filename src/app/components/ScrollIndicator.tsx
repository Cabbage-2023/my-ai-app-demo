'use client';

import { useEffect, useRef, useState } from 'react';

interface ScrollIndicatorProps {
  containerRef: React.RefObject<HTMLDivElement | null>
  rounds: { id: string; label: string; el: HTMLElement | null }[]
}

const MAX_VISIBLE_DOTS = 5;

export default function ScrollIndicator({ containerRef, rounds }: ScrollIndicatorProps) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const lastActive = useRef(-1);
  const [panelOpen, setPanelOpen] = useState(false);
  const zoneRef = useRef<HTMLDivElement>(null);
  const panelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // IntersectionObserver
  useEffect(() => {
    if (rounds.length < 3 || !containerRef.current) return;
    observerRef.current?.disconnect();

    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = rounds.findIndex(r => r.el === entry.target)
            if (idx >= 0) setActiveIndex(idx)
          }
        }
      },
      { root: containerRef.current, threshold: 0.3 },
    )

    rounds.forEach(r => {
      if (r.el) observer.observe(r.el)
    })

    observerRef.current = observer
    return () => observer.disconnect()
  }, [rounds, containerRef]);

  // 记住最后可见的 activeIndex
  if (activeIndex > lastActive.current) lastActive.current = activeIndex;
  const displayIndex = activeIndex >= 0 ? activeIndex : 0;

  // 少于 3 轮不显示
  if (rounds.length < 3) return null;

  // 计算可见的 5 个圆点窗口
  const half = Math.floor(MAX_VISIBLE_DOTS / 2);
  let start = Math.max(0, displayIndex - half);
  let end = Math.min(rounds.length, start + MAX_VISIBLE_DOTS);
  if (end - start < MAX_VISIBLE_DOTS) {
    start = Math.max(0, end - MAX_VISIBLE_DOTS);
  }
  const visibleRounds = rounds.slice(start, end);
  const hasPrev = start > 0;
  const hasNext = end < rounds.length;

  // 进出整个区域的延迟管理
  const enterZone = () => {
    if (panelTimeoutRef.current) clearTimeout(panelTimeoutRef.current);
    setPanelOpen(true);
  };
  const leaveZone = () => {
    panelTimeoutRef.current = setTimeout(() => setPanelOpen(false), 200);
  };

  const scrollTo = (round: typeof rounds[0]) => {
    round.el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setPanelOpen(false);
  };

  return (
    <div
      ref={zoneRef}
      className="fixed right-2 top-1/2 -translate-y-1/2 z-10 max-sm:hidden select-none"
      onMouseEnter={enterZone}
      onMouseLeave={leaveZone}
    >
      {/* ── 圆点指示器 ── */}
      <div
        className={`flex flex-col items-center gap-1 transition-all duration-200 ${
          panelOpen ? 'opacity-0 invisible scale-95' : 'opacity-100 visible scale-100'
        }`}
      >
        {hasPrev && (
          <div className="text-[8px] text-fg-muted leading-none mb-0.5">▲</div>
        )}
        {visibleRounds.map((r) => {
          const globalIdx = start + visibleRounds.indexOf(r);
          const isActive = globalIdx === displayIndex;
          return (
            <button
              key={r.id}
              onClick={() => scrollTo(r)}
              className={[
                'rounded-full transition-all duration-200',
                isActive ? 'w-3 h-5 bg-miku' : 'w-2 h-2 bg-border hover:bg-miku/50',
              ].join(' ')}
              aria-label={`跳转到: ${r.label}`}
            />
          );
        })}
        {hasNext && (
          <div className="text-[8px] text-fg-muted leading-none mt-0.5">▼</div>
        )}
      </div>

      {/* ── 悬浮面板 ── */}
      <div
        className={`absolute right-0 top-1/2 -translate-y-1/2 transition-all duration-200 ${
          panelOpen ? 'opacity-100 visible scale-100' : 'opacity-0 invisible scale-95 pointer-events-none'
        }`}
        onMouseEnter={enterZone}
        onMouseLeave={leaveZone}
      >
        <div
          className="bg-surface border border-border/70 rounded-xl shadow-lg
            py-2 px-1 max-h-[60vh] overflow-y-auto min-w-[150px] max-w-[200px]"
        >
          {rounds.map((r, i) => {
            const isActive = i === displayIndex;
            return (
              <button
                key={r.id}
                onClick={() => scrollTo(r)}
                className={[
                  'w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors',
                  isActive
                    ? 'bg-miku/15 text-miku-dark font-medium'
                    : 'text-fg hover:bg-miku/10',
                ].join(' ')}
              >
                <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
                  {r.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
