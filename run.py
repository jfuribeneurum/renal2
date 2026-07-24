import os

from server import run


if __name__ == "__main__":
    host = os.getenv("RENAL_HOST", "127.0.0.1")
    port = int(os.getenv("PORT", os.getenv("RENAL_PORT", "8780")))
    run(host, port)
