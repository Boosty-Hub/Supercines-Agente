# Prompt: dejar CUALQUIER proyecto listo para el workspace del Boosty Hub

Copiá el bloque de abajo y pegalo en Claude Code (o Claude en el IDE) **dentro del
repositorio del proyecto** que querés ver en el Projects Hub. Es **dinámico y
stack-agnóstico**: sirve para agentes Next.js, SPAs de Vite, sitios estáticos u otros
stacks — Claude analiza el proyecto y llega al mismo objetivo adaptado a su realidad.
También lo dispara el propio Hub con el botón **"Copiar prompt para Claude"** cuando un
proyecto no carga o no auto-loguea en el workspace.

> El Hub mantiene la copia canónica de este prompt en `src/lib/embed/setup-prompt.ts`.

---

## ⤵️ PEGAR ESTO EN CLAUDE

OBJETIVO: dejar ESTE proyecto listo para abrirse DENTRO del workspace del Boosty Projects
Hub (un iframe cross-site) y —si el proyecto tiene login— que quede YA autenticado, sin que
el usuario vuelva a loguearse. El prompt es genérico: primero ANALIZÁ el proyecto y adaptá la
solución a su stack real. No asumas Next.js.

PASO 0 — ANALIZÁ y respondé (para vos):
- ¿Qué stack/framework es? (Next.js App/Pages, Vite + React/Vue/Svelte SPA, Astro, sitio
  estático, server-rendered, otro).
- ¿Dónde se hostea y cómo se emiten las cabeceras HTTP? (Netlify netlify.toml/public/_headers,
  Vercel/next.config, vercel.json, nginx/Apache, Cloudflare Workers, etc.).
- ¿Tiene autenticación? ¿Con qué? (Supabase Auth, Auth0, Firebase, sesión propia, ninguna).
  ¿La sesión vive en cookies o en localStorage?

Después cumplí el objetivo en DOS NIVELES, según lo que aplique:

NIVEL 1 — EMBEBER (para CUALQUIER proyecto, tenga login o no):
El proyecto debe permitir mostrarse en el iframe del Hub. Ajustá las cabeceras de RESPUESTA
para permitir el framing desde el Hub, con el mecanismo propio del stack/host:
- Quitar cualquier `X-Frame-Options: DENY/SAMEORIGIN`.
- Emitir `Content-Security-Policy: frame-ancestors <origen-del-Hub>` (o `*` si aún no hay
  dominio fijo; idealmente restringido al dominio del Hub vía una env tipo EMBED_ORIGINS).
- Debe ser un HEADER HTTP real (un `<meta http-equiv>` NO sirve para frame-ancestors). Usá
  netlify.toml [[headers]] o public/_headers, next.config headers()/middleware, vercel.json,
  nginx add_header, según corresponda.
- Seguridad: dejá el default en `frame-ancestors 'self'` y abrilo SOLO en modo embed
  (detectado por `?mode=embed` o una cookie/param), no siempre.
Con esto, un sitio SIN login (landing, web, dashboard público) YA se ve en el workspace. Si el
proyecto no tiene login, TERMINÁ acá.

NIVEL 2 — AUTO-LOGIN SSO (SOLO si el login es con Supabase Auth):
El Hub mintea un magic-link de Supabase para el usuario `api@boosty.digital` y redirige a
`https://<este-proyecto>/auth/callback?mode=embed`. La app debe:
- Exponer una ruta/handler `/auth/callback` que lea el token del magic-link (flujo implícito:
  `#access_token`+`#refresh_token` en el HASH; o PKCE: `?code`) y establezca la sesión
  (setSession / exchangeCodeForSession). Idempotente: chequear getSession() primero y ante
  error de token — si ya hay sesión, seguir (los magic-links son de un solo uso y el callback
  puede correr dos veces).
- MANTENER la sesión viva dentro del iframe cross-site, según dónde se guarde:
  * Cookies (ej. `@supabase/ssr`): en contexto embebido, las cookies de sesión (y cualquier
    cookie de la que dependa) deben ser `SameSite=None; Secure; Partitioned` (CHIPS) o el
    navegador las descarta. Gatealo a embed para no debilitar el uso top-level ni romper dev
    local en http.
  * localStorage (SPA con supabase-js): usá `detectSessionInUrl: true` y `persistSession: true`;
    suele sobrevivir el iframe particionado. Asegurá que la ruta de callback procese el hash.
- Si el login NO es Supabase (Auth0/Firebase/propio): el SSO del Hub (magic-link de Supabase)
  NO aplica tal cual. Reportalo y dejá al menos el Nivel 1 + el botón "Abrir en pestaña nueva".

SI ALGO NO SE PUEDE (el host no deja setear cabeceras, el navegador no soporta cookies
particionadas para ese caso, o el auth no es Supabase): decilo CLARO — qué nivel se logró, qué
no, y por qué. NO inventes ni fuerces algo inseguro.

AL TERMINAR: resumen de (1) stack detectado, (2) qué nivel quedó (embeber / auto-login), (3)
archivos tocados y por qué, (4) cómo probarlo. NO rompas el uso normal (top-level) ni el dev
local. Corré el build/type-check y arreglá lo que rompa.

## ⤴️ FIN DEL PROMPT

---

### Qué hace el Hub por su cuenta (no lo tenés que hacer en el proyecto)

- Deriva la `service_role` del proyecto desde su access token, asegura el usuario SSO
  `api@boosty.digital` y configura `site_url` + `uri_allow_list` del Supabase del proyecto
  (botón **"Conectar SSO"** en la pestaña Credenciales del Hub). Esto solo aplica al Nivel 2.
- Mintea el magic-link hacia `/auth/callback?mode=embed` y embebe el proyecto en el workspace.

### Cómo verificar

1. (Solo Nivel 2) En el Hub → proyecto → **Credenciales** → **Conectar SSO** (verde "conectado").
2. Abrí el **workspace** del proyecto: debe mostrarse embebido (y ya logueado si tiene login).
3. Si el embebido no auto-loguea por políticas del navegador, **"Abrir en pestaña nueva"**
   siempre funciona (top-level, sin partición de cookies).
