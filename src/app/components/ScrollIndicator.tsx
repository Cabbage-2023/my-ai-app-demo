'use client';

import { useEffect, useRef, useState } from 'react';

interface ScrollIndicatorProps {
  containerRef: React.RefObject<HTMLDivElement | null>
  rounds: { id: string; label: string; el: HTMLElement | null }[]
}

export default function ScrollIndicator({ containerRef, rounds }: ScrollIndicatorProps) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const [positions, setPositions] = useState<number[]>([]);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const lastActive = useRef(-1);

  // IntersectionObserver — 无条件调用 hooks，内部判断 rounds 数量
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
  }, [rounds, containerRef])

  // 记住最后可见的 activeIndex，不让它往回跳
  if (activeIndex > lastActive.current) lastActive.current = activeIndex

  // 少于 3 轮不显示（在 hooks 之后）
  if (rounds.length < 3) return null;

  const indicatorIndex = activeIndex >= 0 ? activeIndex : 0

  return (
    <div className="fixed right-2 top-1/2 -translate-y-1/2 z-10 flex flex-col items-center gap-2 max-sm:hidden select-none">
      {rounds.map((r, i) => {
        const isActive = i === indicatorIndex
        return (
          <div key={r.id} className="group relative flex items-center justify-center">
            <button
              onClick={() => { r.el?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}
              className={[
                'rounded-full transition-all duration-200',
                isActive ? 'w-3 h-6 bg-miku' : 'w-2.5 h-2.5 bg-border hover:bg-miku/50',
              ].join(' ')}
              aria-label={`跳转到: ${r.label}`}
            />
            <div className="absolute right-full mr-2 px-3 py-1.5 rounded-md text-sm whitespace-nowrap bg-surface border border-border/70 shadow-md text-fg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              {r.label}
            </div>
          </div>
        )
      })}
    </div>
  );
}
