"""Ensure the complete source inventory is published without a parallel equation catalog."""
import re
from pathlib import Path
import tempfile
import unittest
from paths import ROOT
from model_math import block_latex, definition_text, latex_line, model_equations, model_formulas, source_blocks


class ModelEquationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.sources = {path.stem: path.read_text() for path in (ROOT / 'spec').glob('*.tla')}
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        (self.repo / 'spec').mkdir()
        (self.repo / 'spec/modules.json').write_text('["Example"]')
        (self.repo / 'spec/Example.tla').write_text('---- MODULE Example ----\n(* Section: Completion\n\nThe source explains the action.\n*)\nFinish == TRUE\nNewAction == FALSE\n====')

    def test_every_definition_and_declaration_is_published_in_order(self) -> None:
        count = 0
        for module, source in sorted(self.sources.items()):
            independent = re.findall(r'^([A-Za-z][A-Za-z0-9_]*(?:\([^\n)]*\))?)\s*==', source, re.MULTILINE)
            blocks = source_blocks(source)
            actual = [block['name'] for block in blocks if block['kind'] == 'definition']
            self.assertEqual(actual, [name.split('(')[0] for name in independent], module)
            count += len(actual) + len(re.findall(r'^(?:EXTENDS|CONSTANTS|ASSUME|VARIABLES)\b', source, re.MULTILINE))
        self.assertEqual(len(model_formulas(ROOT)), count)
        self.assertEqual(model_equations(ROOT).count('```=mathtex'), count)

    def test_new_source_sections_and_definitions_automatically_appear(self) -> None:
        document = '\n'.join(model_equations(self.repo))
        self.assertIn('Example - Completion', document)
        self.assertIn('The source explains the action.', document)
        self.assertIn('Example - NewAction', document)
        self.assertEqual(document.count('```=mathtex'), 2)

    def test_model_change_changes_the_equation(self) -> None:
        source = self.sources['FailurePolicy']
        original = block_latex(definition_text(source, 'NewFailure'))
        changed = block_latex(definition_text(source.replace('"timeout"', '"different-finding"'), 'NewFailure'))
        self.assertNotEqual(original, changed)
        self.assertIn('different-finding', changed)

    def test_temporal_set_and_record_operators_remain_distinct(self) -> None:
        expression = latex_line(r'[]<>(a \ b) \subseteq c ~> [v |-> 0..1]')
        for operator in (r'\Box', r'\Diamond', r'\setminus', r'\subseteq', r'\leadsto', r'\mapsto', r'\text{..}'):
            self.assertIn(operator, expression)

    def test_unknown_notation_fails_instead_of_dropping_source(self) -> None:
        for source in (r'a @@ b', r'a \unknown b'):
            with self.assertRaisesRegex(ValueError, 'Unsupported TLA'):
                latex_line(source)
        with self.assertRaisesRegex(ValueError, 'Unrecognised top-level'):
            source_blocks('---- MODULE Example ----\nMYSTERY content\n====')

    def test_definition_does_not_capture_declarations_or_comments(self) -> None:
        source = 'First(x) ==\n    x = 1\nVARIABLES y\n(* A comment. *)\nSecond == FALSE\n===='
        self.assertEqual(definition_text(source, 'First'), 'First(x) ==\n    x = 1')
        with self.assertRaisesRegex(AssertionError, 'Expected one definition'):
            definition_text(source, 'Missing')


if __name__ == '__main__':
    unittest.main()
