#!/usr/bin/env python3
"""Typeset every TLA+ module with TLATeX into the Spec page's PDFs, or with --check verifying that each typesets."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile
from spec_sources import spec_sources

ROOT = Path(__file__).resolve().parents[1]
PDFS = ROOT / 'docs/assets/spec'


def typeset(source_text: str, jar: Path) -> bytes:
    """Run TLATeX in a temporary directory, retaining only the PDF it typesets."""
    assert ' MODULE ' in source_text, 'TLATeX input must contain a module declaration'
    assert jar.is_file(), f'TLA tools jar missing: {jar}'
    with tempfile.TemporaryDirectory(prefix='overwatch-latex-') as directory:
        work = Path(directory)
        target = work / "Module.tla"
        target.write_text(source_text)
        result = subprocess.run(['java', '-cp', str(jar), 'tla2tex.TLA', '-number',
                                 '-textwidth', '500', '-hoffset', '-70', '-textheight', '680', '-voffset', '-60',
                                 '-latexCommand', 'pdflatex', '-latexOutputExt', 'pdf', target.name],
                                cwd=work, capture_output=True, text=True, timeout=90)
        if result.returncode or not target.with_suffix('.pdf').is_file():
            raise RuntimeError(f'TLATeX failed for {target.name}:\n{result.stdout}\n{result.stderr}')
        log = target.with_suffix('.log').read_text()
        if 'Overfull' in log:
            raise RuntimeError(f'{target.name} has overflowing typeset lines; wrap them in the TLA+ source')
        return target.with_suffix('.pdf').read_bytes()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jar', type=Path, default=os.environ.get('TLA2TOOLS_JAR', str(Path.home() / '.cache/tlalings/tla2tools.jar')))
    parser.add_argument('--check', action='store_true', help='Typeset every module without rewriting its PDF')
    args = parser.parse_args()
    sources = spec_sources(ROOT)
    assert sources, 'No TLA+ modules found in spec/'
    assert len({source.stem for source in sources}) == len(sources), f'Module names must be unique: {sources}'
    for source in sources:
        pdf = typeset(source.read_text(), args.jar.resolve())
        if not args.check:
            (PDFS / f'{source.stem}.pdf').write_bytes(pdf)
    print(f'{len(sources)} modules typeset{"" if args.check else f" into {PDFS.relative_to(ROOT)}"}')


if __name__ == '__main__':
    main()
