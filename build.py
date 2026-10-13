from pathlib import Path
from shutil import copy2, copytree, rmtree
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
PACKAGE_DIR = DIST / "star-ai-server"
ARCHIVE = DIST / "star-ai-server.zip"


def copy_file(relative_path: str) -> None:
    source = ROOT / relative_path
    target = PACKAGE_DIR / relative_path
    target.parent.mkdir(parents=True, exist_ok=True)
    copy2(source, target)


def main() -> None:
    if DIST.exists():
        rmtree(DIST)
    PACKAGE_DIR.mkdir(parents=True)

    for directory in ("backend", "frontend"):
        copytree(ROOT / directory, PACKAGE_DIR / directory, ignore=lambda _, names: {
            name for name in names if name in {"__pycache__", ".pytest_cache"}
        })

    copy_file("backend/requirements.txt")
    copy_file("package.json")
    copy_file("package-lock.json")

    (PACKAGE_DIR / "database" / "log_archives").mkdir(parents=True)
    copy_file("database/custom_database.json")
    (PACKAGE_DIR / "config").mkdir()

    (PACKAGE_DIR / "DEPLOY.txt").write_text(
        "Star AI Server deployment package\n"
        "\n"
        "Install Python dependencies:\n"
        "  python -m pip install -r backend/requirements.txt\n"
        "\n"
        "Start with Uvicorn in production:\n"
        "  uvicorn backend.server:app --host 0.0.0.0 --port 3000\n"
        "\n"
        "Set Google Drive credentials with GOOGLE_APPLICATION_CREDENTIALS before starting.\n",
        encoding="utf-8",
    )

    with ZipFile(ARCHIVE, "w", ZIP_DEFLATED) as archive:
        for file_path in PACKAGE_DIR.rglob("*"):
            if file_path.is_file():
                archive.write(file_path, file_path.relative_to(DIST))

    print(f"Build complete: {ARCHIVE}")
    print(f"Upload package size: {ARCHIVE.stat().st_size} bytes")


if __name__ == "__main__":
    main()
