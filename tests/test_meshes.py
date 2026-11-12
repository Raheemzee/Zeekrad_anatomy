import gzip

import numpy as np
import pytest

from anatomy import config, meshes

vtk = pytest.importorskip('vtk')


def ball(shape, centre, radius):
    z, y, x = np.meshgrid(*[np.arange(n) for n in shape[::-1]], indexing='ij')
    return ((x - centre[0]) ** 2 + (y - centre[1]) ** 2 + (z - centre[2]) ** 2 <= radius ** 2).transpose(2, 1, 0)


def test_the_light_pack_holds_the_same_structures_with_fewer_triangles():
    from anatomy.registry import registry
    liver, spleen = registry()['byKey']['liver']['id'], registry()['byKey']['spleen']['id']
    labels = np.zeros((70, 60, 50), dtype=np.uint16)
    labels[ball(labels.shape, (25, 30, 25), 18)] = liver
    labels[ball(labels.shape, (55, 30, 25), 9)] = spleen
    values = np.where(labels > 0, 40, -1000).astype(np.int16)
    full, facts = meshes.build(labels, values, (1.0, 1.0, 1.0), 'CT')
    light, light_facts = meshes.reduce_pack(full, fraction=0.12, floor=120, cap=3500)
    a, b = {i: (p, c) for i, p, c in meshes.read_pack(full)}, {i: (p, c) for i, p, c in meshes.read_pack(light)}
    assert set(a) == set(b) and {liver, spleen, meshes.BODY_ID} <= set(a)
    assert light_facts['triangles'] < facts['triangles'] * 0.5
    for ident in (liver, spleen):
        (pa, ca), (pb, cb) = a[ident], b[ident]
        assert len(cb) <= max(120, len(ca) * 0.12) * 1.15 or len(cb) == len(ca)
        assert np.allclose(pa.min(0), pb.min(0), atol=2.0) and np.allclose(pa.max(0), pb.max(0), atol=2.0)      # same place and size
        assert cb.max() < len(pb)


def test_the_light_pack_is_served_beside_the_full_one(data_dir):
    import app as application
    from anatomy import config
    folder = config.STUDIES_DIR / 'abcdef123456' / 'seg'; folder.mkdir(parents=True)
    (folder.parent / 'study.json').write_text('{"id": "abcdef123456", "modality": "CT", "dims": [4, 4, 4]}')
    full_pack = meshes._write([(5, np.random.default_rng(0).random((40, 3)), np.arange(60).reshape(-1, 3) % 40)])[0]
    light_pack = meshes._write([(5, np.random.default_rng(0).random((10, 3)), np.arange(12).reshape(-1, 3) % 10)])[0]
    (folder / 'meshes.bin.gz').write_bytes(gzip.compress(full_pack)); (folder / 'meshes_lo.bin.gz').write_bytes(gzip.compress(light_pack))
    client = application.app.test_client()
    full = client.get('/api/studies/abcdef123456/meshes'); light = client.get('/api/studies/abcdef123456/meshes?lod=low')
    assert full.status_code == light.status_code == 200 and full.headers['Content-Encoding'] == 'gzip'
    assert gzip.decompress(full.data) == full_pack and gzip.decompress(light.data) == light_pack
