import gzip
import io
import zipfile

import nibabel as nib
import numpy as np
import pytest

from conftest import write_series


def nifti_bytes(shape=(10, 12, 8), low=-1000):
    data = np.full(shape, low, dtype=np.int16); data[2:6, 3:9, 2:6] = 60
    image = nib.Nifti1Image(data, np.diag([-1.5, -1.5, 3.0, 1.0]))
    return gzip.compress(image.to_bytes())


def zipped(folder):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for path in sorted(folder.rglob('*')):
            if path.is_file():
                archive.write(path, path.relative_to(folder))
    buffer.seek(0)
    return buffer


def test_no_study_is_bundled_and_the_registry_is_served(client):
    meta = client.get('/api/meta').get_json()
    assert len(meta['registry']['locales']) == 14 and meta['segmentable'] == ['CT', 'MR']
    assert client.get('/api/studies').get_json()['studies'] == []


def test_no_access_key_is_asked_for(client):
    for path in ('/', '/api/meta', '/api/studies', '/api/reference', '/static/app.js', '/healthz'):
        assert client.get(path).status_code == 200, path


def test_an_unwritable_upload_folder_falls_back_and_says_so(tmp_path, monkeypatch):
    import importlib
    from anatomy import config
    blocked = tmp_path / 'blocked'; blocked.write_text('a file where the folder should be')     # cannot be created as a folder
    monkeypatch.setenv('ZK_ANATOMY_DATA', str(blocked / 'data'))
    try:
        fresh = importlib.reload(config)
        assert fresh.DATA_DIR != fresh.REQUESTED_DATA_DIR and fresh._writable(fresh.DATA_DIR)
        assert 'cannot be written' in fresh.DATA_NOTE and 'lost when the service restarts' in fresh.DATA_NOTE
    finally:
        monkeypatch.delenv('ZK_ANATOMY_DATA'); importlib.reload(config)


def test_an_upload_that_fails_inside_the_server_answers_with_its_reason(client, monkeypatch):
    from anatomy import studies
    def broken(*args, **kwargs):
        raise OSError(28, 'No space left on device')
    monkeypatch.setattr(studies, 'create', broken)
    response = client.post('/api/studies', data={'files': (io.BytesIO(nifti_bytes()), 'scan.nii.gz'), 'modality': 'CT'}, content_type='multipart/form-data')
    assert response.status_code == 422 and 'No space left on device' in response.get_json()['refused'][0]['reason']
    import app as application
    monkeypatch.setattr(application, 'expand', lambda *a: (_ for _ in ()).throw(PermissionError(13, 'Permission denied')))
    response = client.post('/api/studies', data={'files': (io.BytesIO(nifti_bytes()), 'scan.nii.gz')}, content_type='multipart/form-data')
    assert response.status_code == 400 and 'Permission denied' in response.get_json()['error']['message']


def test_a_nifti_upload_becomes_a_study_whose_bytes_match_its_record(client):
    response = client.post('/api/studies', data={'files': (io.BytesIO(nifti_bytes()), 'scan.nii.gz'), 'modality': 'CT'}, content_type='multipart/form-data')
    assert response.status_code == 201, response.get_json()
    study = response.get_json()['created'][0]
    assert study['modality'] == 'CT' and study['dims'] == [10, 12, 8] and study['spacing'] == [1.5, 1.5, 3.0] and study['segmentation'] is None
    assert study['title'] == 'scan.nii.gz'
    assert study['facts']['modalitySource'] == 'stated at upload'
    volume = client.get(f"/api/studies/{study['id']}/volume")
    assert volume.headers['Content-Encoding'] == 'gzip'
    raw = gzip.decompress(volume.data)
    values = np.frombuffer(raw, dtype='<i2').reshape(study['dims'], order='F')
    assert len(raw) == 10 * 12 * 8 * 2 and values.max() == 60 and values.min() == -1000
    assert client.get(f"/api/studies/{study['id']}/labels").status_code == 404           # not segmented: nothing is invented
    assert client.delete(f"/api/studies/{study['id']}").status_code == 200
    assert client.get(f"/api/studies/{study['id']}").status_code == 404


def test_an_unstated_nifti_modality_is_recorded_as_an_assumption(client):
    response = client.post('/api/studies', data={'files': (io.BytesIO(nifti_bytes(low=0)), 'scan.nii.gz')}, content_type='multipart/form-data')
    study = response.get_json()['created'][0]
    assert study['modality'] == 'MR' and 'assumed from the value range' in study['facts']['modalitySource']


def test_a_dicom_archive_is_read_and_carries_no_patient_identifier(client, tmp_path):
    write_series(tmp_path / 'series', [(0.0, 0.0, 2.0 * k) for k in range(6)])
    response = client.post('/api/studies', data={'files': (zipped(tmp_path / 'series'), 'study.zip')}, content_type='multipart/form-data')
    assert response.status_code == 201, response.get_json()
    study = response.get_json()['created'][0]
    assert study['modality'] == 'CT' and study['dims'] == [8, 6, 6] and study['values']['unit'] == 'HU'
    assert 'FIXTURE' not in response.get_data(as_text=True) and '1.2.826' not in response.get_data(as_text=True)      # no name, ID or UID is kept
    import app as application
    from anatomy import config
    stored = b''.join(p.read_bytes() for p in (config.STUDIES_DIR / study['id']).iterdir() if p.suffix == '.json')
    assert b'FIXTURE' not in stored and b'1.2.826' not in stored


def test_what_cannot_be_shown_is_refused_with_its_reason(client, tmp_path):
    write_series(tmp_path / 'series', [(0.0, 0.0, 0.0), (0.0, 0.0, 2.0)])
    response = client.post('/api/studies', data={'files': (zipped(tmp_path / 'series'), 'study.zip')}, content_type='multipart/form-data')
    assert response.status_code == 422
    body = response.get_json()
    assert body['created'] == [] and 'not a volume' in body['refused'][0]['reason']
    assert client.post('/api/studies', data={}, content_type='multipart/form-data').status_code == 400
    assert client.post('/api/studies', data={'files': (io.BytesIO(b'x'), 'a.txt'), 'level': 'maximum'}, content_type='multipart/form-data').status_code == 400


def test_segmentation_states_why_it_cannot_run(client, monkeypatch):
    from anatomy import engine
    created = client.post('/api/studies', data={'files': (io.BytesIO(nifti_bytes()), 'scan.nii.gz'), 'modality': 'CT'}, content_type='multipart/form-data').get_json()['created'][0]
    monkeypatch.setattr(engine, 'availability', lambda: {'available': False, 'reason': 'The TotalSegmentator package is not installed.', 'version': None, 'device': None})
    response = client.post(f"/api/studies/{created['id']}/segment", json={'level': 'quick'})
    assert response.status_code == 409 and 'not installed' in response.get_json()['error']['message']
    assert client.post(f"/api/studies/{created['id']}/segment", json={'level': 'everything'}).status_code == 400


def test_unknown_ids_and_paths_are_not_found(client):
    for path in ('/api/studies/nope', '/api/studies/..%2F..%2Fetc/volume', '/api/reference/other/x.json', '/api/reference/cadaver/..%2Fapp.py'):
        assert client.get(path).status_code == 404, path


def test_the_page_asks_for_nothing_outside_this_computer(client):
    page = client.get('/')
    assert page.status_code == 200 and "default-src 'self'" in page.headers['Content-Security-Policy']
    assert 'http://' not in page.get_data(as_text=True).replace('http://127.0.0.1', '') and 'https://' not in page.get_data(as_text=True)


def test_any_unexpected_upload_failure_is_answered_as_json(client, monkeypatch):
    import app as application
    monkeypatch.setattr(application, 'find_volumes', lambda folder: (_ for _ in ()).throw(RuntimeError('reader crashed')))
    response = client.post('/api/studies', data={'files': (io.BytesIO(nifti_bytes()), 'scan.nii.gz')}, content_type='multipart/form-data')
    assert response.status_code == 500 and response.get_json()['error']['message'] == 'The server could not take the upload: RuntimeError: reader crashed'
