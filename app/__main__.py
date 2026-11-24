"""Run locally with:  uv run python -m app"""

import os
import threading
import webbrowser

import uvicorn


def main() -> None:
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8765"))
    # Spotify only accepts the 127.0.0.1 form of a local redirect URI, so open that.
    url = f"http://127.0.0.1:{port}"
    if os.environ.get("NO_BROWSER") != "1":
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    print(f"\n  Dubdeck is running at {url}  (Ctrl+C to stop)\n", flush=True)
    uvicorn.run("app.main:app", host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
