import re

from anatomy.presentation import REGIONS
from anatomy.registry import registry

LOCALES = ['en', 'ru', 'uz-Latn', 'ar', 'tr', 'es', 'fr', 'de', 'it', 'pt', 'zh-Hans', 'ja', 'ko', 'hi']
SCRIPT = {'ru': r'[Ѐ-ӿ]', 'ar': r'[؀-ۿ]', 'zh-Hans': r'[一-鿿]', 'ja': r'[぀-ヿ一-鿿]', 'ko': r'[가-힯]', 'hi': r'[ऀ-ॿ]'}


def test_the_fourteen_owner_languages_and_no_other():
    assert [l['code'] for l in registry()['locales']] == LOCALES            # Uzbek Cyrillic is excluded (owner, 8 November 2026)
    assert [l['code'] for l in registry()['locales'] if l['rtl']] == ['ar']


def test_every_structure_has_one_stable_id_and_a_canonical_english_name():
    structures = registry()['structures']
    assert len({s['id'] for s in structures}) == len(structures) == len({s['key'] for s in structures})
    assert all(0 < s['id'] < 65535 for s in structures)                     # 65535 is the body outline in the mesh pack
    for s in structures:
        assert s['en'] and s['en'].strip() == s['en'], s['key']
        assert s['group'] in {g['key'] for g in registry()['groups']}, s['key']
        assert s['region'] == (s['key'] in REGIONS)
        if s['parent']:
            assert s['parent'] in registry()['byKey'] and s['parent'] != s['key'], s['key']


def test_every_translated_name_names_its_source_and_is_in_its_own_script():
    """LANG: a name is shown only where a recorded source gives it; nothing is filled in with English or by a model."""
    sources = set(registry()['sources'])
    for s in registry()['structures']:
        assert set(s['terms']) <= set(LOCALES) - {'en'}, s['key']
        for locale, term in s['terms'].items():
            text, source = term[0], term[1]
            assert text and source in sources, (s['key'], locale)
            if locale in SCRIPT:
                assert re.search(SCRIPT[locale], text), (s['key'], locale, text)
            if locale == 'uz-Latn':
                assert not re.search(r'[Ѐ-ӿ]', text), (s['key'], text)
            if locale == 'zh-Hans':
                assert not re.search(r'[぀-ヿ]', text), (s['key'], text)


def test_the_coverage_table_is_counted_from_the_data_not_stated():
    structures = registry()['structures']
    for locale, count in registry()['coverage']['translated'].items():
        assert count == sum(1 for s in structures if locale in s['terms']), locale
    assert registry()['coverage']['structures'] == len(structures)


def test_a_withheld_name_stays_withheld():
    by_key = registry()['byKey']
    for item in registry()['withheld']:
        for key, s in by_key.items():
            if key.replace('_left', '').replace('_right', '') == item['concept']:
                assert item['locale'] not in s['terms'], key
