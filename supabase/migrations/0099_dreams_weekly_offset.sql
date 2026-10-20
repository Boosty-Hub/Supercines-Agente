-- 0099_dreams_weekly_offset.sql — el análisis semanal ya no choca con el diario.
-- 0010 programó los dos a las 03:00 UTC del domingo y, con el lease de 0098, uno de
-- los dos responde `busy`: si perdía el semanal, esa semana no había análisis
-- semanal (el diario se repone al día siguiente; el semanal no). Se corre el semanal
-- a las 04:30, holgado por encima de la duración de una corrida diaria.
-- Solo cambia el horario si sigue siendo el de 0010: un horario que el operador
-- cambió a mano se respeta. Idempotente.
do $$
declare
  v_job bigint;
begin
  select jobid into v_job from cron.job
   where jobname = 'dreams-weekly' and schedule = '0 3 * * 0';
  if v_job is not null then
    perform cron.alter_job(v_job, schedule := '30 4 * * 0');
  end if;
end$$;
