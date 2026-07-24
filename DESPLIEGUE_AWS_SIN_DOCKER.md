# Despliegue institucional en AWS sin Docker

Esta versión se instala directamente sobre una instancia **AWS EC2 con Ubuntu**. La aplicación se ejecuta con `systemd`, Nginx publica el dominio y Certbot configura HTTPS. El puerto interno `8780` no se expone a Internet.

La arquitectura usa una sola instancia con SQLite en modo WAL y disco EBS persistente. Permite que varios usuarios trabajen simultáneamente sobre la misma cohorte, tareas y trazabilidad. No debe configurarse Auto Scaling con varias instancias mientras se use SQLite; para alta disponibilidad horizontal se requiere migrar primero la base a PostgreSQL/RDS.

## 1. Repositorio privado

No subas cohortes, paraclínicos, bases de datos, respaldos ni archivos `.env`.

```bash
git init
git add .
git commit -m "Neurum Gestion Renal 2.3.2 CAC ERC"
git branch -M main
git remote add origin URL_DEL_REPOSITORIO_PRIVADO
git push -u origin main
```

El archivo `.gitignore` ya excluye datos clínicos, sesiones, bases SQLite, respaldos y secretos.

## 2. Recursos en AWS

Crea los siguientes recursos:

1. Una instancia EC2 Ubuntu LTS con al menos 2 vCPU, 4 GB de RAM y disco EBS cifrado.
2. Una Elastic IP asociada a la instancia.
3. Un dominio o subdominio, por ejemplo `renal.institucion.com`, apuntando a la Elastic IP.
4. Un Security Group con:
   - Puerto `22` únicamente desde la red administrativa o VPN.
   - Puertos `80` y `443` para los usuarios autorizados.
   - Puerto `8780` cerrado.
5. Un bucket S3 privado, con bloqueo de acceso público, versionado, cifrado y política de retención.
6. Un rol IAM para la instancia con acceso limitado al prefijo de respaldos del bucket.

Para datos clínicos reales, limita también `443` a la red institucional/VPN cuando sea posible y documenta el tratamiento de datos con el área de seguridad.

## 3. Clonar e instalar

Conéctate por SSH y clona el repositorio. Para repositorios privados usa una deploy key de solo lectura.

```bash
sudo mkdir -p /opt/neurum-renal
sudo chown ubuntu:ubuntu /opt/neurum-renal
git clone URL_DEL_REPOSITORIO_PRIVADO /opt/neurum-renal/repository
cd /opt/neurum-renal/repository
sudo bash deploy/install_aws_ubuntu.sh \
  --domain renal.institucion.com \
  --email administrador@institucion.com
```

Antes de ejecutar Certbot, el dominio debe resolver hacia la Elastic IP. Si el DNS aún no está listo, usa `--skip-certbot` y vuelve a ejecutar el instalador cuando el dominio ya responda.

El instalador:

- Copia el código a `/opt/neurum-renal/app`.
- Crea un entorno virtual Python.
- Ejecuta las pruebas automáticas.
- Crea el usuario Linux restringido `neurum-renal`.
- Guarda la base en `/var/lib/neurum-renal`.
- Guarda respaldos en `/var/backups/neurum-renal`.
- Registra la aplicación como servicio `systemd`.
- Configura Nginx y HTTPS.
- Programa un respaldo diario.

Al finalizar muestra el usuario administrador y una contraseña temporal. Debes cambiarla en el primer ingreso.

## 4. Configurar respaldo a S3

Edita el archivo protegido del servidor:

```bash
sudo nano /etc/neurum-renal.env
```

Completa:

```ini
RENAL_S3_BUCKET=nombre-bucket-privado
RENAL_S3_PREFIX=produccion
RENAL_S3_KMS_KEY_ID=arn:aws:kms:REGION:CUENTA:key/ID
```

Después prueba el respaldo:

```bash
sudo systemctl start neurum-renal-backup.service
sudo systemctl status neurum-renal-backup.service --no-pager
sudo systemctl list-timers neurum-renal-backup.timer
```

La forma recomendada de acceso a S3 es un rol IAM de la instancia, no llaves permanentes guardadas en archivos.

## 5. Actualizar desde Git

Cuando publiques una nueva versión:

```bash
sudo bash /opt/neurum-renal/repository/deploy/update_aws_ubuntu.sh \
  /opt/neurum-renal/repository
```

El script descarga únicamente avances lineales, ejecuta pruebas, copia el código sin tocar la base ni los respaldos, reinicia el servicio y comprueba `/api/health`.

## 6. Operación

```bash
sudo systemctl status neurum-renal.service
sudo journalctl -u neurum-renal.service -f
sudo systemctl restart neurum-renal.service
curl http://127.0.0.1:8780/api/health
```

El acceso de los usuarios será exclusivamente:

```text
https://renal.institucion.com/
```

No depende de este computador ni de su dirección IP local.

## 7. Restaurar un respaldo

Realiza primero una copia adicional del estado actual. Luego:

```bash
sudo systemctl stop neurum-renal.service
sudo rm -f /var/lib/neurum-renal/renal_shared.sqlite3-wal
sudo rm -f /var/lib/neurum-renal/renal_shared.sqlite3-shm
sudo cp /RUTA/RESPALDO.sqlite3 /var/lib/neurum-renal/renal_shared.sqlite3
sudo chown neurum-renal:neurum-renal /var/lib/neurum-renal/renal_shared.sqlite3
sudo chmod 600 /var/lib/neurum-renal/renal_shared.sqlite3
sudo systemctl start neurum-renal.service
curl http://127.0.0.1:8780/api/health
```

Prueba periódicamente la restauración en un servidor aislado. Un respaldo que nunca se ha restaurado no debe considerarse verificado.

## 8. Controles mínimos

- Repositorio privado y ramas protegidas.
- HTTPS obligatorio.
- EBS y S3 cifrados.
- MFA para administradores de AWS y Git.
- Acceso SSH mediante VPN o IP administrativa.
- Revisión periódica de usuarios y auditoría.
- Política de retención y restauración de respaldos.
- Parches mensuales del sistema operativo.
- Acuerdo institucional y revisión legal para tratamiento de datos clínicos.
