"""The structure registry: one stable id and one canonical English name per structure, and its names in the other 13 languages where a recorded source gives one."""
from __future__ import annotations

import json
from functools import lru_cache

from .config import REGISTRY_FILE


@lru_cache(maxsize=1)
def registry() -> dict:
    data = json.loads(REGISTRY_FILE.read_text(encoding='utf-8'))
    data['byKey'] = {s['key']: s for s in data['structures']}
    data['byId'] = {s['id']: s for s in data['structures']}
    return data


def public_registry() -> dict:
    data = registry()
    return {k: v for k, v in data.items() if k not in ('byKey', 'byId')}


def structure_id(key: str) -> int | None:
    entry = registry()['byKey'].get(key)
    return entry['id'] if entry else None
