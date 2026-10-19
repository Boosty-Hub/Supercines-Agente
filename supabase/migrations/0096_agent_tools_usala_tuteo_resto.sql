-- Las tools sembradas (0028/0029/0030/0031/0058) dicen «USALA cuando…» / «USALA SOLO…» sin tilde:
-- el imperativo voseante con enclítico («usala»); el tuteo la conserva («ÚSALA»). La migración de
-- tuteo anterior no cubría siempre esta variante en mayúsculas. Mismo criterio que esa: solo se
-- reemplaza el fragmento exacto sembrado; una descripción que el operador reescribió sin él no se
-- toca. Idempotente: sin el fragmento viejo no hace nada.
update agent_tools
set description = replace(description, 'USALA ', 'ÚSALA ')
where description like '%USALA %';
