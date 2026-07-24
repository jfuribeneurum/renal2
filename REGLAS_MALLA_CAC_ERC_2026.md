# Reglas del módulo Malla CAC ERC 2026

## Alcance

El módulo corresponde al reporte de enfermedad renal crónica, hipertensión arterial y diabetes mellitus de la Cuenta de Alto Costo.

La salida conserva las 82 variables distribuidas en 121 campos del reporte ERC 2026. La columna `Auditoria` pertenece al control interno y no se incluye en el archivo plano SISCAC.

## Fuentes y prioridad

1. El Excel de atenciones aporta identificación, datos demográficos, diagnósticos, signos vitales y resultados discretos.
2. Los PDF se asocian por tipo de documento, número y fecha obtenidos del nombre del archivo.
3. Para creatinina, HbA1c, RAC y perfil lipídico se comparan los datos discretos del Excel, los resultados fechados dentro de la narrativa de cada atención y los PDF.
4. La TFG solo se toma del dato consignado en la atención. La aplicación no calcula ni reemplaza la variable 35.
5. Los valores calculados y numéricos se reportan con máximo dos decimales sin aproximación.
6. Un dato administrativo ausente no se inventa. Queda como error bloqueante en la hoja `Validacion`.

## Consolidación por paciente

- Cada número de documento genera exactamente una fila, aunque tenga varias atenciones o PDF.
- Las atenciones se ordenan por `fechaCreacion`; cada campo no vacío de una atención posterior complementa o actualiza el consolidado.
- Un campo vacío en una atención nueva no borra el dato válido de una atención anterior.
- Cada paraclínico se consolida por separado. Creatinina, HbA1c, RAC, colesterol total, HDL y LDL conservan su propio valor, fecha y fuente.
- La prioridad cronológica es la fecha real de toma. La fecha de la consulta no se convierte en fecha de laboratorio.
- Cuando dos fuentes tienen la misma fecha de toma, el PDF prevalece por ser el soporte clínico directo.
- Los textos de `paraclinicos` se recorren por bloques fechados para recuperar resultados históricos y seleccionar el más reciente.
- Un valor sin fecha identificable queda visible, se reporta con el código de fecha permitido y bloquea el registro para revisión.
- Peso, talla, presión sistólica y presión diastólica también se consolidan de manera independiente.
- Para los signos vitales, la fecha corresponde a la atención o al soporte PDF donde quedó documentada la medición.
- Se selecciona la medición fechada más reciente disponible para cada signo vital. Un soporte o una atención posterior con el campo vacío no borra una medición válida anterior.
- Si el PDF más reciente no contiene signos vitales, se busca el dato en los PDF anteriores y después en las atenciones. A igual fecha, prevalece el PDF.
- La hoja `Validacion` identifica el valor, la fecha y la fuente seleccionada para peso, talla, TAS y TAD.
- Se cuentan los meses distintos con atenciones entre el 1 de julio de 2025 y el 30 de junio de 2026 para la variable 76.
- Un PDF cuyo documento no aparece en el Excel se clasifica como soporte sin coincidencia.
- Una diferencia entre el tipo documental del Excel y el nombre del PDF bloquea el registro.
- El tipo documental se toma de la atención más reciente que contenga un código reconocido. Si el Excel no permite reconocerlo, puede completarse desde un único PDF coincidente.
- Se reconocen también las variantes institucionales `Permiso de Proteccion Termporal` y `Salvo Conducto`.

## Identificación y administración

- Los nombres se separan en primer nombre, otros nombres, primer apellido y otros apellidos. Los casos compuestos se marcan para revisión.
- Si no existe segundo nombre se reporta `NONE`; si no existe segundo apellido, `NOAP`.
- Sexo: `F` o `M`.
- Régimen: `C`, `S`, `P`, `E`, `N`, `V` o `I`.
- Municipio: código DIVIPOLA de cinco dígitos.
- Teléfono: se toma del PDF; si no está disponible se usa `0`, permitido por el instructivo.
- Los códigos EAPB e IPS, fecha de afiliación, costos y serial BDUA deben venir de la configuración o de columnas adicionales del Excel.
- Para ente territorial puede marcarse la opción que reporta serial BDUA igual a `0`.

Columnas opcionales reconocidas en el Excel:

- `costo_hta`
- `costo_dm`
- `costo_total`
- `serial_bdua`

## Diagnósticos y TFG

- HTA: `1` cuando el campo es afirmativo y `2` cuando es negativo.
- Diabetes: tipo 1 = `1`, sin diabetes = `2`, tipo 2 = `3`, otros tipos = `4`.
- ERC confirmada solo se asigna cuando la historia la registra explícitamente.
- Una TFG menor de 60 o RAC mayor o igual a 30 sin persistencia demostrada se clasifica como indeterminada, no como ERC confirmada.
- Sin pruebas renales se clasifica como no estudiado.
- El estadio se deriva de la TFG registrada solo cuando existe ERC confirmada.
- En adultos, la TFG consignada en la atención debe corresponder a Cockcroft-Gault.
- En menores de 18 años, la TFG consignada en la atención debe corresponder a Schwartz.
- La aplicación no ejecuta ninguna de estas fórmulas para completar la malla.
- Cuando la atención no contiene TFG, la variable 35 se reporta con `999`, la variable 39 queda en `99` y el registro se bloquea para revisión.
- Los códigos especiales `999`, `988` y `777` solo se conservan cuando vienen registrados en la atención.
- El peso usado clínicamente para la TFG no puede tener más de seis meses de diferencia frente a la creatinina.

## Ventanas del reporte

- Creatinina sin ERC o ERC 1-2: del 1 de julio de 2025 al 30 de junio de 2026.
- Creatinina ERC 3-4: del 1 de enero al 30 de junio de 2026.
- Creatinina ERC 5 sin TRR o TMND: del 1 de abril al 30 de junio de 2026.
- HbA1c en diabetes: del 1 de enero al 30 de junio de 2026.
- RAC, albuminuria y perfil lipídico: del 1 de julio de 2025 al 30 de junio de 2026.
- Un resultado fuera de la ventana queda visible, pero bloquea el TXT.

## Albuminuria

El campo `albuminuria` de las historias corresponde a microalbuminuria en mg/L. No se convierte en albuminuria de 24 horas porque las unidades no son equivalentes.

- Variable 29: se reporta `9999` y fecha `1800-01-01` cuando no existe albuminuria de 24 horas.
- Variable 30: se usa exclusivamente para la relación albuminuria/creatininuria en mg/g, identificada como `RAC`.

## TRR y trasplante

Cuando la historia indica que el paciente nunca ha recibido TRR ni trasplante, se aplican los valores de no aplica definidos en el instructivo para las variables 42 a 75.

Si existe TRR o trasplante, el módulo no completa automáticamente estos campos: el registro se bloquea para revisión clínica especializada.

## Salidas

- `Malla_CAC`: 121 campos en el orden de la plantilla oficial, más la columna interna `Auditoria`.
- `Validacion`: estado, tipo documental, cobertura, soportes, valores, fechas, fuentes de signos vitales y paraclínicos, y causas de bloqueo por paciente.
- `Configuracion`: parámetros usados y conteos de control.
- Archivo TXT ANSI separado por tabulaciones: solo contiene registros con estado `LISTO`.

El archivo TXT no incluye encabezados, no contiene campos vacíos y elimina caracteres especiales no permitidos por SISCAC.
