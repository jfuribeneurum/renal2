from __future__ import annotations

import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]


class AwsDeploymentPackageTest(unittest.TestCase):
    def test_docker_artifacts_are_not_present(self) -> None:
        self.assertFalse((APP_DIR / "Dockerfile").exists())
        self.assertFalse((APP_DIR / "docker-compose.yml").exists())

    def test_aws_service_and_https_proxy_are_included(self) -> None:
        runner = (APP_DIR / "run.py").read_text(encoding="utf-8")
        service = (APP_DIR / "deploy" / "neurum-renal.service").read_text(encoding="utf-8")
        nginx = (APP_DIR / "deploy" / "nginx-neurum-renal.conf").read_text(encoding="utf-8")
        installer = (APP_DIR / "deploy" / "install_aws_ubuntu.sh").read_text(encoding="utf-8")

        self.assertIn('os.getenv("PORT"', runner)
        self.assertIn("EnvironmentFile=/etc/neurum-renal.env", service)
        self.assertIn("ReadWritePaths=/var/lib/neurum-renal", service)
        self.assertIn("proxy_pass http://127.0.0.1:8780", nginx)
        self.assertIn("__DOMAIN__", nginx)
        self.assertIn("certbot --nginx", installer)

    def test_repository_excludes_clinical_data_and_secrets(self) -> None:
        gitignore = (APP_DIR / ".gitignore").read_text(encoding="utf-8")
        self.assertIn(".env", gitignore)
        self.assertIn("*.sqlite3", gitignore)
        self.assertIn("data/*", gitignore)
        self.assertIn("backups/*", gitignore)

    def test_cac_resources_and_runtime_dependencies_are_packaged(self) -> None:
        requirements = (APP_DIR / "requirements.txt").read_text(encoding="utf-8")
        self.assertIn("openpyxl", requirements)
        self.assertIn("pypdf", requirements)
        self.assertTrue((APP_DIR / "resources" / "malla_cac_erc_2026.xlsx").is_file())
        self.assertTrue(
            (APP_DIR / "resources" / "plantilla_atenciones_diabetes.xlsx").is_file()
        )
        self.assertTrue((APP_DIR / "resources" / "divipola_map.json").is_file())


if __name__ == "__main__":
    unittest.main()
