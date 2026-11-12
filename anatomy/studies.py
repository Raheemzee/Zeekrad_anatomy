"""The study store: a folder per study, bundled samples read-only beside the user's uploads.

A study folder holds the source volume as uploaded (source.nii.gz, on its own grid, which is what a model reads), the image on the display grid
(volume.i16.gz), study.json, and once segmented seg/ (labels, meshes, seg.json). Every derived file is tied to the study by living in its folder, and
to the image by the checksum seg.json records; nothing is looked up by name across studies.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import re
import shutil
import time
import uuid
from pathlib import Path

import nibabel as nib
import numpy as np

from . import config
from .volumes import block_mean, canonical, display_strides, display_values, gz, obliquity_degrees, spacing_of, to_bytes

ID = re.compile(r'^[a-z0-9][a-z0-9-]{2,40}$')


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')


def write_json(path: Path, value) -> None:
    """Atomic: a reader never sees half a file."""
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding='utf-8')
    for attempt in range(20):                  # on Windows a reader holding the file for a moment refuses the swap; wait for it, never write in place
        try:
            temporary.replace(path)
            return
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.05)


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def folder_of(study_id: str) -> Path | None:
    if not ID.match(study_id or ''):
        return None
    for root in (config.STUDIES_DIR, config.SAMPLES_DIR):
        folder = root / study_id
        if (folder / 'study.json').is_file():
            return folder
    return None


def create(image: nib.Nifti1Image, modality: str, title: str, facts: dict, origin: str = 'upload', study_id: str | None = None, root: Path | None = None) -> dict:
    root = root or config.STUDIES_DIR
    study_id = study_id or uuid.uuid4().hex[:12]
    folder = root / study_id
    folder.mkdir(parents=True, exist_ok=False)
    try:
        data, affine = canonical(image)
        spacing = spacing_of(affine)
        stride = display_strides(data.shape, spacing, config.MAX_DISPLAY_VOXELS)
        shown = block_mean(data, stride)
        values, mapping = display_values(shown, modality)
        display_affine = affine.copy()
        for k in range(3):
            display_affine[:3, 3] += affine[:3, k] * (stride[k] - 1) / 2.0
            display_affine[:3, k] = affine[:3, k] * stride[k]
        raw = to_bytes(values, np.int16)
        (folder / 'volume.i16.gz').write_bytes(gz(raw))
        nib.save(image, str(folder / 'source.nii.gz'))
        study = {
            'schema': 'zk-anatomy-study/1', 'id': study_id, 'title': title, 'modality': modality, 'origin': origin, 'created': now(),
            'dims': list(map(int, values.shape)), 'spacing': [round(s * k, 6) for s, k in zip(spacing, stride)],
            'sourceDims': list(map(int, data.shape)), 'sourceSpacing': [round(s, 6) for s in spacing], 'stride': list(stride),
            'affine': [[round(float(v), 6) for v in row] for row in display_affine], 'obliqueDegrees': round(obliquity_degrees(affine), 2),
            'values': mapping, 'volumeSha256': hashlib.sha256(raw).hexdigest(), 'facts': facts,
        }
        write_json(folder / 'study.json', study)
        return study
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise


def summary(folder: Path) -> dict | None:
    study = read_json(folder / 'study.json')
    if not study:
        return None
    seg = read_json(folder / 'seg' / 'seg.json')
    study['segmentation'] = None
    if seg and seg.get('volumeSha256') == study.get('volumeSha256'):
        study['segmentation'] = {k: seg[k] for k in ('revision', 'created', 'level', 'model', 'device', 'tasks', 'structures', 'seconds', 'meshes') if k in seg}
    study['job'] = read_json(folder / 'job.json')
    study['readOnly'] = folder.parent == config.SAMPLES_DIR
    return study


def list_studies() -> list[dict]:
    out = []
    for root in (config.SAMPLES_DIR, config.STUDIES_DIR):
        if not root.is_dir():
            continue
        for folder in sorted(root.iterdir()):
            study = summary(folder) if folder.is_dir() else None
            if study:
                out.append({k: study[k] for k in ('id', 'title', 'modality', 'origin', 'created', 'dims', 'spacing', 'readOnly', 'job')}
                           | {'segmented': bool(study['segmentation']), 'structures': len(study['segmentation']['structures']) if study['segmentation'] else 0,
                              'description': study['facts'].get('description') or study['facts'].get('studyDescription') or ''})
    return out


def delete(study_id: str) -> bool:
    folder = folder_of(study_id)
    if not folder or folder.parent != config.STUDIES_DIR:
        return False
    for attempt in range(60):                  # a job being stopped still holds its log for a moment (Windows refuses to delete an open file)
        try:
            shutil.rmtree(folder)
            return True
        except OSError:
            if attempt == 59:
                raise
            time.sleep(0.1)
    return False
