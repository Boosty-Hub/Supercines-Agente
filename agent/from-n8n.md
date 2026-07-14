# Migrar un workflow de n8n al template

> **Importante**: este doc se aplica DESPUÉS de Fase 0 de `SETUP-WITH-CLAUDE.md` (cuando el usuario ya tiene su repo propio creado a partir del template). Toda edición sucede en el repo nuevo, NUNCA en el template.
>
> Si sos Claude leyendo esto: el usuario te pasó un workflow exportado de n8n (JSON) y querés reusar lo que se pueda. Este doc te dice qué buscar y dónde mapearlo. Mapeás al repo nuevo (el del agente), no al template.

## Cómo viene un workflow de n8n

Un export de n8n es un JSON con esta forma:
```json
{
  "name": "Mi Agente Kommo",
  "nodes": [
    { "name": "Webhook Kommo", "type": "n8n-nodes-base.webhook", ... },
    { "name": "Set vars", "type": "n8n-nodes-base.set", "parameters": { ... } },
    { "name": "Anthropic", "type": "@n8n/n8n-nodes-langchain.anthropic",
      "parameters": { "model": "claude-...", "options": { "systemMessage": "..." } } },
    { "name": "Kommo Reply", "type": "n8n-nodes-base.httpRequest", ... },
    ...
  ],
  "connections": { ... },
  "settings": { ... }
}
```

## Qué buscar y dónde mapearlo

### 1. System prompt del agente

**Buscar**: nodos de tipo `@n8n/n8n-nodes-langchain.anthropic`, `n8n-nodes-base.httpRequest` apuntando a `api.anthropic.com`, o nodos de OpenAI/cualquier LLM. Mirá `parameters.options.systemMessage`, `parameters.messages[0].content` (role system), o `parameters.jsonBody`.

**Mapear a**: `agent/system-prompt.md`. Pegá el system prompt como está y ajustá:
- Reemplazá referencias del modelo anterior (gpt-4, etc.) por la lógica del template (Sonnet 4.6).
- Si tiene instrucciones sobre paths de archivos (n8n usa otros), reemplazá por los placeholders `{{MASTER_PATH}}` y `{{LEADS_PATH}}` — se sustituyen automáticamente cuando guardás el prompt desde el dashboard (wizard `/setup` o editor `/agent`, vía `web/src/lib/agent-prompt.ts`).
- Si menciona herramientas del workflow n8n (HTTP nodes, Function nodes), describí la intención pero quitá los detalles técnicos — el agente acá usa solo la tool `search_kb`.

### 2. Modelo y parámetros

**Buscar**: `parameters.model` (suele ser `claude-3-5-sonnet`, `gpt-4`, etc.), `temperature`, `maxTokens`.

**Mapear a**:
- `.env.local` → `AGENT_MODEL` (convertí al nombre Anthropic actual; si era OpenAI, recomendá `claude-sonnet-4-6`).
- `temperature` y `maxTokens` del template no son configurables a nivel agent (vienen del CMA). Si el usuario los necesita custom, marcar como tarea pendiente y avisar.

### 3. Identidad del operador

**Buscar**: nodos `n8n-nodes-base.set` que definen variables como `operatorName`, `agentName`, `botName`. O dentro del system prompt: "Eres el asistente de X", "Sos X", etc.

**Mapear a**:
- `.env.local` → `OPERATOR_NAME` (nombre del operador), `AGENT_NAME` (slug kebab-case derivado).
- `web/.env.local` → `NEXT_PUBLIC_AGENT_LABEL` (label corto para el dashboard).

### 4. Credenciales Kommo

**Buscar**: nodos con credenciales tipo `kommoApi`, `httpHeaderAuth`, o URLs apuntando a `*.kommo.com`. Las credenciales reales NO viajan en el export (n8n las guarda aparte por seguridad), pero los nodos referencian su nombre y dejan ver:
- El subdomain (en `parameters.url`: `https://acmesales.kommo.com/api/v4/...` → `acmesales`).
- El custom field ID usado para escribir respuestas (en el body del PATCH a `/api/v4/leads/{id}`).
- El salesbot ID (en POST a `/api/v2/salesbot/run`).

**Mapear a**:
- `.env.local` → `KOMMO_SUBDOMAIN`, `KOMMO_API_DOMAIN` (preguntar al usuario el token y client_id/secret).
- Dashboard `/settings` (configuración runtime, NO env var) → `response_custom_field_id`, `salesbot_id`. Anotalos para configurarlos después.

### 5. Webhook entrante de Kommo

**Buscar**: nodo `n8n-nodes-base.webhook` con `path` definido. La URL pública del webhook en n8n era algo como `https://n8n.example.com/webhook/<uuid>`.

**Mapear a**: en este template el webhook lo recibe la Edge Function `kommo-webhook`. URL nueva:
```
https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/kommo-webhook?secret=<KOMMO_WEBHOOK_SECRET>
```
**Acción**: avisarle al usuario que tiene que actualizar el webhook URL en Kommo apuntando a la nueva (después del deploy).

### 6. Verticales / clasificación

**Buscar**: nodos `IF` o `Switch` o `Function` con lógica de "si el mensaje contiene X → categoría Y". O un node LLM dedicado a clasificación.

**Mapear a**:
- `supabase/migrations/0002_seed.sql` (si todavía no aplicaste migrate): editar para incluir las verticales detectadas (slug, name, description, system_prompt, auto_reply, requires_review).
- O después: dashboard `/verticales` → crearlas a mano.

Por cada categoría que veas:
- `slug`: snake_case sin tildes.
- `name`: nombre legible.
- `description`: 1-2 oraciones que el clasificador (Haiku) va a leer.
- `system_prompt`: instrucciones específicas para responder mensajes de esa categoría.
- `auto_reply`: true si el agente puede contestar sin revisión humana, false si requiere review.
- `requires_review`: true si SIEMPRE va a inbox de revisión.

### 7. KB / contexto factual

**Buscar**: nodos que cargan archivos, queries a vector stores (Pinecone, Supabase Vector, etc.), o que pasan documentos al LLM.

**Mapear a**: dashboard `/kb` (después del setup). Si en el JSON aparecen los textos/docs inline, decile al usuario que los puede subir en /kb directamente cuando arrancamos el dashboard.

### 8. Voz / few-shot examples

**Buscar**: arrays de mensajes ejemplo en el prompt (formato `[{role: user, content: ...}, {role: assistant, content: ...}]`), o nodos que cargan archivos `.txt` de ejemplos de respuestas.

**Mapear a**: dashboard `/voz` (después del setup). El operador los sube ahí como `example_response` o `chat_export`.

### 9. Outcomes / grading (raro en n8n)

n8n no tiene un equivalente nativo. Si el workflow tiene algún nodo evaluador post-respuesta, anotarlo como "feature original que el operador querrá replicar en `/outcomes`".

### 10. Cron / triggers de tiempo

**Buscar**: nodos `Cron` o `Schedule Trigger`.

**Mapear a**: el template ya tiene los crons de pipeline (process-inbound, generate-response, publish-to-kommo, evaluate-outcomes, alerts-scan, dreams-run). Si el workflow tenía otros (ej: resúmenes semanales, exports), anotarlos como "feature custom a agregar después" — no se incluyen out-of-the-box.

## Lo que NO se migra automáticamente

- Credenciales OAuth (Kommo no las exporta — hay que regenerar).
- Lógica custom en nodos `Function` o `Code` — léela, entendé qué hace, y discutí con el usuario si:
  - Se puede expresar como una vertical / prompt / KB → mapear.
  - Es algo que el template no soporta → marcar como deuda pendiente.

## Workflow de Claude para procesar un n8n export

1. Leer el JSON completo.
2. Generar un resumen estructurado al usuario:
   - **Detectado del workflow**: operador, modelo, system prompt completo (mostrarlo), Kommo subdomain, custom field IDs, verticales identificadas, KB/voz inline.
   - **Falta confirmar**: keys reales (Kommo token, Anthropic API key, Supabase credentials), valores específicos no inferibles.
3. Confirmar con el usuario que el extracto es correcto.
4. Aplicar al template (`.env.local`, `agent/system-prompt.md`, `0002_seed.sql` si todavía no migró).
5. Seguir con SETUP-WITH-CLAUDE.md desde la Fase 2 (cuentas/credenciales).
