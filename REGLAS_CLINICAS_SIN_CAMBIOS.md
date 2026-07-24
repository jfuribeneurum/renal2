# Reglas usadas por la aplicacion

Reglas actualizadas contra los scripts `algoritmo_renal_creatinina.py` y `algoritmo_renal_microalbuminuria (1).py`.

## 1. Fecha de vigilancia

Todas las alarmas se calculan contra la fecha seleccionada en **Fecha de vigilancia**.

## 2. Creatinina / TFG

La aplicacion evalua cadenas de creatinina/TFG siguiendo las ventanas del script.

Si no existe TFG registrada, la app intenta calcularla con Cockcroft-Gault cuando tiene creatinina, edad o fecha de nacimiento, sexo y peso:

```text
TFG = ((140 - edad) x peso) / (72 x creatinina serica)
```

En mujeres se multiplica por 0,85.

### Ventanas base

- Primera TFG >=60: segunda toma anual entre **330 y 389 dias**.
- Primera TFG <60: segunda toma entre **90 y 119 dias**.

### Ramas principales

- TFG1 >=60 y TFG2 >=60: se descarta ERC por esta ruta.
- TFG1 <60 y TFG2 <60: se confirma ERC por persistencia.
- TFG1 <60 y TFG2 >=60: TFG3 entre **60 y 89 dias**.
- TFG1 >=60 y TFG2 <60: TFG3 entre **90 y 119 dias**.

### TFG adicional

El script puede exigir una cuarta toma:

- TFG1 >=60, TFG2 <60 y TFG3 >=60: TFG adicional entre **60 y 89 dias**.
- TFG1 >=60, TFG2 >=60 y TFG3 <60: TFG adicional entre **90 y 119 dias**.

## 3. Microalbuminuria / ACR

La app evalua cadenas de microalbuminuria/ACR siguiendo el script nuevo.

### Ventanas base

- MICRO1 <30: MICRO2 anual entre **330 y 389 dias**.
- MICRO1 >=30: MICRO2 entre **90 y 119 dias**.

### Si MICRO1 <30

- MICRO2 <30: se descarta ERC si no hay nueva alteracion en la cadena.
- MICRO2 >=30: MICRO3 entre **90 y 119 dias**.
- MICRO2 >=30 y MICRO3 <30: MICRO adicional entre **60 y 89 dias**.
- MICRO2 <30 y MICRO3 >=30: MICRO adicional entre **90 y 119 dias**.
- Si la adicional vuelve <30 en ese ultimo caso, queda pendiente nueva medicion entre **60 y 89 dias**.

### Si MICRO1 >=30

- MICRO2 >=30: se confirma ERC.
- MICRO2 <30: MICRO3 entre **60 y 89 dias**.
- MICRO3 >=30: se confirma ERC.
- MICRO3 <30: se descarta ERC por esta ruta.

## 4. Cumplimiento del algoritmo

La columna **cumple algoritmo** muestra:

- **Cumple**: la cadena confirma o descarta segun ventanas validas.
- **En oportunidad**: falta la siguiente toma, pero aun no paso el final de la ventana.
- **No cumple**: falta la siguiente toma y ya paso el final de la ventana.
- **Sin registro**: no hay toma valida para iniciar la ruta.

En el detalle del paciente se muestran las tomas usadas y los dias entre toma 1-2, 2-3 y 3-adicional cuando exista.

## 5. HbA1c

Aplica a pacientes con diabetes mellitus.

- Frecuencia maxima: **119 dias**.
- La gestion operativa conserva ventana de toma de 29 dias antes y 29 dias despues de la fecha objetivo.

## 6. Perfil lipidico

El perfil lipidico se considera completo con:

- colesterol total,
- HDL,
- LDL,
- trigliceridos.

Periodicidad usada:

- **365 dias** desde el componente mas antiguo disponible.
- Ventana operativa de 29 dias antes y 29 dias despues de la fecha objetivo.

## 7. Cargue de paraclinicos

La plantilla diaria conserva la columna **fuente**.

Columnas:

- tipo_identificacion,
- numero_identificacion,
- fecha_resultado,
- examen,
- valor,
- unidad,
- fuente,
- observacion.

## 8. Uso administrativo

Priorizar:

1. Pacientes **No cumple** o con examen **Vencido**.
2. Pacientes **En oportunidad** o **En ventana**.
3. Pacientes **Sin registro**.
4. Pacientes **Aun no citar**.

La app conserva las columnas de gestion por laboratorio y permite marcar **paciente gestionado** por creatinina, HbA1c, microalbuminuria/ACR y perfil lipidico.

## 9. Indicadores graficados en la app

Los indicadores se calculan sobre pacientes activos con diabetes mellitus.

Primero se define el universo operativo de la cohorte:

- Solo entran pacientes activos en la cohorte.
- En la cohorte institucional, si existe `Aplica indicadores?`, se consideran activos para el tablero los pacientes con `Aplica indicadores? = Si`.
- Si una cohorte no trae `Aplica indicadores?`, la app usa las columnas de novedad, ruta y afiliacion para retirar fallecidos, retirados, suspendidos, inactivos o egresados.
- Los pacientes no activos salen antes del calculo y no cuentan como denominador ni como exclusion de cada indicador.

Cuando la cohorte trae columnas explicitas de indicador, estas gobiernan el universo evaluable, pero no reemplazan el calculo clinico:

- `Aplica indicador = Si` define el denominador del indicador.
- `Aplica indicador = No - ...` excluye al paciente del denominador.
- `MOTIVO` o el texto de `No - ...` se usa como razon de exclusion.
- `¿CUMPLE?` se conserva como referencia del archivo, pero no define el numerador de la grafica.
- El numerador se calcula con los paraclinicos y variables disponibles: creatinina/TFG, microalbuminuria/ACR, LDL, presion arterial, HbA1c y perdida anual de TFG.

La cohorte institucional de junio trae bloques repetidos `Aplica indicador`, `¿CUMPLE?` y `MOTIVO`. La app los interpreta en este orden:

1. Indicador 1: creatinina/TFG.
2. Indicador 2: microalbuminuria/ACR.
3. Indicador 3: LDL.
4. Indicador 4: presion arterial.
5. Indicador 5: HbA1c.
6. Indicador 6: perdida anual de TFG.

Para el indicador 6, si existen los dos bloques `CKG` y `CKDEPI`, la app usa `CKG` por consistencia con Cockcroft-Gault.

Reglas de calculo del numerador:

- Creatinina/TFG: pacientes con algoritmo de creatinina en **Cumple** o **En oportunidad**. Meta **70%**.
- Microalbuminuria/ACR: pacientes con algoritmo de microalbuminuria en **Cumple** o **En oportunidad**. Meta **60%**.
- LDL en meta: ultimo LDL de los ultimos 12 meses entre **15 y 100 mg/dL**. Meta **50%**.
- Presion arterial controlada: PA del ultimo semestre con sistolica **>90 y <140 mmHg** y diastolica **>60 y <90 mmHg**. Meta **70%**.
- HbA1c controlada: HbA1c del ultimo semestre **>=4% y <7%**. Meta **50%**.
- Sin perdida anual de TFG: usa el bloque Cockcroft-Gault; cuenta cuando el algoritmo del bloque no reporta motivo de no cumplimiento. Meta **50%**.
