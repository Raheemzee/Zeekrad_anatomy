"""Where things live and the few limits the workstation enforces. Every value can be set from the environment."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / f'.write-test-{os.getpid()}'
        probe.write_bytes(b'ok'); probe.unlink()
        return True
    except OSError:
        return False


# Where uploads are kept. A folder the server cannot write to (on Render: ZK_ANATOMY_DATA=/var/data without a disk mounted there) would make
# every upload fail, so the server falls back to a writable folder of its own and says so in the upload dialog.
REQUESTED_DATA_DIR = Path(os.environ.get('ZK_ANATOMY_DATA', ROOT / 'data')).resolve()
DATA_NOTE = ''
if _writable(REQUESTED_DATA_DIR):
    DATA_DIR = REQUESTED_DATA_DIR
else:
    import tempfile
    base = Path(tempfile.gettempdir()).resolve()
    # The fallback is checked too: a folder of that name left by another user would not be writable either.
    DATA_DIR = next((p for p in (base / 'zeekarad-anatomy-data', base / f'zeekarad-anatomy-data-{os.getuid() if hasattr(os, "getuid") else "user"}') if _writable(p)), None) \
        or Path(tempfile.mkdtemp(prefix='zeekarad-anatomy-data-'))
    DATA_NOTE = (f'The upload folder {REQUESTED_DATA_DIR} cannot be written (on Render: no disk is mounted there). Uploads are kept in a '
                 f'temporary folder and are lost when the service restarts or redeploys.')
STUDIES_DIR = DATA_DIR / 'studies'            # uploaded studies; created on first upload
SAMPLES_DIR = ROOT / 'samples'                # bundled studies, read-only
REFERENCE_DIR = ROOT / 'reference'            # bundled reference anatomy (another body; never registered to a patient)
REGISTRY_FILE = Path(__file__).resolve().parent / 'data' / 'structures.json'

HOST = os.environ.get('ZK_ANATOMY_HOST', '127.0.0.1')      # local only unless the owner says otherwise
PORT = int(os.environ.get('ZK_ANATOMY_PORT', '5000'))
MAX_UPLOAD_BYTES = int(os.environ.get('ZK_ANATOMY_MAX_UPLOAD_MB', '4096')) * 1024 * 1024
# The browser holds the image (2 bytes a voxel) and the labels (2 bytes a voxel). Larger volumes are shown on a coarser grid, and say so.
MAX_DISPLAY_VOXELS = int(os.environ.get('ZK_ANATOMY_MAX_DISPLAY_VOXELS', str(48_000_000)))
# quick: base model at 3 mm. standard: base model at full resolution. extended: standard plus the fine-structure models for the regions found.
DEFAULT_LEVEL = os.environ.get('ZK_ANATOMY_LEVEL', 'extended')
LEVELS = ('quick', 'standard', 'extended')
DEVICE = os.environ.get('ZK_ANATOMY_DEVICE', 'auto')        # auto | cpu | gpu
AUTO_SEGMENT = os.environ.get('ZK_ANATOMY_AUTO_SEGMENT', '1') != '0'
# Low memory: the model works through the volume in three parts. Slower; for computers where a model is stopped for lack of memory.
LOW_MEMORY = os.environ.get('ZK_ANATOMY_LOW_MEMORY', '0') == '1'
