"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Renderiza una lista larga de forma progresiva: muestra `step` elementos y
// revela más a medida que el usuario baja (IntersectionObserver sobre un
// centinela). Los items ya vienen renderizados desde el server; esto solo
// controla cuántos se montan en el DOM, para no clavar cientos de nodos de una
// sola vez (el inbox, por ejemplo, puede traer hasta 500 leads).
export function LazyReveal({
  items,
  step = 60,
}: {
  items: ReactNode[];
  step?: number;
}) {
  const [count, setCount] = useState(Math.min(step, items.length));
  const sentinelRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (count >= items.length) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setCount((c) => Math.min(c + step, items.length));
        }
      },
      { rootMargin: "300px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [count, items.length, step]);

  return (
    <ul className="divide-y divide-neutral-100">
      {items.slice(0, count)}
      {count < items.length && (
        <li ref={sentinelRef} className="px-4 py-4 text-center text-xs text-neutral-400">
          Cargando más… ({count}/{items.length})
        </li>
      )}
    </ul>
  );
}
