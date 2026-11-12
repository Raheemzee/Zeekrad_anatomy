"""Runs one model on one study in its own process:  python -m anatomy.segment_task <study folder> <task> <0|1 at 3 mm> <cpu|gpu>

One process per model, so that the memory a model used is returned before the next one starts. Writes seg_work/<task>.nii.gz (labels on the
study's source grid) and seg_work/<task>.json (the class names and what was found). On failure writes seg_work/<task>.failed.json with the reason.
"""
from __future__ import annotations

import sys
import traceback
from pathlib import Path


def main() -> int:
    folder, task, fast, device = Path(sys.argv[1]), sys.argv[2], sys.argv[3] == '1', sys.argv[4]
    from anatomy import config
    from anatomy.studies import write_json
    work = folder / 'seg_work'
    failed = work / f'{task}.failed.json'
    failed.unlink(missing_ok=True)
    try:
        import importlib.metadata

        import nibabel as nib
        import numpy as np
        from totalsegmentator.map_to_binary import class_map
        from totalsegmentator.python_api import totalsegmentator
        image = nib.load(str(folder / 'source.nii.gz'))
        result = totalsegmentator(image, None, ml=True, fast=fast, task=task, device=device, quiet=True, force_split=config.LOW_MEMORY, nr_thr_saving=1)
        data = np.asanyarray(result.dataobj)
        classes = {int(k): v for k, v in class_map[task].items()}
        found = sorted(classes[int(v)] for v in np.unique(data) if int(v) in classes)
        nib.save(nib.Nifti1Image(data.astype(np.uint8 if data.max() < 256 else np.uint16), result.affine), str(work / f'{task}.nii.gz'))
        write_json(work / f'{task}.json', {'task': task, 'fast': fast, 'classes': classes, 'found': found, 'split': config.LOW_MEMORY,
                                            'model': f'TotalSegmentator {importlib.metadata.version("TotalSegmentator")}'})
        return 0
    except BaseException as error:
        traceback.print_exc()
        reason = 'Not enough memory for this model on this volume.' if isinstance(error, MemoryError) else f'{error.__class__.__name__}: {str(error)[:300]}'
        write_json(failed, {'task': task, 'reason': reason})
        return 1


if __name__ == '__main__':          # required: the model starts worker processes of its own
    sys.exit(main())
