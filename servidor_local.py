"""
Servidor local para probar la aplicación sin instalar Vercel CLI.

- Sirve index.html y la carpeta assets/.
- Envía las peticiones de /api/Identificador_Imagenes a la misma
  clase handler que usa Vercel en producción.
- Lee las variables del archivo .env si existe.

Uso:
    python servidor_local.py
Después abre http://localhost:8000
"""

import os
import sys

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
API_PATH = "/api/Identificador_Imagenes"


def load_env_file(path):
    if not path.exists():
        return

    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip().strip('"').strip("'")

        if key:
            os.environ.setdefault(key, value)


# Las variables deben cargarse antes de importar el handler,
# porque el módulo lee ALLOWED_ORIGIN y OPENAI_MODEL al importarse.
load_env_file(BASE_DIR / ".env")
sys.path.insert(0, str(BASE_DIR / "api"))

from Identificador_Imagenes import handler as ApiHandler  # noqa: E402


class LocalHandler(ApiHandler, SimpleHTTPRequestHandler):

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def request_path(self):
        return self.path.split("?", 1)[0].split("#", 1)[0]

    def is_api(self):
        return self.request_path().rstrip("/") == API_PATH

    def is_private(self):
        path = self.request_path()
        parts = [part for part in path.split("/") if part]
        hidden = any(part.startswith(".") for part in parts)
        return hidden or path.startswith("/api/") or path.endswith(".py")

    def do_GET(self):
        if self.is_api():
            return ApiHandler.do_GET(self)

        if self.is_private():
            return self.send_error(404)

        return SimpleHTTPRequestHandler.do_GET(self)

    def do_HEAD(self):
        if self.is_api() or self.is_private():
            return self.send_error(404)

        return SimpleHTTPRequestHandler.do_HEAD(self)

    def do_POST(self):
        if self.is_api():
            return ApiHandler.do_POST(self)

        return self.send_error(404)

    def do_OPTIONS(self):
        if self.is_api():
            return ApiHandler.do_OPTIONS(self)

        return self.send_error(404)


def main():
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), LocalHandler)

    print(f"Aplicación disponible en http://localhost:{port}")

    if not os.environ.get("OPENAI_API_KEY"):
        print(
            "Aviso: OPENAI_API_KEY no está configurada. "
            "Crea el archivo .env a partir de .env.example."
        )

    print("Presiona Ctrl + C para detener el servidor.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
