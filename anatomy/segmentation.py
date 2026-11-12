"""From task outputs to what the viewer loads: the merged label volume, the surfaces and seg.json. Used by the worker and by the sample builder."""
from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np

from . import merge as merging
from . import meshes
from .studies import now, read_json, write_json
from .volumes import gz


def read_volume(folder: Path, study: dict) -> np.ndarray:
    raw = gzip.decompress((folder / 'volume.i16.gz').read_bytes())
    nx, ny, nz = study['dims']
    return np.frombuffer(raw, dtype='<i2').reshape(nz, ny, nx).transpose(2, 1, 0)


def task_outputs(work: Path, tasks: list[str]) -> dict:
    out = {}
    for task in tasks:
        path, names = work / f'{task}.nii.gz', read_json(work / f'{task}.json')
        if path.is_file() and names:
            out[task] = (path, {int(k): v for k, v in names['classes'].items()})
    return out


def finalize(folder: Path, report: dict, on_progress=None) -> dict:
    """Merges the task outputs in seg_work/, builds the surfaces and writes seg/. `report`: level, model, device, tasks, seconds."""
    study = read_json(folder / 'study.json')
    outputs = task_outputs(folder / 'seg_work', [t['task'] for t in report['tasks'] if t['state'] == 'done'])
    labels, structures = merging.merge(outputs, study['stride'], study['sourceSpacing'])
    if tuple(labels.shape) != tuple(study['dims']):
        raise ValueError(f'The label volume is {labels.shape}, the study is {study["dims"]}.')
    revision, _ = merging.store(folder, labels)
    mesh_facts = None
    try:
        pack, mesh_facts = meshes.build(labels, read_volume(folder, study), study['spacing'], study['modality'], on_progress=on_progress)
        (folder / 'seg' / 'meshes.bin.gz').write_bytes(gz(pack))
        low, low_facts = meshes.reduce_pack(pack)
        (folder / 'seg' / 'meshes_lo.bin.gz').write_bytes(gz(low))
        mesh_facts['light'] = low_facts          # bytes before compression, as for the full pack
        mesh_facts['bytes'] = len(pack)
    except ImportError as error:           # no VTK: the labels are still good, the 3D panel says why it is empty
        mesh_facts = {'unavailable': f'Surfaces need the vtk package ({error}).'}
        (folder / 'seg' / 'meshes.bin.gz').unlink(missing_ok=True)
        (folder / 'seg' / 'meshes_lo.bin.gz').unlink(missing_ok=True)
    seg = {
        'schema': 'zk-anatomy-segmentation/1', 'revision': revision[:16], 'created': now(), 'volumeSha256': study['volumeSha256'], 'level': report['level'],
        'model': report['model'], 'device': report['device'], 'seconds': report.get('seconds'), 'tasks': report['tasks'], 'structures': structures, 'meshes': mesh_facts,
        'provenance': {'origin': 'PATIENT_AUTOMATED', 'review': 'UNREVIEWED', 'spatial': 'NATIVE'},
    }
    write_json(folder / 'seg' / 'seg.json', seg)
    return seg
