# Neurum - Gestión renal compartida

Aplicación clínica y administrativa para una cohorte DM/ERC. Conserva el motor renal y las métricas de la versión validada y añade trabajo multiusuario, tareas, responsables y trazabilidad.

Esta edición restaura la malla clínica completa de 34 columnas, el detalle por paciente y el cargue real de cohortes y paraclínicos XLSX, CSV o TSV. Los paraclínicos se guardan en lotes para soportar cohortes grandes sin perder la trazabilidad del archivo original.

## Funciones

- Inicio de sesión con cookie de sesión `HttpOnly` y protección CSRF.
- Roles: administrador, clínico, gestor y auditor.
- Cohorte y paraclínicos compartidos en base de datos SQLite transaccional.
- Tareas asignables por paciente y paraclínico.
- La selección `Paciente gestionado` crea o actualiza una tarea compartida en estado `En gestión`.
- Flujo visual `Pendiente` → `En gestión` → `Programada` → `Resuelta`, con búsqueda y acciones rápidas.
- Historial de creación, cambios de estado, reasignaciones y notas.
- Auditoría de accesos, cargues, tareas, usuarios, respaldos y borrado.
- Respaldo automático diario y respaldo manual descargable.
- Tema claro/oscuro y navegación lateral por módulos.
- Gráficas de prioridad, alarmas por paraclínico, estadio renal y cobertura de datos.
- Malla clínica completa con TFG, fechas objetivo, alarmas, cumplimiento, días vencidos y días faltantes por examen.
- Detalle accesible desde el nombre del paciente o desde el botón `Detalle`.
- Cargues con progreso, validación de documentos activos y columna obligatoria `fuente` para paraclínicos.

## Ejecutar en Windows

1. Instala Python 3.11 o superior marcando la opción `Add Python to PATH`.
2. Abre `ejecutar_app.bat`; alternativamente, abre PowerShell en esta carpeta y ejecuta `python run.py`.
3. Abre `http://127.0.0.1:8780/`.
4. En el primer arranque, el servidor muestra en la consola el usuario administrador y una contraseña temporal.
5. La aplicación exige cambiar esa contraseña al ingresar.

El iniciador local verifica e instala `openpyxl` y `pypdf` desde `requirements.txt` cuando no están disponibles.

## Cargar información

1. Ingresa con un usuario administrador, clínico o gestor.
2. Abre `Cargues` en el menú lateral.
3. Para reemplazar la cohorte activa, selecciona `Cohorte de pacientes` y carga el XLSX institucional.
4. Para anexar resultados, selecciona `Paraclínicos diarios` y usa la hoja `Paraclinicos_diarios` de la plantilla incluida.
5. Espera el mensaje final. En cargas grandes la aplicación muestra el avance de resultados guardados.
6. Abre `Cohorte renal`; selecciona el nombre de un paciente para ver datos, alarmas, secuencias y diferencias entre tomas.
7. Marca `Paciente gestionado` para enviar el caso a `Tareas`; allí podrás asignarlo, programarlo y resolverlo con nota.

La columna `fuente` es obligatoria en el formato diario. Los resultados cuyo documento no pertenezca a la cohorte activa se informan como omitidos y no afectan el seguimiento.

## Generar la malla CAC ERC

1. Abre `Malla CAC` en el menú lateral.
2. Registra fecha de corte, código EAPB, código REPS de la IPS y los parámetros administrativos aplicables.
3. Descarga `Plantilla de atenciones` para consultar la estructura vacía de 319 columnas, o carga directamente el Excel exportado de atenciones institucional.
4. Carga uno o varios PDF. El nombre esperado es `TIPODOCUMENTO_DOCUMENTO_ESPECIALIDAD_AAAA-MM-DD.pdf`, por ejemplo `CC123_ENDOCRINOLOGIA_2026-06-30.pdf`.
5. Selecciona `Generar malla`.
6. Descarga `Malla y validación`. La hoja `Malla_CAC` conserva los 121 campos del reporte ERC y la hoja `Validacion` muestra coincidencias, discrepancias y faltantes.
7. El `TXT SISCAC` solo se habilita para registros sin errores bloqueantes.

El módulo genera una sola fila por paciente y usa todas sus atenciones para complementar el registro. Cada paraclínico conserva de manera independiente el valor con la fecha de toma más reciente; si la misma fecha está en Excel y PDF, prevalece el PDF. Peso, talla, TAS y TAD también se seleccionan de forma independiente por su fecha de atención o soporte: un PDF reciente sin signos vitales no borra los valores de un soporte o atención anterior. La hoja `Validacion` muestra el valor, la fecha y la fuente seleccionada. La TFG solo se reporta cuando está consignada en la atención: debe corresponder a Cockcroft-Gault en adultos o Schwartz en menores de 18 años, pero la aplicación no la calcula para completar la malla. Tampoco convierte microalbuminuria en mg/L en albuminuria de 24 horas porque son unidades diferentes.

Los campos administrativos que no existen en la descarga, como costos o serial BDUA, se mantienen pendientes. Pueden venir como columnas adicionales `costo_hta`, `costo_dm`, `costo_total` y `serial_bdua`; no se inventan para completar el archivo.

## Instalar en AWS sin Docker

La entrega está preparada para un repositorio Git privado y una instancia AWS EC2 Ubuntu:

- Servicio permanente con `systemd`.
- Dominio institucional publicado con Nginx.
- Certificado HTTPS automático con Certbot.
- Base compartida en disco EBS persistente.
- Respaldo diario local y copia opcional a S3/KMS.
- Copia cifrada a S3 de la base, las mallas generadas y los soportes CAC privados.
- Actualización desde Git sin tocar la base ni los respaldos.

Sigue el procedimiento completo en [DESPLIEGUE_AWS_SIN_DOCKER.md](DESPLIEGUE_AWS_SIN_DOCKER.md).

El puerto `8780` queda enlazado a `127.0.0.1` y no se publica en el Security Group. Los usuarios entran por el dominio HTTPS, por ejemplo `https://renal.institucion.com/`, sin depender de este computador.

Esta configuración admite varios usuarios concurrentes sobre una sola instancia. No actives Auto Scaling con varias instancias mientras se conserve SQLite; para escalamiento horizontal se debe migrar la persistencia a PostgreSQL/RDS.

## Roles

| Rol | Cohorte | Tareas | Auditoría | Usuarios y respaldos |
| --- | --- | --- | --- | --- |
| Administrador | Lectura/escritura | Gestión | Lectura | Gestión |
| Clínico | Lectura/escritura | Gestión | No | No |
| Gestor | Lectura/escritura | Gestión | No | No |
| Auditor | Solo lectura | Solo lectura | Lectura | No |

## Base de datos y respaldo

En Windows local, la base queda en `data/renal_shared.sqlite3`. En AWS queda en `/var/lib/neurum-renal/renal_shared.sqlite3`; los respaldos se guardan en `/var/backups/neurum-renal/`. Para crear uno desde consola:

```powershell
python backup.py
```

Los respaldos no sustituyen el cifrado del servidor ni una copia externa. La restauración debe hacerse con la aplicación detenida y por personal autorizado.

## Reglas clínicas

Las reglas del seguimiento renal permanecen documentadas en `REGLAS_CLINICAS_SIN_CAMBIOS.md` y su motor continúa en `static/clinical-engine.js`. Las reglas independientes para construir y auditar la malla de reporte están en `REGLAS_MALLA_CAC_ERC_2026.md`.

## Verificación incluida

Las pruebas en `tests/` validan la estructura de 34 columnas, el detalle clínico, la plantilla diaria, la persistencia por lotes, el flujo de tareas, los seis indicadores de la cohorte de junio y la generación auditada de la malla CAC. No alteran los datos clínicos de la instalación.
