"""One segmentation at a time, each in its own process, in the order they were asked for.

States: QUEUED -> VALIDATING -> RUNNING -> QC_PENDING -> READY, or UNSUPPORTED, FAILED, CANCELLED. A job the server finds unfinished when it starts
was interrupted and is marked so; it is not resumed behind the user's back.
"""
from __future__ import annotations

import atexit
import os
import queue
import signal
import subprocess
import sys
import threading
from pathlib import Path

from . import config, engine
from .studies import folder_of, now, read_json, write_json

ACTIVE = ('QUEUED', 'VALIDATING', 'RUNNING', 'QC_PENDING')
WINDOWS = os.name == 'nt'


def stop_tree(process: subprocess.Popen) -> None:
    """Stops the worker and the processes the model started under it; a cancelled job must not keep the processor or the memory."""
    if process.poll() is not None:
        return
    try:
        if WINDOWS:
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, check=False)
        else:
            os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        process.terminate()


class Jobs:
    def __init__(self) -> None:
        self.pending: queue.Queue = queue.Queue()
        self.lock = threading.Lock()
        self.current: tuple[str, subprocess.Popen] | None = None
        self.cancelled: set[str] = set()
        atexit.register(self._stop_current)          # the server going down takes its worker with it
        self._mark_interrupted()
        threading.Thread(target=self._loop, daemon=True, name='segmentation-jobs').start()

    def _mark_interrupted(self) -> None:
        if not config.STUDIES_DIR.is_dir():
            return
        for marker in config.STUDIES_DIR.glob('*/job.json'):
            job = read_json(marker)
            if job and job.get('state') in ACTIVE:
                job.update({'state': 'FAILED', 'message': 'Interrupted: the server stopped while this job was running. Start it again.', 'finishedAt': now()})
                write_json(marker, job)

    def _stop_current(self) -> None:
        with self.lock:
            if self.current:
                stop_tree(self.current[1])

    def submit(self, study_id: str, level: str) -> dict:
        folder = folder_of(study_id)
        job = read_json(folder / 'job.json')
        if job and job.get('state') in ACTIVE:
            return job                                  # one job per study: asking twice returns the one that is running
        job = {'state': 'QUEUED', 'level': level, 'queuedAt': now(), 'tasks': [], 'message': 'Waiting for the segmentation engine'}
        write_json(folder / 'job.json', job)
        self.pending.put((study_id, level))
        return job

    def cancel(self, study_id: str) -> dict | None:
        folder = folder_of(study_id)
        job = read_json(folder / 'job.json') if folder else None
        if not job or job.get('state') not in ACTIVE:
            return job
        with self.lock:
            job.update({'state': 'CANCELLED', 'message': 'Cancelled', 'finishedAt': now()})
            write_json(folder / 'job.json', job)
            if self.current and self.current[0] == study_id:
                self.cancelled.add(study_id)
                stop_tree(self.current[1])
        return job

    def _loop(self) -> None:
        while True:
            study_id, level = self.pending.get()
            folder = folder_of(study_id)
            job = read_json(folder / 'job.json') if folder else None
            if not job or job.get('state') != 'QUEUED':
                continue
            state = engine.availability()
            device = state['device'] if config.DEVICE == 'auto' else config.DEVICE
            log = open(folder / 'job.log', 'w', encoding='utf-8', errors='replace')
            process = subprocess.Popen([sys.executable, '-m', 'anatomy.segment_worker', str(folder), level, device or 'cpu'], cwd=str(config.ROOT), stdout=log, stderr=subprocess.STDOUT,
                                       **({'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if WINDOWS else {'start_new_session': True}))
            with self.lock:
                self.current = (study_id, process)
            code = process.wait()
            log.close()
            with self.lock:
                self.current = None
            if not (folder / 'study.json').is_file():   # the study was deleted while its job ran: nothing is left to record
                self.cancelled.discard(study_id)
                continue
            job = read_json(folder / 'job.json') or {}
            if study_id in self.cancelled:              # the worker may have written one more state before it was stopped
                self.cancelled.discard(study_id)
                job.update({'state': 'CANCELLED', 'message': 'Cancelled', 'finishedAt': now()})
                write_json(folder / 'job.json', job)
                continue
            if job.get('state') in ACTIVE:              # the worker died without saying why
                tail = Path(folder / 'job.log').read_text(encoding='utf-8', errors='replace')[-600:]
                job.update({'state': 'FAILED', 'message': f'The segmentation process stopped (exit {code}). {tail.strip().splitlines()[-1] if tail.strip() else ""}', 'finishedAt': now()})
                write_json(folder / 'job.json', job)
