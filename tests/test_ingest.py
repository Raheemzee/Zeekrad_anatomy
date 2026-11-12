import zipfile

import nibabel as nib
import numpy as np
import pytest

from anatomy.ingest import expand, find_volumes
from anatomy.volumes import canonical
from conftest import write_series


def one(folder):
    found = find_volumes(folder)
    assert len(found) == 1, [(c.title, c.refused) for c in found]
    return found[0]


def test_a_series_is_placed_by_its_geometry_not_by_file_order_or_instance_number(tmp_path):
    """GEO-03/05: non-square pixels, files stored in reverse order."""
    positions = [(-20.0, -30.0, 5.0 + 2.5 * k) for k in range(5)]
    write_series(tmp_path / 's', positions, spacing=(2.0, 1.0), mark=(3, 1, 4))       # column 3, row 1, slice 4
    candidate = one(tmp_path)
    assert candidate.refused is None and candidate.modality == 'CT' and candidate.facts['sliceSpacing'] == 2.5
    data, lps = canonical(candidate.image)
    where = np.argwhere(data == 777)[0]
    world = lps @ np.array([*where, 1.0])
    # column spacing 1.0 mm along x, row spacing 2.0 mm along y, slices 2.5 mm apart
    assert world[:3] == pytest.approx([-20.0 + 3 * 1.0, -30.0 + 1 * 2.0, 5.0 + 4 * 2.5])
    assert data.shape == (8, 6, 5)


def test_a_coronal_series_keeps_its_patient_orientation(tmp_path):
    positions = [(0.0, 10.0 + 3.0 * k, 0.0) for k in range(4)]
    write_series(tmp_path / 's', positions, orientation=(1, 0, 0, 0, 0, -1), mark=(2, 1, 3), modality='MR')
    candidate = one(tmp_path)
    assert candidate.refused is None and candidate.modality == 'MR'
    data, lps = canonical(candidate.image)
    world = lps @ np.array([*np.argwhere(data == 777)[0], 1.0])
    assert world[:3] == pytest.approx([2 * 1.0, 10.0 + 3 * 3.0, -1 * 2.0])


@pytest.mark.parametrize('case, reason', [
    ('repeat', 'more than one volume'), ('gap', 'unevenly spaced'), ('two', 'not a volume'), ('mixed', 'mixes image orientations'), ('sheared', 'sheared'),
])
def test_series_that_are_not_one_plain_volume_are_refused_with_the_reason(tmp_path, case, reason):
    """GEO-06: nothing is interpolated, dropped or guessed to make such a series load."""
    positions = [(0.0, 0.0, 2.0 * k) for k in range(5)]
    if case == 'repeat': positions[3] = positions[2]
    if case == 'gap': positions[4] = (0.0, 0.0, 12.0)
    if case == 'two': positions = positions[:2]
    if case == 'sheared': positions = [(1.0 * k, 0.0, 2.0 * k) for k in range(5)]
    write_series(tmp_path / 's', positions)
    if case == 'mixed':
        write_series(tmp_path / 't', [(0.0, 9.0, 0.0)], orientation=(1, 0, 0, 0, 0, -1), shuffle=False)
    candidate = one(tmp_path)
    assert candidate.image is None and reason in candidate.refused


def test_a_series_without_patient_geometry_is_refused(tmp_path):
    import pydicom
    write_series(tmp_path / 's', [(0.0, 0.0, 1.0 * k) for k in range(4)])
    for path in (tmp_path / 's').glob('*.dcm'):
        ds = pydicom.dcmread(path); del ds.ImagePositionPatient; ds.save_as(path)
    assert 'no patient geometry' in one(tmp_path).refused


def test_a_four_dimensional_nifti_is_refused_and_a_plain_one_is_read(tmp_path):
    nib.save(nib.Nifti1Image(np.zeros((4, 4, 4, 3), dtype=np.int16), np.eye(4)), tmp_path / 'cine.nii.gz')
    assert 'Only a single 3-D volume' in one(tmp_path).refused
    (tmp_path / 'cine.nii.gz').unlink()
    nib.save(nib.Nifti1Image(np.zeros((4, 5, 6), dtype=np.int16), np.diag([1, 1, 2, 1])), tmp_path / 'v.nii.gz')
    candidate = one(tmp_path)
    assert candidate.refused is None and candidate.modality is None          # a NIfTI file does not say what it is


def test_an_archive_cannot_write_outside_its_folder(tmp_path):
    inbox = tmp_path / 'inbox'; inbox.mkdir()
    with zipfile.ZipFile(inbox / 'a.zip', 'w') as archive:
        archive.writestr('../escaped.txt', 'x'); archive.writestr('inside/ok.txt', 'y')
    expand(inbox, 10_000)
    assert not (tmp_path / 'escaped.txt').exists() and (inbox / 'a' / 'inside' / 'ok.txt').exists()
    with zipfile.ZipFile(inbox / 'b.zip', 'w') as archive:
        archive.writestr('big.bin', b'0' * 5000)
    with pytest.raises(ValueError):
        expand(inbox, 1000)


def test_files_that_are_not_images_give_one_plain_refusal(tmp_path):
    (tmp_path / 'notes.txt').write_text('hello')
    assert 'No DICOM image series and no NIfTI volume' in one(tmp_path).refused


@pytest.mark.parametrize('syntax', ['JPEGLosslessProcess14_1', 'JPEGLSLossless', 'JPEG2000Lossless', 'RLELossless'])
def test_losslessly_compressed_series_decode_to_the_same_voxels(tmp_path, syntax):
    gdcm = pytest.importorskip('gdcm')
    write_series(tmp_path / 'plain', [(0.0, 0.0, 2.0 * k) for k in range(5)], mark=(3, 1, 4))
    expected, _ = canonical(one(tmp_path / 'plain').image)
    packed = tmp_path / 'packed'; packed.mkdir()
    for path in sorted((tmp_path / 'plain').glob('*.dcm')):
        reader = gdcm.ImageReader(); reader.SetFileName(str(path)); assert reader.Read()
        change = gdcm.ImageChangeTransferSyntax(); change.SetTransferSyntax(gdcm.TransferSyntax(getattr(gdcm.TransferSyntax, syntax))); change.SetInput(reader.GetImage()); assert change.Change()
        writer = gdcm.ImageWriter(); writer.SetFileName(str(packed / path.name)); writer.SetFile(reader.GetFile()); writer.SetImage(change.GetOutput()); assert writer.Write()
    candidate = one(packed)
    assert candidate.refused is None, candidate.refused
    assert np.array_equal(canonical(candidate.image)[0], expected)
