"""Segments one study in its own process:  python -m anatomy.segment_worker <study folder> <quick|standard|extended> <cpu|gpu>

Progress is written to job.json in the study folder, task by task. There is no percentage: a task is pending, running, done, failed or skipped, with
the seconds it took. A fine-structure task that fails is recorded and the rest carry on; the base task failing fails the job.
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path


def main() -> int:
    folder, level, device = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    from anatomy import engine
    from anatomy.segmentation import finalize
    from anatomy.studies import now, read_json, write_json
    study = read_json(folder / 'study.json')
    job = read_json(folder / 'job.json') or {}
    job.update({'state': 'VALIDATING', 'level': level, 'device': device, 'startedAt': now(), 'pid': os.getpid(), 'tasks': [], 'message': 'Checking the study'})
    save = lambda: write_json(folder / 'job.json', job)
    save()
    base = engine.base_task(study['modality'])
    if not base:
        job.update({'state': 'UNSUPPORTED', 'message': f'No segmentation model reads {study["modality"] or "this"} images. CT and MR are supported.', 'finishedAt': now()}); save()
        return 0
    import importlib.metadata
    import subprocess
    version = importlib.metadata.version('TotalSegmentator')
    work = folder / 'seg_work'; work.mkdir(exist_ok=True)
    started = time.time()

    def run(task: str, fast: bool) -> set[str]:
        entry = {'task': task, 'state': 'running', 'fast': fast}
        job['tasks'].append(entry); job.update({'state': 'RUNNING', 'message': f'Running {task}' + (' (3 mm)' if fast else '')}); save()
        t0 = time.time()
        marker = work / f'{task}.json'
        cached = read_json(marker)
        if cached and cached.get('fast') == fast and (work / f'{task}.nii.gz').is_file():
            entry.update({'state': 'done', 'seconds': 0.0, 'cached': True, 'found': cached['found']}); save()
            return set(cached['found'])
        marker.unlink(missing_ok=True)
        # Each model in its own process: what one model used is given back before the next starts.
        code = subprocess.run([sys.executable, '-m', 'anatomy.segment_task', str(folder), task, '1' if fast else '0', device]).returncode
        done = read_json(marker)
        if code != 0 or not done:
            why = (read_json(work / f'{task}.failed.json') or {}).get('reason')
            if not why:
                why = (f'The model process was stopped by the operating system (exit {code}), which usually means the computer ran out of memory. '
                       'Close other programs, set ZK_ANATOMY_LOW_MEMORY=1, or use the Quick level.')
            raise RuntimeError(why)
        entry.update({'state': 'done', 'seconds': round(time.time() - t0, 1), 'found': done['found']}); save()
        return set(done['found'])

    try:
        found = run(base, level == 'quick')
    except BaseException as error:
        job['tasks'][-1].update({'state': 'failed', 'reason': str(error)[:400]})
        job.update({'state': 'FAILED', 'message': f'The {base} model failed: {str(error)[:300]}', 'finishedAt': now()}); save()
        traceback.print_exc()
        return 1
    if not found:
        job.update({'state': 'FAILED', 'message': f'The {base} model found no structure in this volume.', 'finishedAt': now()}); save()
        return 1
    if level == 'extended':
        for task in engine.detail_tasks(study['modality'], found):
            try:
                run(task, False)
            except BaseException as error:              # recorded, never hidden; the other tasks still run
                job['tasks'][-1].update({'state': 'failed', 'reason': str(error)[:400]}); save()
                traceback.print_exc()
    job.update({'state': 'QC_PENDING', 'message': 'Merging the label volume and building the surfaces'}); save()
    try:
        report = {'level': level, 'model': {'name': 'TotalSegmentator', 'version': version, 'base': base}, 'device': device, 'tasks': job['tasks'], 'seconds': round(time.time() - started, 1)}
        seg = finalize(folder, report)
    except BaseException as error:
        job.update({'state': 'FAILED', 'message': f'The result could not be assembled: {str(error)[:300]}', 'finishedAt': now()}); save()
        traceback.print_exc()
        return 1
    job.update({'state': 'READY', 'message': f'{len(seg["structures"])} structures', 'revision': seg['revision'], 'finishedAt': now(), 'seconds': report['seconds']}); save()
    return 0


if __name__ == '__main__':          # required: the model starts worker processes of its own
    sys.exit(main())
