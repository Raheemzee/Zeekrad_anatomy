"""How each structure is presented: its group, its place in the hierarchy, its tone, and the order structures are painted in.

The names are the segmentation models' own class names (TotalSegmentator 2.18.0). Nothing here asserts that what a model
segmented is right; this file only says how a named structure is shown. The owner's rule on colour is kept: anatomical
tones that read like a prosection, not a rainbow.
"""
from __future__ import annotations

import re

# key -> English heading, in the order the structure list shows them.
GROUPS = {
    'skeleton': 'Skeleton', 'muscles': 'Muscles', 'arteries': 'Arteries', 'veins': 'Veins', 'heart': 'Heart',
    'airway': 'Lungs and airway', 'digestive': 'Digestive tract', 'abdominal': 'Abdominal organs', 'urinary': 'Urinary and reproductive',
    'glands': 'Glands', 'nervous': 'Nervous system', 'senses': 'Eye and ear', 'regions': 'Body regions and cavities',
}

# Two class names for one structure (two tasks segment it): the second is stored under the first.
ALIASES = {'eyeball_left': 'eye_left', 'eyeball_right': 'eye_right'}

# Classes that are findings, not anatomy, or that would replace finer labels with a coarser one. They are never stored.
DROPPED = {'liver_tumor', 'vertebrae_body', 'kidney_cyst_left', 'kidney_cyst_right'}

# Large containers: named under the pointer, never filled with colour and never meshed.
REGIONS = {'body_trunc', 'body_extremities', 'head', 'thoracic_cavity', 'abdominal_cavity', 'mediastinum'}

_MUSCLE = (r'(gluteus|autochthon|iliopsoas|masseter|temporalis|pterygoid|digastric|sternocleidomastoid|pharyngeal_constrictor|trapezius|platysma|'
           r'levator_|scalene|sterno_thyroid|thyrohyoid|prevertebral|rectus_|oblique|pectoralis|serratus|latissimus|erector_spinae|transversospinalis|'
           r'psoas|quadratus)')


def side_of(name: str) -> str | None:
    match = re.search(r'(?:^|_)(left|right)(?:_|$)', name)
    return match.group(1) if match else None


def group_of(name: str) -> str:
    if name in REGIONS or name in ('pericardium',):
        return 'regions'
    if re.match(r'(eye|auditory_canal)', name):
        return 'senses'
    if re.search(_MUSCLE, name) or re.search(r'_muscle_', name) or name == 'tongue':
        return 'muscles'
    if re.match(r'(vertebrae|intervertebral|rib_|sacrum|sternum|costal|humerus|scapula|clavicula|femur|hip_|skull|mandible|teeth|hyoid|'
                r'zygomatic|styloid|thyroid_cartilage|cricoid|hard_palate)', name):
        return 'skeleton'
    if re.search(r'(artery|arteries|aorta|brachiocephalic_trunk)', name):
        return 'arteries'
    if re.search(r'(vein|vena)', name) or name == 'liver_vessels':
        return 'veins'
    if re.match(r'(heart|atrial)', name):
        return 'heart'
    if re.match(r'(lung_|trachea|larynx|nasopharynx|oropharynx|hypopharynx|nasal_cavity|sinus_)', name):
        return 'airway'
    if re.match(r'(esophagus|stomach|duodenum|small_bowel|colon|soft_palate)', name):
        return 'digestive'
    if re.match(r'(kidney|urinary|prostate)', name):
        return 'urinary'
    if re.match(r'(brain|spinal|optic_nerve)', name):
        return 'nervous'
    if re.match(r'(thyroid_gland|adrenal|parotid|submandibular)', name):
        return 'glands'
    return 'abdominal'


def parent_of(name: str) -> str | None:
    """The structure this one is part of, by class name. A parent that a study does not hold is simply not shown."""
    side = side_of(name)
    if re.fullmatch(r'liver_segment_\d', name) or name == 'liver_vessels':
        return 'liver'
    if re.fullmatch(r'vertebrae_[CTLS]\d+', name):
        return 'vertebrae'
    if re.match(r'(erector_spinae|transversospinalis)_', name):
        return f'autochthon_{side}'
    if name.startswith('psoas_major_'):
        return f'iliopsoas_{side}'
    if name.startswith('eye_lens_'):
        return f'eye_{side}'
    if re.match(r'lung_(upper|middle|lower)_lobe_', name):
        return f'lung_{side}'
    if re.match(r'(zygomatic_arch|styloid_process)_', name):
        return 'skull'
    if name == 'mediastinum':
        return 'thoracic_cavity'
    if name == 'pericardium':
        return 'mediastinum'
    return None


_TONE = {
    'liver': (124, 52, 40), 'spleen': (112, 48, 72), 'gallbladder': (84, 120, 64), 'pancreas': (222, 184, 118), 'stomach': (214, 150, 132),
    'esophagus': (196, 132, 116), 'small_bowel': (218, 164, 142), 'duodenum': (206, 150, 124), 'colon': (198, 146, 116),
    'urinary_bladder': (222, 198, 130), 'prostate': (190, 128, 116), 'thyroid_gland': (168, 78, 60), 'heart': (166, 44, 42),
    'atrial_appendage_left': (178, 62, 56), 'trachea': (226, 222, 208), 'spinal_cord': (236, 224, 176), 'brain': (226, 206, 196),
    'aorta': (196, 28, 30), 'pulmonary_vein': (176, 52, 60), 'portal_vein_and_splenic_vein': (72, 62, 150),
    'superior_vena_cava': (44, 66, 160), 'inferior_vena_cava': (40, 60, 152), 'brachiocephalic_trunk': (200, 36, 34),
    'sacrum': (226, 216, 196), 'sternum': (230, 220, 200), 'costal_cartilages': (196, 206, 204), 'skull': (232, 224, 206),
    'lung_upper_lobe_left': (222, 150, 144), 'lung_lower_lobe_left': (210, 136, 132), 'lung_upper_lobe_right': (224, 154, 146),
    'lung_middle_lobe_right': (216, 144, 136), 'lung_lower_lobe_right': (208, 134, 130), 'lung_left': (216, 142, 138), 'lung_right': (218, 146, 140),
    'intervertebral_discs': (196, 206, 204), 'vertebrae': (228, 218, 198), 'mandible': (230, 220, 200), 'teeth_lower': (244, 240, 228),
    'teeth_upper': (244, 240, 228), 'hyoid': (226, 214, 190), 'thyroid_cartilage': (198, 208, 206), 'cricoid_cartilage': (192, 204, 204),
    'tongue': (186, 86, 84), 'soft_palate': (204, 128, 120), 'hard_palate': (228, 214, 196), 'liver_vessels': (60, 70, 150),
    'lung_arteries': (70, 90, 190), 'lung_veins': (190, 60, 66), 'lung_airways': (228, 226, 214), 'lung_airways_wall': (206, 200, 186),
    'pericardium': (196, 150, 140), 'larynx_air': (150, 186, 214), 'nasopharynx': (150, 190, 220), 'oropharynx': (146, 184, 214),
    'hypopharynx': (142, 178, 208),
}


def tone_of(name: str) -> tuple[int, int, int]:
    """An anatomical tone (sRGB). Paired and serial structures differ a little so neighbours can be told apart."""
    if name in _TONE:
        return _TONE[name]
    lift = 6 if side_of(name) == 'left' else 0
    match = re.fullmatch(r'liver_segment_(\d)', name)
    if match:
        k = int(match.group(1))
        return (112 + k * 7, 44 + k * 5, 34 + k * 4)
    match = re.search(r'(?:rib_(?:left|right)_|vertebrae_[CTLS])(\d+)', name)
    if match:
        k = int(match.group(1)) % 3
        return (222 + k * 4, 212 + k * 4, 190 + k * 5)
    if re.match(r'(humerus|femur|scapula|clavicula|hip|zygomatic|styloid)', name):
        return (228 + lift // 2, 218 + lift // 2, 198)
    if re.match(r'kidney', name):
        return (150 + lift, 66, 48)
    if re.match(r'adrenal', name):
        return (216, 176 + lift, 84)
    if re.match(r'(parotid|submandibular)', name):
        return (214, 172 + lift, 122)
    if re.match(r'eye_lens', name):
        return (196, 216, 236)
    if re.match(r'eye', name):
        return (236, 234, 226)
    if re.match(r'optic_nerve', name):
        return (236, 222, 170)
    if re.match(r'(nasal_cavity|sinus_|auditory_canal)', name):
        return (148 + lift, 188, 218)
    if re.search(r'(artery|arteries)', name):
        return (198, 32 + lift, 32)
    if re.search(r'(vein|vena)', name):
        return (44 + lift, 64, 156)
    if group_of(name) == 'muscles':
        seed = sum(ord(c) for c in re.sub(r'_(left|right)', '', name)) % 5
        return (132 + seed * 7 + lift, 50 + seed * 4, 44 + seed * 3)
    if name in REGIONS:
        return (150, 156, 168)
    return (200, 190, 180)


# Painting order, lowest first: a later task's label replaces an earlier one in the same voxel, so a container never hides
# what lies inside it and a finer structure replaces its parent. Tasks not listed here are not run.
PAINT_ORDER = ['body', 'body_mr', 'trunk_cavities', 'total', 'total_mr', 'vertebrae_mr', 'vertebrae_body', 'abdominal_muscles', 'headneck_muscles',
               'head_muscles', 'liver_segments', 'liver_segments_mr', 'liver_vessels', 'lung_vessels', 'craniofacial_structures',
               'head_glands_cavities', 'headneck_bones_vessels', 'oculomotor_muscles']
# Classes a detail task repeats from the base task; the base task's own label is kept.
REPEATED = {'oculomotor_muscles': {'skull'}, 'craniofacial_structures': {'skull'}, 'vertebrae_mr': {'sacrum'}}
