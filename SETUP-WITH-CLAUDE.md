# Setup con Claude

> **REGLA #1 — NUNCA edites el template directamente**
>
> Este repo (`kommo-claude-agent-template`) es la plantilla. **Jamás se edita.** Cada agente nuevo arranca creando UN REPO PROPIO a partir del template. Todo el trabajo posterior sucede en ese repo nuevo, nunca acá.
>
> ---
>
> **Cómo usar este documento**
>
> **Si sos un humano**: la primera fase de abajo (Fase 0) es crear el repo nuevo. Después abrís ESE repo (no este) con Claude Code y decile *"Sigue SETUP-WITH-CLAUDE.md"*. Claude te va a guiar hasta dejar el agente desplegado.
>
> **Si sos Claude leyendo esto**: tu primera responsabilidad es VERIFICAR que el usuario está trabajando en un repo nuevo, no en el template. Si está en `kommo-claude-agent-template`, hacé Fase 0 con él/ella. Si ya está en su repo propio, saltá Fase 0 y arrancá en Fase 1. En cada fase: leé el **Objetivo**, hacé las **Preguntas al usuario**, esperá respuesta, ejecutá las **Acciones**, validá el **Checkpoint**, y solo entonces avanzá. **No avances si una validación falló** — investigá la causa y resolvé con el usuario.
>
> Si Claude no tiene tools (Claude.ai web sin file access): leé las acciones y dictaselas al usuario.

---

## Fase 0 — Crear el repo del agente (NUNCA editar el template)

**Objetivo**: que el usuario tenga un repo nuevo propio (en su org de GitHub, o en la que corresponda) inicializado a partir del template, y que esté parado en ese repo nuevo localmente.

**Verificación previa**: averiguá en qué directorio está parado el usuario.
- Si el remote `origin` apunta a `Boosty-Hub/Template-Agent-kommo` (o equivalente) → ESTÁ EN EL TEMPLATE. Detenelo y seguí esta fase.
- Si apunta a otro repo del usuario → ya tiene repo propio, saltá a Fase 1.

**Preguntas al usuario**:
1. "¿Cómo se va a llamar el agente y el repo en GitHub? Convención: kebab-case (ej: `acme-agent`, `gmt-responder`)."
2. "¿En qué org/usuario de GitHub lo creamos?"
3. "¿El repo nuevo va a ser privado o público?"

**Acciones**:

```bash
gh repo create <ORG>/<NOMBRE> \
  --template Boosty-Hub/Template-Agent-kommo \
  --private \
  --clone
cd <NOMBRE>
git remote -v   # debe mostrar: origin <ORG>/<NOMBRE>.git
```

**Checkpoint**:
- `pwd` muestra el repo nuevo (NO `kommo-claude-agent-template`).
- `git remote -v` apunta a `<ORG>/<NOMBRE>.git`.

---

## Fase 0a — ¿Tenés un workflow de n8n existente?

**Objetivo**: si el usuario ya tiene un agente en n8n y lo quiere migrar, extraer todo lo que se pueda automáticamente.

**Preguntas al usuario**:
1. "¿Tenés un workflow de n8n del agente que querés migrar? Si sí, exportalo desde n8n (botón ⋯ → Download) y pegame el JSON."

**Acciones**:
- **Si SÍ**: leé `agent/from-n8n.md` y aplicalo. Extraé operator name, system prompt, modelo, verticales, credenciales que aparezcan.
- **Si NO**: avanzá a Fase 1.

---

## Fase 1 — Identidad del agente

**Objetivo**: decidir cómo se llama el agente, quién es el operador, qué voz va a tener.

**Preguntas al usuario** (saltá las que ya sepas por n8n):
1. **Operador**: nombre de la persona o marca detrás del agente.
2. **Slug del agente**: kebab-case, único en la cuenta Anthropic (ej: `acme-responder`).
3. **Label dashboard**: texto en el header del panel (ej: `Agente GMT`).
4. **Modelo**: default `claude-sonnet-4-6`.

**Nota**: estos valores ya NO van en `.env.local`. Se ingresan directamente en el wizard `/setup` del dashboard después del deploy. Podés anotarlos para tenerlos a mano.

**Checkpoint**: tenés anotados los datos de identidad. No hay nada que editar en el repo todavía.

---

## Fase 2 — Cuentas y credenciales (obtener, NO configurar en .env aún)

**Objetivo**: que el usuario tenga las 3 cuentas creadas y los valores a mano para el siguiente paso.

### 2.1 Supabase

1. Creá un proyecto Supabase: `supabase.com/dashboard` → "New project" → región más cercana.
2. Obtené estos valores (los vas a pegar en el host en Fase 3):
   - **URL del proyecto**: `https://<ref>.supabase.co` (Project Settings → API → Project URL)
   - **Anon key** (LEGACY JWT, empieza con `eyJ`): Project Settings → API → Legacy API keys → `anon (public)`
   - **Service role key**: mismo lugar → `service_role (secret)`
3. Para la inicialización, también vas a necesitar un **Personal Access Token** (`sbp_...`): `supabase.com/dashboard/account/tokens` → Generate new token.

### 2.2 Anthropic

1. Obtenés `ANTHROPIC_API_KEY` de `console.anthropic.com/settings/keys` → "Create Key".
   Esta clave la ingresás en el wizard `/setup` después del deploy.

### 2.3 Kommo (podés hacerlo después de Fase 4 si no lo tenés)

1. Creá una integración privada: Settings → Integrations → "Create integration" → tipo Private → scope `crm`.
2. Anotá: `KOMMO_CLIENT_ID`, `KOMMO_CLIENT_SECRET`, `KOMMO_LONG_LIVED_TOKEN`, `KOMMO_SUBDOMAIN`, `KOMMO_API_DOMAIN`.
   Estos se ingresan en el wizard `/setup` → paso Kommo.

**Checkpoint**: tenés los valores anotados. NO se escriben en ningún archivo .env todavía.

---

## Fase 3 — System prompt (la voz del agente)

**Objetivo**: tener el texto del system prompt listo para pegarlo en el wizard `/setup` o editarlo después en `/agent`.

**Preguntas al usuario** (si ya hubo extracción de n8n, presentale el system prompt extraído y preguntá qué ajustar):

1. "¿Tenés ya escrito en algún lado un system prompt o una guía de voz del operador? Pasámelo."
2. Si no: completá los marcadores `[REEMPLAZÁ ESTA SECCIÓN]` de `agent/system-prompt.example.md`. Mínimo:
   - Registro (formal / informal / de negocio).
   - Regionalismos y variantes a usar/evitar.
   - Largo típico preferido.
   - Qué NUNCA decir.
   - Idioma fallback.

**Acciones**:
- Guardá el borrador en `agent/system-prompt.md` (archivo local, no se commitea al template).
- Los placeholders `{{OPERATOR_NAME}}`, `{{MASTER_PATH}}`, `{{LEADS_PATH}}` se sustituyen automáticamente al guardar desde el dashboard. No los toques a mano.

**Checkpoint**: tenés un system prompt que el operador aprobaría. Lo vas a pegar en el wizard en Fase 5.

---

## Fase 4 — Deploy en Netlify o Vercel

**Objetivo**: el dashboard accesible en una URL pública, listo para recibir las credenciales de Supabase.

### Netlify

1. netlify.com → "Add new site" → "Import from Git" → seleccionar el repo.
2. **Build settings**: se leen desde `netlify.toml` — ya están correctos (`base = "web"`, `command = "pnpm build"`).
3. Deploy inicial (va a fallar — no hay env vars aún). Eso es esperado.

### Vercel

1. vercel.com → "Add New" → "Project" → importar repo.
2. Root directory: `web/`. Build command: `pnpm build`.
3. Deploy inicial (va a fallar por las mismas razones).

**Importante — constraint de build**: el directorio `web/` necesita acceso a `../supabase/` para el codegen. Netlify y Vercel hacen checkout completo del repo — funciona sin configuración extra.

**Checkpoint**: tenés una URL pública (aunque el sitio aún no funcione).

---

## Fase 5 — Configurar env vars en el host y primer deploy exitoso

**Objetivo**: configurar las 3 variables de Supabase en el host, redesplegar, y abrir el wizard `/first-run`.

**Acciones**:

1. En el panel del host, ir a las variables de entorno:
   - **Netlify**: Site configuration → Environment variables
   - **Vercel**: Project Settings → Environment Variables

2. Agregar las 3 variables:
   | Variable | Valor |
   |----------|-------|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key legacy JWT |
   | `SUPABASE_SERVICE_ROLE_KEY` | service role key legacy JWT |

3. Redesplegar (Trigger deploy / Redeploy).

4. Abrir la URL del deploy → aparece el wizard `/first-run`.

### Paso Initialize en el wizard

1. El wizard muestra el paso "Inicializar".
2. Pegar el Personal Access Token (`sbp_...`) de Supabase.
3. Hacer clic en "Inicializar" → el wizard aplica las 17 migraciones SQL y deploya las 8 Edge Functions con barras de progreso en tiempo real.
4. Al finalizar, el wizard avanza al paso "Crear usuario".

### Paso Crear usuario

1. Ingresar email y contraseña para el único usuario del dashboard.
2. El sistema bloquea automáticamente registros adicionales.
3. Al crear el usuario, el wizard inicia sesión y te lleva directo al dashboard (`/inbox`). El onboarding de Anthropic + Kommo sigue como panel lateral (drawer), no bloqueante.

**Checkpoint**:
- El deploy exitoso. En supabase.com → Edge Functions aparecen las 8 deployadas con `verify_jwt = off`.
- El usuario puede acceder al dashboard en `/inbox`.

---

## Fase 6 — Wizard de provisioning (panel lateral, Anthropic + Kommo)

**Objetivo**: provisionar Managed Agent, Memory Stores y conexión Kommo desde el dashboard.

Ya dentro del dashboard, un **panel lateral derecho** ("Configurá tu agente") guía el onboarding. No es obligatorio ni bloquea el acceso: se abre solo la primera vez, se puede cerrar y reabrir (botón flotante abajo a la derecha, o visitando `/setup`), y el progreso persiste. Provisiona en orden:

1. **Credenciales e identidad**: Anthropic API key + nombre del operador, del agente y del dashboard. El system prompt se puede pegar acá o después en `/agent`.
2. **Managed Agent**: crea el Environment + Agent con el system prompt.
3. **Verticales** (opcional): la IA sugiere categorías de mensaje a partir del agente creado.
4. **Memory Stores**: crea los dos stores en Anthropic y guarda sus IDs.
5. **Kommo**: token, subdomain, API domain. Verifica contra la API y guarda.

Todo se escribe en `runtime_config` (DB). El wizard es idempotente — podés re-correrlo sin duplicar nada.

**Checkpoint**:
- En Anthropic Console aparecen los 2 Memory Stores y el Managed Agent.
- El paso Kommo completó sin error.

---

## Fase 7 — Kommo (webhook + campo de respuesta)

**Objetivo**: que Kommo envíe sus mensajes al sistema y el sistema pueda escribir respuestas.

### Configurar webhook en Kommo (en el panel de Kommo)

Webhook URL:
```
https://<ref>.supabase.co/functions/v1/kommo-webhook
```

Eventos a habilitar:
- Mensaje agregado (Message added)
- Lead agregado (Lead added)
- Lead actualizado (Lead updated)

### Campo de respuesta + salesbot

En el dashboard `/settings`:
- `response_custom_field_id` — el custom field de Kommo que recibe la respuesta.
- `salesbot_id` — el bot que toma ese campo y lo envía al canal del lead.

**Checkpoint**: mandá un mensaje de prueba al canal. En `/inbox` debe aparecer en <2 min.

---

## Fase 8 — Smoke test + operación en shadow

**Objetivo**: validar el pipeline completo antes de habilitar publicación automática.

1. Dashboard `/settings`:
   - `agent_enabled = true`
   - `publishing_enabled = false` (shadow — genera drafts sin publicar)
   - `bypass_review = false`

2. Cargar contexto mínimo:
   - `/voz` — 2-3 ejemplos de chats reales o reglas de voz.
   - `/kb` — 1-2 docs con info factual (precios, FAQs).
   - `/verticales` — revisar las verticales; agregar las del negocio.

3. Mandar mensajes de prueba y revisar los drafts en `/inbox`.

4. Cuando la calidad sea correcta: `publishing_enabled = true`.

**Checkpoint**: el operador vio al menos un draft que firmaría como suyo.

---

## Apéndice A — Errores comunes

| Síntoma | Causa probable | Fix |
|---|---|---|
| El wizard /first-run no avanza tras configurar las vars | Las `NEXT_PUBLIC_*` necesitan un redeploy para ser incluidas en el bundle | Redesplegar el sitio |
| Webhook Kommo devuelve 401 | `verify_jwt=true` en la Edge Function | Las funciones se despliegan con `verify_jwt=false` vía el wizard. Si desplegaste por CLI, revisá `supabase/config.toml` |
| Drafts quedan `pending` para siempre | `ANTHROPIC_AGENT_ID` no seteado en `runtime_config` | Volver a `/setup` → paso Agente |
| Las páginas `/dreams` o `/voz` dicen "memory_stores/undefined" | Memory Stores no aprovisionados | Volver a `/setup` → paso Memory Stores |
| Login no funciona | Las nuevas keys `sb_publishable_*` no andan con PostgREST | Usar las legacy JWT keys |
| Migración falla con "pg_net not enabled" | pg_net no está habilitado en el proyecto | Habilitar en Supabase Dashboard → Database → Extensions → pg_net, y reintentar desde el wizard |

## Apéndice B — Iteración post-launch

- **Cambiar la voz**: dashboard `/agent` → editar system prompt → guardar (sincroniza con Anthropic).
- **Agregar verticales**: dashboard `/verticales`.
- **Subir más contexto**: dashboard `/voz` y `/kb`.
- **Revisar performance**: dashboard `/outcomes`.
- **Aprendizajes nocturnos**: dashboard `/dreams`.
- **Apagar temporalmente**: `/settings` → `agent_enabled = false`.
- **Re-desplegar una Edge Function puntual**: desde el wizard `/first-run` (si hay funciones faltantes) o desde la CLI: `SUPABASE_ACCESS_TOKEN=<token> npx supabase functions deploy <fn> --project-ref <ref>`.
