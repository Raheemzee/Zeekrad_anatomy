"""The segmentation engine: which model reads which study, and which fine-structure models follow it.

Models are TotalSegmentator tasks. A CT volume is read by `total`, an MR volume by `total_mr`; neither is ever run on the other modality, and a
volume of any other modality is not segmented. The fine-structure tasks are chosen from what the base task found: a head task is not run on an
abdomen. The engine is optional: without the TotalSegmentator package the workstation still opens every study and says segmentation is not installed.

Licence note for the owner. `total` and `total_mr` are the two tasks ZeekaRad's licence registry approves for production (owner decisions of
2026-10-28 and 2026-11-12). The fine-structure tasks listed here are published by the same project as openly usable (Apache-2.0 weights) but are
NOT approved in that registry. They are here for local evaluation; taking them to production needs their own decision.
"""
from __future__ import annotations

import importlib.metadata
import importlib.util
import re

BASE = {'CT': 'total', 'MR': 'total_mr'}

# task -> a pattern; the task runs when the base task found a structure whose class name matches it.
# The body task tells trunk from limbs. On a head-only volume it has neither to find and names the head a limb, so it runs only where the trunk is in view.
TRUNK = r'^(lung|liver|heart|stomach|spleen|kidney|urinary_bladder|colon|sacrum|hip_|femur_|humerus_|vertebrae_[TL]|vertebrae$|aorta|autochthon_|iliopsoas_)'
DETAIL = {
    'CT': [
        ('body', TRUNK), ('trunk_cavities', r'^(lung_|liver|heart|stomach|spleen)'), ('vertebrae_body', r'^vertebrae_'),
        ('lung_vessels', r'^lung_'), ('liver_segments', r'^liver$'), ('liver_vessels', r'^liver$'), ('abdominal_muscles', r'^(autochthon_|rib_|iliopsoas_)'),
        ('headneck_muscles', r'^(skull|vertebrae_C[1-7]$)'), ('headneck_bones_vessels', r'^(skull|vertebrae_C[1-5]$|thyroid_gland)'),
        ('head_glands_cavities', r'^(skull|brain)$'), ('head_muscles', r'^(skull|brain)$'), ('oculomotor_muscles', r'^(skull|brain)$'),
        ('craniofacial_structures', r'^(skull|brain)$'),
    ],
    'MR': [('body_mr', TRUNK), ('vertebrae_mr', r'^vertebrae$'), ('liver_segments_mr', r'^liver$')],
}


def availability() -> dict:
    """Whether a segmentation can run on this machine, and if not, why."""
    if importlib.util.find_spec('totalsegmentator') is None:
        return {'available': False, 'reason': 'The TotalSegmentator package is not installed. Install it with: pip install -r requirements-segmentation.txt', 'version': None, 'device': None}
    version = importlib.metadata.version('TotalSegmentator')
    device = 'cpu'
    try:
        import torch
        if torch.cuda.is_available():
            device = 'gpu'
    except Exception as error:
        return {'available': False, 'reason': f'PyTorch could not be loaded: {error}', 'version': version, 'device': None}
    return {'available': True, 'reason': None, 'version': version, 'device': device}


def base_task(modality: str) -> str | None:
    return BASE.get(modality)


def detail_tasks(modality: str, found: set[str]) -> list[str]:
    return [task for task, pattern in DETAIL.get(modality, []) if any(re.search(pattern, name) for name in found)]
