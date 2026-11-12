"""One label volume from the task outputs: which structure a voxel is shown as when several tasks name it.

Order (anatomy/presentation.py): containers first (body, cavities), then the base task, then the fine-structure tasks. A fine structure replaces only
a voxel that is unlabelled, a container, its own parent, or a sibling under the same parent; it never takes a voxel the base task gave to another
organ. Findings (tumour, cyst) are not anatomy and are dropped. The result is model output on the study's own grid: origin patient-derived automated,
review state unreviewed.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy import ndimage as ndi

from .presentation import ALIASES, DROPPED, PAINT_ORDER, REGIONS, REPEATED
from .registry import registry
from .volumes import block_pick, canonical, gz, to_bytes

# A fine structure may also replace these base-task structures, which contain it.
PAINT_OVER = {
    'lung_arteries': 'lung', 'lung_veins': 'lung', 'lung_airways': 'lung', 'lung_airways_wall': 'lung',
    'mandible': 'skull', 'teeth_lower': 'skull', 'teeth_upper': 'skull', 'internal_carotid_artery': 'none', 'intervertebral_discs': 'none',
}


def _may_replace(key: str, by_key: dict, size: int) -> np.ndarray:
    """Which current labels a structure may take over."""
    allowed = np.zeros(size, dtype=bool)
    allowed[0] = True
    for name in REGIONS:
        if name in by_key:
            allowed[by_key[name]['id']] = True
    if 'pericardium' in by_key and key != 'pericardium':
        allowed[by_key['pericardium']['id']] = True
    entry = by_key[key]
    parent = entry.get('parent')
    if parent:
        if parent in by_key:
            allowed[by_key[parent]['id']] = True
        for other in by_key.values():
            if other.get('parent') == parent:
                allowed[other['id']] = True
    base = key.replace('_left', '').replace('_right', '')
    if PAINT_OVER.get(base) == 'lung':
        for other in by_key.values():
            if other['key'].startswith('lung_') and ('lobe' in other['key'] or other['key'] in ('lung_left', 'lung_right')):
                allowed[other['id']] = True
    if PAINT_OVER.get(base) == 'skull' and 'skull' in by_key:
        allowed[by_key['skull']['id']] = True
    return allowed


def merge(task_outputs: dict[str, tuple[Path, dict[int, str]]], stride, source_spacing) -> tuple[np.ndarray, list[dict]]:
    """(labels on the display grid as uint16, per-structure facts). task_outputs: task -> (label NIfTI on the source grid, its class names by value)."""
    by_key = registry()['byKey']
    size = max(s['id'] for s in by_key.values()) + 1
    labels = None
    origin = {}
    for region_pass in (True, False):
        for task in PAINT_ORDER:
            if task not in task_outputs:
                continue
            path, classes = task_outputs[task]
            array, _ = canonical(nib.load(str(path)))
            array = np.asarray(array).astype(np.int32)
            if labels is None:
                labels = np.zeros(array.shape, dtype=np.uint16)
            if array.shape != labels.shape:
                raise ValueError(f'Task {task} returned a {array.shape} volume for a {labels.shape} study; it is not used.')
            boxes = ndi.find_objects(array, max_label=max(classes) if classes else 0)
            for value, name in sorted(classes.items()):
                key = ALIASES.get(name, name)
                if name in DROPPED or key in REPEATED.get(task, ()) or key not in by_key or (key in REGIONS) != region_pass:
                    continue
                box = boxes[value - 1] if value - 1 < len(boxes) else None
                if box is None:
                    continue
                current = labels[box]
                take = (array[box] == value) & _may_replace(key, by_key, size)[current]
                if take.any():
                    current[take] = by_key[key]['id']
                    origin.setdefault(by_key[key]['id'], task)
    if labels is None:
        raise ValueError('No task produced a label volume.')
    counts = np.bincount(labels.ravel(), minlength=size)
    millilitres = float(np.prod(source_spacing)) / 1000.0
    by_id = registry()['byId']
    facts = [{'id': int(i), 'key': by_id[int(i)]['key'], 'voxels': int(counts[i]), 'ml': round(float(counts[i]) * millilitres, 1), 'task': origin.get(int(i))}
             for i in np.flatnonzero(counts) if i]
    return block_pick(labels, stride), facts


def store(folder: Path, labels: np.ndarray) -> tuple[str, int]:
    raw = to_bytes(labels, np.uint16)
    (folder / 'seg').mkdir(exist_ok=True)
    (folder / 'seg' / 'labels.u16.gz').write_bytes(gz(raw))
    return hashlib.sha256(raw).hexdigest(), len(raw)
