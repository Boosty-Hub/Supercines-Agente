"use client";

import { useEffect, useState } from "react";
import Script from "next/script";

// Soporte Boosty: botón de tickets con grabación de pantalla, inyectado una
// sola vez. La app no tiene un único header responsive (sidebar en desktop +
// header propio en mobile — ver nav.tsx), así que el ícono se monta en el que
// corresponda según el viewport al cargar la página.
const BOOSTY_KEY = "bw_pk_eb2dd8dd6621f60d761c60396c03542e";
export const BOOSTY_MOUNT_DESKTOP = "boosty-mount-desktop";
export const BOOSTY_MOUNT_MOBILE = "boosty-mount-mobile";

export function BoostySupportWidget({ email }: { email: string }) {
  const [mountId, setMountId] = useState<string | null>(null);

  useEffect(() => {
    // Breakpoint `lg` de Tailwind (1024px) — mismo punto de corte que usan
    // SidebarNav (lg:flex) y MobileNav (lg:hidden) en nav.tsx.
    const mq = window.matchMedia("(min-width: 1024px)");
    setMountId(mq.matches ? BOOSTY_MOUNT_DESKTOP : BOOSTY_MOUNT_MOBILE);
  }, []);

  // Sin email no hay sesión resuelta todavía — no hay nada más que inferir
  // (este sistema no guarda un nombre de usuario separado del email).
  if (!mountId) return null;
  const name = email ? email.split("@")[0] : undefined;

  return (
    <Script
      src="https://portal.boosty.digital/boosty-support.js"
      strategy="afterInteractive"
      data-boosty-key={BOOSTY_KEY}
      data-boosty-mount={`#${mountId}`}
      {...(email ? { "data-boosty-user-email": email } : {})}
      {...(name ? { "data-boosty-user-name": name } : {})}
    />
  );
}
