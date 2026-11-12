import nibabel as nib
import numpy as np

from anatomy.merge import merge
from anatomy.registry import registry


def save(path, array):
    nib.save(nib.Nifti1Image(array.astype(np.uint8), np.diag([-1.0, -1.0, 1.0, 1.0])), str(path))     # an LPS-ordered grid: canonical order is the stored order
    return path


def ids(*keys):
    by_key = registry()['byKey']
    return [by_key[k]['id'] for k in keys]


def test_fine_structures_replace_their_parent_and_never_another_organ(tmp_path):
    shape = (12, 12, 6)
    body = np.zeros(shape); body[1:11, 1:11, :] = 1
    total = np.zeros(shape); total[2:6, 2:10, :] = 1; total[7:10, 2:10, :] = 2                 # liver | spleen
    segments = np.zeros(shape); segments[2:4, 2:10, :] = 1; segments[4:8, 2:10, :] = 2          # segment 2 runs on into the spleen's voxels
    tumour = np.zeros(shape); tumour[2:4, 2:4, :] = 2
    outputs = {
        'body': (save(tmp_path / 'body.nii.gz', body), {1: 'body_trunc'}),
        'total': (save(tmp_path / 'total.nii.gz', total), {1: 'liver', 2: 'spleen'}),
        'liver_segments': (save(tmp_path / 'ls.nii.gz', segments), {1: 'liver_segment_1', 2: 'liver_segment_2'}),
        'liver_vessels': (save(tmp_path / 'lv.nii.gz', tumour), {1: 'liver_vessels', 2: 'liver_tumor'}),
    }
    labels, facts = merge(outputs, (1, 1, 1), (1.0, 1.0, 1.0))
    trunk, liver, spleen, s1, s2 = ids('body_trunc', 'liver', 'spleen', 'liver_segment_1', 'liver_segment_2')
    assert labels.dtype == np.uint16 and labels.shape == shape
    assert (labels[2:4, 2:10, :] == s1).all() and (labels[4:6, 2:10, :] == s2).all()           # inside the liver, the segment is shown
    assert (labels[7:10, 2:10, :] == spleen).all()                                             # the spleen keeps every voxel the base model gave it
    assert (labels[6, 2:10, :] == s2).all()                                                    # a container voxel may take the fine label
    assert labels[1, 1, 0] == trunk and labels[0, 0, 0] == 0
    found = {f['key']: f for f in facts}
    assert 'liver_tumor' not in found and set(found) == {'body_trunc', 'spleen', 'liver_segment_1', 'liver_segment_2'}       # a finding is not anatomy
    assert found['spleen']['task'] == 'total' and found['liver_segment_2']['task'] == 'liver_segments'
    assert found['spleen']['voxels'] == 3 * 8 * 6 and found['spleen']['ml'] == round(3 * 8 * 6 / 1000, 1)


def test_a_task_volume_on_another_grid_is_refused_not_resampled(tmp_path):
    outputs = {
        'total': (save(tmp_path / 'a.nii.gz', np.ones((6, 6, 6))), {1: 'liver'}),
        'liver_segments': (save(tmp_path / 'b.nii.gz', np.ones((5, 6, 6))), {1: 'liver_segment_1'}),
    }
    try:
        merge(outputs, (1, 1, 1), (1.0, 1.0, 1.0))
    except ValueError as error:
        assert 'it is not used' in str(error)
    else:
        raise AssertionError('a mismatched grid was accepted')


def test_labels_on_a_coarser_display_grid_are_picked_not_blended(tmp_path):
    total = np.zeros((8, 8, 4)); total[:4] = 1; total[4:] = 2
    labels, _ = merge({'total': (save(tmp_path / 't.nii.gz', total), {1: 'liver', 2: 'spleen'})}, (2, 2, 1), (1.0, 1.0, 1.0))
    assert labels.shape == (4, 4, 4) and set(np.unique(labels)) == set(ids('liver', 'spleen'))


def test_fine_structure_models_are_routed_by_what_the_base_model_found():
    from anatomy.engine import base_task, detail_tasks
    assert base_task('CT') == 'total' and base_task('MR') == 'total_mr' and base_task('US') is None and base_task('PT') is None
    head = detail_tasks('CT', {'brain', 'skull', 'vertebrae_C1', 'vertebrae_C2'})
    assert 'head_muscles' in head and 'oculomotor_muscles' in head
    assert not {'body', 'lung_vessels', 'liver_segments', 'liver_vessels', 'trunk_cavities', 'abdominal_muscles'} & set(head)       # no trunk task on a head
    abdomen = detail_tasks('CT', {'liver', 'spleen', 'vertebrae_L1', 'autochthon_left', 'kidney_left'})
    assert {'body', 'liver_segments', 'liver_vessels', 'trunk_cavities', 'abdominal_muscles', 'vertebrae_body'} <= set(abdomen)
    assert not {'head_muscles', 'oculomotor_muscles', 'lung_vessels'} & set(abdomen)                                               # no head or lung task on an abdomen
    assert detail_tasks('MR', {'liver', 'vertebrae'}) == ['body_mr', 'vertebrae_mr', 'liver_segments_mr'] and detail_tasks('MR', {'brain'}) == []
