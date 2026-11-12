"""Engineering fixtures only: small synthetic arrays with a known answer, used to test arithmetic and rules. None of them is a patient study and none
is evidence of anatomical or clinical correctness."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    from anatomy import config
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(config, 'STUDIES_DIR', tmp_path / 'studies')
    monkeypatch.setattr(config, 'AUTO_SEGMENT', False)
    return tmp_path


def write_series(folder, positions, orientation=(1, 0, 0, 0, 1, 0), rows=6, columns=8, spacing=(2.0, 1.0), modality='CT', uid='1.2.826.0.1.3680043.8.498.1', mark=None, shuffle=True, extra=None):
    """A classic single-frame series with stated geometry. File names are deliberately out of order."""
    import pydicom
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, generate_uid
    folder.mkdir(parents=True, exist_ok=True)
    order = list(range(len(positions)))
    if shuffle:
        order = order[::-1]
    for file_number, k in enumerate(order):
        meta = FileMetaDataset(); meta.MediaStorageSOPClassUID = '1.2.840.10008.5.1.4.1.1.2' if modality == 'CT' else '1.2.840.10008.5.1.4.1.1.4'
        meta.MediaStorageSOPInstanceUID = generate_uid(); meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = FileDataset(str(folder / f'f{file_number:03d}.dcm'), {}, file_meta=meta, preamble=b'\0' * 128)
        ds.SOPClassUID = meta.MediaStorageSOPClassUID; ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
        ds.StudyInstanceUID = '1.2.826.0.1.3680043.8.498.9'; ds.SeriesInstanceUID = uid; ds.Modality = modality; ds.SeriesDescription = 'fixture'
        ds.PatientName = 'FIXTURE^ENGINEERING'; ds.PatientID = 'FIXTURE'
        ds.Rows, ds.Columns = rows, columns; ds.PixelSpacing = [spacing[0], spacing[1]]; ds.ImageOrientationPatient = list(orientation)
        ds.ImagePositionPatient = [float(v) for v in positions[k]]; ds.InstanceNumber = file_number + 1
        ds.SamplesPerPixel = 1; ds.PhotometricInterpretation = 'MONOCHROME2'; ds.BitsAllocated = 16; ds.BitsStored = 16; ds.HighBit = 15; ds.PixelRepresentation = 1
        ds.RescaleSlope = 1; ds.RescaleIntercept = 0
        if modality == 'CT': ds.RescaleType = 'HU'
        pixels = np.full((rows, columns), -1000 + k, dtype=np.int16)
        if mark and mark[2] == k: pixels[mark[1], mark[0]] = 777          # (column, row, slice)
        ds.PixelData = pixels.tobytes()
        for key, value in (extra or {}).items(): setattr(ds, key, value)
        ds.save_as(str(folder / f'f{file_number:03d}.dcm'), enforce_file_format=True)


@pytest.fixture()
def client(data_dir):
    import app as application
    application.jobs = None
    return application.app.test_client()
