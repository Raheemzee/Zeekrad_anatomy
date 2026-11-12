import nibabel as nib
import numpy as np
import pytest

from anatomy.volumes import block_mean, block_pick, canonical, display_strides, display_values, obliquity_degrees, spacing_of, to_bytes


@pytest.mark.parametrize('codes', ['RAS', 'LPS', 'LAS', 'RPI', 'PIR', 'SLA', 'IAL'])
def test_a_marked_voxel_keeps_its_patient_position_in_every_storage_order(codes):
    """GEO-04/08: whatever order a file stores its axes in, the canonical grid puts each voxel where the file says it is."""
    rng = np.random.default_rng(1)
    base = rng.integers(0, 100, size=(5, 6, 7)).astype(np.int16)
    affine = np.diag([1.5, 2.0, 2.5, 1.0]); affine[:3, 3] = [-10, 20, 30]
    stored = nib.as_closest_canonical(nib.Nifti1Image(base, affine)).as_reoriented(
        nib.orientations.ornt_transform(nib.orientations.axcodes2ornt('RAS'), nib.orientations.axcodes2ornt(tuple(codes))))
    data, lps = canonical(stored)
    index = (1, 4, 2)
    world_ras = affine @ np.array([*index, 1.0])
    world_lps = np.array([-world_ras[0], -world_ras[1], world_ras[2]])
    found = np.rint(np.linalg.inv(lps) @ np.array([*world_lps, 1.0]))[:3].astype(int)
    assert data[tuple(found)] == base[index]
    # x runs to the patient's left, y to posterior, z to superior
    assert lps[0, 0] > 0 and lps[1, 1] > 0 and lps[2, 2] > 0
    assert sorted(np.round(spacing_of(lps), 6)) == [1.5, 2.0, 2.5]
    assert obliquity_degrees(lps) < 1e-6


def test_an_oblique_volume_is_kept_on_its_own_grid_and_its_tilt_is_reported():
    angle = np.radians(12.0)
    rotation = np.array([[np.cos(angle), -np.sin(angle), 0], [np.sin(angle), np.cos(angle), 0], [0, 0, 1]])
    affine = np.eye(4); affine[:3, :3] = rotation @ np.diag([1.0, 1.0, 3.0])
    data, lps = canonical(nib.Nifti1Image(np.zeros((4, 4, 4), dtype=np.int16), affine))
    assert data.shape == (4, 4, 4)                                    # nothing was resampled
    assert obliquity_degrees(lps) == pytest.approx(12.0, abs=1e-6)


def test_the_display_grid_averages_images_and_never_averages_labels():
    assert display_strides((512, 512, 400), (0.7, 0.7, 1.0), 48_000_000) == (2, 2, 1)
    assert display_strides((100, 100, 100), (1, 1, 1), 48_000_000) == (1, 1, 1)
    image = np.arange(4 * 4 * 2, dtype=np.float32).reshape(4, 4, 2)
    assert block_mean(image, (2, 2, 1)).shape == (2, 2, 2)
    assert block_mean(image, (2, 2, 1))[0, 0, 0] == pytest.approx(image[:2, :2, 0].mean())
    labels = np.zeros((4, 4, 2), dtype=np.uint16); labels[1, 1, 0] = 7; labels[0, 0, 0] = 200
    picked = block_pick(labels, (2, 2, 1))
    assert picked[0, 0, 0] == 7 and set(np.unique(picked)) <= {0, 7, 200}        # a value that was stored, never a blend


def test_ct_keeps_hounsfield_units_and_other_modalities_state_their_scale():
    ct, mapping = display_values(np.array([[[-2000.0, 40.4, 5000.0]]]), 'CT')
    assert ct.tolist() == [[[-1024, 40, 3071]]] and mapping['unit'] == 'HU'
    data = np.linspace(0, 500, 1000).reshape(10, 10, 10)
    mr, mapping = display_values(data, 'MR')
    assert mapping['unit'] is None and mr.min() == -1024
    back = (mr.astype(float) + 1024) / mapping['scale'] + mapping['offset']
    assert np.max(np.abs(back - data)[data < np.percentile(data, 99)]) < 1.0 / mapping['scale'] + 1e-6


def test_bytes_are_x_fastest_little_endian():
    array = np.zeros((2, 3, 4), dtype=np.int16); array[1, 0, 0] = 5; array[0, 1, 0] = 9; array[0, 0, 1] = -3
    flat = np.frombuffer(to_bytes(array, np.int16), dtype='<i2')
    assert flat[1] == 5 and flat[2] == 9 and flat[6] == -3
