"""What reaches the server is what Git commits: every file the app needs must survive .gitignore."""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def test_git_commits_every_file_the_app_needs(tmp_path):
    git = shutil.which('git')
    if not git:
        pytest.skip('git is not installed')
    copy = tmp_path / 'repo'
    shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns('__pycache__', '.pytest_cache', '.venv', '.git'))
    subprocess.run([git, 'init', '-q'], cwd=copy, check=True)
    subprocess.run([git, 'add', '-A'], cwd=copy, check=True)
    committed = set(subprocess.run([git, 'ls-files'], cwd=copy, check=True, capture_output=True, text=True).stdout.split())
    shipped = {p.relative_to(copy).as_posix() for p in copy.rglob('*') if p.is_file() and '.git' not in p.relative_to(copy).parts and p.parts[len(copy.parts)] != 'data'}
    assert shipped - committed == set()
    assert {'anatomy/data/structures.json', 'requirements.txt', 'render.yaml', '.python-version', 'static/app.js', 'static/vendor.js'} <= committed


def test_the_health_check_fails_without_the_structure_registry(client, monkeypatch, tmp_path):
    from anatomy import config, registry
    assert client.get('/healthz').get_json() == {'ok': True}
    registry.registry.cache_clear()
    monkeypatch.setattr(registry, 'REGISTRY_FILE', tmp_path / 'missing.json')
    try:
        response = client.get('/healthz')
        assert response.status_code == 503 and 'structure registry' in response.get_json()['reason']
    finally:
        registry.registry.cache_clear()
