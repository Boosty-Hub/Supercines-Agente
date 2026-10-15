-- =============================================================
-- 0083_provisioned_marker.sql
-- Marcador PERSISTENTE «esta instalación ya fue provisionada» (_app_secrets.PROVISIONED_AT).
--
-- El provisioner (/api/provision/*) trataba «sin usuarios» como primer arranque abierto: si se
-- borraban todos los usuarios de una instalación ya provisionada, el /first-run se reabría sin
-- sesión. Ahora el primer arranque exige además que NO exista este marcador (lo reclama el
-- register de forma atómica al crear al maestro). Una instalación provisionada sin usuarios queda
-- en recuperación: solo la recupera el operador desde Supabase (ver README).
--
-- Esta migración lo escribe para las instalaciones EXISTENTES: si ya hay algún usuario, la
-- instalación está provisionada. Si no hay ninguno (un despliegue recién creado que todavía no
-- pasó por el /first-run) no se marca: el register lo hará. IDEMPOTENTE.
-- =============================================================
insert into _app_secrets (clave, valor)
select 'PROVISIONED_AT', now()::text
 where exists (select 1 from auth.users)
on conflict (clave) do nothing;
