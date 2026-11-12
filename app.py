"""ZeekaRad Anatomy workstation, server build (Render).

    gunicorn app:app --workers 1 --threads 8 --timeout 300 --bind 0.0.0.0:$PORT       (what render.yaml runs)
    python app.py                                                                       (on your own computer: http://127.0.0.1:5000)

Serves the seven-panel workstation, the reference anatomy and the studies uploaded to this server. No sample studies are bundled, and no
access key is asked for: anyone with the address can open it. The page makes no outside request.
"""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from flask import Flask, Response, abort, jsonify, render_template, request, send_from_directory
from werkzeug.utils import secure_filename

import anatomy
from anatomy import config, engine, studies
from anatomy.ingest import expand, find_volumes
from anatomy.jobs import ACTIVE, Jobs
from anatomy.registry import public_registry

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = config.MAX_UPLOAD_BYTES
app.json.ensure_ascii = False
jobs: Jobs | None = None


def job_runner() -> Jobs:
    global jobs
    if jobs is None:
        jobs = Jobs()
    return jobs


def problem(status: int, code: str, message: str):
    return jsonify({'error': {'code': code, 'message': message}}), status


def binary(path: Path) -> Response:
    """A gzip file sent as the bytes it holds; the browser inflates it."""
    if not path.is_file():
        abort(404)
    return Response(path.read_bytes(), mimetype='application/octet-stream', headers={'Content-Encoding': 'gzip', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})


def study_folder(study_id: str) -> Path:
    folder = studies.folder_of(study_id)
    if not folder:
        abort(404)
    return folder


@app.get('/healthz')
def healthz():
    """For the platform's health check. Fails when a file the page needs is missing (for example the structure registry left out of the
    repository), so that Render does not put such a deploy live. Says nothing about any study."""
    try:
        public_registry()
    except (OSError, ValueError) as error:
        return jsonify({'ok': False, 'reason': f'The structure registry cannot be read: {error.__class__.__name__}: {error}'}), 503
    return jsonify({'ok': True})


@app.after_request
def harden(response: Response) -> Response:
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('Referrer-Policy', 'no-referrer')
    if request.is_secure or request.headers.get('X-Forwarded-Proto') == 'https':
        response.headers.setdefault('Strict-Transport-Security', 'max-age=31536000')
    response.headers.setdefault('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'")
    return response


@app.get('/')
def index():
    return render_template('index.html', version=anatomy.__version__)


@app.get('/api/meta')
def meta():
    return jsonify({'version': anatomy.__version__, 'registry': public_registry(), 'engine': engine.availability(), 'levels': config.LEVELS, 'defaultLevel': config.DEFAULT_LEVEL,
                    'autoSegment': config.AUTO_SEGMENT, 'maxUploadBytes': config.MAX_UPLOAD_BYTES, 'segmentable': sorted(engine.BASE),
                    'storageNote': config.DATA_NOTE})


@app.get('/api/studies')
def study_list():
    return jsonify({'studies': studies.list_studies()})


@app.post('/api/studies')
def upload():
    try:
        return _upload()
    except Exception as error:                     # logged in full for the server's log; the reader gets the reason
        app.logger.exception('upload failed')
        return problem(500, 'upload_failed', f'The server could not take the upload: {error.__class__.__name__}: {error}')


def _upload():
    files = [f for f in request.files.getlist('files') if f and f.filename]
    if not files:
        return problem(400, 'no_files', 'No file was sent.')
    level = request.form.get('level') or config.DEFAULT_LEVEL
    if level not in config.LEVELS:
        return problem(400, 'bad_level', f'Level must be one of {", ".join(config.LEVELS)}.')
    stated = (request.form.get('modality') or 'auto').upper()
    inbox = config.DATA_DIR / 'inbox' / uuid.uuid4().hex
    inbox.mkdir(parents=True)
    created, refused = [], []
    try:
        for n, upload_file in enumerate(files):
            name = secure_filename(Path(upload_file.filename).name) or 'file'
            upload_file.save(inbox / f'{n:06d}_{name}')
        try:
            expand(inbox, config.MAX_UPLOAD_BYTES)
        except Exception as error:
            return problem(400, 'bad_archive', f'The archive could not be unpacked: {error}')
        available = engine.availability()['available']
        for candidate in find_volumes(inbox):
            if candidate.refused:
                refused.append({'title': candidate.title, 'reason': candidate.refused})
                continue
            modality, facts = candidate.modality, dict(candidate.facts)
            if not modality:                                     # NIfTI: the file does not say. The user's statement wins; otherwise the value range decides, and that is recorded.
                if stated in ('CT', 'MR'):
                    modality = stated
                    facts['modalitySource'] = 'stated at upload'
                else:
                    import numpy as np
                    data = np.asanyarray(candidate.image.dataobj)
                    modality = 'CT' if float(data.min()) <= -500 else 'MR'
                    facts['modalitySource'] = f'assumed from the value range ({float(data.min()):.0f} to {float(data.max()):.0f}); state it at upload if this is wrong'
            try:
                study = studies.create(candidate.image, modality, candidate.title, facts)
            except Exception as error:
                refused.append({'title': candidate.title, 'reason': f'The volume could not be stored: {error}'})
                continue
            if config.AUTO_SEGMENT and available and engine.base_task(modality):
                job_runner().submit(study['id'], level)
            created.append(studies.summary(studies.folder_of(study['id'])))
    finally:
        shutil.rmtree(inbox, ignore_errors=True)
    return jsonify({'created': created, 'refused': refused}), (201 if created else 422)


@app.get('/api/studies/<study_id>')
def study_get(study_id: str):
    return jsonify(studies.summary(study_folder(study_id)))


@app.delete('/api/studies/<study_id>')
def study_delete(study_id: str):
    folder = study_folder(study_id)
    if folder.parent != config.STUDIES_DIR:
        return problem(403, 'read_only', 'Bundled sample studies cannot be deleted.')
    job = studies.read_json(folder / 'job.json')
    if job and job.get('state') in ACTIVE:
        job_runner().cancel(study_id)
    try:
        studies.delete(study_id)
    except OSError as error:
        return problem(409, 'busy', f'The study could not be deleted yet ({error.__class__.__name__}); its segmentation job is still stopping. Try again in a moment.')
    return jsonify({'deleted': study_id})


@app.get('/api/studies/<study_id>/volume')
def study_volume(study_id: str):
    return binary(study_folder(study_id) / 'volume.i16.gz')


@app.get('/api/studies/<study_id>/labels')
def study_labels(study_id: str):
    return binary(study_folder(study_id) / 'seg' / 'labels.u16.gz')


@app.get('/api/studies/<study_id>/meshes')
def study_meshes(study_id: str):
    # ?lod=low: the light surfaces drawn while a 3D view moves
    name = 'meshes_lo.bin.gz' if request.args.get('lod') == 'low' else 'meshes.bin.gz'
    return binary(study_folder(study_id) / 'seg' / name)


@app.post('/api/studies/<study_id>/segment')
def study_segment(study_id: str):
    folder = study_folder(study_id)
    if folder.parent != config.STUDIES_DIR:
        return problem(403, 'read_only', 'Bundled sample studies are already segmented and are read-only.')
    level = (request.get_json(silent=True) or {}).get('level') or config.DEFAULT_LEVEL
    if level not in config.LEVELS:
        return problem(400, 'bad_level', f'Level must be one of {", ".join(config.LEVELS)}.')
    study = studies.read_json(folder / 'study.json')
    if not engine.base_task(study['modality']):
        return problem(422, 'unsupported_modality', f'No segmentation model reads {study["modality"]} images. CT and MR are supported.')
    state = engine.availability()
    if not state['available']:
        return problem(409, 'engine_missing', state['reason'])
    return jsonify({'job': job_runner().submit(study_id, level)}), 202


@app.post('/api/studies/<study_id>/cancel')
def study_cancel(study_id: str):
    study_folder(study_id)
    return jsonify({'job': job_runner().cancel(study_id)})


@app.get('/api/reference')
def reference_index():
    out = {}
    for kind in ('labelled-ct', 'cadaver'):
        info = studies.read_json(config.REFERENCE_DIR / kind / 'reference.json')
        if info:
            out[kind] = info
    return jsonify(out)


@app.get('/api/reference/<kind>/<name>')
def reference_file(kind: str, name: str):
    if kind not in ('labelled-ct', 'cadaver'):
        abort(404)
    folder = config.REFERENCE_DIR / kind
    if name.endswith('.gz'):
        return binary(folder / secure_filename(name))
    return send_from_directory(folder, secure_filename(name), max_age=0)


@app.errorhandler(413)
def too_large(_error):
    return problem(413, 'too_large', f'The upload is larger than the limit of {config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB (ZK_ANATOMY_MAX_UPLOAD_MB).')


if __name__ == '__main__':          # required on Windows: the segmentation worker is started as a process
    job_runner()
    print(f'ZeekaRad Anatomy workstation {anatomy.__version__}: http://{config.HOST}:{config.PORT}')
    app.run(host=config.HOST, port=config.PORT, debug=False, threaded=True)
